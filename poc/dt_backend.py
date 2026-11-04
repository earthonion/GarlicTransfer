#!/usr/bin/env python3
import hashlib
import ipaddress
import json
import re
import sqlite3
import struct
import sys
from contextlib import closing
from pathlib import Path

from poc.dt_download import DtChannel, discovery_versions, download_entry, download_metadata, launch_console
from poc.dt_ppr_power import CAPTURED_BODY


def emit(kind, **values):
    print(json.dumps({"type": kind, **values}), flush=True)


def channel_host(client, interface, response, prefer_ipv6=False):
    if ":" in client:
        return client
    if prefer_ipv6:
        for line in response.splitlines():
            if line.startswith(b"host-address:"):
                address = ipaddress.IPv6Address(bytes.fromhex(line.split(b":", 1)[1].decode()))
                return f"{address.compressed}%{interface}"
    return client


def discovery_host_id(response):
    for line in response.splitlines():
        if line.startswith(b"host-id:"):
            return line.split(b":", 1)[1].decode().strip()
    return None


def hardware_id(options, response):
    requested = int(options.get("hardware", 0))
    if requested:
        return requested
    host_id = discovery_host_id(response)
    if host_id:
        return {"5C843CC6D727": 2, "5C96661F7C1A": 3}.get(host_id, 3)
    return 3


def power_request_prefix(account_id, metadata_path=None, prefix_path=None):
    """Hash the console owner's 8-byte PSN account ID for the 0x91 request.

    The UI sends a decimal string because JavaScript numbers cannot represent
    every 64-bit account ID exactly. A prior per-console metadata database can
    supply the same ID as a 16-character big-endian hex UUID.
    """
    if account_id is not None and str(account_id).strip():
        value = str(account_id).strip()
        if not re.fullmatch(r"[0-9]+", value):
            raise ValueError("accountId must be an unsigned decimal PSN account ID")
        number = int(value, 10)
        if not 0 <= number < 1 << 64:
            raise ValueError("accountId is outside the unsigned 64-bit range")
        raw = number.to_bytes(8, "big")
    elif prefix_path:
        with Path(prefix_path).open("rb") as stream:
            prefix = stream.read(33)
        if len(prefix) != 32:
            raise ValueError("paired power-request prefix must be exactly 32 bytes")
        return prefix
    elif metadata_path is not None and metadata_path.is_file():
        with closing(sqlite3.connect(metadata_path)) as db:
            rows = db.execute(
                "SELECT DISTINCT uuid FROM user_info_tbl "
                "WHERE target_owner = 1 AND online_user = 1"
            ).fetchall()
        if len(rows) != 1 or not isinstance(rows[0][0], str) or not re.fullmatch(r"[0-9a-fA-F]{16}", rows[0][0]):
            raise ValueError("metadata.db needs exactly one online target owner with a 16-digit UUID")
        raw = bytes.fromhex(rows[0][0])
    else:
        return None
    return hashlib.sha256(raw).digest()


def build_power_request_body(firmware_version, hardware, host_id_hex, prefix):
    body = bytearray(CAPTURED_BODY)
    if prefix is not None:
        if len(prefix) != 32:
            raise ValueError("power request prefix must be 32 bytes")
        body[:32] = prefix
    if host_id_hex and len(host_id_hex) == 12:
        body[32:38] = bytes.fromhex(host_id_hex)
    struct.pack_into("<I", body, 44, hardware)
    # Observed in a console-generated 14.22 request; older templates use 0x282.
    if firmware_version == 0x14220000:
        struct.pack_into("<I", body, 48, 0x284)
    struct.pack_into("<I", body, 76, firmware_version)
    struct.pack_into("<I", body, 84, firmware_version)
    return bytes(body)


def disconnect_console(command):
    emit("log", message="Sending DisconnectPS5; the console will reboot")
    sub = command.request(0x94, struct.pack("<Q", 0))
    try:
        result, _ = command.response(0x94, sub)
    except (EOFError, ConnectionResetError):
        result = 0
    if result != 0:
        raise RuntimeError(f"DisconnectPS5 failed with result {result:#x}")


def index_downloaded_manifests(output):
    combined = {}
    downloaded = set()
    for manifest_path in output.glob("*/manifest.json"):
        if not manifest_path.parent.name.isdigit():
            continue
        try:
            entry_id = int(manifest_path.parent.name)
            manifest = json.loads(manifest_path.read_text())
            entry = manifest.get(str(entry_id), {})
            files = entry.get("files", manifest.get("files", []))
            final_header = entry.get("final_header")
            if not files or not final_header:
                continue
            if not all(item.get("header") and (manifest_path.parent / item["file"]).is_file()
                       for item in files):
                continue
            combined[str(entry_id)] = {"files": files, "final_header": final_header}
            downloaded.add(entry_id)
        except (OSError, ValueError, KeyError, TypeError):
            continue
    (output / "manifest.json").write_text(json.dumps(combined, indent=2) + "\n")
    return downloaded


