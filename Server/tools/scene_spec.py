"""Validated, compact SceneSpec commands for parameterized 3D scenes."""

from typing import Any, Literal
import math

from langchain_core.tools import tool
from pydantic import BaseModel, ConfigDict, Field, model_validator


Vector3 = tuple[float, float, float]


class SceneObject(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=48, pattern=r"^[A-Za-z0-9_-]+$")
    name: str = Field(min_length=1, max_length=80)
    geometry: Literal["box", "sphere", "cylinder", "cone", "torus", "plane"]
    size: Vector3 = (1.0, 1.0, 1.0)
    position: Vector3 = (0.0, 0.0, 0.0)
    rotation: Vector3 = (0.0, 0.0, 0.0)
    scale: Vector3 = (1.0, 1.0, 1.0)
    color: str = Field(default="#7c6cf2", pattern=r"^#[0-9a-fA-F]{6}$")
    metalness: float = Field(default=0.0, ge=0.0, le=1.0)
    roughness: float = Field(default=0.7, ge=0.0, le=1.0)
    copy_offsets: list[Vector3] = Field(default_factory=list, max_length=12)

    @model_validator(mode="after")
    def validate_dimensions(self):
        for vector in (self.size, self.position, self.rotation, self.scale, *self.copy_offsets):
            if any(not math.isfinite(value) or abs(value) > 100 for value in vector):
                raise ValueError("SceneSpec 坐标或尺寸超过安全范围。")
        if any(value <= 0 for value in self.size) or any(value <= 0 for value in self.scale):
            raise ValueError("几何体尺寸和缩放必须为正数。")
        if self.geometry == "sphere" and not (self.size[0] == self.size[1] == self.size[2]):
            raise ValueError("sphere 的 size 三轴必须相等。")
        return self


class SceneSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal[1] = 1
    name: str = Field(min_length=1, max_length=80)
    objects: list[SceneObject] = Field(min_length=1, max_length=80)

    @model_validator(mode="after")
    def unique_object_ids(self):
        ids = [item.id for item in self.objects]
        if len(ids) != len(set(ids)):
            raise ValueError("SceneSpec 对象 id 必须唯一。")
        if sum(1 + len(item.copy_offsets) for item in self.objects) > 100:
            raise ValueError("SceneSpec 展开后的对象数量最多为 100。")
        return self


class SceneOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    op: Literal["add", "update", "remove"]
    id: str | None = Field(default=None, min_length=1, max_length=48)
    object: SceneObject | None = None
    values: dict[str, Any] | None = None

    @model_validator(mode="after")
    def validate_operation(self):
        if self.op == "add" and (self.object is None or self.id is not None or self.values is not None):
            raise ValueError("add 操作必须只提供 object。")
        if self.op == "remove" and (not self.id or self.object is not None or self.values is not None):
            raise ValueError("remove 操作必须只提供 id。")
        if self.op == "update" and (not self.id or not self.values or self.object is not None):
            raise ValueError("update 操作必须提供 id 和 values。")
        return self


class SceneCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["create", "patch"]
    name: str | None = Field(default=None, max_length=80)
    objects: list[SceneObject] | None = Field(default=None, max_length=80)
    operations: list[SceneOperation] | None = Field(default=None, max_length=40)

    @model_validator(mode="after")
    def validate_action(self):
        if self.action == "create" and (not self.objects or self.operations is not None):
            raise ValueError("create 必须提供 objects，且不能提供 operations。")
        if self.action == "patch" and (not self.operations or self.objects is not None):
            raise ValueError("patch 必须提供 operations，且不能提供 objects。")
        return self


@tool(args_schema=SceneCommand)
def set_3d_scene(
    action: Literal["create", "patch"],
    name: str | None = None,
    objects: list[dict] | None = None,
    operations: list[dict] | None = None,
) -> str:
    """Create a compact SceneSpec or apply small edits to the current 3D scene."""
    return '{"success":false,"error":"SceneSpec 上下文不可用。"}'


def apply_scene_command(current: dict | None, raw_command: dict) -> dict:
    command = SceneCommand.model_validate(raw_command)
    if command.action == "create":
        spec = SceneSpec(name=command.name or "3D Scene", objects=command.objects or [])
        return spec.model_dump(mode="json")

    if current is None:
        raise ValueError("当前会话没有可修改的 3D 场景，请先创建场景。")
    spec = SceneSpec.model_validate(current)
    objects = [item.model_dump(mode="json") for item in spec.objects]
    for operation in command.operations or []:
        if operation.op == "add":
            if any(item["id"] == operation.object.id for item in objects):
                raise ValueError(f"对象 id 已存在：{operation.object.id}")
            objects.append(operation.object.model_dump(mode="json"))
        elif operation.op == "remove":
            before = len(objects)
            objects = [item for item in objects if item["id"] != operation.id]
            if before == len(objects):
                raise ValueError(f"找不到要删除的对象：{operation.id}")
        else:
            allowed = set(SceneObject.model_fields) - {"id"}
            values = operation.values or {}
            if not values or set(values) - allowed:
                raise ValueError("update 仅支持修改对象名称、几何尺寸、变换和材质字段。")
            index = next((i for i, item in enumerate(objects) if item["id"] == operation.id), None)
            if index is None:
                raise ValueError(f"找不到要修改的对象：{operation.id}")
            objects[index] = SceneObject.model_validate({**objects[index], **values}).model_dump(mode="json")
    result = SceneSpec(name=command.name or spec.name, objects=objects)
    return result.model_dump(mode="json")
