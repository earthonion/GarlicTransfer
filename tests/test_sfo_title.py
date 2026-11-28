import ctypes
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest


def make_sfo(fields):
    """Function SFO Fixture."""
    keys, data, entries = bytearray(), bytearray(), bytearray()
    for key, value, kind in fields:
        offset = len(data)
        capacity = (len(value) + 3) & ~3
        entries.extend(struct.pack('<HHIII', len(keys), kind, len(value), capacity, offset))
        keys.extend(key.encode() + b'\0')
        data.extend(value + b'\0' * (capacity - len(value)))
    key_offset = 20 + len(entries)
    data_offset = (key_offset + len(keys) + 3) & ~3
    return (struct.pack('<4sIIII', b'\0PSF', 0x101, key_offset, data_offset, len(fields))
            + entries + keys + b'\0' * (data_offset - key_offset - len(keys)) + data)


@unittest.skipUnless(os.name == 'posix', 'POSIX native SFO check')
class SfoTitleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        compiler = shutil.which('cc')
        if not compiler:
            raise unittest.SkipTest('C compiler unavailable')
        cls.directory = tempfile.TemporaryDirectory(prefix='garlic-title-')
        cls.addClassCleanup(cls.directory.cleanup)
        cls.root = Path(cls.directory.name)
        source = Path(__file__).resolve().parents[1] / 'poc/local_worker/src'
        wrapper = cls.root / 'title.c'
        wrapper.write_text(
            '#include "sfo_title.h"\n'
            'int patch(void *p, size_t n, const char *t) { return sfo_title_patch_bytes(p,n,t); }\n'
            'int patch_file(const char *p, const char *t) { return sfo_title_patch_file(p,t); }\n'
        )
        library = cls.root / ('title.dylib' if sys.platform == 'darwin' else 'title.so')
        linking = '-dynamiclib' if sys.platform == 'darwin' else '-shared'
        subprocess.run([compiler, linking, '-fPIC', '-std=c11', '-D_DEFAULT_SOURCE',
                        '-Wall', '-Wextra', '-Werror', '-I', str(source), str(wrapper),
                        '-o', str(library)], check=True, capture_output=True, text=True)
        cls.native = ctypes.CDLL(str(library))
        cls.native.patch.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_char_p]
        cls.native.patch.restype = ctypes.c_int
        cls.native.patch_file.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
        cls.native.patch_file.restype = ctypes.c_int

    def patch(self, original, target=b'PPSA54321'):
        buffer = ctypes.create_string_buffer(original)
        result = self.native.patch(buffer, len(original), target)
        return result, buffer.raw[:len(original)]

    def fixture(self):
        return make_sfo([
            ('TITLE_ID', b'PPSA12345\0', 0x0204),
            ('CONTENT_ID', b'EP0000-PPSA12345_00-PPSA12345_00\0', 0x0204),
            ('SAVEDATA_DIRECTORY', b'PPSA12345-save\0', 0x0204),
            ('PARAMS', b'\0PPSA12345\0', 0x0004),
            ('ACCOUNT_ID', bytes.fromhex('1122334455667788'), 0x0004),
            ('SAVEDATA_BLOCKS', struct.pack('<Q', 256), 0x0404),
        ])

    def test_all_matching_metadata_tokens_change_without_rebuilding_sfo(self):
        original = self.fixture()
        count, result = self.patch(original)
        self.assertEqual(count, 5)
        self.assertEqual(result, original.replace(b'PPSA12345', b'PPSA54321'))

    def test_unrelated_title_ids_are_rejected_before_any_changes(self):
        original = make_sfo([('TITLE_ID', b'PPSA12345\0', 0x0204),
                             ('CONTENT_ID', b'EP0000-PPSA99999_00\0', 0x0204)])
        self.assertEqual(self.patch(original), (-1, original))

    def test_partial_identifiers_and_unused_padding_are_untouched(self):
        original = make_sfo([('TITLE_ID', b'PPSA12345\0', 0x0204),
                             ('TEXT', b'XPPSA12345 PPSA123456 PPSA12345Y\0', 0x0204)])
        original += b'PPSA12345'
        count, result = self.patch(original)
        self.assertEqual(count, 1)
        position = original.index(b'PPSA12345')
        self.assertEqual(result, original[:position] + b'PPSA54321' + original[position + 9:])

    def test_same_title_is_an_exact_noop(self):
        original = self.fixture()
        self.assertEqual(self.patch(original, b'PPSA12345'), (0, original))

    def test_invalid_targets_are_rejected(self):
        original = self.fixture()
        for target in (b'', b'ppsa54321', b'PPSA123456', b'PPSA1234', b'CUSA12345', b'PPSA12A45'):
            with self.subTest(target=target):
                self.assertEqual(self.patch(original, target), (-1, original))

    def test_malformed_metadata_is_rejected_without_changes(self):
        original = self.fixture()
        variants = [b'\0' * len(original), original[:19], original[:-4]]
        for offset, value in ((4, 0x102), (8, 20), (12, 0xFFFFFFFF), (16, 0xFFFFFFFF),
                              (24, 0xFFFFFFFF), (32, 0xFFFFFFFF)):
            malformed = bytearray(original)
            struct.pack_into('<I', malformed, offset, value)
            variants.append(bytes(malformed))
        for malformed in variants:
            with self.subTest(length=len(malformed), header=malformed[:20]):
                self.assertEqual(self.patch(malformed), (-1, malformed))

    def test_missing_duplicate_and_binary_title_fields_are_rejected(self):
        for fields in ([('OTHER_ID', b'PPSA12345\0', 0x0204)],
                       [('TITLE_ID', b'PPSA12345\0', 0x0204)] * 2,
                       [('TITLE_ID', b'PPSA12345\0', 0x0004)]):
            original = make_sfo(fields)
            self.assertEqual(self.patch(original), (-1, original))

    def test_overlapping_values_are_rejected(self):
        original = bytearray(self.fixture())
        struct.pack_into('<I', original, 20 + 16 + 12, 0)
        original = bytes(original)
        self.assertEqual(self.patch(original), (-1, original))

    def test_file_write_is_verified_and_malformed_files_are_preserved(self):
        selected = self.root / 'param.sfo'
        original = self.fixture()
        selected.write_bytes(original)
        self.assertEqual(self.native.patch_file(os.fsencode(selected), b'PPSA54321'), 5)
        self.assertEqual(selected.read_bytes(), original.replace(b'PPSA12345', b'PPSA54321'))
        selected.write_bytes(b'\0' * 100)
        self.assertEqual(self.native.patch_file(os.fsencode(selected), b'PPSA54321'), -1)
        self.assertEqual(selected.read_bytes(), b'\0' * 100)


if __name__ == '__main__':
    unittest.main()
