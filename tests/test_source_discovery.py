import socket
import struct
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, call, patch

from poc import dt_source


class _PacketsComplete(Exception):
    pass


class AddressHelperTests(unittest.TestCase):
    def test_packed_address_accepts_ipv4_and_ipv6(self):
        # DDP's host-address is always 16 bytes; an IPv4 goes in mapped form
        self.assertEqual(dt_source.packed_address("192.168.1.50"),
                         bytes.fromhex("00000000000000000000ffffc0a80132"))
        self.assertEqual(dt_source.packed_address("127.0.0.1"),
                         bytes.fromhex("00000000000000000000ffff7f000001"))
        self.assertEqual(dt_source.packed_address("fe80::1"),
                         bytes.fromhex("fe800000000000000000000000000001"))
        self.assertEqual(len(dt_source.packed_address("10.0.0.1")), 16)

    def test_ipv4_mapped_matches_the_captured_form(self):
        # export_test_1 advertised the sender's own 192.168.50.86 as
        # 00000000000000000000ffffc0a83256
        self.assertEqual(dt_source.ipv4_mapped("192.168.50.86").hex(),
                         "00000000000000000000ffffc0a83256")
        self.assertIsNone(dt_source.ipv4_mapped("not-an-ip"))
        self.assertIsNone(dt_source.ipv4_mapped(""))

    def test_packed_address_rejects_nonsense(self):
        for bad in ("", "192.168.1", "fe80::1::2", "hello"):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                dt_source.packed_address(bad)

    def test_local_ipv4_toward_returns_a_local_address(self):
        found = dt_source.local_ipv4_toward("127.0.0.1")
        self.assertEqual(found, "127.0.0.1")
        self.assertEqual(dt_source.local_ipv4_toward("this is not a host"), "")


