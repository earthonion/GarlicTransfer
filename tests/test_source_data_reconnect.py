"""A clean PS5 data disconnect must not stop later transfer requests."""

import socket
import unittest
from unittest.mock import patch

from poc.dt_source import data_server


class Client:
    family = socket.AF_INET

    def __init__(self):
        self.hello = bytes(64)
        self.closed = False
        self.sent = []

    def recv(self, size):
        result, self.hello = self.hello[:size], self.hello[size:]
        return result

    def sendall(self, data):
        self.sent.append(data)

    def settimeout(self, seconds):
        self.timeout = seconds

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed = True


class Listener:
    def __init__(self):
        self.clients = [Client(), Client()]
        self.accepted = 0

    def accept(self):
        if self.accepted == len(self.clients):
            raise StopIteration
        client = self.clients[self.accepted]
        self.accepted += 1
        return client, ("127.0.0.1", 1004)


class DataReconnectTest(unittest.TestCase):
    def test_accepts_second_session_after_console_closes_first(self):
        listener = Listener()
        with patch("poc.dt_source.derive_session", return_value=(b"k", b"k", b"n", b"n")), \
             patch("poc.dt_source.recv_record", side_effect=[
                 b"completion", EOFError("console closed"),
                 b"completion", EOFError("console closed"),
             ]) as recv_record:
            with self.assertRaises(StopIteration):
                data_server(listener, "unused", 0)

        self.assertEqual(listener.accepted, 2)
        self.assertEqual(recv_record.call_count, 4)
        self.assertTrue(all(client.closed for client in listener.clients))
        self.assertTrue(all(len(client.sent) == 1 for client in listener.clients))


if __name__ == "__main__":
    unittest.main()
