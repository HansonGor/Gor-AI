"""fact_qa：问答类题目，检查引用、日期、新鲜度、gold_facts 与编造。"""

from metrics import evaluate_case


def check(case: dict, result: dict, *, run_date=None, freshness_days: int = 3) -> dict:
    return evaluate_case(case, result, run_date=run_date, freshness_days=freshness_days)
