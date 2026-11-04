"""Synthetic fixtures for the read-only PS5 round-trip diagnostic."""

import hashlib
import json
import struct
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from poc.dt_roundtrip_diff import compare_entries, diff_files


def write_entry(folder, image, timestamp):
    folder.mkdir()
    image_path = folder / "sdimg_SAVEDATA00"
    image_path.write_bytes(image)
    header = bytearray(1304)
    struct.pack_into("<II", header, 0, 0x35504647, 77)
    struct.pack_into("<Q", header, 0xC0, timestamp)
    struct.pack_into("<Q", header, 0xE0, timestamp)
    struct.pack_into("<Q", header, 240, len(image))
    header[276:286] = b"/test/save"
    final = bytearray(1304)
    struct.pack_into("<II", final, 0, 0x35504647, 77)
    final[274] = 1
    files = [{"file": image_path.name, "path": "/test/save",
              "size": len(image), "sha256": hashlib.sha256(image).hexdigest(),
              "header": header.hex()}]
    (folder / "manifest.json").write_text(json.dumps({
        "entry_id": 77, "files": files,
        "77": {"files": files, "final_header": final.hex()},
    }), encoding="utf-8")


class RoundtripDiffTests(unittest.TestCase):
    def test_classifies_ps5_wrapper_changes_without_altering_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = bytearray(0x22000)
            struct.pack_into("<QQ", original, 0, 2, 0x1332A0B)
            struct.pack_into("<I", original, 0x20, 0x10000)
            struct.pack_into("<Q", original, 0x40, 1)
            original[0x800:0x860] = bytes(range(0x60))
            later = original.copy()
            for offset in (0xB8, 0x380, 0xFFA0, 0x11390, 0x11920):
                later[offset] = 1
            write_entry(root / "before", original, 1700000000)
            write_entry(root / "after", later, 1700000001)
            before_zip, after_zip = root / "before.zip", root / "after.zip"
            for path in (before_zip, after_zip):
                with zipfile.ZipFile(path, "w") as archive:
                    archive.writestr("persistent", b"unchanged progress")

            result = compare_entries(root / "before", root / "after",
                                     before_zip, after_zip)
            image = result["files"]["sdimg_SAVEDATA00"]
            self.assertEqual(image["changed_bytes"], 5)
            self.assertEqual(image["changed_ranges"],
                             [[offset, offset + 1] for offset in
                              (0xB8, 0x380, 0xFFA0, 0x11390, 0x11920)])
            self.assertEqual([item["region"] for item in image["regions"]], [
                "super-root digest candidate (PS4 layout)", "PFS header hash",
                "save-auth IV", "inode-table region (layout inferred)",
                "inode-table region (layout inferred)",
            ])
            self.assertTrue(image["sealed_key_equal"])
            self.assertEqual(image["manifest_integrity"], {"before": True, "after": True})
            self.assertEqual(len(image["gfp5_header"]["timestamp_like_changes"]), 2)
            self.assertTrue(result["plaintext"]["archive_sha256_equal"])
            self.assertEqual(result["plaintext"]["changed_entries"], [])
            self.assertEqual((root / "before" / "sdimg_SAVEDATA00").read_bytes(), original)

    def test_diff_run_continues_across_stream_chunk_boundary(self):
        with tempfile.TemporaryDirectory() as temporary:
            left, right = Path(temporary) / "a", Path(temporary) / "b"
            left.write_bytes(b"abcdefgh")
            right.write_bytes(b"abcXYfgh")
            with patch("poc.dt_roundtrip_diff.CHUNK_SIZE", 4):
                result = diff_files(left, right)
            self.assertEqual(result["changed_bytes"], 2)
            self.assertEqual(result["changed_ranges"], [[3, 5]])

    def test_rejects_manifest_paths_outside_entry(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            write_entry(root / "before", b"abc", 1700000000)
            write_entry(root / "after", b"abc", 1700000000)
            manifest_path = root / "before" / "manifest.json"
            original = json.loads(manifest_path.read_text(encoding="utf-8"))
            for name in (".", "..", "../outside", "..\\outside"):
                altered = dict(original)
                altered["files"] = [dict(original["files"][0], file=name)]
                manifest_path.write_text(json.dumps(altered), encoding="utf-8")
                with self.subTest(name=name), self.assertRaises(ValueError):
                    compare_entries(root / "before", root / "after")


if __name__ == "__main__":
    unittest.main()
