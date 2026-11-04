import io
import json
import sqlite3
import struct
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from poc.dt_backend import build_power_request_body, main, power_request_prefix
from poc.dt_ppr_power import CAPTURED_BODY


EXPECTED = bytes.fromhex("66840dda154e8a113c31dd0ad32f7f3a366a80e8136979d8f5a101d3d29d6f72")
ACCOUNT_ID = "72623859790382856"  # 0x0102030405060708, beyond JS's safe integer range.


class PowerIdentityTests(unittest.TestCase):
    def test_decimal_account_id_uses_all_eight_big_endian_bytes(self):
        self.assertEqual(power_request_prefix(ACCOUNT_ID), EXPECTED)

    def test_prior_metadata_uses_online_target_owner(self):
        with tempfile.TemporaryDirectory() as folder:
            db_path = Path(folder) / "metadata.db"
            with closing(sqlite3.connect(db_path)) as db:
                db.execute("CREATE TABLE user_info_tbl (uuid TEXT, target_owner INTEGER, online_user INTEGER)")
                db.executemany("INSERT INTO user_info_tbl VALUES (?, ?, ?)", [
                    ("0102030405060708", 1, 1),
                    ("FFFFFFFFFFFFFFFF", 0, 1),
                ])
                db.commit()
            self.assertEqual(power_request_prefix(None, db_path), EXPECTED)

    def test_rejects_ambiguous_or_out_of_range_identity(self):
        for value in ("1.0", "-1", "18446744073709551616"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                power_request_prefix(value)
        with tempfile.TemporaryDirectory() as folder:
            db_path = Path(folder) / "metadata.db"
            with closing(sqlite3.connect(db_path)) as db:
                db.execute("CREATE TABLE user_info_tbl (uuid TEXT, target_owner INTEGER, online_user INTEGER)")
                db.executemany("INSERT INTO user_info_tbl VALUES (?, 1, 1)", [
                    ("0102030405060708",), ("1111111111111111",),
                ])
                db.commit()
            with self.assertRaisesRegex(ValueError, "exactly one online target owner"):
                power_request_prefix(None, db_path)

    def test_paired_prefix_is_exact_and_explicit_id_takes_priority(self):
        with tempfile.TemporaryDirectory() as folder:
            prefix_path = Path(folder) / "paired.bin"
            paired = bytes(range(32))
            prefix_path.write_bytes(paired)
            self.assertEqual(power_request_prefix(None, prefix_path=prefix_path), paired)
            self.assertEqual(power_request_prefix(ACCOUNT_ID, prefix_path=prefix_path), EXPECTED)
            prefix_path.write_bytes(paired + b"x")
            with self.assertRaisesRegex(ValueError, "exactly 32 bytes"):
                power_request_prefix(None, prefix_path=prefix_path)

    def test_backend_accepts_initial_options_on_standard_input(self):
        options = {"accountId": ACCOUNT_ID, "workerKey": "never-in-argv"}
        with patch.object(sys, "argv", ["dt_backend", "download", "-"]), \
             patch.object(sys, "stdin", io.StringIO(json.dumps(options) + "\n")), \
             patch("poc.dt_backend.download") as download:
            main()
        download.assert_called_once_with(options)

    def test_1422_request_body_places_identity_and_console_fields(self):
        body = build_power_request_body(
            0x14220000, 3, "001122334455", power_request_prefix(ACCOUNT_ID),
        )
        self.assertEqual(len(body), 88)
        self.assertEqual(body[:32], EXPECTED)
        self.assertEqual(body[32:38], bytes.fromhex("001122334455"))
        self.assertEqual(struct.unpack_from("<I", body, 44)[0], 3)
        self.assertEqual(struct.unpack_from("<I", body, 48)[0], 0x284)
        self.assertEqual(struct.unpack_from("<I", body, 76)[0], 0x14220000)
        self.assertEqual(struct.unpack_from("<I", body, 84)[0], 0x14220000)

    def test_legacy_body_preserves_upstream_captured_prefix(self):
        body = build_power_request_body(0x13600000, 3, "001122334455", None)
        self.assertEqual(body[:32], CAPTURED_BODY[:32])


if __name__ == "__main__":
    unittest.main()
