# Source provenance

- Repository: https://github.com/earthonion/garlic-worker
- Commit: `4d1602847e8ee41d3de2f7e94a6e51ededfc8720`
- Upstream version: `v1.6.6`
- Local payload version: `v1.6.6-local1`
- License: GNU GPL version 3; complete text in `LICENSE`.

The full upstream `src` tree, original Makefile and original README accompany
the local source. `Makefile.upstream` and `README.upstream.md` retain originals.

Local changes add `local_main.c`, `local_runtime.h`, `local_loop.inc`,
`local_validation.c` and `local_shutdown.c`/`local_shutdown.h`. The entry point supplies a direct save listener on 9023
and a compatible PPR listener on 9022. It does not start the public worker loops
or read/modify the upstream worker configuration. Save/PPR operations share a
mutex, and PPR credentials are restored after each request.

Changes to `src/ps5/worker.c` connect that listener to the existing save-engine
functions, escape TCP log/status JSON, validate file/result acknowledgements,
and validate stored input archives before extraction. `src/tcp.c` rejects
invalid frame sizes. Output ZIP collection fails on unsupported entries or
classic ZIP limits rather than silently omitting files. Cryptographic and PFS
save-engine algorithms are kept from the pinned upstream source.

Build SDK: official ps5-payload-dev SDK `v0.50`:

https://github.com/ps5-payload-dev/sdk/releases/download/v0.50/ps5-payload-sdk.zip

SDK archive SHA-256:
`2993a69e52fea04a32bf1753318fc60b3f918ab635bdf946870e7d1849557bb2`

The build uses private LLVM/Clang 19.1.7 tools on Linux. Exact SDK and compiler
download metadata are retained in `toolchain-provenance.json`. Compiler/SDK
files are build tools and are not part of the application runtime.

## Payload packaging

The Makefile runs the SDK's `prospero-strip --strip-all` after linking; override
`STRIP` to use another compatible LLVM strip executable. Build with
`make PS5_PAYLOAD_SDK=/path/to/ps5-payload-sdk`. This pipeline reproduced the
earlier stripped payload byte for byte. No C engine or job protocol changed.

Trailing non-runtime metadata shrank from 32,848 to 1,240 bytes. This may help
loaders that stop reading after load segments; it is not a confirmed cause
of the reported timeout. All program headers, PT_LOAD/PT_DYNAMIC bytes and
allocated section contents of that earlier stripped build are identical to
Test1, including dynamic symbols and relocations. LOAD-EQUIVALENCE.json records
that historical comparison; it does not apply to later functional changes.

Test1 SHA256: `1e55999186c0d9ae397c7f766744872f42b984b55b3f507f9418ed163c79e8d2` (245,888 bytes).

Earlier stripped payload SHA256: `c4729cc23228e9392cdf30a550817b24fa66880600ec1a74154d7015bd2e08ad` (214,280 bytes).

## Current local additions

The local entry point sets the PS5 process name to `GarlicWorker.elf` and logs
a failure without stopping save processing. The deployed file remains
`garlic-local-worker.elf`. Local greetings advertise `target_title_id` support and a per-startup instance
ID. When TCP 9024 control starts, they also advertise `shutdown`. Shutdown
interrupts active socket reads, drains save unmount/credential/file cleanup,
and joins the owned PPR and control threads before returning from main. An
unrelated existing PPR listener is preserved; a failed unmount keeps shutdown
pending rather than deleting its backing files or forcing termination.
Current binary hashes, source hashes and build checks are in
`BUILD-METADATA.json`. No live PS5 execution is claimed by those build checks.