def download(options):
    oracle_host = options["oracleHost"]
    oracle_port = int(options.get("oraclePort", 9022))
    client = options["clientHost"]
    output = Path(options["output"]).expanduser()
    output.mkdir(parents=True, exist_ok=True)

    emit("status", step=1, message="Discovering the client console.")
    skip_launch = options.get("skipLaunch", False) and not options.get("preferIpv6", False)
    response = launch_console(client, skip_launch=skip_launch)
    host = channel_host(client, options["interface"], response, options.get("preferIpv6", False))
    protocol_version, firmware_version = discovery_versions(response)
    if options.get("approvalPrefixPath"):
        expected_host_id = str(options.get("hostId", ""))
        expected_version = str(options.get("systemVersion", ""))
        actual_host_id = discovery_host_id(response)
        if (not actual_host_id or actual_host_id.lower() != expected_host_id.lower()
                or f"{firmware_version:08x}" != expected_version.lower()):
            raise RuntimeError("Selected console identity changed; discover and pair it again")
    emit("log", message=f"Encrypted channel: {host}")
    emit("log", message=f"Protocol version: {protocol_version:#x}; body firmware: {firmware_version:#x}")

    command = None
    data = None
    try:
        if options.get("skipPower", False):
            emit("log", message="Reusing Data Transfer approval; no power request needed")
        else:
            emit("status", step=2, message="Approving Data Transfer. Press the CLIENT power button if asked.")
            prefix = (power_request_prefix(options.get("accountId"), output / "metadata.db",
                                           options.get("approvalPrefixPath"))
                      if firmware_version == 0x14220000 else None)
            if firmware_version == 0x14220000 and prefix is None:
                raise RuntimeError(
                    "14.22 needs a paired console or the PSN account ID for the first browse. "
                    "Pair through the PS5 Data Transfer menu, select a PS4 USB backup, "
                    "or enter the decimal account ID."
                )
            if prefix is not None:
                source = ("PSN account ID" if str(options.get("accountId", "")).strip() else
                          "paired console" if options.get("approvalPrefixPath") else "prior metadata")
                emit("log", message=f"Power request identity: {source}")
            else:
                emit("log", message="Power request identity: legacy captured template")
            host_id_hex = discovery_host_id(response)
            hardware = hardware_id(options, response)
            emit("log", message=f"Power request hardware ID: {hardware}")
            body = build_power_request_body(
                firmware_version, hardware, host_id_hex, prefix,
            )
            command = DtChannel(host, 1004, oracle_host, oracle_port, version=protocol_version)
            sub = command.request(0x91, body)
            result, _ = command.response(0x91, sub)
            if result == 33:
                emit("powerRequired", message="Press power button until it beeps and release")
                emit("status", step=2, message="Briefly press the CLIENT console power button now.")
                result, _ = command.response(0x91, sub)
            if result == 0x17:
                raise RuntimeError(
                    "client rejected Data Transfer with a hardware mismatch (0x17). "
                    f"Power request used hardware ID {hardware}; set Client hardware ID manually to 1, 2, or 3 to match the target."
                )
            if result != 0:
                hint = ""
                if result == 0x11 and firmware_version == 0x14220000:
                    hint = (" Stored pairing may be for a different PSN user; pair this PS5 again."
                            if options.get("approvalPrefixPath") and not str(options.get("accountId", "")).strip()
                            else " Check that the decimal PSN account ID belongs to this console user.")
                raise RuntimeError(f"client rejected Data Transfer with result {result:#x}.{hint}")

        emit("status", step=3, message="Downloading save metadata.")
        data = DtChannel(host, 1005, oracle_host, oracle_port, version=protocol_version)
        download_metadata(data, output)
        db = sqlite3.connect(output / "metadata.db")
        rows = db.execute(
            "SELECT id, path, actual_size FROM dir_entry_info_tbl WHERE target_type = 3 ORDER BY id"
        ).fetchall()
        users = [
            {
                "id": f"{user_id:08x}",
                "name": user_name or login_id or online_id or f"{user_id:08x}",
            }
            for user_id, user_name, login_id, online_id in db.execute(
                "SELECT user_id, user_name, login_id, online_id FROM user_info_tbl ORDER BY user_name"
            )
        ]
        db.close()
        downloaded_ids = index_downloaded_manifests(output)
        entries = []
        for entry_id, path, size in rows:
            parts = path.strip("/").split("/")
            entries.append({
                "id": entry_id,
                "title": Path(path.rstrip("/")).name,
                "owner": parts[2] if len(parts) > 2 else "unknown",
                "size": size,
                "downloaded": entry_id in downloaded_ids,
            })
        emit("entries", entries=entries, users=users)
        if options.get("metadataOnly"):
            disconnected = command is not None
            if command is not None:
                disconnect_console(command)
            emit(
                "done",
                message=(f"Metadata ready in {output}; found {len(downloaded_ids)} previously downloaded saves. "
                         + ("Console is rebooting." if disconnected else "Existing Data Transfer approval remains active.")),
                metadataOnly=True,
                consoleDisconnected=disconnected,
                users=users,
            )
            return

        def select_rows(entry_ids):
            requested_ids = {int(value) for value in entry_ids}
            available_ids = {row[0] for row in rows}
            missing_ids = requested_ids - available_ids
            if missing_ids:
                raise RuntimeError(f"save entries are not present on this console: {sorted(missing_ids)}")
            selected_rows = [row for row in rows if row[0] in requested_ids]
            if not selected_rows:
                raise RuntimeError("select at least one save entry to download")
            return selected_rows

        def download_rows(selected_rows):
            for index, (entry_id, _, _) in enumerate(selected_rows, 1):
                emit("status", step=4, message=f"Downloading entry {entry_id} ({index}/{len(selected_rows)}).")
                download_entry(data, entry_id, output)
            index_downloaded_manifests(output)

        if options.get("waitForSelection"):
            emit("ready", message="Select saves to download on the open Data Transfer session", users=users)
            for line in sys.stdin:
                if not line.strip():
                    continue
                request = json.loads(line)
                if request.get("action") == "finish":
                    if command is None:
                        raise RuntimeError("the Data Transfer command channel is not open")
                    disconnect_console(command)
                    emit("done", message="Disconnect sent. The console is rebooting.")
                    return
                selected_rows = select_rows(request.get("entryIds", []))
                download_rows(selected_rows)
                downloaded_ids = index_downloaded_manifests(output)
                for entry in entries:
                    entry["downloaded"] = entry["id"] in downloaded_ids
                emit(
                    "downloaded",
                    message=f"Downloaded {len(selected_rows)} selected save entries to {output}",
                    users=users,
                    entryIds=[row[0] for row in selected_rows],
                )
                emit("entries", entries=entries, users=users)
                emit("ready", message="Select more saves or close the download session", users=users)
            return

        selected_rows = select_rows(options.get("entryIds", []))
        download_rows(selected_rows)
        emit(
            "done",
            message=f"Downloaded {len(selected_rows)} selected save entries to {output}",
            users=users,
            entryIds=[row[0] for row in selected_rows],
        )
    finally:
        if data is not None:
            data.close()
        if command is not None:
            command.close()


