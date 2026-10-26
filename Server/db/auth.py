"""账号与登录凭证的数据库读写。凭证只存 SHA-256 哈希，密码只存 scrypt 哈希。"""
import uuid
from datetime import datetime, timedelta, timezone

import asyncpg

from db.supabase_chat import get_pool
from services.auth import ACCOUNT_PREFIX, DESKTOP_SUFFIX, VSCODE_SUFFIX

DDL = """CREATE TABLE IF NOT EXISTS gor_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    nickname TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS gor_auth_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES gor_users(id) ON DELETE CASCADE,
    client TEXT NOT NULL DEFAULT 'web',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS gor_auth_tokens_user ON gor_auth_tokens(user_id);
-- 头像随账号保存（Web 与插件共用），不写服务器目录
ALTER TABLE gor_users ADD COLUMN IF NOT EXISTS avatar BYTEA;
ALTER TABLE gor_users ADD COLUMN IF NOT EXISTS avatar_type TEXT;
ALTER TABLE gor_users ADD COLUMN IF NOT EXISTS avatar_updated_at TIMESTAMPTZ;"""

# 账号上线前所有会话都在这几个未登录命名空间下。
UNCLAIMED_WEB = "default"
UNCLAIMED_VSCODE = "default:vscode"
UNCLAIMED_DESKTOP = "default:desktop"


class EmailTakenError(Exception):
    pass


def public_user(row) -> dict:
    """返回给客户端的账号信息；avatarVersion 为头像更新时间（毫秒），没有头像时为 None。"""
    updated = row.get("avatar_updated_at") if hasattr(row, "get") else None
    return {
        "id": row["id"], "email": row["email"], "nickname": row["nickname"],
        "avatarVersion": int(updated.timestamp() * 1000) if updated else None,
    }


async def create_user(email: str, nickname: str, password_hash: str) -> tuple[dict, int]:
    """创建账号；若是第一个账号，同时把未登录命名空间下的历史会话归入其名下。

    返回 (用户, 认领的会话数)。锁表保证并发注册时只有一个账号成为「首个账号」。
    """
    user_id = str(uuid.uuid4())
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute("LOCK TABLE gor_users IN SHARE ROW EXCLUSIVE MODE")
            is_first = await conn.fetchval("SELECT NOT EXISTS (SELECT 1 FROM gor_users)")
            try:
                row = await conn.fetchrow(
                    "INSERT INTO gor_users (id, email, nickname, password_hash) VALUES ($1, $2, $3, $4)"
                    " RETURNING id, email, nickname",
                    user_id, email, nickname, password_hash,
                )
            except asyncpg.UniqueViolationError as error:
                raise EmailTakenError() from error
            claimed = 0
            if is_first:
                account = f"{ACCOUNT_PREFIX}{user_id}"
                for source, target in ((UNCLAIMED_WEB, account), (UNCLAIMED_VSCODE, account + VSCODE_SUFFIX),
                                       (UNCLAIMED_DESKTOP, account + DESKTOP_SUFFIX)):
                    status = await conn.execute("UPDATE chat_sessions SET user_id = $1 WHERE user_id = $2", target, source)
                    claimed += int(status.rsplit(" ", 1)[-1])
    return public_user(row), claimed


async def get_user_credentials(email: str) -> dict | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, email, nickname, password_hash, avatar_updated_at FROM gor_users WHERE email = $1", email,
        )
    return dict(row) if row else None


async def create_token(user_id: str, hashed: str, client: str, lifetime_seconds: int) -> None:
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=lifetime_seconds)
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                "INSERT INTO gor_auth_tokens (token_hash, user_id, client, expires_at) VALUES ($1, $2, $3, $4)",
                hashed, user_id, client, expires_at,
            )
            await conn.execute("UPDATE gor_users SET last_login_at = NOW() WHERE id = $1", user_id)


async def get_user_by_token(hashed: str) -> dict | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """SELECT u.id, u.email, u.nickname, u.avatar_updated_at FROM gor_auth_tokens t JOIN gor_users u ON u.id = t.user_id
               WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND t.expires_at > NOW()""",
            hashed,
        )
    return public_user(row) if row else None


async def revoke_token(hashed: str) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE gor_auth_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL", hashed,
        )


async def set_avatar(user_id: str, data: bytes, content_type: str) -> dict | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """UPDATE gor_users SET avatar = $2, avatar_type = $3, avatar_updated_at = NOW() WHERE id = $1
               RETURNING id, email, nickname, avatar_updated_at""",
            user_id, data, content_type,
        )
    return public_user(row) if row else None


async def get_avatar(user_id: str) -> tuple[bytes, str] | None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT avatar, avatar_type FROM gor_users WHERE id = $1 AND avatar IS NOT NULL", user_id)
    return (bytes(row["avatar"]), row["avatar_type"]) if row else None


async def get_session_owner(session_id: str) -> str | None:
    """会话所属命名空间；会话不存在时返回 None。"""
    try:
        # 线上表的 id 是 UUID 列；非 UUID 的 ID 不可能对应会话，也不能送进查询
        uuid.UUID(session_id)
    except (ValueError, TypeError, AttributeError):
        return None
    pool = await get_pool()
    async with pool.acquire() as conn:
        return await conn.fetchval("SELECT user_id FROM chat_sessions WHERE id = $1", session_id)
