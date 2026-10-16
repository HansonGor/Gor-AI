"""白名单与参数校验。"""

import pytest

from policy import PolicyError, validate

ALLOWED = [
    ["git", "status"],
    ["git", "status", "--short"],
    ["git", "status", "-s", "-b"],
    ["git", "status", "--branch", "--porcelain", "--ignored"],
    ["git", "log", "--oneline", "-n5"],
    ["git", "log", "--oneline", "-3"],
    ["git", "log", "--max-count=3", "--stat", "--graph", "--all"],
    ["git", "log", "--format=%H %s"],
    ["git", "diff"],
    ["git", "diff", "--stat", "--name-only", "--name-status"],
    ["git", "diff", "--cached", "-U3"],
    ["git", "diff", "--staged", "--", "src/app.py", "README.md"],
    ["git", "show"],
    ["git", "show", "--oneline", "--stat", "--name-only", "--format=%an"],
    ["git", "branch"],
    ["git", "branch", "-a", "-v"],
    ["git", "branch", "-r", "--list"],
    ["git", "branch", "--show-current"],
    ["git", "rev-parse", "--show-toplevel"],
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    ["git", "rev-parse", "--is-inside-work-tree"],
    ["git", "ls-files"],
    ["git", "ls-files", "--cached", "--others", "--modified", "--stage"],
    ["git", "blame", "README.md"],
    ["git", "blame", "-L1,5", "--porcelain", "--", "src/a.py"],
    ["git", "blame", "-L10,+3", "src/a.py"],
]


@pytest.mark.parametrize("argv", ALLOWED)
def test_allowed_combinations_pass(argv):
    assert validate(argv)[:2] == argv[:2]


def test_diff_gets_safety_flags_before_paths():
    assert validate(["git", "diff", "--stat", "--", "a.txt"]) == \
        ["git", "diff", "--no-ext-diff", "--no-textconv", "--stat", "--", "a.txt"]


@pytest.mark.parametrize("sub", ["commit", "add", "checkout", "reset", "clean", "push", "pull", "fetch",
                                 "clone", "remote", "config", "stash", "rebase", "merge"])
def test_forbidden_subcommands(sub):
    with pytest.raises(PolicyError, match="子命令不在白名单内"):
        validate(["git", sub])


@pytest.mark.parametrize("argv", [
    ["git", "-c", "core.pager=sh", "status"],
    ["git", "-C", "/etc", "status"],
    ["git", "--git-dir=/tmp/x", "status"],
    ["git", "--git-dir", "/tmp/x", "status"],
    ["git", "--work-tree=/", "status"],
    ["git", "--exec-path=/tmp", "status"],
    ["git", "--namespace=x", "log"],
])
def test_global_options_rejected(argv):
    with pytest.raises(PolicyError, match="全局选项"):
        validate(argv)


@pytest.mark.parametrize("argv, rule", [
    (["git", "diff", "--output=/tmp/x"], "--output"),
    (["git", "log", "--output", "x"], "--output"),
    (["git", "diff", "-o", "x"], "-o"),
    (["git", "diff", "--ext-diff"], "--ext-diff"),
    (["git", "diff", "--textconv"], "--textconv"),
    (["git", "diff", "--no-index", "--", "a", "b"], "--no-index"),
    (["git", "log", "--exec=sh"], "--exec"),
    (["git", "status", "--upload-pack=x"], "--upload-pack"),
    (["git", "status", "--receive-pack=x"], "--receive-pack"),
    (["git", "log", "--open-files-in-pager"], "--open-files-in-pager"),
])
def test_dangerous_args_rejected(argv, rule):
    with pytest.raises(PolicyError, match=f"禁止使用参数：{rule}"):
        validate(argv)


@pytest.mark.parametrize("arg", ["a\nb", "--format=%H\n", "x\x00y", "a\rb"])
def test_newline_and_nul_rejected(arg):
    with pytest.raises(PolicyError, match="换行符或 NUL"):
        validate(["git", "log", arg])


@pytest.mark.parametrize("argv", [
    ["git", "branch", "new-branch"],
    ["git", "branch", "-a", "feature"],
    ["git", "branch", "-d", "main"],
    ["git", "branch", "-m", "old", "new"],
    ["git", "branch", "--delete", "x"],
])
def test_branch_cannot_create_delete_or_rename(argv):
    with pytest.raises(PolicyError):
        validate(argv)


@pytest.mark.parametrize("argv, message", [
    (["ls"], "argv\\[0\\] 必须是 git"),
    (["git"], "缺少 git 子命令"),
    ([], "非空字符串数组"),
    ("git status", "非空字符串数组"),
    (["git", "status", 1], "非空字符串数组"),
    (["git", "--version"], "不能是选项"),
    (["git", "status", "--untracked-files=all"], "不允许参数"),
    (["git", "log", "-n", "5"], "不允许参数"),
    (["git", "log", "HEAD~3..HEAD"], "不允许位置参数"),
    (["git", "diff", "src/a.py"], "必须放在 -- 之后"),
    (["git", "diff", "--", "/etc/passwd"], "绝对路径"),
    (["git", "diff", "--", "C:\\Windows"], "绝对路径"),
    (["git", "diff", "--", "../outside"], "\\.\\."),
    (["git", "diff", "--", ":(top)x"], "pathspec"),
    (["git", "status", "--", "a"], "不接受路径参数"),
    (["git", "rev-parse", "--git-path", "x"], "只允许"),
    (["git", "rev-parse", "main"], "只允许"),
    (["git", "blame"], "必须指定文件路径"),
    (["git", "blame", "-L:main", "a.py"], "不允许参数"),
    (["git", "show", "--graph"], "不允许参数"),
])
def test_other_violations_explain_rule(argv, message):
    with pytest.raises(PolicyError, match=message):
        validate(argv)
