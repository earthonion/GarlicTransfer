# Garlic local helper

Local PS5 save processing for GarlicTransfer. The helper combines the pinned
garlic-worker save engine with a local listener and the transfer PPR oracle.

- TCP 9023: one decrypt, encrypt or resign job per connection.
- TCP 9022: existing 32-byte PPR requests and 40-byte responses.
- TCP 9024: instance-bound shutdown control for the desktop app.
- A common mutex serializes save operations and borrowed PPR credentials.
- If another oracle owns 9022, it stays in place and 9023 remains available.
- No public worker server, worker key or `/data/garlic/config.ini` is used.

GarlicTransfer deploys `garlic-local-worker.elf` through the configured PS5
payload listener when local save processing is selected. The console must be
jailbroken and expose the same save services required by garlic-worker.
Closing GarlicTransfer requests shutdown of the compatible helper used by that
app session. An active job finishes its unmount, credential restore and folder
cleanup before the helper joins its PPR/control threads and exits. A canceled
close leaves the helper running. Other oracle processes are not stopped.
An old helper must be restarted with this build before automatic shutdown is
available. Loss of network access or forced app termination can leave it running.

Temporary jobs use newly created folders under `/data/garlic/local-work`.
Each connection owns its folder and removes that folder when finished.
The source PC saves and existing console worker configuration are preserved.

The local protocol uses four-byte big-endian JSON frame lengths. A helper
greeting identifies `garlic-local-v1`, followed by one job request. Input and
result archives use the worker's `file_request`/`file_data` and
`result_start`/`result_ok` framing. Every job frame contains its `job_id`.
Stored ZIP archives are required; unsupported formats fail before extraction.
The classic ZIP limits of the upstream save engine remain in effect.

Build with the official PS5 payload SDK and Clang/LLVM:

```sh
make PS5_PAYLOAD_SDK=/path/to/ps5-payload-sdk
```

Native transport and input-archive checks can run on Linux with Python and GCC:

```sh
python3 tests/test_native.py
```

The PS5 ELF is cross-compiled. Save mounting and cryptographic operations
require a console test. See `UPSTREAM.md` and `LICENSE` for provenance.

## Payload packaging

The build strips unused ELF symbols after linking. See `UPSTREAM.md` for the
build command, toolchain details and comparison with the original payload.
