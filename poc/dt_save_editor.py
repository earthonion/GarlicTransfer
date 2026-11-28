#!/usr/bin/env python3
import argparse
from contextlib import ExitStack
import json
import os
import re
import stat
import tempfile
import threading
from pathlib import Path, PurePosixPath, PureWindowsPath
import zipfile
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo


def archive_parts(name):
    normalized = name.replace("\\", "/")
    parts = PurePosixPath(normalized).parts
    if (
        not normalized
        or normalized.startswith("/")
        or "\x00" in normalized
        or ".." in parts
        or (parts and parts[0].endswith(":"))
    ):
        raise ValueError(f"unsafe archive path: {name!r}")
    return parts


def extract_archive(archive, workspace):
    archive = Path(archive).expanduser()
    workspace = Path(workspace).expanduser()
    if workspace.exists() and any(workspace.iterdir()):
        raise ValueError("the decrypted workspace is not empty")
    workspace.mkdir(parents=True, exist_ok=True)
    root = workspace.resolve()
    with ZipFile(archive) as source:
        for item in source.infolist():
            parts = archive_parts(item.filename)
            if stat.S_ISLNK(item.external_attr >> 16):
                raise ValueError(f"archive links are not supported: {item.filename}")
            destination = root.joinpath(*parts)
            destination.resolve().relative_to(root)
            if item.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            with source.open(item) as input_stream, destination.open("xb") as output_stream:
                while chunk := input_stream.read(0x200000):
                    output_stream.write(chunk)
    return workspace


def pack_workspace(workspace, archive):
    workspace = Path(workspace).expanduser()
    archive = Path(archive).expanduser()
    if not workspace.is_dir():
        raise ValueError("select an existing decrypted workspace")
    archive.parent.mkdir(parents=True, exist_ok=True)
    temporary = archive.with_name(archive.name + ".tmp")
    root = workspace.resolve()
    try:
        with ZipFile(temporary, "w", compression=ZIP_DEFLATED, compresslevel=6) as output:
            for current, directories, files in os.walk(root):
                directories.sort()
                files.sort()
                current_path = Path(current)
                relative_directory = current_path.relative_to(root).as_posix()
                if not files and current_path != root:
                    output.writestr(relative_directory + "/", "")
                for name in files:
                    path = current_path / name
                    if path.is_symlink() or not path.is_file():
                        raise ValueError(f"workspace links are not supported: {path}")
                    output.write(path, path.relative_to(root).as_posix())
        os.replace(temporary, archive)
    finally:
        if temporary.exists():
            temporary.unlink()
    return archive


CLASSIC_ZIP_SIZE = 0xFFFFFFFF
CLASSIC_ZIP_ENTRIES = 0xFFFF
_local_zip_lock = threading.RLock()


# Function Local Paths
def local_archive_name(name, directory=False):
    parts = archive_parts(name)
    if not parts or PureWindowsPath(name).drive or any(":" in part for part in parts):
        raise ValueError(f"unsafe archive path: {name!r}")
    normalized = "/".join(parts) + ("/" if directory else "")
    if len(normalized.encode("utf-8")) >= 512:
        raise ValueError(f"archive path is too long for the local worker: {name!r}")
    return normalized


# Function Local Entries
class LocalEntries:
    def __init__(self):
        self.entries = []
        self.files = set()
        self.directories = set()
        self.explicit_directories = set()
        self.bytes = 22

    def add(self, name, size, directory, opener=None, mode=0):
        name = local_archive_name(name, directory)
        if size < 0 or size > CLASSIC_ZIP_SIZE or (directory and size):
            raise ValueError(f"invalid local archive file size: {name!r}")
        parts = PurePosixPath(name).parts
        key = name.rstrip("/").casefold()
        if size < 0 or size > CLASSIC_ZIP_SIZE:
            raise ValueError(f"file is too large for the local worker: {name}")
        if directory and size:
            raise ValueError(f"archive directory contains file data: {name}")
        if key in self.files or (not directory and key in self.directories) or key in self.explicit_directories:
            raise ValueError(f"duplicate archive path or file collision: {name}")
        for count in range(1, len(parts)):
            parent = "/".join(parts[:count]).casefold()
            if parent in self.files:
                raise ValueError(f"archive file and directory collide: {name}")
            self.directories.add(parent)
        if directory:
            self.directories.add(key)
            self.explicit_directories.add(key)
        else:
            self.files.add(key)
        self.bytes += size + 76 + 2 * len(name.encode("utf-8"))
        if len(self.entries) >= CLASSIC_ZIP_ENTRIES or self.bytes > CLASSIC_ZIP_SIZE:
            raise ValueError("the local worker requires a classic ZIP smaller than 4 GiB with at most 65535 entries")
        self.entries.append((name, size, directory, opener, mode))


