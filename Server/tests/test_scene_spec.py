import unittest
import asyncio
import json

from pydantic import ValidationError

from tools.scene_spec import SceneSpec, apply_scene_command
from services.preview.workspace import PreviewProjectWorkspace
from tools.preview_project import execute_preview_tool


def object_spec(object_id="body", **overrides):
    return {
        "id": object_id,
        "name": "Body",
        "geometry": "box",
        "size": [3, 0.8, 1.4],
        "position": [0, 0.8, 0],
        "rotation": [0, 0, 0],
        "scale": [1, 1, 1],
        "color": "#d42b32",
        "metalness": 0.1,
        "roughness": 0.5,
        "copy_offsets": [],
        **overrides,
    }


class SceneSpecTests(unittest.TestCase):
    def test_create_scene_and_expand_compact_copies(self):
        result = apply_scene_command(None, {
            "action": "create",
            "name": "Car",
            "objects": [object_spec("wheel", geometry="cylinder", size=[0.35, 0.2, 0.35], copy_offsets=[[-1, 0, -0.6], [1, 0, -0.6], [-1, 0, 0.6], [1, 0, 0.6]])],
        })
        parsed = SceneSpec.model_validate(result)
        self.assertEqual(parsed.name, "Car")
        self.assertEqual(1 + len(parsed.objects[0].copy_offsets), 5)

    def test_patch_changes_only_selected_field(self):
        current = {"version": 1, "name": "Car", "objects": [object_spec()]}
        result = apply_scene_command(current, {
            "action": "patch",
            "operations": [{"op": "update", "id": "body", "values": {"color": "#3366ff"}}],
        })
        self.assertEqual(result["objects"][0]["color"], "#3366ff")
        self.assertEqual(result["objects"][0]["size"], [3.0, 0.8, 1.4])

    def test_rejects_duplicate_ids_and_unsafe_or_unknown_geometry(self):
        with self.assertRaises(ValidationError):
            SceneSpec(name="bad", objects=[object_spec(), object_spec()])
        with self.assertRaises(ValidationError):
            SceneSpec(name="bad", objects=[object_spec(geometry="script")])
        with self.assertRaises(ValidationError):
            SceneSpec(name="bad", objects=[object_spec(position=[float("nan"), 0, 0])])

    def test_invalid_patch_does_not_mutate_previous_snapshot(self):
        current = {"version": 1, "name": "Car", "objects": [object_spec()]}
        original_color = current["objects"][0]["color"]
        with self.assertRaises(ValueError):
            apply_scene_command(current, {
                "action": "patch",
                "operations": [{"op": "update", "id": "body", "values": {"executable": "alert(1)"}}],
            })
        self.assertEqual(current["objects"][0]["color"], original_color)

    def test_scene_tool_stores_compact_spec_in_virtual_project_for_snapshotting(self):
        workspace = PreviewProjectWorkspace("preview-test", "react", {"/index.html": "<div />"})
        result = asyncio.run(execute_preview_tool(workspace, "set_3d_scene", {
            "action": "create",
            "name": "Car",
            "objects": [object_spec()],
        }))
        parsed = json.loads(result)
        self.assertTrue(parsed["success"])
        self.assertEqual(parsed["sceneSpec"]["name"], "Car")
        self.assertEqual(json.loads(workspace.files["/src/scene.json"])["name"], "Car")


if __name__ == "__main__":
    unittest.main()
