#!/usr/bin/env python3
import argparse
import json
import os
import shutil
from pathlib import Path

from poc.dt_metadata import infer_title_id, load_manifest


def public_entry(entry_id, entry):
    files = [
        {
            "file": item["file"],
            "path": item["path"],
            "size": item["size"],
            "sha256": item["sha256"],
        }
        for item in entry["files"]
    ]
    owner = files[0]["path"].strip("/").split("/")[2] if files else ""
    return {
        "id": entry_id,
        "title": infer_title_id("", entry["files"]),
        "owner": owner,
        "files": files,
    }


def local_inventory(assets):
    assets = Path(assets).expanduser()
    root_manifest = assets / "manifest.json"
    entry_ids = set()
    if root_manifest.is_file():
        document = json.loads(root_manifest.read_text())
        entry_ids.update(int(key) for key in document if key.isdigit())
    for directory in assets.iterdir() if assets.is_dir() else []:
        if directory.name.isdigit() and (directory / "manifest.json").is_file():
            entry_ids.add(int(directory.name))
    if not entry_ids:
        raise ValueError(f"no downloaded saves were found under {assets}")
    entries = []
    for entry_id in sorted(entry_ids):
        actual_id, entry = load_manifest(assets, entry_id)
        entries.append(public_entry(actual_id, entry))
    return entries


def selected_file(assets, entry_id, filename):
    actual_id, entry = load_manifest(assets, entry_id)
    for item in entry["files"]:
        if item["file"] == filename:
            path = next(
                candidate
                for candidate in (assets / str(entry_id) / filename, assets / filename)
                if candidate.is_file()
            )
            return actual_id, entry, item, path
    raise ValueError(f"save file {filename} is not present in entry {entry_id}")


def export_save(assets, entry_id, filename, destination):
    _, _, _, source = selected_file(Path(assets).expanduser(), entry_id, filename)
    destination = Path(destination).expanduser()
    if not destination.is_dir():
        raise ValueError("select an existing export directory")
    target = destination / source.name
    if source.resolve() == target.resolve():
        raise ValueError("the export destination is the same as the source file")
    shutil.copyfile(source, target)
    return target


def replace_manifest(assets, entry_id, entry):
    assets = Path(assets).expanduser()
    root_path = assets / "manifest.json"
    entry_path = assets / str(entry_id) / "manifest.json"
    if root_path.is_file():
        document = json.loads(root_path.read_text())
        document[str(entry_id)] = entry
        temporary = root_path.with_name(root_path.name + ".import.tmp")
        temporary.write_text(json.dumps(document, indent=2) + "\n")
        os.replace(temporary, root_path)
    document = json.loads(entry_path.read_text()) if entry_path.is_file() else {}
    document["entry_id"] = entry_id
    document["files"] = entry["files"]
    document[str(entry_id)] = entry
    temporary = entry_path.with_name(entry_path.name + ".import.tmp")
    temporary.write_text(json.dumps(document, indent=2) + "\n")
    os.replace(temporary, entry_path)


def import_save(assets, entry_id, filename, source):
    assets = Path(assets).expanduser()
    _, _, _, target = selected_file(assets, entry_id, filename)
    source = Path(source).expanduser()
    if not source.is_file() or source.stat().st_size <= 0:
        raise ValueError("the import image is missing or empty")
    if source.resolve() == target.resolve():
        raise ValueError("the import source and destination are the same file")
    temporary = target.with_name(target.name + ".import.tmp")
    shutil.copyfile(source, temporary)
    try:
        with temporary.open("r+b") as stream:
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        actual_id, entry = load_manifest(assets, entry_id)
        replace_manifest(assets, actual_id, entry)
        return public_entry(actual_id, entry)
    finally:
        if temporary.exists():
            temporary.unlink()


def main():
    parser = argparse.ArgumentParser(description="Manage downloaded GarlicTransfer save files")
    subparsers = parser.add_subparsers(dest="command", required=True)
    list_parser = subparsers.add_parser("list")
    list_parser.add_argument("assets")
    for name in ("export", "import"):
        command = subparsers.add_parser(name)
        command.add_argument("assets")
        command.add_argument("entry_id", type=int)
        command.add_argument("filename")
        command.add_argument("destination")
    args = parser.parse_args()
    try:
        if args.command == "list":
            result = {"entries": local_inventory(args.assets)}
        elif args.command == "export":
            destination = export_save(args.assets, args.entry_id, args.filename, args.destination)
            result = {"destination": str(destination)}
        else:
            entry = import_save(args.assets, args.entry_id, args.filename, args.destination)
            result = {"entry": entry}
        print(json.dumps(result), flush=True)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise SystemExit(str(exc)) from exc


if __name__ == "__main__":
    main()
