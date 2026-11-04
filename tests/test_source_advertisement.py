"""Exercise the upload source's live discovery replies on a local loopback route."""

import ipaddress
import os
from pathlib import Path
import socket
import subprocess
import struct
import sys
import tempfile
import time
import unittest

from poc.dt_backend import build_power_request_body
from poc.dt_source import console_info_for_power_request, selected_client, system_version_bytes


ROOT = Path(__file__).resolve().parents[1]


def available_port(kind):
    with socket.socket(socket.AF_INET, kind) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class SourceAdvertisementTest(unittest.TestCase):
    def test_restricts_connections_to_selected_console(self):
        self.assertTrue(selected_client(("127.0.0.1", 1004), "127.0.0.1"))
        self.assertTrue(selected_client(("::ffff:127.0.0.1", 1004), "127.0.0.1"))
        self.assertFalse(selected_client(("127.0.0.2", 1004), "127.0.0.1"))

    def test_requires_eight_digit_console_version(self):
        self.assertEqual(system_version_bytes("14220000"), b"14220000")
        with self.assertRaises(ValueError):
            system_version_bytes("1422000f")

    def test_console_info_matches_advertised_identity_and_1422_request(self):
        request = build_power_request_body(
            0x14220000, 0x12345678, "020000000001", bytes(32)
        )
        response = console_info_for_power_request(request)
        self.assertEqual(response[:6], bytes.fromhex("020000000001"))
        self.assertEqual(struct.unpack_from("<I", response, 8)[0], 0x12345678)
        self.assertEqual(struct.unpack_from("<I", response, 12)[0], 0x284)
        self.assertEqual(struct.unpack_from("<I", response, 32)[0], 0x14220000)
        self.assertEqual(struct.unpack_from("<I", response, 44)[0], 0x14220000)

    def test_uses_selected_console_version_and_local_route(self):
        command_port = available_port(socket.SOCK_STREAM)
        data_port = available_port(socket.SOCK_STREAM)
        discovery_port = available_port(socket.SOCK_DGRAM)
        with tempfile.TemporaryDirectory() as temp:
            environment = {**os.environ, "DT_LOG": str(Path(temp) / "source.log")}
            process = subprocess.Popen(
                [
                    sys.executable, "-u", "-m", "poc.dt_source",
                    "--client-host", "127.0.0.1",
                    "--system-version", "14220000",
                    "--port", str(command_port),
                    "--data-port", str(data_port),
                    "--discovery-port", str(discovery_port),
                ],
                cwd=ROOT,
                env=environment,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
                    probe.settimeout(0.25)
                    deadline = time.monotonic() + 5
                    while True:
                        probe.sendto(b"SRCH * HTTP/1.1\n", ("127.0.0.1", discovery_port))
                        try:
                            search, _ = probe.recvfrom(4096)
                            break
                        except socket.timeout:
                            if process.poll() is not None or time.monotonic() >= deadline:
                                self.fail("upload source did not answer discovery")
                    self.assertIn(b"system-version:14220000\n", search)
                    probe.sendto(b"LAUNCH4 * HTTP/1.1\n", ("127.0.0.1", discovery_port))
                    launch, _ = probe.recvfrom(4096)
                    expected = ipaddress.IPv6Address("::ffff:127.0.0.1").packed.hex().encode()
                    self.assertIn(b"host-address:" + expected + b"\n", launch)
            finally:
                process.terminate()
                process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
