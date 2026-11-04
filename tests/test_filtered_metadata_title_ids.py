"""Regression coverage for PS4 saves whose installed title and save folder differ."""

import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from poc.dt_metadata import create_filtered_metadata, create_metadata


class FilteredMetadataTitleIdTests(unittest.TestCase):
    def test_preserves_ps4_source_row_by_owner_and_save_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            assets = root / "assets"
            assets.mkdir()
            (assets / "save.bin").write_bytes(b"save")
            (assets / "manifest.json").write_text(json.dumps({
                "entry_id": 7,
                "7": {
                    "files": [{
                        "file": "save.bin", "size": 4, "header": "00",
                        "path": "/user/home/11111111/savedata/CUSA09303/save.bin",
                    }],
                    "final_header": "00",
                },
            }))
            source = root / "source.db"
            create_metadata(source, "11111111", "CUSA09303", 7, assets)
            with closing(sqlite3.connect(source)) as db:
                # The real Odyssey metadata has a canonical title ID that differs
                # from its save-directory title ID. A second owner checks that
                # filtering cannot borrow metadata from another PS5 user.
                db.execute(
                    "UPDATE users_savedata_tbl SET title_id = ?, bu_size = ?, "
                    "last_modified_time = ? WHERE user_id = ?",
                    ("CUSA09311", 0, 12345, 0x11111111),
                )
                db.execute(
                    "INSERT INTO users_savedata_tbl VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (0x22222222, "CUSA09303", "CUSA09303", 4, 4, 1, 1, 0, 67890),
                )
                db.commit()

            output = root / "filtered.db"
            create_filtered_metadata(output, source, "11111111", "primary", [7], assets)
            with closing(sqlite3.connect(output)) as db:
                row = db.execute(
                    "SELECT user_id, title_id, path_to_title_id, size, bu_size, "
                    "format_type, upload_setting, already_exists, last_modified_time "
                    "FROM users_savedata_tbl"
                ).fetchone()
                user_count = db.execute("SELECT COUNT(*) FROM user_info_tbl").fetchone()[0]
            self.assertEqual(
                row, (0x11111111, "CUSA09311", "CUSA09303", 4, 0, 0, 255, 0, 12345)
            )
            self.assertEqual(user_count, 1)

    def test_missing_source_row_uses_ps4_format(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            assets = root / "assets"
            assets.mkdir()
            (assets / "save.bin").write_bytes(b"save")
            (assets / "manifest.json").write_text(json.dumps({
                "entry_id": 7,
                "7": {
                    "files": [{
                        "file": "save.bin", "size": 4, "header": "00",
                        "path": "/user/home/11111111/savedata/CUSA09303/save.bin",
                    }],
                    "final_header": "00",
                },
            }))
            source = root / "source.db"
            create_metadata(source, "11111111", "CUSA09303", 7, assets)
            with closing(sqlite3.connect(source)) as db:
                db.execute("DELETE FROM users_savedata_tbl")
                db.commit()

            output = root / "filtered.db"
            create_filtered_metadata(output, source, "11111111", "primary", [7], assets)
            with closing(sqlite3.connect(output)) as db:
                row = db.execute(
                    "SELECT title_id, path_to_title_id, bu_size, format_type, upload_setting "
                    "FROM users_savedata_tbl"
                ).fetchone()
            self.assertEqual(row, ("CUSA09303", "CUSA09303", 0, 0, 255))


if __name__ == "__main__":
    unittest.main()
