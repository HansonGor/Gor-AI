"""Per-run search reuse and lossless model-facing duplicate removal."""
import json
import re
import copy
import time

from tools.web_search import _SEARCH_RESULT_MARKER
from tools.web_reader import page_has_evidence, MAX_PAGES


class ReaderContext:
    """Per-page successes only; permissions and URL allowlist stay in Agent."""
    def __init__(self):
        self._pages: dict[str, dict] = {}
        self._fingerprints: dict[str, str] = {}

    async def invoke(self, args: dict, execute, can_reuse) -> str:
        if not can_reuse():
            return await execute(args)
        started = time.perf_counter()
        limit = args.get("max_pages", MAX_PAGES)
        offset = args.get("start_char", 0)
        if not isinstance(limit, int) or not isinstance(offset, int) or offset < 0:
            return await execute(args)
        urls = list(dict.fromkeys(args.get("urls", [])))[:min(MAX_PAGES, max(1, limit))]
        conditions = {key: value for key, value in args.items() if key != "urls"}
        conditions.setdefault("query", "")
        conditions.setdefault("max_pages", MAX_PAGES)
        conditions.setdefault("start_char", 0)
        keys = {url: json.dumps([url, conditions], ensure_ascii=False, sort_keys=True) for url in urls}
        hits = {url: copy.deepcopy(self._pages[key]) for url, key in keys.items() if key in self._pages}
        missing = [url for url in urls if url not in hits]
        fetched = {}
        payload = {"pages": [], "failures": []}
        if missing:
            raw = await execute({**args, "urls": missing})
            try:
                payload = json.loads(raw)
                if not isinstance(payload, dict) or not isinstance(payload.get("pages"), list):
                    return raw
            except (ValueError, TypeError):
                return raw
            for page in payload["pages"]:
                if not isinstance(page, dict) or page.get("url") not in keys:
                    continue
                url = page["url"]
                fingerprint = page.get("body_fingerprint")
                if fingerprint:
                    previous = self._fingerprints.get(url)
                    if previous and previous != fingerprint:
                        self._pages = {key: value for key, value in self._pages.items() if value.get("url") != url}
                        hits.pop(url, None)
                        page["snapshot_changed"] = True
                        page["reading_note"] = "网页正文已变化，不能与此前片段拼接为同一全文；请从 start_char=0 重新核实。"
                    self._fingerprints[url] = fingerprint
                fetched[url] = page
                if can_reuse() and page_has_evidence(page) and not page.get("error") and not page.get("snapshot_changed"):
                    self._pages[keys[url]] = copy.deepcopy(page)
        pages = []
        for url in urls:
            page = hits.get(url) or fetched.get(url)
            if page is not None:
                page["cache_hit"] = url in hits
                if url in hits:
                    page["timings"] = {"download_ms": 0, "extraction_ms": 0}
                pages.append(page)
        payload.update(success=any(page_has_evidence(page) for page in pages), pages=pages,
                       requested_pages=len(urls), max_pages=MAX_PAGES)
        print("[ReaderReuse] " + json.dumps({"requested_pages": len(urls), "cache_hits": len(hits),
              "fetched_pages": len(fetched), "failed_pages": len(payload.get("failures") or []),
              "start_char": offset, "elapsed_ms": round((time.perf_counter() - started) * 1000)}))
        return json.dumps(payload, ensure_ascii=False)


class SearchContext:
    def __init__(self):
        self._queries: dict[str, str] = {}
        self._evidence: set[str] = set()

    @staticmethod
    def key(name: str, args: dict) -> str | None:
        if name not in {"web_search", "search_github_code"}:
            return None
        return json.dumps([name, args], ensure_ascii=False, sort_keys=True)

    def get(self, key: str | None) -> str | None:
        return self._queries.get(key) if key else None

    @staticmethod
    def healthy(payload: dict) -> bool:
        trace = payload.get("trace") or []
        if not isinstance(trace, list):
            return False
        return payload.get("success") is not False and not any(
            item.get("status") == "error" for item in trace if isinstance(item, dict)
        ) and not any(payload.get(field) == "error" for field in
                      ("github_code_search_status", "github_repositories_status"))

    def remember(self, key: str | None, result: str) -> None:
        if not key or not isinstance(result, str) or not result.startswith(_SEARCH_RESULT_MARKER):
            return
        try:
            envelope = json.loads(result[len(_SEARCH_RESULT_MARKER):])
            payload = envelope.get("payload") or {}
            results = payload.get("results") or []
            # Empty, failed and partially failed searches must remain retryable.
            if self.healthy(payload) and envelope.get("text") and any(
                isinstance(item, dict) and item.get("url") for item in results
            ):
                self._queries[key] = result
        except (ValueError, TypeError, AttributeError):
            return

    def compact_search(self, text: str) -> str:
        """Only reference exactly identical source blocks already in this run."""
        parts = re.split(r"(?m)(?=^\[S\d+\])", text)
        output = []
        for block in parts:
            marker = re.match(r"\[S\d+\]", block)
            if not marker:
                output.append(block)
                continue
            signature = block.rstrip()
            if signature in self._evidence:
                output.append(marker[0] + " 本轮此前已返回相同完整证据，请参阅前文。\n")
            else:
                self._evidence.add(signature)
                output.append(block)
        return "".join(output)


def compact_reader(result: str) -> str:
    """Keep complete unique paragraphs and metadata; preserve raw UI results."""
    try:
        payload = json.loads(result)
        changed = False
        for page in payload.get("pages", []):
            if not isinstance(page, dict) or not isinstance(page.get("body"), str):
                continue
            body = page["body"]
            paragraphs = body.split("\n\n")
            unique = list(dict.fromkeys(paragraphs))
            if len(unique) != len(paragraphs):
                page["body"] = "\n\n".join(unique)
                changed = True
            keys = page.get("key_paragraphs")
            if isinstance(keys, list):
                # A key paragraph absent from the bounded body may hold unique
                # evidence; keep it, including evidence beyond the body's limit.
                remaining = [key for key in keys if not isinstance(key, str) or key not in page["body"]]
                if remaining != keys:
                    page["key_paragraphs"] = remaining
                    changed = True
        return json.dumps(payload, ensure_ascii=False) if changed else result
    except (ValueError, TypeError, AttributeError):
        return result
