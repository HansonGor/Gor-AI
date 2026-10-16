"""沙箱集成测试：需要 Docker 可用且已构建 gor-runner-git:latest，否则跳过。"""

from __future__ import annotations

import io
import os
import shutil
import subprocess
import tarfile
import time
from pathlib import Path

import pytest

import policy
import sandbox
from config import settings
from snapshot import filter_snapshot


def _docker_ready() -> bool:
    try:
        return sandbox.image_present(sandbox.get_client())
    except sandbox.DockerUnavailable:
        return False


DOCKER_READY = _docker_ready()
needs_docker = pytest.mark.skipif(not DOCKER_READY, reason="Docker 不可用或镜像 gor-runner-git:latest 未构建")


def test_container_options_include_required_isolation():
    opts = sandbox.container_options(["git", "status"])
    assert opts["image"] == "gor-runner-git:latest"
    assert opts["network_mode"] == "none" and opts["read_only"] is True
    assert opts["tmpfs"] == {"/tmp": "rw,size=64m"}
    assert [(m["Target"], m["Type"], m.get("Source")) for m in opts["mounts"]] == [("/work", "volume", None)]
    assert opts["user"] == "1000:1000" and opts["working_dir"] == "/work"
    assert (opts["mem_limit"], opts["nano_cpus"], opts["pids_limit"]) == ("512m", 1_000_000_000, 128)
    assert opts["cap_drop"] == ["ALL"] and opts["security_opt"] == ["no-new-privileges:true"]
    assert opts["environment"] == {"HOME": "/tmp", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                                   "GIT_TERMINAL_PROMPT": "0", "LANG": "C.UTF-8"}
    assert opts["labels"] == {"gor-runner": "1"}
    assert "volumes" not in opts and "privileged" not in opts


def test_docker_unavailable_returns_503(monkeypatch):
    """模拟 Docker 不可达：/health 与 /v1/runs 都返回 DOCKER_UNAVAILABLE，而不是未处理异常。"""
    from fastapi.testclient import TestClient
    import app as app_module

    def down():
        raise sandbox.DockerUnavailable("Docker 不可用，请确认 Docker Desktop 已启动")

    monkeypatch.setattr(sandbox, "get_client", down)
    monkeypatch.setattr(app_module, "sweep_forever", lambda: _noop())
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        info = tarfile.TarInfo("a.txt")
        tar.addfile(info, io.BytesIO(b""))
    with TestClient(app_module.app) as client:
        health = client.get("/health")
        assert health.status_code == 503 and health.json()["error"]["code"] == "DOCKER_UNAVAILABLE"
        run = client.post("/v1/runs", files={"snapshot": ("s.tar.gz", buf.getvalue(), "application/gzip")},
                          data={"language": "git", "argv": '["git","status"]'})
        assert run.status_code == 503 and run.json()["error"]["code"] == "DOCKER_UNAVAILABLE"


async def _noop():
    return None


# ---------------------------------------------------------------- 测试仓库

def _host_env(home: Path) -> dict:
    env = {k: v for k, v in os.environ.items() if k.upper() in {"PATH", "SYSTEMROOT", "TEMP", "TMP", "COMSPEC"}}
    env.update({"HOME": str(home), "USERPROFILE": str(home), "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0", "LANG": "C.UTF-8"})
    return env


def _git(repo: Path, env: dict, *args: str) -> str:
    done = subprocess.run(["git", *args], cwd=repo, env=env, capture_output=True, check=True)
    return done.stdout.decode("utf-8")


@pytest.fixture(scope="module")
def repo(tmp_path_factory):
    if shutil.which("git") is None:
        pytest.skip("宿主机没有 git")
    root = tmp_path_factory.mktemp("repo")
    home = tmp_path_factory.mktemp("home")
    env = _host_env(home)
    _git(root, env, "init", "-q", "-b", "main")
    for key, value in (("user.name", "Gor Test"), ("user.email", "test@example.invalid"),
                       ("core.autocrlf", "false"), ("core.filemode", "false")):
        _git(root, env, "config", key, value)
    for i in range(1, 5):
        (root / "notes.txt").write_bytes("".join(f"line {n}\n" for n in range(i * 3)).encode())
        (root / "src").mkdir(exist_ok=True)
        (root / "src" / f"m{i}.py").write_bytes(f"VALUE = {i}\n".encode())
        _git(root, env, "add", "-A")
        _git(root, env, "commit", "-q", "-m", f"commit {i}")
    (root / "notes.txt").write_bytes(b"line 0\nchanged\n")
    (root / "untracked.md").write_bytes(b"new\n")
    return root, env


