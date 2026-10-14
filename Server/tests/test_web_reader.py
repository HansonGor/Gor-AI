import json

import pytest

import tools.web_reader as reader


def test_extract_article_returns_requested_metadata_and_article_body():
    html = """<!doctype html><html><head>
      <title>Python 3.15 发布说明</title>
      <meta name="author" content="Python 核心团队">
      <meta property="article:published_time" content="2026-10-08T09:00:00+08:00">
      <meta name="description" content="版本发布摘要">
      </head><body><main><article><h1>Python 3.15 发布说明</h1>
      <p>Python 核心团队今日发布了新版本，并说明了主要变化与支持周期。</p>
      <p>新版本改进了性能，并包含面向开发者的兼容性更新和安全修复。</p>
      <p>官方建议用户阅读迁移指南后再升级生产环境中的应用。</p>
      </article></main><nav>这段导航不应进入正文</nav></body></html>"""

    page = reader._extract_article(html, "https://python.org/news/release", "Python 最新版本")

    assert page["title"] == "Python 3.15 发布说明"
    assert page["published_at"] == "2026-10-08T09:00:00+08:00"
    assert page["author"] == "Python 核心团队"
    assert page["url"] == "https://python.org/news/release"
    assert "支持周期" in page["body"]
    assert "不应进入正文" not in page["body"]
    assert page["key_paragraphs"]


def test_extract_article_uses_html_title_and_common_publication_metadata():
    html = """<html><head><title>标题回退</title>
      <meta name="pubdate" content="2026-10-07"></head><body>
      <p>这是足够长的文章正文段落，用于验证普通页面标题和发布时间元数据能够正确读取。</p>
      </body></html>"""
    page = reader._extract_article(html, "https://example.com/story")
    assert page["title"] == "标题回退"
    assert page["published_at"] == "2026-10-07"


@pytest.mark.parametrize("url", [
    "file:///C:/Users/private.txt", "http://localhost/article",
    "http://127.0.0.1/article", "http://192.168.1.20/article",
    "http://user:password@example.com/article",
])
def test_validate_public_url_rejects_local_or_credential_urls(url):
    with pytest.raises(ValueError):
        reader._validate_public_url(url)


def test_reader_deduplicates_urls_and_caps_pages_at_eight(monkeypatch):
    calls = []

    def fake_read(url, focus):
        calls.append(url)
        return {"url": url, "body": "正文内容足够长。" * 20}

    monkeypatch.setattr(reader, "_read_one", fake_read)
    urls = [f"https://example.com/{number}" for number in range(10)]
    result = reader.read_web_pages([urls[0], *urls], query="测试", max_pages=99)

    assert len(calls) == 8
    assert len(result["pages"]) == 8
    assert result["requested_pages"] == 8
    assert result["success"] is True


def test_reader_honors_configured_network_proxy_after_public_url_validation(monkeypatch):
    client_options = {}

    class FakeResponse:
        status_code = 200
        headers = {"content-type": "text/html; charset=utf-8"}
        encoding = "utf-8"

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def raise_for_status(self):
            return None

        def iter_bytes(self):
            yield b"<html><head><title>Grok 4.7</title></head><body><article><p>" + (
                "Grok 4.7 is available today. This paragraph is long enough to verify that the article body "
                "is extracted through the configured network route."
            ).encode() + b"</p></article></body></html>"

    class FakeClient:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def stream(self, *args, **kwargs):
            return FakeResponse()

    def fake_client(**kwargs):
        client_options.update(kwargs)
        return FakeClient()

    monkeypatch.setattr(reader, "_validate_public_url", lambda url: url)
    monkeypatch.setattr(reader.httpx, "Client", fake_client)

    page = reader._read_one("https://example.com/grok-4-7", "Grok 4.7")

    assert client_options["trust_env"] is True
    assert page["title"] == "Grok 4.7"
    assert "available today" in page["body"]


def test_tool_returns_json_with_page_fields(monkeypatch):
    expected = {"success": True, "pages": [{"title": "标题"}], "failures": []}
    monkeypatch.setattr(reader, "read_web_pages", lambda *args, **kwargs: expected)

    assert json.loads(reader.web_reader.invoke({"urls": ["https://example.com"]})) == expected


def test_long_article_continuations_cover_all_characters_and_tail_facts():
    paragraphs = [f"段落{i}：" + "新闻背景内容" * 90 for i in range(20)]
    paragraphs.append("最终确认：正式发布日期是2026年10月14日，价格为5200元，前三季度传闻数字并不准确。")
    html = "<article>" + "".join(f"<p>{p}</p>" for p in paragraphs) + "</article>"
    complete = "\n\n".join(paragraphs)
    chunks, fingerprints = [], []
    offset = 0
    while True:
        page = reader._extract_article(html, "https://example.com/news", "正式发布日期", start_char=offset)
        chunks.append(page["body"])
        fingerprints.append(page["body_fingerprint"])
        assert page["total_body_chars"] == len(complete)
        assert page["body_start_char"] == offset
        if not page["has_more"]:
            assert page["next_start_char"] is None
            break
        assert page["body_truncated"] and page["reading_note"]
        assert page["next_start_char"] > offset
        offset = page["next_start_char"]
    assert "".join(chunks) == complete
    assert "5200元" in chunks[-1]
    assert len(set(fingerprints)) == 1


def test_short_article_is_not_marked_truncated_and_short_tail_is_valid_evidence():
    page = reader._extract_article("<article><p>" + "完整新闻正文。" * 20 + "</p></article>", "https://example.com/news")
    assert not page["body_truncated"] and not page["has_more"] and not page["reading_note"]
    assert reader.page_has_evidence({"body": "最后五个字", "body_start_char": 8000, "total_body_chars": 8005})


def test_read_timings_and_continuation_arguments_are_reported(monkeypatch, capsys):
    seen = []
    def read(url, focus, offset=0):
        seen.append((url, focus, offset))
        return {"url": url, "body": "正文" * 50, "body_truncated": True,
                "timings": {"download_ms": 10, "extraction_ms": 2}}
    monkeypatch.setattr(reader, "_read_one", read)
    payload = reader.read_web_pages(["https://example.com/a"], "重点", start_char=8000)
    assert payload["success"]
    assert seen == [("https://example.com/a", "重点", 8000)]
    output = capsys.readouterr().out
    assert "ReaderTiming" in output and '"download_ms": 10' in output and '"start_char": 8000' in output


def test_tool_rejects_negative_continuation_before_network():
    with pytest.raises(ValueError):
        reader.web_reader.invoke({"urls": ["https://example.com/a"], "start_char": -1})
