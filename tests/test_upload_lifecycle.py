import socket
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from poc import dt_source
from poc.dt_backend import build_power_request_body, power_request_prefix
from poc.dt_download import DtChannel
from poc.dt_psk_client import derive_keys


class UploadLifecycleTests(unittest.TestCase):
    def test_b3_waits_for_disconnect_instead_of_killing_backend(self):
        source = Path(__file__).resolve().parent.parent.joinpath("electron", "main.cjs").read_text()
        b3 = source.index("if (line.toLowerCase().includes('cmd=0xb3'))")
        b4 = source.index("if (active.transferFinished && !active.rebootRequested && line.toLowerCase().includes('response complete cmd=0x94'))")
        self.assertIn("active.transferFinished = true", source[b3:b4])
        self.assertNotIn("stopActive", source[b3:b4])
        disconnect_block = source[b4:source.index("child.stderr.on", b4)]
        self.assertIn("active.completed = true", disconnect_block)
        self.assertIn("stopActive", disconnect_block)

    def test_reboot_auth_reconnect_finishes_before_backend_stops(self):
        source = Path(__file__).resolve().parent.parent.joinpath("electron", "main.cjs").read_text()
        reboot = source.index("active.rebootRequested = true")
        authenticated = source.index("active.rebootAuthenticated = true", reboot)
        closed = source.index("active.rebootAuthenticated && line.includes('[cmd] session ended:')", authenticated)
        self.assertLess(reboot, authenticated)
        self.assertLess(authenticated, closed)
        self.assertIn("!active.rebootRequested", source[reboot:closed])
        self.assertIn("stopActive", source[closed:source.index("child.stderr.on", closed)])

    def test_clean_close_after_b3_is_also_a_success(self):
        source = Path(__file__).resolve().parent.parent.joinpath("electron", "main.cjs").read_text()
        self.assertIn("active.transferFinished && !active.completed && code === 0", source)

    def test_stop_clears_active_before_killing_process(self):
        source = Path(__file__).resolve().parent.parent.joinpath("electron", "main.cjs").read_text()
        stop = source[source.index("function stopActive()"):source.index("function startDownload")]
        self.assertLess(stop.index("active = null"), stop.index("session.process.kill()"))
        self.assertNotIn("active.process.kill()", stop)

    def test_upload_power_body_caches_pairing_prefix(self):
        import os
        import tempfile
        from poc.dt_ppr_power import CAPTURED_BODY

        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder) / "pairings" / "prefix.bin"
            environment = {
                "DT_PAIRING_PREFIX": str(destination),
                "DT_EXPECTED_HOST_ID": "5C843CC6D727",
            }
            with patch.dict(os.environ, environment):
                dt_source.cache_pairing_prefix(CAPTURED_BODY)
            self.assertEqual(destination.read_bytes(), CAPTURED_BODY[:32])

            with patch.dict(os.environ, {**environment, "DT_EXPECTED_HOST_ID": "000000000001"}):
                with self.assertRaisesRegex(ValueError, "does not match"):
                    dt_source.cache_pairing_prefix(CAPTURED_BODY)
            self.assertEqual(destination.read_bytes(), CAPTURED_BODY[:32])

    def test_download_falls_back_to_pairing_and_upload_supplies_prefix_path(self):
        source = Path(__file__).resolve().parent.parent.joinpath("electron", "main.cjs").read_text()
        download = source[source.index("function startDownload"):source.index("function startPairing")]
        self.assertIn("!paired && !fs.existsSync(metadataPath)", download)
        self.assertIn("startPairing(options)", download)
        upload = source[source.index("function startUpload"):source.index("function finish")]
        self.assertIn("const prefixPath = pairingPrefixPath(app.getPath('userData'), options)", upload)
        self.assertIn("fs.mkdirSync(path.dirname(prefixPath)", upload)
        self.assertIn("DT_PAIRING_PREFIX: prefixPath", upload)
        self.assertIn("DT_PAIRING_UID = String(process.getuid())", upload)
        self.assertIn("DT_PAIRING_GID = String(process.getgid())", upload)
        self.assertIn("DT_EXPECTED_HOST_ID: String(options.hostId)", upload)

    def test_auto_power_does_not_require_stdin(self):
        import os

        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        errors = []

        def serve():
            try:
                client, _ = listener.accept()
                with client:
                    dt_source.serve_command(client, "unused", 0)
            except EOFError:
                pass
            except Exception as exc:
                errors.append(exc)

        def derive_source(sock, oracle_host, oracle_port, client_value, server_value):
            return derive_keys(client_value, server_value)

        def derive_oracle(host, port, client_value, server_value):
            return derive_keys(client_value, server_value)

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        channel = None
        try:
            with patch.dict(os.environ, {"DT_AUTO_POWER": "1"}), \
                 patch.object(dt_source, "derive_session", side_effect=derive_source), \
                 patch("poc.dt_download.derive_with_oracle", side_effect=derive_oracle):
                channel = DtChannel("127.0.0.1", port, "unused", 0)
                channel.sock.settimeout(5)
                body = build_power_request_body(
                    0x13600007,
                    2,
                    "5C843CC6D727",
                    power_request_prefix("72623859790382856"),
                )
                sub = channel.request(0x91, body)
                self.assertEqual(channel.response(0x91, sub)[0], 33)
                result, response = channel.response(0x91, sub)
                self.assertEqual(result, 0)
                self.assertEqual(len(response), 72)
        finally:
            if channel is not None:
                channel.close()
            listener.close()
            thread.join(timeout=2)

        self.assertEqual(errors, [])
        self.assertFalse(thread.is_alive())

    def test_auth_b3_and_disconnect_share_one_command_channel(self):
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        errors = []

        def serve():
            try:
                client, _ = listener.accept()
                with client:
                    dt_source.serve_command(client, "unused", 0)
            except Exception as exc:
                errors.append(exc)

        def derive_source(sock, oracle_host, oracle_port, client_value, server_value):
            return derive_keys(client_value, server_value)

        def derive_oracle(host, port, client_value, server_value):
            return derive_keys(client_value, server_value)

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        channel = None
        try:
            with patch.object(dt_source, "derive_session", side_effect=derive_source), \
                 patch("poc.dt_download.derive_with_oracle", side_effect=derive_oracle):
                channel = DtChannel("127.0.0.1", port, "unused", 0)
                body = build_power_request_body(
                    0x13600007,
                    2,
                    "5C843CC6D727",
                    power_request_prefix("72623859790382856"),
                )
                sub = channel.request(0x93, body)
                result, response = channel.response(0x93, sub)
                self.assertEqual(result, 0)
                self.assertEqual(len(response), 72)

                sub = channel.request(0xB3)
                self.assertEqual(channel.response(0xB3, sub), (0, b""))

                sub = channel.request(0x94)
                self.assertEqual(channel.response(0x94, sub), (0, b""))
        finally:
            if channel is not None:
                channel.close()
            listener.close()
            thread.join(timeout=2)

        self.assertEqual(errors, [])
        self.assertFalse(thread.is_alive())

    def test_b0_allows_reboot_auth_on_the_next_connection(self):
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        errors = []

        def serve():
            try:
                for _ in range(2):
                    client, _ = listener.accept()
                    with client:
                        try:
                            dt_source.serve_command(client, "unused", 0)
                        except EOFError:
                            pass
            except Exception as exc:
                errors.append(exc)

        def derive_source(sock, oracle_host, oracle_port, client_value, server_value):
            return derive_keys(client_value, server_value)

        def derive_oracle(host, port, client_value, server_value):
            return derive_keys(client_value, server_value)

        def authenticate(channel):
            body = build_power_request_body(
                0x13600007,
                2,
                "5C843CC6D727",
                power_request_prefix("72623859790382856"),
            )
            sub = channel.request(0x93, body)
            result, response = channel.response(0x93, sub)
            self.assertEqual(result, 0)
            self.assertEqual(len(response), 72)

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        channels = []
        try:
            with patch.object(dt_source, "derive_session", side_effect=derive_source), \
                 patch("poc.dt_download.derive_with_oracle", side_effect=derive_oracle):
                first = DtChannel("127.0.0.1", port, "unused", 0)
                channels.append(first)
                first.sock.settimeout(5)
                authenticate(first)
                sub = first.request(0xB0)
                self.assertEqual(first.response(0xB0, sub), (0, b""))
                first.close()

                second = DtChannel("127.0.0.1", port, "unused", 0)
                channels.append(second)
                second.sock.settimeout(5)
                authenticate(second)
                second.close()
        finally:
            for channel in channels:
                channel.close()
            listener.close()
            thread.join(timeout=2)

        self.assertEqual(errors, [])
        self.assertFalse(thread.is_alive())

    def test_data_close_is_clean_and_accepts_another_connection(self):
        import io
        import struct
        from contextlib import redirect_stdout

        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen(2)
        port = listener.getsockname()[1]
        errors = []

        def serve():
            try:
                dt_source.data_server(listener, "unused", 0)
            except OSError:
                pass
            except Exception as exc:
                errors.append(exc)

        def derive_source(sock, oracle_host, oracle_port, client_value, server_value):
            return derive_keys(client_value, server_value)

        def derive_oracle(host, port, client_value, server_value):
            return derive_keys(client_value, server_value)

        thread = threading.Thread(target=serve, daemon=True)
        logs = io.StringIO()
        channels = []
        try:
            with redirect_stdout(logs), \
                 patch.object(dt_source, "derive_session", side_effect=derive_source), \
                 patch("poc.dt_download.derive_with_oracle", side_effect=derive_oracle):
                thread.start()
                first = DtChannel("127.0.0.1", port, "unused", 0)
                channels.append(first)
                first.close()

                second = DtChannel("127.0.0.1", port, "unused", 0)
                channels.append(second)
                second.sock.settimeout(5)
                sub = second.request(0xB3, struct.pack("<II", 2, 0))
                self.assertEqual(second.response(0xB3, sub), (0, b""))
                second.close()

                listener.settimeout(0.1)
                third = DtChannel("127.0.0.1", port, "unused", 0)
                channels.append(third)
                third.close()
                thread.join(timeout=2)
        finally:
            for channel in channels:
                channel.close()
            thread.join(timeout=2)
            listener.close()

        self.assertEqual(errors, [])
        self.assertFalse(thread.is_alive())
        self.assertIn("[data] session ended: connection closed after 0/24 bytes", logs.getvalue())
        self.assertEqual(logs.getvalue().count("[data] completion:"), 3)


if __name__ == "__main__":
    unittest.main()
