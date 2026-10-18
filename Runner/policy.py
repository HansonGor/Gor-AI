"""git 只读命令白名单与参数校验。

保守设计：未列出的子命令、选项和位置参数一律拒绝，不做"尽量放行"。
校验通过后返回最终交给容器执行的 argv（diff 会自动追加安全参数）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import PurePosixPath, PureWindowsPath


class PolicyError(Exception):
    """命令不在白名单内；message 说明具体违反的规则。"""


# 子命令之前出现即拒绝的全局选项
GLOBAL_OPTIONS = ("-c", "-C", "--git-dir", "--work-tree", "--exec-path", "--namespace")

# 无论出现在哪里都拒绝的参数（精确匹配或 "--name=..." 形式）
FORBIDDEN_ARGS = ("--output", "-o", "--ext-diff", "--textconv", "--exec", "--upload-pack",
                  "--receive-pack", "--no-index", "--open-files-in-pager")

FORMAT_FLAGS = {"--oneline"}
FORMAT_PATTERNS = (re.compile(r"--format=.*", re.S),)
# -<数字> 是 git 对 -n<数字> 的简写（验收命令 git log --oneline -3 需要）
COUNT_PATTERNS = (re.compile(r"-n\d+"), re.compile(r"--max-count=\d+"), re.compile(r"-\d+"))


@dataclass(frozen=True)
class Rule:
    flags: frozenset[str] = frozenset()
    patterns: tuple[re.Pattern, ...] = ()
    # paths: none=不允许位置参数；after_dashdash=仅 "--" 之后的路径；any=路径可直接出现或在 "--" 之后
    paths: str = "none"
    require_path: bool = False
    exact_tokens: frozenset[str] = field(default_factory=frozenset)


RULES: dict[str, Rule] = {
    "status": Rule(flags=frozenset({"--short", "-s", "--branch", "-b", "--porcelain", "--ignored"})),
    "log": Rule(flags=frozenset({"--oneline", "--stat", "--graph", "--all"}),
                patterns=COUNT_PATTERNS + FORMAT_PATTERNS),
    "diff": Rule(flags=frozenset({"--stat", "--name-only", "--name-status", "--cached", "--staged"}),
                 patterns=(re.compile(r"-U\d+"),), paths="after_dashdash"),
    "show": Rule(flags=frozenset(FORMAT_FLAGS | {"--stat", "--name-only"}), patterns=FORMAT_PATTERNS),
    "branch": Rule(flags=frozenset({"-a", "-r", "-v", "--list", "--show-current"})),
    "rev-parse": Rule(exact_tokens=frozenset({"--show-toplevel", "--abbrev-ref", "HEAD", "--is-inside-work-tree"})),
    "ls-files": Rule(flags=frozenset({"--cached", "--others", "--modified", "--stage"})),
    "blame": Rule(flags=frozenset({"--porcelain"}), patterns=(re.compile(r"-L\d+(?:,[+-]?\d+)?"),),
                  paths="any", require_path=True),
}

# diff 自动追加，阻止外部 diff 程序与 textconv 过滤器
DIFF_SAFETY_ARGS = ["--no-ext-diff", "--no-textconv"]


def _check_path(value: str) -> None:
    if not value:
        raise PolicyError("路径参数不能为空")
    if value.startswith(("/", "\\")) or PureWindowsPath(value).drive or PurePosixPath(value).is_absolute():
        raise PolicyError(f"路径参数不得是绝对路径：{value}")
    if ".." in value:
        raise PolicyError(f"路径参数不得包含 ..：{value}")
    if value.startswith("-"):
        raise PolicyError(f"路径参数不得以 - 开头：{value}")
    if value.startswith(":"):
        raise PolicyError(f"不支持 pathspec 魔法前缀（以 : 开头）：{value}")


def _is_forbidden(arg: str) -> str | None:
    for name in FORBIDDEN_ARGS:
        if arg == name or arg.startswith(name + "="):
            return name
    # 短选项 -o 的连写形式（-ofile）
    if arg.startswith("-o") and not arg.startswith("--"):
        return "-o"
    return None


def validate(argv: object) -> list[str]:
    """校验 argv，通过则返回最终执行的 argv；否则抛出 PolicyError。"""
    if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
        raise PolicyError("argv 必须是非空字符串数组")
    for arg in argv:
        if "\n" in arg or "\r" in arg or "\x00" in arg:
            raise PolicyError("参数不得包含换行符或 NUL 字符")
    if argv[0] != "git":
        raise PolicyError(f"argv[0] 必须是 git，实际为：{argv[0]}")
    if len(argv) < 2:
        raise PolicyError("缺少 git 子命令")
    sub = argv[1]
    if sub.startswith("-"):
        name = sub.split("=", 1)[0]
        if name in GLOBAL_OPTIONS or any(sub.startswith(g) for g in ("-c", "-C") if len(sub) > 2):
            raise PolicyError(f"不允许在子命令之前使用全局选项：{name}")
        raise PolicyError(f"argv[1] 必须是允许的子命令，不能是选项：{sub}")
    rule = RULES.get(sub)
    if rule is None:
        raise PolicyError(f"子命令不在白名单内：{sub}（允许：{', '.join(RULES)}）")

    args = argv[2:]
    for arg in args:
        hit = _is_forbidden(arg)
        if hit:
            raise PolicyError(f"禁止使用参数：{hit}")

    paths: list[str] = []
    after_dashdash = False
    for arg in args:
        if after_dashdash:
            paths.append(arg)
            continue
        if arg == "--":
            if rule.paths == "none":
                raise PolicyError(f"git {sub} 不接受路径参数")
            after_dashdash = True
            continue
        if rule.exact_tokens:
            if arg not in rule.exact_tokens:
                raise PolicyError(f"git {sub} 只允许：{', '.join(sorted(rule.exact_tokens))}；不允许：{arg}")
            continue
        if arg.startswith("-"):
            if arg in rule.flags or any(p.fullmatch(arg) for p in rule.patterns):
                continue
            raise PolicyError(f"git {sub} 不允许参数：{arg}")
        if rule.paths == "any":
            paths.append(arg)
            continue
        if rule.paths == "after_dashdash":
            raise PolicyError(f"git {sub} 的路径必须放在 -- 之后：{arg}")
        raise PolicyError(f"git {sub} 不允许位置参数：{arg}")

    for path in paths:
        _check_path(path)
    if rule.require_path and not paths:
        raise PolicyError(f"git {sub} 必须指定文件路径")

    final = list(argv)
    if sub == "diff":
        final[2:2] = DIFF_SAFETY_ARGS
    return final
