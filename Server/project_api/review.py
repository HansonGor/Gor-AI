"""Request-local candidate editing; never sends mutation RPCs to a workspace."""
import copy
import difflib
from project_api.changes import snapshot, conflict
from project_api.types import ProjectAPIError


def diff(path, before, after):
    return "".join(difflib.unified_diff((before or "").splitlines(keepends=True),
        (after or "").splitlines(keepends=True), fromfile="a" + path, tofile="b" + path))


async def stage_vscode(provider, ref, method, params, recorder):
    """Reuse native snapshot/path validation and retain the first real baseline."""
    if method in {"project.createDirectory", "project.deleteDirectory"}:
        raise ProjectAPIError("UNSUPPORTED_OPERATION", "当前项目 Provider 不支持此操作。")
    patches = params.get("patches", [params])
    if any(p.get("root", ref.root) != ref.root for p in patches):
        raise ProjectAPIError("UNSUPPORTED_OPERATION", "当前项目 Provider 不支持此操作。")
    paths = list(dict.fromkeys(p.get("path") for p in patches))
    actual = await provider.inspect_files(ref, paths)
    prior = recorder.sets.get((ref.provider, ref.project_id, ref.root), {})
    records = {f["path"]: f for f in prior.get("files", [])}
    before, after = {}, {}
    # Inspect validates raw paths at the native boundary; normalized keys are authoritative.
    normalized = {path: "/" + path.lstrip("/") for path in paths}
    for raw in paths:
        path = normalized[raw]
        baseline = actual[path]
        previous = records.get(path)
        expected = previous["before"] if previous else baseline
        error = conflict(baseline, expected)
        if error:
            raise ProjectAPIError(error, "文件在本轮修改之间发生变化，请重新发起请求。")
        before[path] = copy.deepcopy(previous["after"] if previous else baseline)
        after[path] = copy.deepcopy(before[path])
    ranges = {}
    for patch in patches:
        path = normalized[patch["path"]]
        source = before[path]["content"]
        version = patch.get("expectedFileVersion", params.get("expectedFileVersion"))
        if version is not None and version != actual[path]["version"]:
            raise ProjectAPIError("VERSION_CONFLICT", "文件版本已变化。")
        if method == "project.createFile":
            if source is not None:
                raise ProjectAPIError("FILE_ALREADY_EXISTS", "文件已存在。")
            text = params.get("content", "")
        elif method == "project.deleteFile":
            if source is None:
                raise ProjectAPIError("FILE_NOT_FOUND", "文件不存在。")
            text = None
        elif method == "project.writeFile":
            if source is None:
                raise ProjectAPIError("FILE_NOT_FOUND", "文件不存在。")
            text = params.get("content", "")
        else:
            old, new = patch.get("oldText"), patch.get("newText")
            if source is None:
                raise ProjectAPIError("FILE_NOT_FOUND", "文件不存在。")
            if not isinstance(old, str) or not old or not isinstance(new, str):
                raise ProjectAPIError("PATCH_INVALID", "补丁参数无效。")
            if source.count(old) != 1:
                raise ProjectAPIError("PATCH_TARGET_NOT_FOUND" if not source.count(old) else "PATCH_TARGET_NOT_UNIQUE", "补丁目标无法唯一定位。")
            start = source.index(old)
            end = start + len(old)
            if any(start < b and end > a for a, b, _ in ranges.get(path, [])):
                raise ProjectAPIError("PATCH_OVERLAP_CONFLICT", "补丁范围重叠。")
            ranges.setdefault(path, []).append((start, end, new))
            continue
        if text is not None and (not isinstance(text, str) or "\x00" in text):
            raise ProjectAPIError("PATCH_INVALID", "文件内容无效。")
        after[path] = snapshot(text, actual[path]["version"], identity=actual[path].get("identity"), dirty=False)
    for path, edits in ranges.items():
        text = before[path]["content"]
        for start, end, new in sorted(edits, reverse=True):
            text = text[:start] + new + text[end:]
        after[path] = snapshot(text, actual[path]["version"], identity=actual[path].get("identity"), dirty=False)
    if sum(len((state["content"] or "").encode("utf-8")) for state in after.values()) > 2_000_000:
        raise ProjectAPIError("FILE_TOO_LARGE", "变更快照超过 2 MB 安全预算，未执行操作。")
    item = await recorder.record(ref, before, after, {p: "pending" for p in before})
    # A staged net no-op is not an actionable pending change.
    for file in item["files"]:
        if file["before"]["content"] == file["after"]["content"]:
            file["status"] = "unchanged"
    await recorder.store.put(item)
    changed = [{"path": path, "diff": diff(path, records.get(path, {}).get("before", before[path])["content"], after[path]["content"])}
               for path in before if before[path]["content"] != after[path]["content"]]
    result = {"success": True, "pending": True, "applied": False, "changedFiles": changed,
              "changed": bool(changed), "created": method == "project.createFile" and bool(changed),
              "deleted": method == "project.deleteFile" and bool(changed),
              "fileVersions": {p: actual[p]["version"] for p in before}}
    if len(before) == 1:
        path = next(iter(before))
        result.update(path=path, diff=changed[0]["diff"] if changed else "", fileVersion=actual[path]["version"])
    return result


