"""Persistent change journal and host-neutral undo orchestration (not UI state)."""
import copy
import hashlib
import uuid
from contextvars import ContextVar
from dataclasses import asdict
from datetime import datetime, timezone

from project_api.types import ProjectAPIError, ProjectRef


current_recorder = ContextVar("project_change_recorder", default=None)


def snapshot(content, version=None, **extra):
    return {"content": content, "hash": hashlib.sha256(content.encode("utf-8")).hexdigest()
            if content is not None else None, "version": version, **extra}


def conflict(current, expected):
    if current.get("dirty"):
        return "FILE_HAS_UNSAVED_CHANGES"
    if current.get("hash") != expected.get("hash"):
        return "HASH_CONFLICT"
    if expected.get("identity") and current.get("identity") != expected["identity"]:
        return "WORKSPACE_ROOT_CONFLICT"
    if expected.get("version") is not None and current.get("version") != expected["version"]:
        return "VERSION_CONFLICT"
    return None


class ChangeRecorder:
    def __init__(self, store, session_id, round_id=None, edit_mode="auto"):
        self.store, self.session_id = store, session_id
        self.round_id = round_id or str(uuid.uuid4())
        self.sets = {}
        self.edit_mode = edit_mode

    async def record(self, ref, before, after, statuses=None):
        key = (ref.provider, ref.project_id, ref.root)
        item = self.sets.setdefault(key, {"id": str(uuid.uuid4()), "sessionId": self.session_id,
            "roundId": self.round_id, "projectRef": asdict(ref), "files": [], "sealed": False,
            "createdAt": datetime.now(timezone.utc).isoformat(), "editMode": self.edit_mode})
        item["updatedAt"] = datetime.now(timezone.utc).isoformat()
        for path in before.keys() | after.keys():
            first, last = before[path], after[path]
            if first == last and not statuses:
                continue
            file = next((f for f in item["files"] if f["path"] == path), None)
            if file is None:
                file = {"id": str(uuid.uuid4()), "path": path, "before": copy.deepcopy(first)}
                item["files"].append(file)
            file["after"] = copy.deepcopy(last)
            file["operation"] = "create" if file["before"]["content"] is None else (
                "delete" if last["content"] is None else "modify")
            file["status"] = (statuses or {}).get(path, "applied")
            if file["status"] == "applied" and file["before"]["content"] == last["content"]:
                file["status"] = "unchanged"
        if item["files"]:
            await self.store.put(item)
        return item

    async def seal(self):
        for item in self.sets.values():
            if item["sealed"]:
                continue
            item["sealed"] = True
            if item["files"]:
                try:
                    await self.store.put(item)
                except BaseException:
                    item["sealed"] = False
                    raise


class UndoService:
    def __init__(self, store, provider_factory):
        self.store, self.provider_factory = store, provider_factory

    async def getChangeSet(self, id):
        item = await self.store.get(id)
        if item is None:
            raise ProjectAPIError("CHANGE_SET_NOT_FOUND", "变更记录不存在。")
        return item

    async def undoFile(self, changeSetId, fileId):
        return await self._undo(changeSetId, fileId)

    async def undoChangeSet(self, changeSetId):
        return await self._undo(changeSetId, None)

    async def _undo(self, id, file_id):
        async with self.store.lock(id):
            item = await self.getChangeSet(id)
            if not item.get("sealed"):
                raise ProjectAPIError("CHANGE_SET_BUSY", "本轮修改尚未结束，不能撤销。")
            if file_id and not any(f["id"] == file_id for f in item["files"]):
                raise ProjectAPIError("CHANGE_FILE_NOT_FOUND", "文件不属于此变更记录。")
            chosen = [f for f in item["files"] if (not file_id or f["id"] == file_id)]
            if any(f["status"] in {"undoing", "applying"} for f in chosen):
                raise ProjectAPIError("UNDO_OUTCOME_UNKNOWN", "上次撤销中断，需核对文件后处理；未重复执行。")
            targets = [f for f in chosen if f["status"] == "applied"]
            if not targets:
                failed = [f for f in chosen if f["status"] in {"failed", "undo_failed"}]
                if failed:
                    return {"success": False, "changeSetId": id, "unchanged": True,
                        "results": [{"fileId": f["id"], "path": f["path"], "success": False,
                                     "code": "FILE_REQUIRES_REVIEW"} for f in failed]}
                return {"success": True, "changeSetId": id, "results": [], "unchanged": True}
            ref = ProjectRef(**item["projectRef"])
            provider = await self.provider_factory(ref, item)
            current = await provider.inspect_files(ref, [f["path"] for f in targets])
            execution = [{**f, "after": {**f["after"],
                "version": f.get("undoExpectedVersion", f["after"]["version"])}} for f in targets]
            errors = {f["id"]: conflict(current[f["path"]], f["after"]) for f in execution}
            if any(errors.values()):
                return {"success": False, "code": "UNDO_CONFLICT", "changeSetId": id,
                    "results": [{"fileId": f["id"], "path": f["path"], "success": False,
                                 "code": errors[f["id"]] or "BATCH_BLOCKED"} for f in targets]}
            # Durable intent before remote IO. Crash/timeout is fail-closed, not retried blindly.
            for f in targets:
                f["status"] = "undoing"
            await self.store.put(item)
            try:
                results = await provider.restore_files(ref, execution)
            except Exception as exc:
                if getattr(exc, "code", None) in {"VERSION_CONFLICT", "FILE_HAS_UNSAVED_CHANGES", "HASH_CONFLICT"}:
                    for f in targets:
                        f["status"] = "applied"
                    await self.store.put(item)
                return {"success": False, "code": "UNDO_OUTCOME_UNKNOWN", "changeSetId": id,
                        "results": [{"fileId": f["id"], "path": f["path"], "success": False,
                                     "code": getattr(exc, "code", "UNDO_OUTCOME_UNKNOWN")} for f in targets]}
            by_id = {r["fileId"]: r for r in results}
            for f in targets:
                result = by_id.get(f["id"])
                if result is None:
                    continue
                f["undoResult"] = result
                f["undoAt"] = datetime.now(timezone.utc).isoformat()
                f["status"] = "reverted" if result["success"] else (
                    "undo_failed" if result.get("changed") else "applied")
            # Preview versions are project-wide: our own undo revision must not
            # invalidate untouched targets, but external revisions still must.
            version = getattr(provider, "undo_version", None)
            if version is not None:
                for f in item["files"]:
                    if f["status"] == "applied":
                        f["undoExpectedVersion"] = version
                    if f["status"] == "pending":
                        f["applyExpectedVersion"] = version
            try:
                await self.store.put(item)
            except Exception:
                # File IO may already be saved. Return those results truthfully,
                # while durable undoing blocks a blind replay after DB recovery.
                return {"success": False, "code": "CHANGE_SET_SAVE_FAILED", "changeSetId": id,
                        "results": results, "journalSaved": False, **getattr(provider, "sync_result", {})}
            return {"success": all(r.get("success") for r in results) and len(results) == len(targets),
                    "changeSetId": id, "results": results,
                    **getattr(provider, "sync_result", {})}