class DiscoveryReplyTests(unittest.TestCase):
    """The address we advertise must be ours, not the developer's captured one.

    Regression: DATA_ADDRESS was a module constant holding
    00000000000000000000ffffc0a8006f (192.168.0.111) and --advertise-address only
    accepted IPv6, so on any other network the console was told to open its data
    connection to a host that does not exist.  Discovery still looked fine, which
    is why the failure landed "at discovery or just after it".
    """

    def setUp(self):
        state = patch.multiple(dt_source,
                               DATA_ADDRESS=dt_source.packed_address("192.0.2.1"),
                               ADDRESS_PINNED=False,
                               SYSTEM_VERSION=b"14200007",
                               HOST_NAME=b"GarlicTransfer")
        state.start()
        self.addCleanup(state.stop)

    # Function Discovery Replies
    def replies(self, *payloads):
        peer = ("127.0.0.1", 53000)
        transport = Mock()
        transport.recvfrom.side_effect = [(payload, peer) for payload in payloads] + [_PacketsComplete()]
        network = SimpleNamespace(
            AF_INET=socket.AF_INET, AF_INET6=socket.AF_INET6,
            SOCK_DGRAM=socket.SOCK_DGRAM, SOL_SOCKET=socket.SOL_SOCKET,
            SO_REUSEADDR=socket.SO_REUSEADDR,
            socket=Mock(return_value=transport))
        expected_probes = sum(not dt_source.ADDRESS_PINNED and
                              payload.split(b" ", 1)[0] in (b"SRCH", b"LAUNCH4")
                              for payload in payloads)
        with patch.object(dt_source, "socket", network), \
             patch.object(dt_source, "local_ipv4_toward", return_value=peer[0]) as detect:
            with self.assertRaises(_PacketsComplete):
                dt_source.discovery_server(1006)
        network.socket.assert_called_once_with(socket.AF_INET, socket.SOCK_DGRAM)
        transport.setsockopt.assert_called_once_with(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        transport.bind.assert_called_once_with(("0.0.0.0", 1006))
        self.assertEqual(detect.call_args_list, [call(peer[0])] * expected_probes)
        responses = []
        for sent in transport.sendto.call_args_list:
            response, destination = sent.args
            self.assertEqual(destination, peer)
            self.assertIsInstance(response, bytes)
            responses.append(response)
        return responses

    def test_srch_reply_shape(self):
        reply, = self.replies(b"SRCH * HTTP/1.1\n"
                              b"device-discovery-protocol-version:00030000\n")
        text = reply.decode()
        self.assertTrue(text.startswith("HTTP/1.1 200 Ok\n"), text)
        for field in ("host-id:", "host-request-port:", "host-type:PS5",
                      "host-name:GarlicTransfer", "system-version:",
                      "device-discovery-protocol-version:00030010"):
            self.assertIn(field, text)
        # only LAUNCH4 carries host-address, as in the captures
        self.assertNotIn("host-address:", text)
        # The reply must use the interface detected for its peer.
        self.assertTrue(dt_source.DATA_ADDRESS.endswith(bytes((127, 0, 0, 1))),
                        dt_source.DATA_ADDRESS.hex())

    def test_srch_uses_the_configured_display_name(self):
        dt_source.HOST_NAME = b"Living Room PC"
        reply, = self.replies(b"SRCH * HTTP/1.1\n")
        self.assertIn(b"host-name:Living Room PC\n", reply)

    def test_launch4_advertises_our_own_address(self):
        _, reply = self.replies(b"SRCH * HTTP/1.1\n",
                                b"LAUNCH4 * HTTP/1.1\n"
                                b"device-discovery-protocol-version:00030000\n")
        text = reply.decode()
        fields = dict(
            line.split(":", 1) for line in text.splitlines()[1:] if ":" in line
        )
        self.assertEqual(fields.get("host-network"), "0")
        self.assertEqual(fields.get("host-address"),
                         "00000000000000000000ffff7f000001",
                         "the console would be sent to the wrong host for its data connection")
        self.assertNotEqual(fields.get("host-address"),
                            "00000000000000000000ffffc0a8006f",
                            "still advertising the captured 192.168.0.111")
        self.assertEqual(int(fields["host-request-port"]), dt_source.COMMAND_PORT)

    def test_pinned_address_is_not_overridden_by_detection(self):
        dt_source.ADDRESS_PINNED = True
        dt_source.DATA_ADDRESS = dt_source.packed_address("10.9.8.7")
        reply, = self.replies(b"LAUNCH4 * HTTP/1.1\n")
        fields = dict(line.split(":", 1) for line in reply.decode().splitlines()[1:]
                      if ":" in line)
        self.assertEqual(fields.get("host-address"), "00000000000000000000ffff0a090807")

    def test_unknown_verbs_are_ignored(self):
        # Only SRCH replies, and it is processed after the ignored datagram.
        reply, = self.replies(b"WAKEUP * HTTP/1.1\n", b"SRCH * HTTP/1.1\n")
        self.assertIn(b"200 Ok", reply)
        self.assertIn(b"host-type:PS5\n", reply)


class DisplayNameConfigurationTests(unittest.TestCase):
    def test_display_name_defaults_and_reads_the_environment(self):
        import os
        from unittest.mock import patch

        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(dt_source.configured_host_name(), b"GarlicTransfer")
        with patch.dict(os.environ, {"DT_HOST_NAME": "  Bedroom PS5  "}):
            self.assertEqual(dt_source.configured_host_name(), b"Bedroom PS5")

    def test_display_name_rejects_invalid_protocol_values(self):
        import os
        from unittest.mock import patch

        for value in ("", "x" * 33, "bad\nname", "bad\rname", "caf\u00e9"):
            with self.subTest(value=value), patch.dict(os.environ, {"DT_HOST_NAME": value}):
                with self.assertRaises(ValueError):
                    dt_source.configured_host_name()


class DeriveSessionTests(unittest.TestCase):
    def test_ipv6_uses_oracle_keys_by_default(self):
        sock = SimpleNamespace(family=socket.AF_INET6)
        with patch.object(dt_source, "LOCAL_PSK", False), \
             patch.object(dt_source, "derive_with_oracle", return_value="oracle") as oracle, \
             patch.object(dt_source, "derive_keys", return_value="local") as local:
            self.assertEqual(dt_source.derive_session(sock, "oracle-host", 9022, b"client", b"server"), "oracle")
        oracle.assert_called_once_with("oracle-host", 9022, b"client", b"server")
        local.assert_not_called()

    def test_explicit_ipv6_mode_uses_local_psk(self):
        sock = SimpleNamespace(family=socket.AF_INET6)
        with patch.object(dt_source, "LOCAL_PSK", True), \
             patch.object(dt_source, "derive_with_oracle", return_value="oracle") as oracle, \
             patch.object(dt_source, "derive_keys", return_value="local") as local:
            self.assertEqual(dt_source.derive_session(sock, "oracle-host", 9022, b"client", b"server"), "local")
        local.assert_called_once_with(b"client", b"server")
        oracle.assert_not_called()


class OracleConfigurationTests(unittest.TestCase):
    """The oracle location must come from the app, not a hardcoded LAN address."""

    def test_environment_supplies_the_oracle_defaults(self):
        """The oracle location and advertise address must be settable from the app.

        main.cjs spawns this module with no argv, so the environment is the only
        channel it has; before this the oracle silently defaulted to
        192.168.0.125:9022 and upload could not derive keys off the developer's LAN.
        """
        import os
        from pathlib import Path
        saved = {k: os.environ.get(k) for k in ("DT_ORACLE_HOST", "DT_ORACLE_PORT",
                                                "DT_ADVERTISE", "DT_SYSTEM_VERSION")}
        os.environ["DT_ADVERTISE"] = "192.168.5.44"
        try:
            source = Path(dt_source.__file__).read_text(encoding="utf-8")
            for needle in ('os.environ.get("DT_ORACLE_HOST"',
                           'os.environ.get("DT_ORACLE_PORT"',
                           'os.environ.get("DT_ADVERTISE")',
                           'os.environ.get("DT_SYSTEM_VERSION"'):
                self.assertIn(needle, source, f"{needle} is not read from the environment")
            # an IPv4 advertise address must be accepted; it used to require IPv6
            self.assertIn("packed_address(args.advertise_address)", source)
            self.assertNotIn("ipaddress.IPv6Address(args.advertise_address).packed", source)
            self.assertEqual(dt_source.packed_address(os.environ["DT_ADVERTISE"]),
                             bytes.fromhex("00000000000000000000ffffc0a8052c"))
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_console_info_carries_the_detected_address(self):
        with patch.object(dt_source, "DATA_ADDRESS", dt_source.packed_address("192.168.5.44")):
            body = dt_source.console_info(3, 0x290, b"np", 0x13600007, 0x13600007)
        self.assertEqual(len(body), 72)
        self.assertEqual(body[:6], bytes.fromhex(dt_source.HOST_ID.decode()))
        self.assertEqual(body[48:64], bytes.fromhex("00000000000000000000ffffc0a8052c"))
        self.assertEqual(struct.unpack_from("<I", body, 32)[0], 0x13600007)

    def test_console_info_supports_the_extended_ps5_pro_layout(self):
        address = dt_source.packed_address("fe80::1234")
        body = dt_source.console_info(3, 0x290, b"np", 0x14230000, 0x14230000,
                                      data_address=address, extended=True)
        self.assertEqual(len(body), 72)
        self.assertEqual(struct.unpack_from("<H", body, 16)[0], 0)
        self.assertEqual(struct.unpack_from("<I", body, 40)[0], 0x14230000)
        self.assertEqual(struct.unpack_from("<I", body, 48)[0], 1)
        self.assertEqual(struct.unpack_from("<I", body, 52)[0], 0x14230000)
        self.assertEqual(body[56:72], address)

    def test_local_link_local_uses_the_command_adapter(self):
        class FakeSocket:
            def getsockname(self):
                return ("192.168.1.50", 1004)
        addresses = {"eth0": [
            SimpleNamespace(family=socket.AF_INET, address="192.168.1.50"),
            SimpleNamespace(family=socket.AF_INET6, address="fe80::1234"),
            SimpleNamespace(family=socket.AF_INET6, address="2001:db8::1"),
        ]}
        with patch("psutil.net_if_addrs", return_value=addresses):
            self.assertEqual(dt_source.local_link_local(FakeSocket()),
                             dt_source.packed_address("fe80::1234"))

    def test_local_link_local_requires_ipv6(self):
        class FakeSocket:
            def getsockname(self):
                return ("192.168.1.50", 1004)
        addresses = {"eth0": [SimpleNamespace(family=socket.AF_INET, address="192.168.1.50")]}
        with patch("psutil.net_if_addrs", return_value=addresses):
            with self.assertRaisesRegex(ValueError, "enable IPv6"):
                dt_source.local_link_local(FakeSocket())


class PowerExchangeTests(unittest.TestCase):
    def test_power_response_matches_each_console(self):
        from poc.dt_backend import build_power_request_body, power_request_prefix
        from poc.dt_download import DtChannel
        from poc.dt_psk_client import derive_keys

        for firmware, hardware, host_id, protocol in (
            (0x13600007, 2, "5C843CC6D727", 0x130),
            (0x14220000, 3, "5C96661F7C1A", 0x140),
        ):
            with self.subTest(firmware=f"{firmware:08x}"):
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
                            dt_source.serve_command(client, "unused", 0, prepare_ipv6=lambda: None)
                    except EOFError:
                        pass
                    except Exception as exc:
                        errors.append(exc)

                thread = threading.Thread(target=serve, daemon=True)
                thread.start()

                def derive_source(sock, oracle_host, oracle_port, client_value, server_value):
                    return derive_keys(client_value, server_value)

                def derive_oracle(host, port, client_value, server_value):
                    return derive_keys(client_value, server_value)

                body = build_power_request_body(
                    firmware, hardware, host_id, power_request_prefix("72623859790382856")
                )
                channel = None
                timer = threading.Timer(0.5, dt_source.POWER_EVENT.set)
                try:
                    from unittest.mock import patch
                    with patch.object(dt_source, "derive_session", side_effect=derive_source), \
                         patch.object(dt_source, "local_link_local", return_value=dt_source.packed_address("fe80::1234")), \
                         patch("poc.dt_download.derive_with_oracle", side_effect=derive_oracle):
                        channel = DtChannel("127.0.0.1", port, "unused", 0, version=protocol)
                        timer.start()
                        sub = channel.request(0x91, body)
                        result, _ = channel.response(0x91, sub)
                        self.assertEqual(result, 33)
                        result, response = channel.response(0x91, sub)
                        self.assertEqual(result, 0)
                        self.assertEqual(struct.unpack_from("<I", response, 32)[0], firmware)
                        if hardware == 3:
                            self.assertEqual(struct.unpack_from("<I", response, 40)[0], firmware)
                            self.assertEqual(struct.unpack_from("<I", response, 44)[0], 0)
                            self.assertEqual(struct.unpack_from("<I", response, 48)[0], 1)
                            self.assertEqual(struct.unpack_from("<I", response, 52)[0], firmware)
                            self.assertEqual(response[56:72], dt_source.packed_address("fe80::1234"))
                        else:
                            self.assertEqual(struct.unpack_from("<I", response, 44)[0], firmware)
                finally:
                    timer.cancel()
                    if channel is not None:
                        channel.close()
                    listener.close()
                    thread.join(timeout=2)
                self.assertEqual(errors, [])


if __name__ == "__main__":
    unittest.main()