def list_users(path):
    db = sqlite3.connect(path)
    users = [
            {
                "id": f"{user_id:08x}",
                "name": user_name or login_id or online_id or f"{user_id:08x}",
            }
            for user_id, user_name, login_id, online_id in db.execute(
                "SELECT user_id, user_name, login_id, online_id FROM user_info_tbl ORDER BY user_name"
            )
        ]
    db.close()
    emit("users", users=users)


def list_inventory(path):
    db = sqlite3.connect(path)
    rows = db.execute(
        "SELECT id, path, actual_size FROM dir_entry_info_tbl WHERE target_type = 3 ORDER BY id"
    ).fetchall()
    users = [
        {
            "id": f"{user_id:08x}",
            "name": user_name or login_id or online_id or f"{user_id:08x}",
        }
        for user_id, user_name, login_id, online_id in db.execute(
            "SELECT user_id, user_name, login_id, online_id FROM user_info_tbl ORDER BY user_name"
        )
    ]
    db.close()
    downloaded_ids = index_downloaded_manifests(Path(path).parent)
    entries = []
    for entry_id, save_path, size in rows:
        parts = save_path.strip("/").split("/")
        entries.append({
            "id": entry_id,
            "title": Path(save_path.rstrip("/")).name,
            "owner": parts[2] if len(parts) > 2 else "unknown",
            "size": size,
            "downloaded": entry_id in downloaded_ids,
        })
    emit("inventory", entries=entries, users=users)


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "users":
        list_users(sys.argv[2])
        return
    if len(sys.argv) == 3 and sys.argv[1] == "inventory":
        list_inventory(sys.argv[2])
        return
    if len(sys.argv) != 3 or sys.argv[1] != "download":
        raise SystemExit("usage: python3 -m poc.dt_backend download '<options-json>'")
    options = json.loads(sys.stdin.readline() if sys.argv[2] == "-" else sys.argv[2])
    try:
        download(options)
    except Exception as exc:
        emit("error", message=f"{type(exc).__name__}: {exc}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
