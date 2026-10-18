"""task_type → 检查器注册表。

检查器签名：check(case: dict, result: dict, *, run_date, freshness_days) -> dict
返回值至少包含 metrics.evaluate_case 定义的字段，供 metrics.aggregate 汇总。
"""

from . import fact_qa


def _not_implemented(task_type: str):
    def check(case, result, **_):
        raise NotImplementedError(f"task_type={task_type} 的检查器尚未实现")
    return check


CHECKERS = {
    "fact_qa": fact_qa.check,
    # TODO(code_run): 运行回答中的代码/项目并比对输出，需沙箱执行环境。
    "code_run": _not_implemented("code_run"),
    # TODO(file_produced): 校验生成的文档/PPT/产物是否存在、格式正确并包含要求内容。
    "file_produced": _not_implemented("file_produced"),
}


def get_checker(task_type: str):
    try:
        return CHECKERS[task_type]
    except KeyError:
        raise KeyError(f"未注册的 task_type: {task_type}") from None
