"""输出截断。"""

from config import settings
from sandbox import truncate_output


def test_output_over_limit_is_truncated():
    data = b"a" * (64 * 1024 + 10)
    text, truncated = truncate_output(data)
    assert settings.output_limit == 64 * 1024
    assert truncated is True
    assert len(text.encode()) == 64 * 1024


def test_output_at_limit_is_kept():
    data = b"b" * (64 * 1024)
    text, truncated = truncate_output(data)
    assert truncated is False and text == data.decode()


def test_truncation_drops_partial_utf8_character():
    data = "中".encode() * 30000  # 每个字 3 字节，共 90000 字节
    text, truncated = truncate_output(data)
    assert truncated is True
    assert text == "中" * (64 * 1024 // 3)


def test_invalid_utf8_without_truncation_is_replaced():
    text, truncated = truncate_output(b"ok\xff")
    assert truncated is False and text == "ok�"
