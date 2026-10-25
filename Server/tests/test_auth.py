"""账号鉴权：密码与凭证、注册/登录/退出、会话命名空间与归属校验（数据库全部替身，离线运行）。"""
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

import app as app_module
from db import auth as auth_db
from routes import auth as auth_routes
from routes import chat_routes
from services import auth as auth_service

USER = {"id": "acc-1", "email": "a@example.com", "nickname": "樺"}


class PasswordAndTokenTest(unittest.TestCase):
    def test_scrypt_hash_is_salted_and_verifies(self):
        first, second = auth_service.hash_password("abc12345"), auth_service.hash_password("abc12345")
        self.assertNotEqual(first, second)
        self.assertTrue(first.startswith("scrypt$"))
        self.assertTrue(auth_service.verify_password("abc12345", first))
        self.assertFalse(auth_service.verify_password("abc12346", first))
        self.assertFalse(auth_service.verify_password("abc12345", "garbage"))

    def test_input_validation(self):
        self.assertEqual(auth_service.normalize_email("  A@Example.COM "), "a@example.com")
        for bad in ("", "no-at", "a@b", "a b@c.com"):
            with self.assertRaises(auth_service.AuthInputError):
                auth_service.normalize_email(bad)
        for bad in ("short1", "lettersonly", "12345678"):
            with self.assertRaises(auth_service.AuthInputError):
                auth_service.validate_password(bad)
        self.assertEqual(auth_service.validate_nickname(" 樺 "), "樺")
        with self.assertRaises(auth_service.AuthInputError):
            auth_service.validate_nickname("x" * 21)

    def test_token_only_hash_is_stored_and_bearer_wins_over_cookie(self):
        raw, hashed = auth_service.new_token()
        self.assertEqual(hashed, auth_service.token_hash(raw))
        self.assertNotEqual(raw, hashed)
        self.assertEqual(auth_service.read_token({"authorization": "Bearer t1"}, {"gor_auth": "c1"}), "t1")
        self.assertEqual(auth_service.read_token({}, {"gor_auth": "c1"}), "c1")
        self.assertIsNone(auth_service.read_token({}, {}))

    def test_namespaces_keep_web_and_vscode_apart(self):
        self.assertEqual(auth_service.account_namespace("acc-1", "default"), "user:acc-1")
        self.assertEqual(auth_service.account_namespace("acc-1", "default:vscode"), "user:acc-1:vscode")
        self.assertEqual(auth_service.namespace_account("user:acc-1:vscode"), "acc-1")
        self.assertIsNone(auth_service.namespace_account("default:vscode"))
        self.assertTrue(auth_service.can_access_session("default", None))
        self.assertTrue(auth_service.can_access_session("user:acc-1:vscode", "acc-1"))
        self.assertFalse(auth_service.can_access_session("user:acc-1", "acc-2"))
        self.assertFalse(auth_service.can_access_session("user:acc-1", None))

    def test_throttle_blocks_after_limit_then_expires(self):
        throttle = auth_service.LoginThrottle(limit=2, window_seconds=60)
        throttle.fail("k", now=0)
        self.assertFalse(throttle.blocked("k", now=1))
        throttle.fail("k", now=1)
        self.assertTrue(throttle.blocked("k", now=2))
        self.assertFalse(throttle.blocked("k", now=100))


