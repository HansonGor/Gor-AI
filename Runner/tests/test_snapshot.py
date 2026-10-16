"""快照检查与过滤（纯内存构造 tar.gz，不依赖 Docker）。"""

import io
import tarfile

import pytest

from snapshot import SnapshotRejected, SnapshotTooLarge, filter_snapshot


def make_tgz(entries) -> io.BytesIO:
    """entries: (name, kind, payload) ；kind=file/dir/sym/lnk/chr/fifo。"""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name, kind, payload in entries:
            info = tarfile.TarInfo(name)
            data = b""
            if kind == "file":
                data = payload if isinstance(payload, bytes) else str(payload).encode()
                info.size = len(data)
            elif kind == "dir":
                info.type = tarfile.DIRTYPE
            elif kind == "sym":
                info.type, info.linkname = tarfile.SYMTYPE, payload
            elif kind == "lnk":
                info.type, info.linkname = tarfile.LNKTYPE, payload
            elif kind == "chr":
                info.type = tarfile.CHRTYPE
            elif kind == "fifo":
                info.type = tarfile.FIFOTYPE
            tar.addfile(info, io.BytesIO(data) if kind == "file" else None)
    buf.seek(0)
    return buf


def names_of(filtered) -> list[str]:
    with tarfile.open(fileobj=filtered.tar_file, mode="r:") as tar:
        return tar.getnames()


@pytest.mark.parametrize("entries, message", [
    ([("/etc/passwd", "file", "x")], "绝对路径"),
    ([("C:/Windows/x", "file", "x")], "绝对路径"),
    ([("a/../../escape", "file", "x")], "\\.\\."),
    ([("../escape", "file", "x")], "\\.\\."),
    ([("a\\b", "file", "x")], "反斜杠"),
    ([("link", "sym", "/etc/passwd")], "符号链接"),
    ([("a.txt", "file", "x"), ("hard", "lnk", "a.txt")], "硬链接"),
    ([("dev", "chr", None)], "设备"),
    ([("pipe", "fifo", None)], "设备"),
])
def test_unsafe_members_rejected(entries, message):
    with pytest.raises(SnapshotRejected, match=message):
        filter_snapshot(make_tgz(entries))


def test_not_gzip_rejected():
    with pytest.raises(SnapshotRejected, match="gzip"):
        filter_snapshot(io.BytesIO(b"PK\x03\x04 not a tar"))


def test_corrupt_gzip_rejected():
    with pytest.raises(SnapshotRejected, match="无法解析"):
        filter_snapshot(io.BytesIO(b"\x1f\x8b\x08\x00garbage"))


def test_uncompressed_size_limit():
    entries = [("a.bin", "file", b"0" * 600), ("b.bin", "file", b"0" * 600)]
    with pytest.raises(SnapshotTooLarge, match="大小超过上限"):
        filter_snapshot(make_tgz(entries), max_uncompressed=1000)


def test_member_count_limit():
    entries = [(f"f{i}.txt", "file", "x") for i in range(6)]
    with pytest.raises(SnapshotTooLarge, match="成员数量超过上限 5"):
        filter_snapshot(make_tgz(entries), max_members=5)


def test_sensitive_and_generated_paths_are_dropped_and_reported():
    entries = [
        ("README.md", "file", "hi"),
        ("src/app.py", "file", "print(1)"),
        (".env", "file", "TOKEN=x"),
        ("config/.env.local", "file", "TOKEN=y"),
        ("node_modules/pkg/index.js", "file", "x"),
        ("node_modules/pkg/package.json", "file", "{}"),
        ("web/dist/app.js", "file", "x"),
        ("certs/server.pem", "file", "x"),
        ("keys/id_rsa.pub", "file", "x"),
        ("my_secret_notes.txt", "file", "x"),
        ("aws_credentials.json", "file", "x"),
        ("app/__pycache__/a.pyc", "file", "x"),
        (".git/HEAD", "file", "ref: refs/heads/main\n"),
        (".git/refs/heads/build", "file", "0" * 40),
    ]
    filtered = filter_snapshot(make_tgz(entries))
    assert filtered.skipped == [
        ".env", "config/.env.local", "node_modules/", "web/dist/", "certs/server.pem", "keys/id_rsa.pub",
        "my_secret_notes.txt", "aws_credentials.json", "app/__pycache__/",
    ]
    names = names_of(filtered)
    assert "README.md" in names and "src/app.py" in names and ".git/HEAD" in names
    # .git 内部按名称不过滤（分支名 build 不应被当成构建目录丢弃）
    assert ".git/refs/heads/build" in names
    for dropped in (".env", "config/.env.local", "node_modules/pkg/index.js", "web/dist/app.js",
                    "certs/server.pem", "keys/id_rsa.pub", "my_secret_notes.txt", "aws_credentials.json"):
        assert dropped not in names


def test_rebuilt_tar_owned_by_container_user_with_parent_dirs():
    filtered = filter_snapshot(make_tgz([("./a/b/c.txt", "file", "x")]))
    with tarfile.open(fileobj=filtered.tar_file, mode="r:") as tar:
        members = {m.name: m for m in tar.getmembers()}
    assert set(members) == {"a", "a/b", "a/b/c.txt"}
    assert all(m.uid == 1000 and m.gid == 1000 for m in members.values())
    assert members["a"].isdir() and members["a/b/c.txt"].isfile()
    assert not members["a/b/c.txt"].mode & 0o7000