def candidate_files(recorder, ref):
    return {f["path"]: f["after"] for f in recorder.sets.get(
        (ref.provider, ref.project_id, ref.root), {}).get("files", [])}


class ApplyService:
    """Confirm pending candidates through the same provider restore boundary as undo."""
    def __init__(self, store, provider_factory):
        self.store, self.provider_factory = store, provider_factory

    async def applyFile(self, id, file_id):
        return await self._apply(id, file_id)

    async def applyChangeSet(self, id):
        return await self._apply(id, None)

    async def _apply(self, id, file_id):
        from project_api.types import ProjectRef
        async with self.store.lock(id):
            item = await self.store.get(id)
            if not item:
                raise ProjectAPIError("CHANGE_SET_NOT_FOUND", "变更记录不存在。")
            if not item.get("sealed"):
                raise ProjectAPIError("CHANGE_SET_BUSY", "本轮修改尚未结束，不能撤销。")
            chosen = [f for f in item["files"] if not file_id or f["id"] == file_id]
            if file_id and not chosen:
                raise ProjectAPIError("CHANGE_FILE_NOT_FOUND", "文件不属于此变更记录。")
            if any(f["status"] in {"applying", "undoing", "failed"} for f in chosen):
                raise ProjectAPIError("UNDO_OUTCOME_UNKNOWN", "文件变更请求失败。")
            targets = [f for f in chosen if f["status"] == "pending"]
            if not targets:
                return {"success": True, "changeSetId": id, "results": [], "unchanged": True}
            ref = ProjectRef(**item["projectRef"])
            provider = await self.provider_factory(ref, item)
            current = await provider.inspect_files(ref, [f["path"] for f in targets])
            expected = {f["id"]: {**f["before"], "version": f.get("applyExpectedVersion", f["before"]["version"])} for f in targets}
            errors = {f["id"]: conflict(current[f["path"]], expected[f["id"]]) for f in targets}
            if any(errors.values()):
                return {"success": False, "code": "VERSION_CONFLICT", "changeSetId": id,
                    "results": [{"fileId": f["id"], "path": f["path"], "success": False,
                                 "code": errors[f["id"]] or "BATCH_BLOCKED"} for f in targets]}
            execution = [{**f, "before": f["after"], "after": expected[f["id"]]} for f in targets]
            for file in targets:
                file["status"] = "applying"
            await self.store.put(item)
            try:
                results = await provider.restore_files(ref, execution)
            except Exception as error:
                if getattr(error, "code", None) in {"VERSION_CONFLICT", "HASH_CONFLICT", "FILE_HAS_UNSAVED_CHANGES"}:
                    for file in targets:
                        file["status"] = "pending"
                    await self.store.put(item)
                return {"success": False, "code": "UNDO_OUTCOME_UNKNOWN", "changeSetId": id,
                    "results": [{"fileId": f["id"], "path": f["path"], "success": False,
                                 "code": getattr(error, "code", "UNDO_OUTCOME_UNKNOWN")} for f in targets]}
            try:
                states = await provider.inspect_files(ref, [f["path"] for f in targets])
            except Exception:
                # Keep durable applying intent when a saved outcome cannot be re-inspected.
                # Preserve native per-file receipts without claiming journal confirmation.
                return {"success": False, "code": "UNDO_OUTCOME_UNKNOWN", "changeSetId": id,
                        "results": results, "journalSaved": False, **getattr(provider, "sync_result", {})}
            by_id = {r["fileId"]: r for r in results}
            for file in targets:
                result = by_id.get(file["id"])
                if not result:
                    continue
                state = states[file["path"]]
                if result.get("success") and (state.get("dirty") or state["hash"] != file["after"]["hash"]):
                    result.update(success=False, changed=True, code="RESTORE_CONTENT_MISMATCH")
                file["applyResult"] = result
                file["status"] = "applied" if result.get("success") else ("failed" if result.get("changed") else "pending")
                if result.get("success"):
                    file["after"] = state
            version = getattr(provider, "undo_version", None)
            if version is not None:
                for file in item["files"]:
                    if file["status"] == "applied": file["undoExpectedVersion"] = version
                    if file["status"] == "pending": file["applyExpectedVersion"] = version
            try:
                await self.store.put(item)
            except Exception:
                return {"success": False, "code": "CHANGE_SET_SAVE_FAILED", "changeSetId": id,
                        "results": results, "journalSaved": False, **getattr(provider, "sync_result", {})}
            return {"success": all(r.get("success") for r in results) and len(results) == len(targets),
                    "changeSetId": id, "results": results, **getattr(provider, "sync_result", {})}