def _snapshot_bytes(root: Path) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for path in sorted(root.rglob("*")):
            tar.add(path, arcname=path.relative_to(root).as_posix(), recursive=False)
    return buf.getvalue()


def _run(snapshot_bytes: bytes, argv: list[str], timeout: int = 30, validator=policy.validate):
    filtered = filter_snapshot(io.BytesIO(snapshot_bytes))
    try:
        return sandbox.run(filtered.tar_file, argv, timeout, validator, filtered.skipped)
    finally:
        filtered.close()


def _allow_sh_for_tests(argv: list[str]) -> list[str]:
    """仅测试使用的策略：允许 sh -c，用于验证隔离；不进入正式 policy.py。"""
    if argv[:2] == ["sh", "-c"] and len(argv) == 3 or argv[:1] == ["sleep"]:
        return argv
    raise policy.PolicyError("测试策略只允许 sh -c 与 sleep")


@pytest.fixture(scope="module", autouse=True)
def _no_leftover_containers():
    yield
    if DOCKER_READY:
        left = sandbox.get_client().containers.list(all=True, filters={"label": "gor-runner=1"})
        assert left == [], f"残留容器：{[c.short_id for c in left]}"


@needs_docker
@pytest.mark.parametrize("argv", [
    ["git", "status", "--short"],
    ["git", "log", "--oneline", "-3"],
    ["git", "diff"],
])
def test_git_output_matches_host(repo, argv):
    root, env = repo
    result = _run(_snapshot_bytes(root), argv)
    assert result.exit_code == 0, result.stderr
    assert not result.timed_out
    expected = _git(root, env, *policy.validate(argv)[1:])
    assert expected.strip(), "宿主机输出不应为空，否则对比没有意义"
    assert result.stdout == expected


@needs_docker
def test_network_is_isolated(repo):
    result = _run(_snapshot_bytes(repo[0]), ["sh", "-c", "wget -T 5 -O- http://example.com"],
                  validator=_allow_sh_for_tests)
    assert result.exit_code != 0
    assert not result.timed_out


@needs_docker
def test_root_filesystem_is_read_only(repo):
    result = _run(_snapshot_bytes(repo[0]), ["sh", "-c", "echo x > /etc/x"], validator=_allow_sh_for_tests)
    assert result.exit_code != 0
    assert "Read-only file system" in result.stderr or "Permission denied" in result.stderr


@needs_docker
def test_timeout_kills_and_removes_container(repo):
    client = sandbox.get_client()
    started = time.perf_counter()
    result = _run(_snapshot_bytes(repo[0]), ["sleep", "999"], timeout=3, validator=_allow_sh_for_tests)
    elapsed = time.perf_counter() - started
    assert result.timed_out is True and result.exit_code is None
    assert 3 <= elapsed <= 6, f"实际耗时 {elapsed:.2f}s"
    names = [c.name for c in client.containers.list(all=True, filters={"label": "gor-runner=1"})]
    assert f"gor-runner-{result.run_id[:12]}" not in names


@needs_docker
def test_api_runs_and_rejects_push(repo):
    from fastapi.testclient import TestClient
    from app import app

    data = _snapshot_bytes(repo[0])
    with TestClient(app) as client:
        health = client.get("/health").json()
        assert health["docker_reachable"] is True and health["image_present"] is True
        ok = client.post("/v1/runs", files={"snapshot": ("repo.tar.gz", data, "application/gzip")},
                         data={"language": "git", "argv": '["git","status","--short"]'})
        assert ok.status_code == 200, ok.text
        body = ok.json()
        assert body["exit_code"] == 0 and " M notes.txt" in body["stdout"]
        assert client.get(f"/v1/runs/{body['run_id']}").json()["exit_code"] == 0
        denied = client.post("/v1/runs", files={"snapshot": ("repo.tar.gz", data, "application/gzip")},
                             data={"language": "git", "argv": '["git","push"]'})
        assert denied.status_code == 403
        assert denied.json()["error"]["code"] == "COMMAND_NOT_ALLOWED"
        bad_lang = client.post("/v1/runs", files={"snapshot": ("repo.tar.gz", data, "application/gzip")},
                               data={"language": "python", "argv": '["git","status"]'})
        assert bad_lang.status_code == 400 and bad_lang.json()["error"]["code"] == "BAD_REQUEST"
