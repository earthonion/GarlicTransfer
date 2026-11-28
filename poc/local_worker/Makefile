PS5_PAYLOAD_SDK ?= /opt/ps5-payload-sdk
CC := $(PS5_PAYLOAD_SDK)/bin/prospero-clang
STRIP ?= $(PS5_PAYLOAD_SDK)/bin/prospero-strip
CFLAGS := -O2 -Wall -D_BSD_SOURCE -std=gnu11 -Isrc -Isrc/ps5 \
          -DWORKER_VERSION=\"v1.6.6-local1\"
LIBS := -lkernel_sys -lkernel -lSceSystemService -lSceUserService -lSceFsInternalForVsh -lSceNet
SOURCES := src/local_main.c src/local_shutdown.c src/local_validation.c src/config.c src/json.c src/zip.c src/util.c \
           src/log.c src/killswitch.c src/tcp.c src/ps5/http.c src/ps5/worker.c \
           src/ps5/savedata.c src/ps5/chives.c src/ps5/chives_io.c \
           src/ps5/metadata_layout.c src/ps5/pfs_rebuild.c

all: garlic-local-worker.elf

garlic-local-worker.elf: Makefile $(SOURCES) $(wildcard src/*.h src/*.inc src/ps5/*.h)
	$(CC) $(CFLAGS) -o $@ $(SOURCES) $(LIBS)
	$(STRIP) --strip-all $@

clean:
	rm -f garlic-local-worker.elf

.PHONY: all clean