# Function Local Reading
def open_local_file(path, expected_size):
    if path.is_symlink():
        raise ValueError(f"save links are not supported: {path}")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
    try:
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode) or details.st_size != expected_size:
            raise ValueError(f"save file changed while preparing it: {path}")
        return os.fdopen(descriptor, "rb")
    except BaseException:
        os.close(descriptor)
        raise


# Function Local Packing
def write_local_archive(entries, archive):
    if not entries.files:
        raise ValueError("choose at least one save file for the local worker")
    archive.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=archive.name + ".", suffix=".tmp", dir=archive.parent)
    os.close(descriptor)
    temporary = Path(name)
    try:
        # The helper runs in its own Python process. Prechecked classic limits
        # replace zipfile's conservative 2 GiB threshold and 5% size reserve.
        with _local_zip_lock:
            previous_limit = zipfile.ZIP64_LIMIT
            zipfile.ZIP64_LIMIT = CLASSIC_ZIP_SIZE * 2
            try:
                with ZipFile(temporary, "w", compression=ZIP_STORED, allowZip64=False) as output:
                    for name, size, directory, opener, mode in entries.entries:
                        item = ZipInfo(name)
                        item.compress_type = ZIP_STORED
                        item.file_size = size
                        item.external_attr = (mode or (stat.S_IFDIR | 0o755 if directory else stat.S_IFREG | 0o644)) << 16
                        if directory:
                            item.external_attr |= 0x10
                            output.writestr(item, b"")
                            continue
                        with opener() as source, output.open(item, "w", force_zip64=False) as destination:
                            copied = 0
                            while chunk := source.read(0x200000):
                                copied += len(chunk)
                                if copied > size:
                                    raise ValueError(f"save file changed while preparing it: {name}")
                                destination.write(chunk)
                            if copied != size:
                                raise ValueError(f"save file is truncated: {name}")
            finally:
                zipfile.ZIP64_LIMIT = previous_limit
        if temporary.stat().st_size > CLASSIC_ZIP_SIZE:
            raise ValueError("the local worker requires a classic ZIP smaller than 4 GiB")
        os.replace(temporary, archive)
    finally:
        temporary.unlink(missing_ok=True)
    return archive


# Function Local Workspace
def pack_local_workspace(workspace, archive):
    workspace = Path(workspace).expanduser()
    archive = Path(archive).expanduser()
    if workspace.is_symlink() or not workspace.is_dir():
        raise ValueError("select an existing decrypted workspace without links")
    root = workspace.resolve()
    if archive.resolve().is_relative_to(root):
        raise ValueError("save the local archive outside the decrypted workspace")
    entries = LocalEntries()
    for current, directories, files in os.walk(root):
        directories.sort()
        files.sort()
        current = Path(current)
        for name in directories:
            path = current / name
            if path.is_symlink() or not stat.S_ISDIR(path.lstat().st_mode):
                raise ValueError(f"workspace links are not supported: {path}")
            entries.add(path.relative_to(root).as_posix(), 0, True)
        for name in files:
            path = current / name
            details = path.lstat()
            if not stat.S_ISREG(details.st_mode):
                raise ValueError(f"workspace links or special files are not supported: {path}")
            size = details.st_size
            entries.add(path.relative_to(root).as_posix(), size, False,
                        lambda path=path, size=size: open_local_file(path, size), details.st_mode)
    return write_local_archive(entries, archive)


# Function Local Inputs
def pack_local_inputs(archive, inputs):
    archive = Path(archive).expanduser()
    entries = LocalEntries()
    with ExitStack() as stack:
        for selected in inputs:
            selected = Path(selected).expanduser()
            details = selected.lstat()
            if not stat.S_ISREG(details.st_mode):
                raise ValueError(f"save links or special files are not supported: {selected}")
            if selected.resolve() == archive.resolve():
                raise ValueError("save the local archive separately from its input files")
            if selected.suffix.lower() == ".zip" or zipfile.is_zipfile(selected):
                source = stack.enter_context(ZipFile(selected))
                file_count = 0
                for item in source.infolist():
                    mode = item.external_attr >> 16
                    kind = stat.S_IFMT(mode)
                    if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
                        raise ValueError(f"archive links or special files are not supported: {item.filename}")
                    directory = item.is_dir() or kind == stat.S_IFDIR
                    file_count += not directory
                    entries.add(item.filename, item.file_size, directory,
                                lambda source=source, item=item: source.open(item), mode)
                if not file_count:
                    raise ValueError(f"ZIP input contains no save files: {selected.name}")
            else:
                size = details.st_size
                entries.add(selected.name, size, False,
                            lambda selected=selected, size=size: open_local_file(selected, size), details.st_mode)
        return write_local_archive(entries, archive)


