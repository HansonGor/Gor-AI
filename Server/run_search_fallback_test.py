# -*- coding: utf-8 -*-
"""
SearchOrchestrator fallback 专项测试
=====================================
验证三件事：
1. Provider 抛异常 → 继续 fallback（不只空结果才降级）——用户要求的修复点
2. Provider 返回空列表 → 继续 fallback
3. preferred 结果不足 → 扩大到全网（general）
"""
import sys
import io
from unittest import mock

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

import tools.search_orchestrator as orch
from tools.search_orchestrator import orchestrator


def run_case(title, patches, query):
    print(f"\n### {title}")
    print(f"Query: {query} | intent={orch.classify_intent(query)}")
    with mock.patch.multiple("tools.search_orchestrator", **patches):
        payload = orchestrator.run(query)
    flow = " → ".join(f"{p}[{'域限定' if s == 'preferred' else '全网'}]" for p, s in payload["providers_used"])
    print(f"providers used: {flow}")
    print(f"fallback 触发  : {'是' if payload['fallback_used'] else '否'}")
    for r in payload["results"][:4]:
        print(f"  - [{r['sourceType']}|{r['provider']}] {r['title'][:48]} | {r['domain']}")
    return payload


if __name__ == "__main__":
    # 场景 1：豆包抛异常（网络/401/限流），必须继续 Serper/Tavily
    run_case(
        "场景1: doubao 抛异常 → 继续 fallback",
        {"_search_doubao": mock.Mock(side_effect=RuntimeError("boom: 401"))},
        "React Web Worker esbuild-wasm",
    )

    # 场景 2：豆包返回空列表，继续 Serper
    run_case(
        "场景2: doubao 返回空 → 继续 fallback",
        {"_search_doubao": mock.Mock(return_value=[])},
        "广州陈家祠开放时间",
    )

    # 场景 3：所有 provider 在域限定下都只返回 1 条（不足 MIN_PREFERRED=3），
    #         应扩大到全网搜索（general）
    one_item = [{"title": "t1", "url": "https://example.com/a", "content": "x", "source": "x"}]
    run_case(
        "场景3: preferred 不足 → 扩大到全网",
        {
            "_search_doubao": mock.Mock(return_value=one_item),
            "_search_serper": mock.Mock(return_value=one_item),
            "_search_tavily": mock.Mock(return_value=one_item),
        },
        "广州早茶哪里值得吃",
    )
