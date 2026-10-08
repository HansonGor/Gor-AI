"""Do not substitute one project kind for two independent deliverables."""

REACT_ENTRIES = {"/src/main.jsx", "/src/main.tsx", "/src/App.jsx", "/src/App.tsx"}
SCENE = "/src/scene.json"
WRITES = {"write_project_file", "create_project_file", "patch_project_file", "batch_patch_project_files"}


def project_kind_conflict(workspace, name: str, args: dict) -> dict | None:
    if workspace is None or (name not in WRITES and name != "set_3d_scene"):
        return None
    paths = {SCENE} if name == "set_3d_scene" else {
        "/" + str(patch.get("path", "")).lstrip("/")
        for patch in args.get("patches", []) if isinstance(patch, dict)
    } if name == "batch_patch_project_files" and isinstance(args.get("patches"), list) else {
        "/" + str(args.get("path", "")).lstrip("/")
    }
    existing = set(workspace.files)
    # Existing legacy mixed snapshots stay readable/editable. Reject only a
    # new cross-kind target, not every unrelated CSS patch in old data.
    new_scene_in_react = SCENE in paths and SCENE not in existing and bool(REACT_ENTRIES & existing)
    new_react_in_scene = SCENE in existing and bool((REACT_ENTRIES & paths) - existing)
    mixed_new_batch = SCENE in paths and bool(REACT_ENTRIES & paths) and SCENE not in existing
    if new_scene_in_react or new_react_in_scene or mixed_new_batch:
        return {"success": False, "code": "INDEPENDENT_PROJECT_CONTEXT_REQUIRED",
                "error": "React 网页与独立 GLB 模型需要不同项目上下文；当前不能同轮建立两个独立项目。"
                         "本次冲突操作未执行，已有源码保留，请分轮创建。"}
    return None