# Function Batch Results
def bundle_results(manifest, archive):
    manifest = Path(manifest).expanduser()
    archive = Path(archive).expanduser()
    details = manifest.lstat()
    if not stat.S_ISREG(details.st_mode):
        raise ValueError("select a regular batch manifest without links")
    with open_local_file(manifest, details.st_size) as source:
        document = json.load(source)
    results = document.get("results") if isinstance(document, dict) else None
    if not isinstance(results, list) or not results:
        raise ValueError("the batch manifest must contain save results")
    if archive.resolve() == manifest.resolve():
        raise ValueError("save the batch archive separately from its manifest")
    entries = []
    names = set()
    with ExitStack() as stack:
        for result in results:
            if not isinstance(result, dict):
                raise ValueError("invalid batch save result")
            title_id = result.get("titleId")
            name = result.get("encryptedName")
            if not isinstance(title_id, str) or not re.fullmatch(r"PPSA[0-9]{5}", title_id):
                raise ValueError("invalid batch result title ID")
            if (not isinstance(name, str) or not name or name in (".", "..")
                    or name.endswith((".", " "))
                    or any(ord(character) < 32 or character in '/\\<>:"|?*' for character in name)):
                raise ValueError("unsafe batch result name")
            destination = f"{title_id}/{name}"
            if destination.casefold() in names:
                raise ValueError(f"duplicate batch result path: {destination}")
            names.add(destination.casefold())
            selected = result.get("archive")
            if not isinstance(selected, str) or not Path(selected).is_absolute():
                raise ValueError("batch result archives must use absolute paths")
            selected = Path(selected)
            if selected.resolve() == archive.resolve():
                raise ValueError("save the batch archive separately from its input files")
            details = selected.lstat()
            if not stat.S_ISREG(details.st_mode):
                raise ValueError("batch result links or special files are not supported")
            stream = stack.enter_context(open_local_file(selected, details.st_size))
            source = stack.enter_context(ZipFile(stream))
            members = source.infolist()
            if len(members) != 1:
                raise ValueError(f"batch result must contain exactly one encrypted save: {selected.name}")
            item = members[0]
            kind = stat.S_IFMT(item.external_attr >> 16)
            if kind not in (0, stat.S_IFREG) or item.is_dir() or item.external_attr & 0x10:
                raise ValueError("batch result links, directories or special files are not supported")
            if item.filename != name or item.file_size <= 0:
                raise ValueError(f"batch result does not contain the expected encrypted save: {name}")
            entries.append((destination, source, item))
        archive.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(prefix=archive.name + ".", suffix=".tmp", dir=archive.parent)
        os.close(descriptor)
        temporary = Path(temporary_name)
        try:
            with ZipFile(temporary, "w", compression=ZIP_STORED, allowZip64=True) as output:
                for destination, source, item in entries:
                    info = ZipInfo(destination)
                    info.compress_type = ZIP_STORED
                    info.file_size = item.file_size
                    info.external_attr = (stat.S_IFREG | 0o644) << 16
                    with source.open(item) as input_stream, output.open(info, "w", force_zip64=True) as output_stream:
                        copied = 0
                        while chunk := input_stream.read(0x200000):
                            copied += len(chunk)
                            if copied > item.file_size:
                                raise ValueError(f"batch result size changed: {item.filename}")
                            output_stream.write(chunk)
                        if copied != item.file_size:
                            raise ValueError(f"batch result is truncated: {item.filename}")
            os.replace(temporary, archive)
        finally:
            temporary.unlink(missing_ok=True)
    return archive


def main():
    parser = argparse.ArgumentParser(description="Safely unpack and repack GarlicTransfer save workspaces")
    subparsers = parser.add_subparsers(dest="command", required=True)
    extract = subparsers.add_parser("extract")
    extract.add_argument("archive")
    extract.add_argument("workspace")
    pack = subparsers.add_parser("pack")
    pack.add_argument("workspace")
    pack.add_argument("archive")
    local_pack = subparsers.add_parser("local-pack")
    local_pack.add_argument("workspace")
    local_pack.add_argument("archive")
    local_inputs = subparsers.add_parser("local-inputs")
    local_inputs.add_argument("archive")
    local_inputs.add_argument("inputs", nargs="+")
    bundle = subparsers.add_parser("bundle-results")
    bundle.add_argument("manifest")
    bundle.add_argument("archive")
    args = parser.parse_args()
    try:
        if args.command == "extract":
            result = extract_archive(args.archive, args.workspace)
            output = {"workspace": str(result)}
        elif args.command == "pack":
            result = pack_workspace(args.workspace, args.archive)
            output = {"archive": str(result), "bytes": result.stat().st_size}
        elif args.command == "bundle-results":
            result = bundle_results(args.manifest, args.archive)
            with ZipFile(result) as bundled:
                count = len(bundled.infolist())
            output = {"archive": str(result), "bytes": result.stat().st_size, "count": count}
        else:
            result = (pack_local_workspace(args.workspace, args.archive)
                      if args.command == "local-pack" else pack_local_inputs(args.archive, args.inputs))
            output = {"archive": str(result), "bytes": result.stat().st_size}
        print(json.dumps(output), flush=True)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, zipfile.LargeZipFile, RuntimeError) as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == "__main__":
    main()
