"""Read-only comparison of two downloaded Data Transfer save entries.

This identifies changed container regions; it does not decrypt PFS or decide
whether a retail PS5 will accept either image.
"""

import argparse
import hashlib
import json
import struct
import zipfile
from itertools import zip_longest
from pathlib import Path


PFS_MAGIC = 0x1332A0B
CHUNK_SIZE = 1024 * 1024


def _runs(before, after, base=0):
    """Return half-open ranges of differing bytes in two in-memory buffers."""
    ranges = []
    start = None
    for offset, pair in enumerate(zip_longest(before, after)):
        different = pair[0] != pair[1]
        if different and start is None:
            start = offset
        elif not different and start is not None:
            ranges.append([base + start, base + offset])
            start = None
    if start is not None:
        ranges.append([base + start, base + max(len(before), len(after))])
    return ranges


def _append_run(ranges, start, end):
    if ranges and ranges[-1][1] == start:
        ranges[-1][1] = end
    else:
        ranges.append([start, end])


def diff_files(before, after):
    """Stream-compare files without loading save images into memory."""
    ranges = []
    changed = 0
    before_hash = hashlib.sha256()
    after_hash = hashlib.sha256()
    offset = 0
    with Path(before).open("rb") as left, Path(after).open("rb") as right:
        while True:
            a, b = left.read(CHUNK_SIZE), right.read(CHUNK_SIZE)
            if not a and not b:
                break
            before_hash.update(a)
            after_hash.update(b)
            if a != b:
                for start, end in _runs(a, b, offset):
                    _append_run(ranges, start, end)
                    changed += end - start
            offset += max(len(a), len(b))
    return {
        "before_size": Path(before).stat().st_size,
        "after_size": Path(after).stat().st_size,
        "before_sha256": before_hash.hexdigest(),
        "after_sha256": after_hash.hexdigest(),
        "changed_bytes": changed,
        "changed_ranges": ranges,
    }


