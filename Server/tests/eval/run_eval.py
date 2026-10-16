"""Gor 评测运行脚本（通用，按 task_type 选择检查器）。

用法（在 Server 目录）：
    venv\\Scripts\\python.exe -X utf8 tests\\eval\\run_eval.py --domain news
    venv\\Scripts\\python.exe -X utf8 tests\\eval\\run_eval.py --only news-tech-05
    venv\\Scripts\\python.exe -X utf8 tests\\eval\\run_eval.py --baseline ..\\.runlogs\\eval\\news-baseline.json

每题创建独立测试会话（userId=gor-eval），通过 POST /api/chat 获取 SSE 回答，结束后
DELETE /api/chat/session/{id}。只删除本脚本创建的会话；删除失败的会话 ID 写入报告。
输出只写入 --out-dir（默认仓库根目录 .runlogs/eval）。不读取、不打印 .env。
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from datetime import date, datetime
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE))

from checkers import get_checker  # noqa: E402
from metrics import aggregate, badness  # noqa: E402

EVAL_USER_ID = "gor-eval"
SUMMARY_KEYS = ("citation_coverage", "paragraph_citation_coverage", "date_accuracy", "unsourced_statements", "freshness_violations",
                "fact_accuracy", "fabrication_rate", "unanswered_cases")


def load_cases(domain: str, only: str | None) -> list[dict]:
    path = HERE / "cases" / f"{domain}.jsonl"
    cases = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if only:
        cases = [c for c in cases if c["id"] == only]
        if not cases:
            raise SystemExit(f"未找到题目 {only}")
    return cases


def _reader_pages(tool_result: str) -> list[dict]:
    try:
        payload = json.loads(tool_result)
    except (TypeError, json.JSONDecodeError):
        return []
    pages = payload.get("pages") if isinstance(payload, dict) else None
    return [p for p in pages or [] if isinstance(p, dict)]


def _sse_lines(stream):
    """只按 \\n 切分 SSE 行（与前端 Web/src/utils/sse.ts 一致）。

    httpx 的 iter_lines 还会在 \\u2028、\\x1c 等字符处断行；网页摘要里出现这些字符时，
    整条 search_sources 事件的 JSON 会被切断并丢失。
    """
    buffer = ""
    for chunk in stream.iter_text():
        buffer += chunk
        *lines, buffer = buffer.split("\n")
        for line in lines:
            yield line.rstrip("\r")
    if buffer:
        yield buffer.rstrip("\r")


def run_case(client: httpx.Client, base_url: str, case: dict, timeout: float) -> dict:
    record = {"id": case["id"], "question": case["question"], "category": case.get("category", ""),
              "session_id": None, "session_deleted": False, "answer": "", "sources": [], "reader_pages": [],
              "tools": [], "error": None, "status": None, "elapsed_s": None}
    started = time.perf_counter()
    try:
        resp = client.post(f"{base_url}/api/chat/session/create", json={"userId": EVAL_USER_ID}, timeout=30)
        resp.raise_for_status()
        record["session_id"] = resp.json()["sessionId"]
        body = {"sessionId": record["session_id"], "message": case["question"], "clientMode": "web"}
        deadline = started + timeout
        with client.stream("POST", f"{base_url}/api/chat", json=body,
                           timeout=httpx.Timeout(timeout, connect=15)) as stream:
            stream.raise_for_status()
            for line in _sse_lines(stream):
                if time.perf_counter() > deadline:
                    raise TimeoutError(f"超过 {timeout:.0f}s 未完成")
                if not line.startswith("data:"):
                    continue
                try:
                    event = json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    continue
                kind = event.get("type")
                if kind == "token":
                    record["answer"] += event.get("content") or ""
                elif kind == "search_sources":
                    for src in event.get("sources") or []:
                        if isinstance(src, dict) and src.get("url") and \
                                not any(s.get("url") == src["url"] for s in record["sources"]):
                            record["sources"].append(src)
                elif kind == "tool_end":
                    record["tools"].append(event.get("name"))
                    if event.get("name") == "web_reader":
                        record["reader_pages"].extend(_reader_pages(event.get("result")))
                elif kind == "error":
                    record["error"] = event.get("message") or event.get("code") or "error"
                elif kind == "done":
                    record["status"] = event.get("status")
                    break
        if record["status"] is None and not record["error"]:
            record["error"] = "SSE 未收到 done 事件"
    except Exception as exc:  # 单题失败记录后继续
        record["error"] = f"{type(exc).__name__}: {exc}"
    finally:
        record["elapsed_s"] = round(time.perf_counter() - started, 2)
        if record["session_id"]:
            try:
                resp = client.delete(f"{base_url}/api/chat/session/{record['session_id']}", timeout=30)
                record["session_deleted"] = resp.status_code == 200
            except Exception:
                record["session_deleted"] = False
    return record


def _fmt(value) -> str:
    if value is None:
        return "—"
    return f"{value:.1%}" if isinstance(value, float) else str(value)


def build_markdown(report: dict, baseline: dict | None) -> str:
    s = report["summary"]
    lines = [f"# Gor 评测：{report['domain']}（{report['started_at']}）", "",
             "> 所有指标均为启发式规则计算，用于同一题库前后对比，不等于人工核验。", "",
             f"- 后端：{report['base_url']}；题数 {s['cases']}，成功评估 {s['evaluated_cases']}；"
             f"新鲜度阈值 {report['freshness_days']} 天", "",
             "## 总体指标", "", "| 指标 | 数值 | 说明 |" + (" 基线 |" if baseline else ""),
             "| --- | --- | --- |" + (" --- |" if baseline else "")]
    rows = [
        ("引用覆盖率", "citation_coverage", f"{s['cited_fact_sentences']}/{s['fact_sentences']} 事实句带有效引用"),
        ("段落级覆盖率（辅助）", "paragraph_citation_coverage",
         f"{s['paragraph_cited_fact_sentences']}/{s['fact_sentences']} 事实句所在段落带有效引用"),
        ("日期正确率", "date_accuracy", f"{s['dates_correct']}/{s['dates_checked']}；无法核对日期 {s['dates_unverifiable']}"),
        ("无来源陈述数", "unsourced_statements", f"无引用 {s['unsourced_no_citation']}，无效编号 {s['unsourced_invalid_citation']}"),
        ("新鲜度违规数", "freshness_violations", f"来源无日期的时效陈述 {s['freshness_undated']}"),
        ("事实正确率", "fact_accuracy", f"命中 {s['gold_hits']}/{s['gold_total']}，未命中 {s['gold_misses']}，待复核 {s['gold_needs_review']}"),
        ("编造率", "fabrication_rate", f"{s['fabricated_cases']}/{s['no_answer_cases']} 道虚构前提题给出了具体事实"),
        ("未作答题数", "unanswered_cases", "回答为空或只有“已达到最大工具调用轮次限制”"),
    ]
    for label, key, note in rows:
        line = f"| {label} | {_fmt(s.get(key))} | {note} |"
        if baseline:
            line += f" {_fmt(baseline.get('summary', {}).get(key))} |"
        lines.append(line)
    lines += ["", "## 按类别", "", "| 类别 | 覆盖率 | 日期正确率 | 无来源陈述 | 新鲜度违规 | 事实正确率 |",
              "| --- | --- | --- | --- | --- | --- |"]
    for cat, m in report["by_category"].items():
        lines.append(f"| {cat} | {_fmt(m['citation_coverage'])} | {_fmt(m['date_accuracy'])} | "
                     f"{m['unsourced_statements']} | {m['freshness_violations']} | {_fmt(m['fact_accuracy'])} |")
    lines += ["", "## 最差的 5 题", ""]
    for item in report["worst"]:
        lines.append(f"### {item['id']}（得分 {item['badness']}）{item['question']}")
        if item.get("error"):
            lines.append(f"- 错误：{item['error']}")
        for p in item["problems"][:5]:
            extra = p.get("date") or p.get("ids") or p.get("age_days") or ""
            lines.append(f"- [{p['kind']}] {p['sentence'][:160]} {extra}")
        lines.append("")
    failed = [c for c in report["cases"] if c["error"] or c["metrics"].get("unanswered")]
    lines += ["## 失败、超时或未作答", ""] + (
        [f"- {c['id']}：{c['error'] or '未作答（已达到最大工具调用轮次限制或回答为空）'}" for c in failed] or ["- 无"])
    lines += ["", "## 人工复核", "",
              f"- 题库标记 needs_review 的题：{report['needs_review_cases']} 道（不计入事实正确率）",
              f"- 自动匹配无法判定的 gold_facts：{s['gold_needs_review']} 条", "",
              "## 遗留测试会话", ""]
    lines += [f"- {sid}" for sid in report["leftover_sessions"]] or ["- 无（全部已删除）"]
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Gor 评测运行脚本")
    parser.add_argument("--domain", default="news")
    parser.add_argument("--base-url", default="http://localhost:3001")
    parser.add_argument("--only")
    parser.add_argument("--out-dir", default=".runlogs/eval", help="相对路径以仓库根目录为基准")
    parser.add_argument("--baseline")
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument("--freshness-days", type=int, default=3)
    parser.add_argument("--rescore", help="不调用后端，用已保存结果 JSON 中的原始回答按当前题库与指标重新计算")
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir = out_dir if out_dir.is_absolute() else REPO_ROOT / out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    base_url = args.base_url.rstrip("/")
    cases = load_cases(args.domain, args.only)
    run_date = date.today()
    started_at = datetime.now().strftime("%Y%m%d-%H%M%S")

    def score(case: dict, record: dict) -> None:
        if record["error"] and not record["answer"]:
            record["metrics"] = {"error": record["error"]}
        else:
            checker = get_checker(case.get("task_type", "fact_qa"))
            record["metrics"] = checker(case, record, run_date=run_date, freshness_days=args.freshness_days)
        record["badness"] = badness(record["metrics"])

    records = []
    if args.rescore:
        saved = json.loads(Path(args.rescore).read_text(encoding="utf-8"))
        run_date = date.fromisoformat(saved["run_date"])
        base_url = saved.get("base_url", base_url)
        started_at = saved["started_at"] + "-rescored"
        by_id = {r["id"]: r for r in saved["cases"]}
        for case in cases:
            if case["id"] in by_id:
                record = by_id[case["id"]]
                record["category"] = case.get("category", "")
                score(case, record)
                records.append(record)
    else:
        with httpx.Client() as client:
            for n, case in enumerate(cases, 1):
                print(f"[{n}/{len(cases)}] {case['id']} …", flush=True)
                record = run_case(client, base_url, case, args.timeout)
                score(case, record)
                print(f"    {record['elapsed_s']}s 来源 {len(record['sources'])} 读取 {len(record['reader_pages'])}"
                      f"{' 错误: ' + record['error'] if record['error'] else ''}", flush=True)
                records.append(record)

    categories = sorted({r["category"] for r in records})
    report = {
        "domain": args.domain, "base_url": base_url, "started_at": started_at, "run_date": run_date.isoformat(),
        "freshness_days": args.freshness_days,
        "heuristic_note": "指标为启发式规则计算，见 tests/eval/metrics.py 注释。",
        "summary": aggregate([r["metrics"] for r in records]),
        "by_category": {c: aggregate([r["metrics"] for r in records if r["category"] == c]) for c in categories},
        "needs_review_cases": sum(bool(c.get("needs_review")) for c in cases),
        "leftover_sessions": [r["session_id"] for r in records if r["session_id"] and not r["session_deleted"]],
        "cases": records,
    }
    report["worst"] = [
        {"id": r["id"], "question": r["question"], "badness": r["badness"], "error": r["error"],
         "problems": r["metrics"].get("problems", [])}
        for r in sorted(records, key=lambda r: r["badness"], reverse=True)[:5]
    ]
    baseline = json.loads(Path(args.baseline).read_text(encoding="utf-8")) if args.baseline else None

    stem = f"{args.domain}-{started_at}" + (f"-{args.only}" if args.only else "")
    json_path = out_dir / f"{stem}.json"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    (out_dir / f"{stem}.md").write_text(build_markdown(report, baseline), encoding="utf-8")
    baseline_path = out_dir / f"{args.domain}-baseline.json"
    if not args.only and not args.rescore and not baseline_path.exists():
        shutil.copyfile(json_path, baseline_path)
        print(f"首次运行，已复制为基线：{baseline_path}")

    s = report["summary"]
    print(f"\n报告：{json_path}")
    for key in SUMMARY_KEYS:
        print(f"  {key}: {_fmt(s.get(key))}")
    if report["leftover_sessions"]:
        print(f"  遗留测试会话：{', '.join(report['leftover_sessions'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
