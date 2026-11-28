import ctypes
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path


@unittest.skipUnless(os.name == "posix", "Native worker checks require POSIX sockets")
class LocalShutdownTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        compiler = shutil.which("cc")
        if not compiler:
            raise unittest.SkipTest("C compiler unavailable")
        cls.directory = tempfile.TemporaryDirectory(prefix="garlic-shutdown-")
        cls.addClassCleanup(cls.directory.cleanup)
        cls.work = Path(cls.directory.name)
        worker = Path(__file__).resolve().parents[1] / "poc/local_worker"
        source = worker / "src"
        stub = cls.work / "stubs.c"
        stub.write_text(
            "int http_tcp_connect(const char *host,int port){(void)host;(void)port;return -1;}\n"
            "void garlic_log(const char *message,...){(void)message;}\n"
        )
        library = cls.work / ("shutdown.dylib" if sys.platform == "darwin" else "shutdown.so")
        subprocess.run([
            compiler, "-dynamiclib" if sys.platform == "darwin" else "-shared",
            "-fPIC", "-pthread", "-std=c11", "-D_DEFAULT_SOURCE",
            "-Wall", "-Wextra", "-Werror", "-I", str(source), "-I", str(source / "ps5"),
            str(source / "local_shutdown.c"), str(source / "tcp.c"), str(source / "json.c"),
            str(worker / "tests/shutdown_loop_probe.c"), str(stub), "-o", str(library),
        ], check=True, capture_output=True, text=True)
        cls.native = ctypes.CDLL(str(library))
        for name in ("local_shutdown_accept", "local_control_start", "probe_worker_loop"):
            getattr(cls.native, name).argtypes = [ctypes.c_int]
        for name in ("local_shutdown_track", "local_shutdown_close"):
            getattr(cls.native, name).argtypes = [ctypes.c_int, ctypes.c_int]
        cls.native.local_shutdown_greeting.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        cls.native.local_instance_id.restype = ctypes.c_char_p

    def setUp(self):
        self.native.local_shutdown_init()
        self.native.probe_reset()
        self.addCleanup(self.native.local_control_stop)

    def greeting(self):
        data = ctypes.create_string_buffer(512)
        length = self.native.local_shutdown_greeting(data, len(data))
        self.assertGreater(length, 0)
        self.assertLess(length, len(data))
        return json.loads(data.value)

    def start_control(self):
        self.assertEqual(self.native.local_control_start(0), 0)
        return self.native.local_control_port()

    def connection(self):
        client = socket.create_connection(("127.0.0.1", self.native.local_control_port()), timeout=4)
        self.addCleanup(client.close)
        hello = self.read_message(client)
        self.assertEqual(hello["protocol"], "garlic-local-control-v1")
        self.assertEqual(hello["instance_id"], self.native.local_instance_id().decode())
        return client, hello["instance_id"]

    def exact(self, client, length):
        data = bytearray()
        while len(data) < length:
            piece = client.recv(length - len(data))
            if not piece:
                raise EOFError("Connection closed")
            data.extend(piece)
        return bytes(data)

    def read_message(self, client):
        length, = struct.unpack("!I", self.exact(client, 4))
        return json.loads(self.exact(client, length))

    def send_message(self, client, payload):
        if not isinstance(payload, bytes):
            payload = json.dumps(payload).encode()
        client.sendall(struct.pack("!I", len(payload)) + payload)

    def shutdown(self):
        client, instance = self.connection()
        self.send_message(client, {"type": "shutdown", "instance_id": instance})
        self.assertEqual(self.read_message(client), {"type": "shutdown_accepted", "instance_id": instance})

    def test_identity_and_capability_match_control_availability(self):
        first = self.greeting()
        self.assertRegex(first["instance_id"], r"^[0-9a-f]{32}$")
        self.assertEqual(first["capabilities"], ["target_title_id"])
        self.assertEqual(first["shutdown_port"], 0)
        self.assertFalse(first["owns_ppr"])
        port = self.start_control()
        self.native.local_shutdown_owns_ppr(1)
        ready = self.greeting()
        self.assertEqual(ready["shutdown_port"], port)
        self.assertIn("shutdown", ready["capabilities"])
        self.assertTrue(ready["owns_ppr"])
        self.native.local_control_stop()
        self.native.local_shutdown_init()
        self.assertNotEqual(first["instance_id"], self.greeting()["instance_id"])

    def test_unavailable_control_does_not_claim_shutdown(self):
        with socket.socket() as busy:
            busy.bind(("0.0.0.0", 0))
            busy.listen()
            self.assertEqual(self.native.local_control_start(busy.getsockname()[1]), -1)
            self.assertNotIn("shutdown", self.greeting()["capabilities"])
            self.assertEqual(self.greeting()["shutdown_port"], 0)

    def test_wrong_or_malformed_identity_does_not_stop_worker(self):
        self.start_control()
        instance = self.native.local_instance_id().decode()
        requests = [
            {"type": "shutdown", "instance_id": "0" * 32},
            {"type": "shutdown"},
            {"type": "shutdown", "instance_id": instance + "extra"},
            {"type": "job", "instance_id": instance},
            {"type": "shutdown", "instance_id": instance, "extra": True},
            b'{"type":"shutdown","type":"shutdown"}',
            json.dumps({"type": "shutdown", "instance_id": instance}).encode() + b"\0",
            b"{not-json}",
        ]
        for request in requests:
            with self.subTest(request=request):
                client, _ = self.connection()
                self.send_message(client, request)
                self.assertEqual(client.recv(1), b"")
                self.assertFalse(self.native.local_shutdown_requested())
        self.shutdown()
        self.assertTrue(self.native.local_shutdown_requested())

    def test_partial_control_frame_does_not_hold_shutdown_open(self):
        self.start_control()
        client, _ = self.connection()
        client.sendall(b"\0\0")
        started = time.monotonic()
        self.native.local_control_stop()
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(client.recv(1), b"")

    def test_shutdown_interrupts_tracked_save_and_ppr_reads(self):
        self.start_control()
        waiting = []
        for slot in (0, 1):
            incoming, outgoing = socket.socketpair()
            self.addCleanup(incoming.close)
            self.addCleanup(outgoing.close)
            owned = os.dup(incoming.fileno())
            self.assertEqual(self.native.local_shutdown_track(slot, owned), 0)
            self.addCleanup(self.native.local_shutdown_close, slot, owned)
            result = []
            reader = threading.Thread(target=lambda fd=owned, data=result: data.append(os.read(fd, 1)))
            reader.start()
            waiting.append((reader, result, owned))
        self.shutdown()
        for reader, result, owned in waiting:
            reader.join(timeout=1)
            self.assertFalse(reader.is_alive())
            self.assertEqual(result, [b""])
            os.fstat(owned)
        self.assertEqual(self.native.local_shutdown_track(0, waiting[0][2]), -1)

    def test_shutdown_wakes_idle_accept(self):
        self.start_control()
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            result = []
            waiter = threading.Thread(target=lambda: result.append(self.native.local_shutdown_accept(listener.fileno())))
            waiter.start()
            self.shutdown()
            waiter.join(timeout=1)
            self.assertFalse(waiter.is_alive())
            self.assertEqual(result, [-1])

    def test_real_job_loop_cleans_up_before_returning(self):
        self.check_busy_shutdown(False)

    def test_failed_unmount_preserves_credentials_and_backing_until_success(self):
        self.check_busy_shutdown(True)

    def check_busy_shutdown(self, block_unmount):
        self.start_control()
        self.native.probe_block_unmount(int(block_unmount))
        with tempfile.TemporaryDirectory() as folder, socket.socket() as listener:
            previous = os.environ.get("GARLIC_SHUTDOWN_TEST_DIR")
            os.environ["GARLIC_SHUTDOWN_TEST_DIR"] = folder
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            loop = threading.Thread(target=self.native.probe_worker_loop, args=(listener.fileno(),), daemon=True)
            loop.start()
            try:
                with socket.create_connection(listener.getsockname(), timeout=2) as client:
                    hello = self.read_message(client)
                    self.assertIn("shutdown", hello["capabilities"])
                    self.send_message(client, {"type": "job", "id": "00000000-0000-0000-0000-000000000001", "operation": "decrypt", "params": {}})
                    deadline = time.monotonic() + 2
                    while self.native.probe_stage() < 2 and time.monotonic() < deadline:
                        time.sleep(0.005)
                    self.assertEqual(self.native.probe_stage(), 2)
                    self.shutdown()
                    if block_unmount:
                        deadline = time.monotonic() + 2
                        while not self.native.probe_unmount_attempts() and time.monotonic() < deadline:
                            time.sleep(0.005)
                        self.assertGreater(self.native.probe_unmount_attempts(), 0)
                        self.assertTrue(loop.is_alive())
                        self.assertEqual(self.native.probe_stage(), 2)
                        self.assertEqual(len(list(Path(folder).iterdir())), 1)
                        self.native.probe_block_unmount(0)
                    loop.join(timeout=2)
                    self.assertFalse(loop.is_alive())
                    self.assertEqual(self.native.probe_stage(), 7)
                    self.assertEqual(list(Path(folder).iterdir()), [])
            finally:
                self.native.probe_block_unmount(0)
                self.native.local_shutdown_request()
                loop.join(timeout=2)
                if previous is None:
                    os.environ.pop("GARLIC_SHUTDOWN_TEST_DIR", None)
                else:
                    os.environ["GARLIC_SHUTDOWN_TEST_DIR"] = previous


if __name__ == "__main__":
    unittest.main()
