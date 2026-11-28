import json
import os
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import zipfile
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo

from poc.dt_save_editor import bundle_results, extract_archive, pack_workspace, pack_local_workspace, pack_local_inputs


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



class LocalWorkerZipTests(unittest.TestCase):
    def assert_stored_classic(self, archive):
        raw = archive.read_bytes()
        self.assertNotIn(b"PK\x06\x06", raw)
        with ZipFile(archive) as result:
            self.assertIsNone(result.testzip())
            for item in result.infolist():
                self.assertEqual(item.compress_type, ZIP_STORED)
                self.assertFalse(item.flag_bits & 8, "data descriptors are unsupported by the worker")
                self.assertLess(item.extract_version, 45, "ZIP64 is unsupported by the worker")
                offset = item.header_offset
                self.assertEqual(struct.unpack_from("<I", raw, offset + 14)[0], item.CRC)
                self.assertEqual(struct.unpack_from("<I", raw, offset + 18)[0], item.file_size)
                self.assertEqual(struct.unpack_from("<I", raw, offset + 22)[0], item.file_size)

    def test_workspace_preserves_geometry_metadata_files_and_empty_folders(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            workspace = root / "workspace"
            (workspace / "DATA" / "sce_sys").mkdir(parents=True)
            (workspace / "DATA" / "empty").mkdir()
            (workspace / "DATA" / "sce_sys" / "param.sfo").write_bytes(b"sfo")
            (workspace / "DATA" / "save.dat").write_bytes(b"game" * 100)
            (workspace / "chives.json").write_text('{"block_size_bytes":65536}')
            (workspace / "PS5KEY").write_bytes(b"original key")
            archive = pack_local_workspace(workspace, root / "stored.zip")
            self.assert_stored_classic(archive)
            with ZipFile(archive) as result:
                self.assertEqual(result.read("chives.json"), b'{"block_size_bytes":65536}')
                self.assertEqual(result.read("PS5KEY"), b"original key")
                self.assertEqual(result.read("DATA/save.dat"), b"game" * 100)
                self.assertIn("DATA/empty/", result.namelist())
            remote_archive = pack_workspace(workspace, root / "remote.zip")
            with ZipFile(remote_archive) as result:
                self.assertEqual(result.getinfo("DATA/save.dat").compress_type, ZIP_DEFLATED)

    def test_raw_save_inputs_keep_container_and_companion_names(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "inputs"
            source.mkdir()
            save = source / "sdimg_SLOT01"
            companion = source / "sdimg_SLOT01.bin"
            save.write_bytes(b"GFP5encrypted save")
            companion.write_bytes(b"sealed key")
            archive = pack_local_inputs(root / "stored.zip", [save, companion])
            self.assert_stored_classic(archive)
            with ZipFile(archive) as result:
                self.assertEqual(set(result.namelist()), {save.name, companion.name})
                self.assertEqual(result.read(save.name), save.read_bytes())
                self.assertEqual(result.read(companion.name), companion.read_bytes())

    def test_compressed_zip_inputs_are_repacked_stored_without_changing_layout(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "input.zip"
            with ZipFile(source, "w", compression=ZIP_DEFLATED) as archive:
                archive.writestr("SLOT01/", b"")
                archive.writestr("SLOT01/sdimg_SLOT01", b"GFP5encrypted")
                archive.writestr("SLOT01/sdimg_SLOT01.bin", b"key")
            result_path = pack_local_inputs(root / "stored.zip", [source])
            self.assert_stored_classic(result_path)
            with ZipFile(result_path) as result:
                self.assertEqual(result.read("SLOT01/sdimg_SLOT01"), b"GFP5encrypted")
                self.assertEqual(result.read("SLOT01/sdimg_SLOT01.bin"), b"key")

    def test_zip64_input_headers_are_normalized_to_classic_headers(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "input.zip"
            with ZipFile(source, "w") as archive:
                with archive.open("save", "w", force_zip64=True) as data:
                    data.write(b"GFP5encrypted")
            result = pack_local_inputs(root / "stored.zip", [source])
            self.assert_stored_classic(result)

    def test_conservative_python_threshold_does_not_force_zip64(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            save = root / "save"
            save.write_bytes(b"x" * 500)
            with patch.object(zipfile, "ZIP64_LIMIT", 32):
                result = pack_local_inputs(root / "stored.zip", [save])
                self.assertEqual(zipfile.ZIP64_LIMIT, 32)
            self.assert_stored_classic(result)

    def test_unsafe_zip_paths_are_rejected_before_output_is_replaced(self):
        names = ["../outside", "/absolute", "C:/outside", "C:outside", "\\\\host\\outside", "safe/../../outside"]
        for name in names:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                source = root / "input.zip"
                with ZipFile(source, "w") as archive:
                    archive.writestr(name, b"payload")
                output = root / "stored.zip"
                output.write_bytes(b"previous output")
                with self.assertRaisesRegex(ValueError, "unsafe archive path"):
                    pack_local_inputs(output, [source])
                self.assertEqual(output.read_bytes(), b"previous output")
                self.assertEqual(list(root.glob("*.tmp")), [])

    def test_zip_symlinks_and_special_files_are_rejected(self):
        for kind in [stat.S_IFLNK, stat.S_IFIFO]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                source = root / "input.zip"
                item = ZipInfo("link")
                item.create_system = 3
                item.external_attr = (kind | 0o777) << 16
                with ZipFile(source, "w") as archive:
                    archive.writestr(item, b"outside")
                with self.assertRaisesRegex(ValueError, "links or special files"):
                    pack_local_inputs(root / "stored.zip", [source])

    @unittest.skipIf(os.name == "nt", "creating symlinks requires Windows privileges")
    def test_workspace_directory_and_file_links_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            workspace = root / "workspace"
            workspace.mkdir()
            outside = root / "outside"
            outside.mkdir()
            (outside / "secret").write_bytes(b"outside")
            (workspace / "linked").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "links"):
                pack_local_workspace(workspace, root / "stored.zip")
            (workspace / "linked").unlink()
            (workspace / "linked").symlink_to(outside / "secret")
            with self.assertRaisesRegex(ValueError, "links or special files"):
                pack_local_workspace(workspace, root / "stored.zip")

    def test_duplicate_raw_names_and_shadowed_zip_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            sources = []
            for name in ["one", "two"]:
                parent = root / name
                parent.mkdir()
                save = parent / "save"
                save.write_bytes(name.encode())
                sources.append(save)
            with self.assertRaisesRegex(ValueError, "duplicate|conflicting"):
                pack_local_inputs(root / "stored.zip", sources)
            source = root / "shadowed.zip"
            with ZipFile(source, "w") as archive:
                archive.writestr("folder", b"file")
                archive.writestr("folder/save", b"payload")
            with self.assertRaisesRegex(ValueError, "conflicting|collide"):
                pack_local_inputs(root / "stored.zip", [source])

    def test_empty_archives_workspaces_and_in_place_input_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            workspace = root / "empty"
            workspace.mkdir()
            with self.assertRaisesRegex(ValueError, "at least one"):
                pack_local_workspace(workspace, root / "stored.zip")
            source = root / "empty.zip"
            with ZipFile(source, "w"):
                pass
            with self.assertRaisesRegex(ValueError, "contains no save files"):
                pack_local_inputs(root / "stored.zip", [source])
            with self.assertRaisesRegex(ValueError, "separately"):
                pack_local_inputs(source, [source])
            (workspace / "save").write_bytes(b"payload")
            with self.assertRaisesRegex(ValueError, "outside the decrypted workspace"):
                pack_local_workspace(workspace, workspace / "stored.zip")

    def test_invalid_entry_size_and_entry_count_never_publish_partial_zip(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "huge.zip"
            with ZipFile(source, "w") as archive:
                archive.writestr("save", b"x")
            raw = bytearray(source.read_bytes())
            central = raw.index(b"PK\x01\x02")
            struct.pack_into("<I", raw, central + 24, 0xFFFFFFFF)
            source.write_bytes(raw)
            output = root / "stored.zip"
            output.write_bytes(b"previous output")
            with self.assertRaisesRegex(ValueError, "classic ZIP"):
                pack_local_inputs(output, [source])
            self.assertEqual(output.read_bytes(), b"previous output")
            source = root / "many.zip"
            with ZipFile(source, "w") as archive:
                archive.writestr("one", b"1")
                archive.writestr("two", b"2")
            with patch("poc.dt_save_editor.CLASSIC_ZIP_ENTRIES", 1):
                with self.assertRaisesRegex(ValueError, "classic ZIP"):
                    pack_local_inputs(output, [source])
            self.assertEqual(output.read_bytes(), b"previous output")
            self.assertEqual(list(root.glob("*.tmp")), [])

    def test_failed_zip_read_cleans_temporary_and_preserves_previous_output(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "bad.zip"
            with ZipFile(source, "w", compression=ZIP_STORED) as archive:
                archive.writestr("save", b"payload")
            raw = bytearray(source.read_bytes())
            raw[30 + len("save")] ^= 1
            source.write_bytes(raw)
            output = root / "stored.zip"
            output.write_bytes(b"previous output")
            with self.assertRaises(zipfile.BadZipFile):
                pack_local_inputs(output, [source])
            self.assertEqual(output.read_bytes(), b"previous output")
            self.assertEqual(list(root.glob("*.tmp")), [])

    def test_both_local_cli_commands_report_archive_and_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            workspace = root / "workspace"
            workspace.mkdir()
            save = workspace / "save"
            save.write_bytes(b"GFP5encrypted")
            for command, args in [
                ("local-pack", [str(workspace), str(root / "workspace.zip")]),
                ("local-inputs", [str(root / "inputs.zip"), str(save)]),
            ]:
                with self.subTest(command=command):
                    result = subprocess.run([sys.executable, "-m", "poc.dt_save_editor", command, *args],
                                            check=True, capture_output=True, text=True)
                    data = json.loads(result.stdout)
                    archive = Path(data["archive"])
                    self.assertEqual(data["bytes"], archive.stat().st_size)
                    self.assert_stored_classic(archive)


class BatchResultZipTests(unittest.TestCase):
    def make_result(self, root, label, name=None, title="PPSA54321", content=b"GFP5encrypted"):
        name = name or f"sdimg_{label}"
        archive = root / f"{label}.zip"
        with ZipFile(archive, "w") as output:
            output.writestr(name, content)
        return {"archive": str(archive), "titleId": title, "encryptedName": name}

    def manifest(self, root, results):
        manifest = root / "manifest.json"
        manifest.write_text(json.dumps({"results": results}), encoding="utf-8")
        return manifest

    def test_five_save_results_keep_bytes_and_use_selected_title_folder(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            results = [self.make_result(root, str(number), content=f"GFP5save{number}".encode())
                       for number in range(5)]
            originals = {result["archive"]: Path(result["archive"]).read_bytes() for result in results}
            output = bundle_results(self.manifest(root, results), root / "combined.zip")
            with ZipFile(output) as archive:
                self.assertIsNone(archive.testzip())
                self.assertEqual(archive.namelist(), [f"PPSA54321/sdimg_{number}" for number in range(5)])
                for number in range(5):
                    self.assertEqual(archive.read(f"PPSA54321/sdimg_{number}"), f"GFP5save{number}".encode())
            for source, original in originals.items():
                self.assertEqual(Path(source).read_bytes(), original)
            self.assertEqual(list(root.glob("*.tmp")), [])

    def test_original_title_folders_allow_equal_save_names(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            results = [self.make_result(root, "one", "sdimg_save", "PPSA12345"),
                       self.make_result(root, "two", "sdimg_save", "PPSA54321")]
            output = bundle_results(self.manifest(root, results), root / "combined.zip")
            with ZipFile(output) as archive:
                self.assertEqual(archive.namelist(), ["PPSA12345/sdimg_save", "PPSA54321/sdimg_save"])

    def test_duplicate_paths_are_case_insensitive_and_preserve_previous_output(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            results = [self.make_result(root, "one", "sdimg_save"),
                       self.make_result(root, "two", "SDIMG_SAVE")]
            output = root / "combined.zip"
            output.write_bytes(b"previous export")
            with self.assertRaisesRegex(ValueError, "duplicate batch result path"):
                bundle_results(self.manifest(root, results), output)
            self.assertEqual(output.read_bytes(), b"previous export")
            self.assertEqual(list(root.glob("*.tmp")), [])

    def test_unsafe_manifest_names_titles_and_paths_are_rejected(self):
        cases = [{"titleId": "PPSA12/34"}, {"titleId": "ppsa12345"},
                 {"encryptedName": "../save"}, {"encryptedName": "folder\\save"},
                 {"encryptedName": "save:"}, {"encryptedName": "."},
                 {"encryptedName": "save."}, {"encryptedName": "save "},
                 {"archive": "relative.zip"}, {"archive": None}]
        for changes in cases:
            with self.subTest(changes=changes), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                result = self.make_result(root, "one")
                result.update(changes)
                output = root / "combined.zip"
                with self.assertRaises(ValueError):
                    bundle_results(self.manifest(root, [result]), output)
                self.assertFalse(output.exists())

    def test_empty_extra_nested_or_mismatched_zip_entries_are_rejected(self):
        cases = [[], [("sdimg_one", b"")], [("other", b"data")],
                 [("../sdimg_one", b"data")], [("folder/sdimg_one", b"data")],
                 [("sdimg_one", b"data"), ("extra", b"data")], [("sdimg_one/", b"")]]
        for members in cases:
            with self.subTest(members=members), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                result = self.make_result(root, "one")
                with ZipFile(result["archive"], "w") as archive:
                    for name, data in members:
                        archive.writestr(name, data)
                output = root / "combined.zip"
                output.write_bytes(b"previous export")
                with self.assertRaises(ValueError):
                    bundle_results(self.manifest(root, [result]), output)
                self.assertEqual(output.read_bytes(), b"previous export")

    def test_archive_links_and_special_entries_are_rejected(self):
        for kind in [stat.S_IFLNK, stat.S_IFIFO]:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                result = self.make_result(root, "one")
                item = ZipInfo("sdimg_one")
                item.create_system = 3
                item.external_attr = (kind | 0o777) << 16
                with ZipFile(result["archive"], "w") as archive:
                    archive.writestr(item, b"data")
                with self.assertRaisesRegex(ValueError, "links, directories or special"):
                    bundle_results(self.manifest(root, [result]), root / "combined.zip")

    @unittest.skipIf(os.name == "nt", "creating symlinks requires Windows privileges")
    def test_linked_source_zip_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            result = self.make_result(root, "one")
            linked = root / "linked.zip"
            linked.symlink_to(Path(result["archive"]))
            result["archive"] = str(linked)
            with self.assertRaisesRegex(ValueError, "links or special"):
                bundle_results(self.manifest(root, [result]), root / "combined.zip")

    def test_corrupt_result_keeps_previous_export_and_removes_partial_zip(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            result = self.make_result(root, "one")
            source = Path(result["archive"])
            raw = bytearray(source.read_bytes())
            raw[30 + len(result["encryptedName"])] ^= 1
            source.write_bytes(raw)
            output = root / "combined.zip"
            output.write_bytes(b"previous export")
            with self.assertRaises(zipfile.BadZipFile):
                bundle_results(self.manifest(root, [result]), output)
            self.assertEqual(output.read_bytes(), b"previous export")
            self.assertEqual(list(root.glob("*.tmp")), [])

    def test_output_cannot_replace_an_input_or_manifest(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            result = self.make_result(root, "one")
            source = Path(result["archive"])
            original = source.read_bytes()
            manifest = self.manifest(root, [result])
            for output in [source, manifest]:
                with self.subTest(output=output), self.assertRaisesRegex(ValueError, "separately"):
                    bundle_results(manifest, output)
            self.assertEqual(source.read_bytes(), original)

    def test_cli_reports_archive_bytes_and_save_count(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            results = [self.make_result(root, "one"), self.make_result(root, "two")]
            manifest = self.manifest(root, results)
            output = root / "combined.zip"
            process = subprocess.run([sys.executable, "-m", "poc.dt_save_editor", "bundle-results",
                                      str(manifest), str(output)], check=True, capture_output=True, text=True)
            self.assertEqual(json.loads(process.stdout),
                             {"archive": str(output), "bytes": output.stat().st_size, "count": 2})


if __name__ == "__main__":
    unittest.main()
