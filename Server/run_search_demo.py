# -*- coding: utf-8 -*-
"""
SearchOrchestrator 集成测试
============================
跑 5 个查询，逐个展示：
  intent → preferred domains → 实际 Provider → 实际来源 → fallback 情况
"""
import json
import sys
import io

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from tools.search_orchestrator import orchestrator, classify_intent, preferred_domains_for

QUERIES = [
    "广州三天两夜旅游攻略",
    "广州陈家祠开放时间",
    "广州早茶哪里值得吃",
    "React Web Worker esbuild-wasm",
    "React Web Worker GitHub example",
]

def main():
    print("=" * 90)
    print("SearchOrchestrator 集成测试")
    print("=" * 90)
    for q in QUERIES:
        payload = orchestrator.run(q)
        print(f"\n{'─' * 90}")
        print(f"Query: {q}")
        print(f"  intent            : {payload['intent']}")
        print(f"  preferred domains : {', '.join(payload['preferred_domains']) or '(无)'}")
        provider_flow = " → ".join(
            f"{p}[{'域限定' if st == 'preferred' else '全网'}]" for p, st in payload["providers_used"]
        )
        print(f"  providers used    : {provider_flow}")
        print(f"  fallback(扩大全网): {'是' if payload['fallback_used'] else '否'}")
        print(f"  results({len(payload['results'])}):")
        for r in payload["results"]:
            print(f"    - [{r['sourceType']:>8}|{r['provider']:<6}] {r['title'][:56]}")
            print(f"        domain={r['domain'] or '(无)'}  url={r['url'][:80]}")
    print(f"\n{'=' * 90}")

if __name__ == "__main__":
    main()
