import io
import json
import struct
import unittest

from glb_validation import GlbValidationError, validate_glb_stream


def glb_bytes(document: dict, binary: bytes = b"") -> bytes:
    encoded = json.dumps(document, separators=(",", ":")).encode("utf-8")
    encoded += b" " * (-len(encoded) % 4)
    chunks = struct.pack("<II", len(encoded), 0x4E4F534A) + encoded
    if binary:
        binary += b"\x00" * (-len(binary) % 4)
        chunks += struct.pack("<II", len(binary), 0x004E4942) + binary
    size = 12 + len(chunks)
    return b"glTF" + struct.pack("<II", 2, size) + chunks


class GlbValidationTests(unittest.TestCase):
    def test_accepts_exporter_style_glb_with_json_and_binary_chunks(self):
        data = glb_bytes(
            {"asset": {"version": "2.0"}, "buffers": [{"byteLength": 4}]},
            b"mesh",
        )
        validate_glb_stream(io.BytesIO(data), len(data))

    def test_json_chunk_is_read_after_the_12_byte_glb_header(self):
        data = glb_bytes({"asset": {"version": "2.0"}})
        self.assertEqual(data[12 + 4:12 + 8], b"JSON")
        validate_glb_stream(io.BytesIO(data), len(data))

    def test_rejects_external_resources_and_invalid_json(self):
        external = glb_bytes({"asset": {"version": "2.0"}, "images": [{"uri": "https://example.test/image.png"}]})
        with self.assertRaisesRegex(GlbValidationError, "外部文件或网络资源"):
            validate_glb_stream(io.BytesIO(external), len(external))

        malformed = bytearray(glb_bytes({"asset": {"version": "2.0"}}))
        malformed[16:20] = b"nope"
        with self.assertRaises(GlbValidationError):
            validate_glb_stream(io.BytesIO(malformed), len(malformed))


if __name__ == "__main__":
    unittest.main()