class AuthApiTest(unittest.TestCase):
    def setUp(self):
        auth_routes.throttle = auth_service.LoginThrottle()
        self.client = TestClient(app_module.app)
        self.patches = [
            patch.object(auth_db, "create_token", new=AsyncMock()),
            patch.object(auth_db, "revoke_token", new=AsyncMock()),
            patch.object(auth_db, "get_user_by_token", new=AsyncMock(return_value=None)),
        ]
        self.create_token, self.revoke_token, self.get_user_by_token = [p.start() for p in self.patches]

    def tearDown(self):
        for item in self.patches:
            item.stop()

    def test_register_sets_httponly_cookie_for_web(self):
        with patch.object(auth_db, "create_user", new=AsyncMock(return_value=(USER, 3))) as create_user:
            response = self.client.post("/api/auth/register", json={"email": "A@example.com", "password": "abc12345", "nickname": "樺"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["user"], USER)
        self.assertNotIn("token", response.json())
        cookie = response.headers["set-cookie"]
        self.assertIn("gor_auth=", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("samesite=lax", cookie.lower())
        email, nickname, stored = create_user.await_args.args
        self.assertEqual((email, nickname), ("a@example.com", "樺"))
        self.assertTrue(auth_service.verify_password("abc12345", stored))
        self.assertEqual(self.create_token.await_args.args[2], "web")

    def test_register_rejects_bad_input_and_duplicate_email(self):
        response = self.client.post("/api/auth/register", json={"email": "a@example.com", "password": "short", "nickname": "樺"})
        self.assertEqual(response.status_code, 400)
        with patch.object(auth_db, "create_user", new=AsyncMock(side_effect=auth_db.EmailTakenError())):
            response = self.client.post("/api/auth/register", json={"email": "a@example.com", "password": "abc12345", "nickname": "樺"})
        self.assertEqual(response.status_code, 409)

    def test_vscode_login_returns_token_in_body_without_cookie(self):
        record = {**USER, "password_hash": auth_service.hash_password("abc12345")}
        with patch.object(auth_db, "get_user_credentials", new=AsyncMock(return_value=record)):
            response = self.client.post("/api/auth/login", headers={"X-Gor-Client": "vscode"},
                                        json={"email": "a@example.com", "password": "abc12345"})
        self.assertEqual(response.status_code, 200)
        token = response.json()["token"]
        self.assertNotIn("set-cookie", response.headers)
        self.assertEqual(self.create_token.await_args.args[1], auth_service.token_hash(token))
        self.assertEqual(self.create_token.await_args.args[2], "vscode")

    def test_desktop_login_returns_token_and_honours_remember(self):
        record = {**USER, "password_hash": auth_service.hash_password("abc12345")}
        with patch.object(auth_db, "get_user_credentials", new=AsyncMock(return_value=record)):
            remembered = self.client.post("/api/auth/login", headers={"X-Gor-Client": "desktop"},
                                          json={"email": "a@example.com", "password": "abc12345", "remember": True})
            remembered_args = self.create_token.await_args.args
            session_only = self.client.post("/api/auth/login", headers={"X-Gor-Client": "Desktop "},
                                            json={"email": "a@example.com", "password": "abc12345"})
        self.assertIn("token", remembered.json())
        self.assertNotIn("set-cookie", remembered.headers)
        self.assertEqual(remembered_args[2], "desktop")
        self.assertEqual(remembered_args[3], auth_service.REMEMBER_SECONDS)
        self.assertIn("token", session_only.json())
        self.assertEqual(self.create_token.await_args.args[3], auth_service.SESSION_SECONDS, '不勾选「记住我」与 Web 相同')
        unknown = auth_service.token_client({"x-gor-client": "evil"})
        self.assertIsNone(unknown, "只有已知客户端才在响应体里拿到凭证")

    def test_remember_controls_cookie_lifetime(self):
        record = {**USER, "password_hash": auth_service.hash_password("abc12345")}
        with patch.object(auth_db, "get_user_credentials", new=AsyncMock(return_value=record)):
            remembered = self.client.post("/api/auth/login", json={"email": "a@example.com", "password": "abc12345", "remember": True})
            session_only = self.client.post("/api/auth/login", json={"email": "a@example.com", "password": "abc12345"})
        self.assertIn("Max-Age=2592000", remembered.headers["set-cookie"])
        self.assertNotIn("Max-Age", session_only.headers["set-cookie"])

    def test_login_failures_are_uniform_and_throttled(self):
        record = {**USER, "password_hash": auth_service.hash_password("abc12345")}
        with patch.object(auth_db, "get_user_credentials", new=AsyncMock(side_effect=[None, record, record, record, record, record])):
            unknown = self.client.post("/api/auth/login", json={"email": "x@example.com", "password": "abc12345"})
            wrong = self.client.post("/api/auth/login", json={"email": "a@example.com", "password": "wrong1234"})
            self.assertEqual((unknown.status_code, wrong.status_code), (401, 401))
            self.assertEqual(unknown.json()["detail"], wrong.json()["detail"])
            for _ in range(4):
                self.client.post("/api/auth/login", json={"email": "a@example.com", "password": "wrong1234"})
            blocked = self.client.post("/api/auth/login", json={"email": "a@example.com", "password": "abc12345"})
        self.assertEqual(blocked.status_code, 429)

    def test_logout_revokes_token_and_clears_cookie(self):
        response = self.client.post("/api/auth/logout", headers={"Authorization": "Bearer raw-token"})
        self.assertEqual(response.status_code, 200)
        self.revoke_token.assert_awaited_once_with(auth_service.token_hash("raw-token"))
        self.assertIn('gor_auth=""', response.headers["set-cookie"])

    def test_me_reads_user_from_token(self):
        self.get_user_by_token.return_value = USER
        response = self.client.get("/api/auth/me", headers={"Authorization": "Bearer t"})
        self.assertEqual(response.json()["user"], USER)
        self.get_user_by_token.assert_awaited_with(auth_service.token_hash("t"))


class SessionOwnershipTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app_module.app)

    def test_middleware_hides_other_accounts_sessions(self):
        with patch.object(auth_db, "get_session_owner", new=AsyncMock(return_value="user:acc-1")), \
             patch.object(auth_db, "get_user_by_token", new=AsyncMock(return_value={**USER, "id": "acc-2"})):
            response = self.client.get("/api/chat/session/s1/messages", headers={"Authorization": "Bearer t"})
            anonymous = self.client.delete("/api/chat/session/s1")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(anonymous.status_code, 404)

    def test_owner_and_unclaimed_sessions_pass(self):
        with patch.object(chat_routes, "load_messages", new=AsyncMock(return_value=[])):
            with patch.object(auth_db, "get_session_owner", new=AsyncMock(return_value="user:acc-1:vscode")), \
                 patch.object(auth_db, "get_user_by_token", new=AsyncMock(return_value=USER)):
                owner = self.client.get("/api/chat/session/s1/messages", headers={"Authorization": "Bearer t"})
            with patch.object(auth_db, "get_session_owner", new=AsyncMock(return_value="default")):
                unclaimed = self.client.get("/api/chat/session/s1/messages")
        self.assertEqual(owner.status_code, 200)
        self.assertEqual(unclaimed.status_code, 200)

    def test_header_less_attachment_reads_skip_the_check(self):
        with patch.object(auth_db, "get_session_owner", new=AsyncMock(return_value="user:acc-1")) as owner, \
             patch.object(chat_routes, "get_session_attachment", new=AsyncMock(return_value=None)):
            self.client.get("/api/chat/session/s1/attachments/a1")
        owner.assert_not_awaited()

    def test_session_list_and_create_use_account_namespace(self):
        with patch.object(auth_db, "get_user_by_token", new=AsyncMock(return_value=USER)), \
             patch.object(chat_routes, "list_sessions", new=AsyncMock(return_value=[])) as list_sessions, \
             patch.object(chat_routes, "create_session", new=AsyncMock(return_value={"id": "s1"})) as create_session:
            self.client.get("/api/chat/sessions?userId=default%3Avscode", headers={"Authorization": "Bearer t"})
            self.client.post("/api/chat/session/create", json={"userId": "default"}, headers={"Authorization": "Bearer t"})
        list_sessions.assert_awaited_once_with("user:acc-1:vscode")
        self.assertEqual(create_session.await_args.args[0], "user:acc-1")

    def test_anonymous_cannot_claim_account_namespace(self):
        with patch.object(chat_routes, "list_sessions", new=AsyncMock(return_value=[])) as list_sessions:
            response = self.client.get("/api/chat/sessions?userId=user%3Aacc-1")
            default = self.client.get("/api/chat/sessions?userId=default")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(default.status_code, 200)
        list_sessions.assert_awaited_once_with("default")

    def test_message_save_and_chat_reject_foreign_session(self):
        with patch.object(auth_db, "get_session_owner", new=AsyncMock(return_value="user:acc-1")), \
             patch.object(auth_db, "get_user_by_token", new=AsyncMock(return_value=None)), \
             patch.object(chat_routes, "save_message", new=AsyncMock()) as save_message:
            saved = self.client.post("/api/chat/message/save", json={"sessionId": "s1", "role": "user", "content": "hi"})
            chat = self.client.post("/api/chat", json={"sessionId": "s1", "message": "hi", "messages": [],
                                                      "editMode": "auto", "thinkingMode": "light"})
        self.assertEqual(saved.status_code, 404)
        save_message.assert_not_awaited()
        self.assertEqual(chat.status_code, 404)


if __name__ == "__main__":
    unittest.main()


PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


class AvatarApiTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app_module.app)

    def test_sniffs_real_image_types_only(self):
        self.assertEqual(auth_service.sniff_avatar_type(PNG), "image/png")
        self.assertEqual(auth_service.sniff_avatar_type(b"\xff\xd8\xff\xe0rest"), "image/jpeg")
        self.assertEqual(auth_service.sniff_avatar_type(b"RIFF\x00\x00\x00\x00WEBPVP8 "), "image/webp")
        self.assertEqual(auth_service.sniff_avatar_type(b"GIF89a..."), "image/gif")
        self.assertIsNone(auth_service.sniff_avatar_type(b"<svg onload=alert(1)>"))

    def test_avatar_requires_login(self):
        self.assertEqual(self.client.put("/api/auth/avatar", content=PNG).status_code, 401)
        self.assertEqual(self.client.get("/api/auth/avatar").status_code, 401)

    def test_upload_stores_bytes_for_the_current_account_and_returns_version(self):
        updated = {**USER, "avatarVersion": 1761300000000}
        with patch.object(auth_db, "get_user_by_token", new=AsyncMock(return_value=USER)), \
             patch.object(auth_db, "set_avatar", new=AsyncMock(return_value=updated)) as set_avatar:
            response = self.client.put("/api/auth/avatar", content=PNG, headers={"Authorization": "Bearer t", "Content-Type": "image/png"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["user"]["avatarVersion"], 1761300000000)
        set_avatar.assert_awaited_once_with("acc-1", PNG, "image/png")

    def test_upload_rejects_non_images_and_oversized_files(self):
        with patch.object(auth_db, "get_user_by_token", new=AsyncMock(return_value=USER)), \
             patch.object(auth_db, "set_avatar", new=AsyncMock()) as set_avatar:
            fake = self.client.put("/api/auth/avatar", content=b"<svg/>", headers={"Authorization": "Bearer t"})
            large = self.client.put("/api/auth/avatar", content=b"\x89PNG\r\n\x1a\n" + b"0" * auth_service.AVATAR_MAX_BYTES,
                                    headers={"Authorization": "Bearer t"})
        self.assertEqual((fake.status_code, large.status_code), (415, 413))
        set_avatar.assert_not_awaited()

    def test_read_returns_own_avatar_with_private_cache(self):
        with patch.object(auth_db, "get_user_by_token", new=AsyncMock(return_value=USER)), \
             patch.object(auth_db, "get_avatar", new=AsyncMock(return_value=(PNG, "image/png"))) as get_avatar:
            response = self.client.get("/api/auth/avatar", headers={"Authorization": "Bearer t"})
        self.assertEqual(response.content, PNG)
        self.assertEqual(response.headers["content-type"], "image/png")
        self.assertIn("private", response.headers["cache-control"])
        get_avatar.assert_awaited_once_with("acc-1")

    def test_public_user_exposes_avatar_version(self):
        from datetime import datetime, timezone
        row = {**USER, "avatar_updated_at": datetime(2026, 10, 24, tzinfo=timezone.utc)}
        self.assertEqual(auth_db.public_user(row)["avatarVersion"], int(row["avatar_updated_at"].timestamp() * 1000))
        self.assertIsNone(auth_db.public_user(USER)["avatarVersion"])
