"""离线测试默认不触达真实数据库的账号表：会话一律视为未登录命名空间、请求一律视为未登录。

需要具体账号场景的测试（tests/test_auth.py）在用例内用 patch.object 覆盖这两个替身。
"""
from unittest.mock import AsyncMock, patch

import pytest

from db import auth as auth_db


@pytest.fixture(autouse=True)
def _offline_auth_lookups():
    with patch.object(auth_db, "get_session_owner", new=AsyncMock(return_value=None)), \
         patch.object(auth_db, "get_user_by_token", new=AsyncMock(return_value=None)):
        yield
