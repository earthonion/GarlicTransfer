import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from poc.dt_metadata import create_metadata


class MetadataSaveMarkerTests(unittest.TestCase):
    def test_single_save_uses_the_source_game_format(self):
        for marker in ("savedata", "savedata_prospero"):
            with self.subTest(marker=marker), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                assets = root / "assets"
                assets.mkdir()
                (assets / "save.bin").write_bytes(b"save")
                (assets / "manifest.json").write_text(json.dumps({
                    "entry_id": 1,
                    "1": {
                        "files": [{
                            "file": "save.bin", "size": 4, "header": "00",
                            "path": f"/user/home/abcdef12/{marker}/ABCDEFGHI/save.bin",
                        }],
                        "final_header": "00",
                    },
                }))
                output = root / "generated.db"
                create_metadata(output, "12345678", "ABCDEFGHI", 1, assets)
                with closing(sqlite3.connect(output)) as db:
                    actual = db.execute("SELECT path FROM dir_entry_info_tbl WHERE id = 1").fetchone()[0]
                self.assertEqual(actual, f"/user/home/12345678/{marker}/ABCDEFGHI/")


if __name__ == "__main__":
    unittest.main()
