import hashlib
import json
import os
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from poc.dt_local_saves import export_save, import_save, local_inventory


class LocalSaveTests(unittest.TestCase):
    def make_case(self, root):
        entry_id = 150
        assets = root / "assets"
        (assets / str(entry_id)).mkdir(parents=True)
        source_path = "/user/home/18c60ea2/savedata_prospero/PPSA24003/sdimg_DATA"
        header = bytearray(1304)
        struct.pack_into("<I", header, 0, 0x35504647)
        struct.pack_into("<I", header, 4, entry_id)
        struct.pack_into("<Q", header, 240, 8)
        header[276:276 + len(source_path)] = source_path.encode()
        final_header = bytearray(1304)
        struct.pack_into("<I", final_header, 0, 0x35504647)
        struct.pack_into("<I", final_header, 4, entry_id)
        final_header[274] = 1
        item = {
            "path": source_path,
            "file": "sdimg_DATA",
            "size": 8,
            "sha256": "stale",
            "header": header.hex(),
        }
        manifest = {
            "entry_id": entry_id,
            "files": [item],
            str(entry_id): {"files": [item], "final_header": final_header.hex()},
        }
        (assets / "manifest.json").write_text(json.dumps({str(entry_id): manifest[str(entry_id)]}))
        (assets / str(entry_id) / "manifest.json").write_text(json.dumps(manifest))
        (assets / str(entry_id) / "sdimg_DATA").write_bytes(b"old-save")
        return assets, entry_id

    def test_inventory_hashes_actual_file(self):
        with tempfile.TemporaryDirectory() as folder:
            assets, entry_id = self.make_case(Path(folder))
            entries = local_inventory(assets)
            self.assertEqual(entries[0]["id"], entry_id)
            self.assertEqual(entries[0]["title"], "PPSA24003")
            self.assertEqual(
                entries[0]["files"][0]["sha256"],
                hashlib.sha256(b"old-save").hexdigest(),
            )

    def test_export_copies_file(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            assets, entry_id = self.make_case(root)
            destination = root / "export"
            destination.mkdir()
            output = export_save(assets, entry_id, "sdimg_DATA", destination)
            self.assertEqual(output.read_bytes(), b"old-save")
            self.assertEqual((assets / str(entry_id) / "sdimg_DATA").read_bytes(), b"old-save")

    def test_import_replaces_file_and_regenerates_both_manifests(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            assets, entry_id = self.make_case(root)
            source = root / "replacement"
            payload = b"new-save"
            source.write_bytes(payload)
            with patch("poc.dt_local_saves.os.fsync", side_effect=lambda descriptor: os.write(descriptor, b"")):
                import_save(assets, entry_id, "sdimg_DATA", source)

            target = assets / str(entry_id) / "sdimg_DATA"
            self.assertEqual(target.read_bytes(), payload)
            self.assertEqual(source.read_bytes(), payload)
            expected_hash = hashlib.sha256(payload).hexdigest()
            for manifest_path in (assets / "manifest.json", target.parent / "manifest.json"):
                document = json.loads(manifest_path.read_text())
                item = document[str(entry_id)]["files"][0]
                self.assertEqual(item["size"], len(payload))
                self.assertEqual(item["sha256"], expected_hash)
                self.assertEqual(struct.unpack_from("<Q", bytes.fromhex(item["header"]), 240)[0], len(payload))


if __name__ == "__main__":
    unittest.main()
