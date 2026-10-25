"""账号接口：注册、登录、退出登录、查询当前用户；以及会话归属校验。

Web 使用 HttpOnly Cookie；插件（X-Gor-Client: vscode）与桌面端（X-Gor-Client: desktop）的凭证在
响应体中返回，分别由扩展存入 SecretStorage、由桌面端主进程加密保存，之后以 Authorization: Bearer 携带。
"""
import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from db import auth as auth_db
from services.auth import (
    AUTH_COOKIE, AVATAR_MAX_BYTES, REMEMBER_SECONDS, SESSION_SECONDS, AuthInputError, LoginThrottle,
    can_access_session, hash_password, new_token, normalize_email, read_token, token_client,
    sniff_avatar_type, token_hash, validate_nickname, validate_password, verify_password,
)

router = APIRouter()
throttle = LoginThrottle()
# 用于对不存在的邮箱也做一次等耗时的哈希比较，避免按响应时间探测账号是否存在。
_DUMMY_HASH = hash_password("gor-dummy-password-0")
_LOGIN_FAILED = "邮箱或密码不正确"


class RegisterRequest(BaseModel):
    email: str
    password: str
    nickname: str


class LoginRequest(BaseModel):
    email: str
    password: str
    remember: bool = False


async def current_account(request: Request) -> dict | None:
    raw = read_token(request.headers, request.cookies)
    if not raw:
        return None
    try:
        return await auth_db.get_user_by_token(token_hash(raw))
    except Exception as error:  # 数据库不可用时按未登录处理，由具体接口自行报错
        print(f"[Auth] 读取登录状态失败: {error}")
        return None


async def ensure_session_access(request: Request, session_id: str) -> None:
    """账号名下的会话只有本人能读写；其他人一律当作不存在，不暴露归属。"""
    owner = await auth_db.get_session_owner(session_id)
    if owner is None or can_access_session(owner, None):
        return
    account = await current_account(request)
    if not can_access_session(owner, account["id"] if account else None):
        raise HTTPException(status_code=404, detail="会话不存在")


async def _issue(request: Request, user: dict, remember: bool) -> JSONResponse:
    raw, hashed = new_token()
    client = token_client(request.headers)
    # 插件没有「记住我」选项，凭证一律 30 天；桌面端与 Web 一样按「记住我」决定
    lifetime = REMEMBER_SECONDS if remember or client == "vscode" else SESSION_SECONDS
    await auth_db.create_token(user["id"], hashed, client or "web", lifetime)
    body: dict = {"success": True, "user": user}
    if client:
        body["token"] = raw
    response = JSONResponse(body)
    if not client:
        response.set_cookie(
            AUTH_COOKIE, raw, max_age=lifetime if remember else None, httponly=True,
            samesite="lax", secure=request.url.scheme == "https", path="/",
        )
    return response


def _client_key(request: Request, email: str) -> str:
    host = request.client.host if request.client else "unknown"
    return f"{host}|{email}"


@router.post("/register")
async def register(body: RegisterRequest, request: Request):
    try:
        email = normalize_email(body.email)
        password = validate_password(body.password)
        nickname = validate_nickname(body.nickname)
    except AuthInputError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    try:
        user, claimed = await auth_db.create_user(email, nickname, hash_password(password))
    except auth_db.EmailTakenError as error:
        raise HTTPException(status_code=409, detail="该邮箱已注册，请直接登录") from error
    if claimed:
        print(f"[Auth] 首个账号认领了 {claimed} 个未登录会话")
    return await _issue(request, user, remember=True)


@router.post("/login")
async def login(body: LoginRequest, request: Request):
    try:
        email = normalize_email(body.email)
    except AuthInputError as error:
        raise HTTPException(status_code=401, detail=_LOGIN_FAILED) from error
    key = _client_key(request, email)
    if throttle.blocked(key):
        raise HTTPException(status_code=429, detail="尝试次数过多，请 15 分钟后再试")
    record = await auth_db.get_user_credentials(email)
    valid = verify_password(body.password or "", record["password_hash"] if record else _DUMMY_HASH)
    if not record or not valid:
        throttle.fail(key)
        raise HTTPException(status_code=401, detail=_LOGIN_FAILED)
    throttle.reset(key)
    return await _issue(request, auth_db.public_user(record), body.remember)


@router.post("/logout")
async def logout(request: Request):
    raw = read_token(request.headers, request.cookies)
    if raw:
        await auth_db.revoke_token(token_hash(raw))
    response = JSONResponse({"success": True})
    response.delete_cookie(AUTH_COOKIE, path="/")
    return response


@router.get("/me")
async def me(request: Request):
    return {"success": True, "user": await current_account(request)}


async def _require_account(request: Request) -> dict:
    account = await current_account(request)
    if not account:
        raise HTTPException(status_code=401, detail="请先登录")
    return account


@router.put("/avatar")
async def upload_avatar(request: Request):
    """以原始图片字节上传当前账号的头像；Web 与插件读取同一份。"""
    account = await _require_account(request)
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > AVATAR_MAX_BYTES:
        raise HTTPException(status_code=413, detail="头像图片不能超过 5 MB")
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="请选择头像图片")
    if len(data) > AVATAR_MAX_BYTES:
        raise HTTPException(status_code=413, detail="头像图片不能超过 5 MB")
    content_type = sniff_avatar_type(data)
    if not content_type:
        raise HTTPException(status_code=415, detail="请上传 PNG、JPG、WebP 或 GIF 图片")
    user = await auth_db.set_avatar(account["id"], data, content_type)
    return {"success": True, "user": user}


@router.get("/avatar")
async def get_avatar(request: Request):
    account = await _require_account(request)
    avatar = await auth_db.get_avatar(account["id"])
    if not avatar:
        raise HTTPException(status_code=404, detail="尚未设置头像")
    data, content_type = avatar
    # 头像属于个人数据：只允许浏览器私有缓存，版本号由客户端放在查询参数里
    return Response(content=data, media_type=content_type,
                    headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"})


# 会话子资源中只有 GET 附件/产物不校验：插件里它们由 <img>/<a> 直接加载，无法携带 Bearer 头；
# 访问它们仍需同时知道随机会话 ID 与随机附件 ID。
_SESSION_PATH = re.compile(r"^/api/chat/session/([^/]+)(/.*)?$")
_HEADERLESS_GET = re.compile(r"^/(attachments|generated-artifacts)/[^/]+$")


class SessionAccessMiddleware:
    """统一拦截 /api/chat/session/{id}/...，新增会话接口也自动受保护。"""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            match = _SESSION_PATH.match(scope.get("path", ""))
            if match and match.group(1) != "create":
                rest = match.group(2) or ""
                if not (scope.get("method") == "GET" and _HEADERLESS_GET.match(rest)):
                    try:
                        await ensure_session_access(Request(scope), match.group(1))
                    except HTTPException as error:
                        await JSONResponse({"detail": error.detail}, status_code=error.status_code)(scope, receive, send)
                        return
        await self.app(scope, receive, send)
