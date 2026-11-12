#!/usr/bin/env python3
import argparse
import json
import os
import stat
from pathlib import Path, PurePosixPath
from zipfile import ZIP_DEFLATED, ZipFile


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


def main():
    parser = argparse.ArgumentParser(description="Safely unpack and repack GarlicTransfer save workspaces")
    subparsers = parser.add_subparsers(dest="command", required=True)
    extract = subparsers.add_parser("extract")
    extract.add_argument("archive")
    extract.add_argument("workspace")
    pack = subparsers.add_parser("pack")
    pack.add_argument("workspace")
    pack.add_argument("archive")
    args = parser.parse_args()
    try:
        if args.command == "extract":
            result = extract_archive(args.archive, args.workspace)
            output = {"workspace": str(result)}
        else:
            result = pack_workspace(args.workspace, args.archive)
            output = {"archive": str(result), "bytes": result.stat().st_size}
        print(json.dumps(output), flush=True)
    except (OSError, ValueError, KeyError) as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == "__main__":
    main()
