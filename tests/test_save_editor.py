import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile, ZipInfo

from poc.dt_save_editor import extract_archive, pack_workspace


class SaveEditorZipTests(unittest.TestCase):
    def make_archive(self, root):
        archive = root / "input.zip"
        with ZipFile(archive, "w") as output:
            output.writestr("DATA/sce_sys/param.sfo", b"sfo")
            output.writestr("DATA/empty.dat", b"")
            output.writestr("DATA/save.dat", b"payload")
            output.writestr("chives.json", json.dumps({"title_id": "PPSA12345"}))
            output.writestr("DATA/empty-folder/", b"")
        return archive

    def test_extract_and_pack_preserve_workspace(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            workspace = extract_archive(self.make_archive(root), root / "workspace")
            self.assertEqual((workspace / "DATA" / "save.dat").read_bytes(), b"payload")
            self.assertEqual((workspace / "DATA" / "empty.dat").read_bytes(), b"")
            self.assertTrue((workspace / "DATA" / "empty-folder").is_dir())
            packed = pack_workspace(workspace, root / "packed.zip")
            with ZipFile(packed) as archive:
                self.assertEqual(archive.read("DATA/save.dat"), b"payload")
                self.assertEqual(archive.read("DATA/empty.dat"), b"")
                self.assertIn("DATA/empty-folder/", archive.namelist())
                self.assertEqual(json.loads(archive.read("chives.json"))["title_id"], "PPSA12345")

    def test_extract_rejects_traversal_absolute_paths_and_links(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for index, name in enumerate(("../outside", "/absolute", "C:/drive")):
                archive = root / f"bad-{index}.zip"
                with ZipFile(archive, "w") as output:
                    output.writestr(name, b"bad")
                with self.assertRaisesRegex(ValueError, "unsafe archive path"):
                    extract_archive(archive, root / f"workspace-{index}")
            archive = root / "link.zip"
            info = ZipInfo("DATA/link")
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            with ZipFile(archive, "w") as output:
                output.writestr(info, b"target")
            with self.assertRaisesRegex(ValueError, "links are not supported"):
                extract_archive(archive, root / "link-workspace")

    def test_extract_does_not_overwrite_existing_workspace(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            workspace = root / "workspace"
            workspace.mkdir()
            (workspace / "keep").write_bytes(b"keep")
            with self.assertRaisesRegex(ValueError, "not empty"):
                extract_archive(self.make_archive(root), workspace)
            self.assertEqual((workspace / "keep").read_bytes(), b"keep")

    @unittest.skipIf(os.name == "nt", "POSIX symlink check")
    def test_pack_rejects_workspace_links(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            workspace = root / "workspace"
            workspace.mkdir()
            (root / "target").write_bytes(b"target")
            (workspace / "link").symlink_to(root / "target")
            with self.assertRaisesRegex(ValueError, "links are not supported"):
                pack_workspace(workspace, root / "packed.zip")


if __name__ == "__main__":
    unittest.main()