def _file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while chunk := stream.read(CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def pfs_header(path):
    with Path(path).open("rb") as stream:
        header = stream.read(0x10000)
    if len(header) < 0x860:
        return None, header
    version, magic = struct.unpack_from("<QQ", header)
    if version != 2 or magic != PFS_MAGIC:
        return None, header
    block_size = struct.unpack_from("<I", header, 0x20)[0]
    inode_blocks = struct.unpack_from("<Q", header, 0x40)[0]
    return {
        "version": version,
        "magic": magic,
        "block_size": block_size,
        "inode_blocks": inode_blocks,
    }, header


def classify_ranges(ranges, pfs, file_size):
    if not pfs:
        return [{"start": start, "end": end, "region": "unclassified"}
                for start, end in ranges]
    block = pfs["block_size"]
    regions = [
        (0xB8, 0xD8, "super-root digest candidate (PS4 layout)"),
        (0x380, 0x3A0, "PFS header hash"),
        (0x800, 0x860, "sealed-key record"),
    ]
    if 0x1000 <= block <= 0x200000 and block <= file_size:
        regions.extend([
            (block - 0x60, block - 0x50, "save-auth IV"),
            (block - 0x50, block, "encrypted save-auth info"),
        ])
        inode_end = min(file_size, block * (1 + pfs["inode_blocks"]))
        if block < inode_end:
            regions.append((block, inode_end, "inode-table region (layout inferred)"))
    boundaries = sorted({point for start, end, _ in regions for point in (start, end)})
    classified = []
    for start, end in ranges:
        points = [start] + [p for p in boundaries if start < p < end] + [end]
        for a, b in zip(points, points[1:]):
            label = next((name for lo, hi, name in regions if lo <= a < hi), "unclassified")
            classified.append({"start": a, "end": b, "region": label})
    return classified


def _manifest(entry):
    manifest_path = Path(entry) / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    files = {}
    for item in manifest["files"]:
        name = item["file"]
        if (not name or name in (".", "..") or "/" in name or "\\" in name
                or name in files):
            raise ValueError(f"invalid or duplicate manifest filename: {name!r}")
        files[name] = item
    return manifest, files


def _entry_file(entry, name):
    path = entry / name
    if not path.is_file() or path.resolve().parent != entry.resolve():
        raise ValueError(f"save file is missing or outside entry folder: {name!r}")
    return path


def _header_diff(before, after):
    a, b = bytes.fromhex(before), bytes.fromhex(after)
    if len(a) != 1304 or len(b) != 1304:
        raise ValueError("GFP5 header is not 1304 bytes")
    times = []
    for offset in (0xC0, 0xE0):
        old, new = struct.unpack_from("<Q", a, offset)[0], struct.unpack_from("<Q", b, offset)[0]
        if old != new:
            times.append({"offset": offset, "before": old, "after": new,
                          "meaning": "timestamp-like (unconfirmed)"})
    ranges = _runs(a, b)
    return {"changed_bytes": sum(end - start for start, end in ranges),
            "changed_ranges": ranges, "timestamp_like_changes": times}


def _zip_entries(path):
    entries = {}
    with zipfile.ZipFile(path) as archive:
        for item in archive.infolist():
            if item.is_dir():
                continue
            if item.filename in entries:
                raise ValueError(f"duplicate ZIP entry: {item.filename!r}")
            digest = hashlib.sha256()
            with archive.open(item) as stream:
                while chunk := stream.read(CHUNK_SIZE):
                    digest.update(chunk)
            entries[item.filename] = {"size": item.file_size, "sha256": digest.hexdigest()}
    return entries


def compare_entries(before_entry, after_entry, before_plaintext=None, after_plaintext=None):
    if (before_plaintext is None) != (after_plaintext is None):
        raise ValueError("provide both plaintext ZIPs or neither")
    before_entry, after_entry = Path(before_entry), Path(after_entry)
    before_manifest, before_files = _manifest(before_entry)
    after_manifest, after_files = _manifest(after_entry)
    names = sorted(before_files.keys() | after_files.keys())
    report = {"entry_id_before": before_manifest.get("entry_id"),
              "entry_id_after": after_manifest.get("entry_id"), "files": {},
              "missing_before": sorted(after_files.keys() - before_files.keys()),
              "missing_after": sorted(before_files.keys() - after_files.keys())}
    for name in names:
        if name not in before_files or name not in after_files:
            continue
        old, new = before_files[name], after_files[name]
        before_path, after_path = _entry_file(before_entry, name), _entry_file(after_entry, name)
        diff = diff_files(before_path, after_path)
        old_pfs, old_head = pfs_header(before_path)
        new_pfs, new_head = pfs_header(after_path)
        diff["pfs_before"] = old_pfs
        diff["pfs_after"] = new_pfs
        diff["sealed_key_equal"] = (old_head[0x800:0x860] == new_head[0x800:0x860]
                                    if old_pfs and new_pfs else None)
        diff["regions"] = classify_ranges(
            diff["changed_ranges"], old_pfs if old_pfs == new_pfs else None,
            min(diff["before_size"], diff["after_size"]),
        )
        diff["manifest_integrity"] = {
            "before": old.get("size") == diff["before_size"] and
                      old.get("sha256", "").lower() == diff["before_sha256"],
            "after": new.get("size") == diff["after_size"] and
                     new.get("sha256", "").lower() == diff["after_sha256"],
        }
        diff["manifest_path_equal"] = old.get("path") == new.get("path")
        diff["gfp5_header"] = _header_diff(old["header"], new["header"])
        report["files"][name] = diff
    before_final = before_manifest.get(str(before_manifest.get("entry_id")), {}).get("final_header")
    after_final = after_manifest.get(str(after_manifest.get("entry_id")), {}).get("final_header")
    if before_final is not None and after_final is not None:
        report["gfp5_final_header"] = _header_diff(before_final, after_final)
    if before_plaintext is not None:
        before_zip, after_zip = _zip_entries(before_plaintext), _zip_entries(after_plaintext)
        before_hash, after_hash = _file_sha256(before_plaintext), _file_sha256(after_plaintext)
        report["plaintext"] = {
            "archive_sha256_equal": before_hash == after_hash,
            "missing_before": sorted(after_zip.keys() - before_zip.keys()),
            "missing_after": sorted(before_zip.keys() - after_zip.keys()),
            "changed_entries": sorted(name for name in before_zip.keys() & after_zip.keys()
                                      if before_zip[name] != after_zip[name]),
            "entry_count_before": len(before_zip),
            "entry_count_after": len(after_zip),
        }
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("before_entry", type=Path, help="original downloaded entry folder")
    parser.add_argument("after_entry", type=Path, help="later downloaded entry folder")
    parser.add_argument("--before-plaintext", type=Path, help="optional original plaintext ZIP")
    parser.add_argument("--after-plaintext", type=Path, help="optional later plaintext ZIP")
    args = parser.parse_args()
    report = compare_entries(args.before_entry, args.after_entry,
                             args.before_plaintext, args.after_plaintext)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
