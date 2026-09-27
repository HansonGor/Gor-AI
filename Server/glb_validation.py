"""Strict structural validation for self-contained binary glTF (GLB) files."""

import json
import struct
from typing import BinaryIO


class GlbValidationError(ValueError):
    pass


def validate_glb_stream(stream: BinaryIO, file_size: int) -> None:
    """Validate GLB v2 chunk layout and reject external resource references."""
    if file_size < 20:
        raise GlbValidationError("GLB 文件过短。")
    stream.seek(0)
    header = stream.read(12)
    if len(header) != 12 or header[:4] != b"glTF":
        raise GlbValidationError("GLB 文件头无效。")
    version, declared_size = struct.unpack_from("<II", header, 4)
    if version != 2:
        raise GlbValidationError("GLB 版本不受支持。")
    if declared_size != file_size:
        raise GlbValidationError("GLB 文件长度与文件头不一致。")

    stream.seek(12)
    chunk_header = stream.read(8)
    if len(chunk_header) != 8:
        raise GlbValidationError("GLB 缺少 JSON 场景数据。")
    json_length, json_type = struct.unpack("<II", chunk_header)
    if json_type != 0x4E4F534A or json_length > 2 * 1024 * 1024 or 20 + json_length > file_size:
        raise GlbValidationError("GLB JSON 场景块无效。")
    try:
        gltf_json = json.loads(stream.read(json_length).decode("utf-8").rstrip(" \t\r\n\x00"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise GlbValidationError("GLB JSON 场景数据无法解析。") from exc
    if not isinstance(gltf_json, dict) or not isinstance(gltf_json.get("asset"), dict) or gltf_json["asset"].get("version") != "2.0":
        raise GlbValidationError("GLB 场景版本无效。")

    buffers = gltf_json.get("buffers", [])
    images = gltf_json.get("images", [])
    if not isinstance(buffers, list) or not isinstance(images, list) or any(not isinstance(entry, dict) for entry in [*buffers, *images]):
        raise GlbValidationError("GLB 资源清单无效。")
    if any("uri" in entry for entry in [*buffers, *images]):
        raise GlbValidationError("GLB 不允许引用外部文件或网络资源。")

    next_chunk_offset = 12 + 8 + json_length
    if next_chunk_offset == file_size:
        return
    if next_chunk_offset + 8 > file_size:
        raise GlbValidationError("GLB 二进制数据块不完整。")
    stream.seek(next_chunk_offset)
    binary_header = stream.read(8)
    binary_length, binary_type = struct.unpack("<II", binary_header)
    if binary_type != 0x004E4942 or next_chunk_offset + 8 + binary_length != file_size:
        raise GlbValidationError("GLB 二进制数据块长度无效。")
