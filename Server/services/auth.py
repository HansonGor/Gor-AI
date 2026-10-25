"""账号鉴权的纯逻辑：密码哈希、输入校验、登录凭证、失败限流与会话命名空间。

不访问数据库，便于离线测试；数据库读写见 db/auth.py，接口见 routes/auth.py。
"""
import base64
import hashlib
import hmac
import re
import secrets
import time
from dataclasses import dataclass, field

# Web 通过同源 Cookie 携带凭证；插件 Webview 跨源访问后端，改用 Authorization: Bearer。
AUTH_COOKIE = "gor_auth"
CLIENT_HEADER = "x-gor-client"
REMEMBER_SECONDS = 30 * 24 * 3600
# 不勾选「记住我」时浏览器关闭即丢弃 Cookie；服务端仍设上限，避免长期不关浏览器时凭证永久有效。
SESSION_SECONDS = 7 * 24 * 3600

ACCOUNT_PREFIX = "user:"
VSCODE_SUFFIX = ":vscode"

_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 2 ** 14, 8, 1
_EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")


class AuthInputError(ValueError):
    """用户输入不合规，消息可直接展示给用户。"""


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P, dklen=32)
    encode = lambda raw: base64.b64encode(raw).decode("ascii")
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${encode(salt)}${encode(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, n, r, p, salt, expected = stored.split("$")
        if scheme != "scrypt":
            return False
        expected_bytes = base64.b64decode(expected)
        digest = hashlib.scrypt(password.encode("utf-8"), salt=base64.b64decode(salt),
                                n=int(n), r=int(r), p=int(p), dklen=len(expected_bytes))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest, expected_bytes)


def normalize_email(email: str) -> str:
    value = (email or "").strip().lower()
    if len(value) > 254 or not _EMAIL.match(value):
        raise AuthInputError("请输入有效的邮箱地址")
    return value


def validate_password(password: str) -> str:
    value = password or ""
    if len(value) < 8 or len(value) > 128:
        raise AuthInputError("密码需为 8 到 128 位")
    if not re.search(r"[A-Za-z]", value) or not re.search(r"\d", value):
        raise AuthInputError("密码需同时包含字母和数字")
    return value


def validate_nickname(nickname: str) -> str:
    value = (nickname or "").strip()
    if not 1 <= len(value) <= 20:
        raise AuthInputError("昵称需为 1 到 20 个字")
    if any(ord(char) < 32 for char in value):
        raise AuthInputError("昵称不能包含控制字符")
    return value


AVATAR_MAX_BYTES = 5 * 1024 * 1024


def sniff_avatar_type(data: bytes) -> str | None:
    """按文件头识别头像格式，不信任客户端声明的类型；只接受 PNG/JPEG/WebP/GIF。"""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


def new_token() -> tuple[str, str]:
    """返回 (原文, 哈希)。原文只交给客户端一次，数据库只存哈希。"""
    raw = secrets.token_urlsafe(32)
    return raw, token_hash(raw)


def token_hash(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def read_token(headers, cookies) -> str | None:
    """优先读插件的 Bearer 头，其次读 Web 的 Cookie。"""
    authorization = headers.get("authorization") or ""
    if authorization.lower().startswith("bearer "):
        value = authorization[7:].strip()
        if value:
            return value
    return cookies.get(AUTH_COOKIE) or None


# 不能用同源 Cookie 的客户端：凭证放在响应体里交给宿主保管（插件存 SecretStorage，桌面端主进程加密保存）
TOKEN_CLIENTS = ("vscode", "desktop")


def token_client(headers) -> str | None:
    """返回请求声明的凭证型客户端（vscode / desktop）；Web 返回 None，走 Cookie。"""
    value = (headers.get(CLIENT_HEADER) or "").strip().lower()
    return value if value in TOKEN_CLIENTS else None


def account_namespace(account_id: str, requested_user_id: str | None) -> str:
    """登录后按账号划分会话：Web 用 user:<id>，插件沿用两端隔离规则用 user:<id>:vscode。"""
    base = f"{ACCOUNT_PREFIX}{account_id}"
    return base + VSCODE_SUFFIX if (requested_user_id or "").endswith(VSCODE_SUFFIX) else base


def namespace_account(user_id: str | None) -> str | None:
    """会话所属命名空间对应的账号 ID；未登录命名空间（default 等）返回 None。"""
    if not user_id or not user_id.startswith(ACCOUNT_PREFIX):
        return None
    rest = user_id[len(ACCOUNT_PREFIX):]
    return rest[: -len(VSCODE_SUFFIX)] if rest.endswith(VSCODE_SUFFIX) else rest


def can_access_session(owner_user_id: str | None, account_id: str | None) -> bool:
    """账号名下的会话只有本人可访问；未登录命名空间的会话保持原有行为。"""
    owner_account = namespace_account(owner_user_id)
    return owner_account is None or owner_account == account_id


@dataclass
class LoginThrottle:
    """同一 IP + 邮箱在窗口内失败次数过多时暂时拒绝登录（单进程内存计数）。"""
    limit: int = 5
    window_seconds: int = 15 * 60
    _failures: dict[str, list[float]] = field(default_factory=dict)

    def _recent(self, key: str, now: float) -> list[float]:
        attempts = [stamp for stamp in self._failures.get(key, []) if now - stamp < self.window_seconds]
        if attempts:
            self._failures[key] = attempts
        else:
            self._failures.pop(key, None)
        return attempts

    def blocked(self, key: str, now: float | None = None) -> bool:
        return len(self._recent(key, time.time() if now is None else now)) >= self.limit

    def fail(self, key: str, now: float | None = None) -> None:
        moment = time.time() if now is None else now
        self._failures[key] = [*self._recent(key, moment), moment]

    def reset(self, key: str) -> None:
        self._failures.pop(key, None)
