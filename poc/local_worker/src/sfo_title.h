#ifndef GARLIC_SFO_TITLE_H
#define GARLIC_SFO_TITLE_H

#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>

#define SFO_TITLE_MAX_BYTES 0x8000u

/* Function Title Checking */
static int sfo_title_valid(const char *title) {
    if (!title || strlen(title) != 9 || memcmp(title, "PPSA", 4)) return 0;
    for (unsigned i = 4; i < 9; i++) if (title[i] < '0' || title[i] > '9') return 0;
    return 1;
}

static uint16_t sfo_title_u16(const uint8_t *p) {
    return (uint16_t)p[0] | (uint16_t)p[1] << 8;
}

static uint32_t sfo_title_u32(const uint8_t *p) {
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static int sfo_title_word(uint8_t c) {
    return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
}

/* Function Title Patching */
static int sfo_title_patch_bytes(uint8_t *sfo, size_t size, const char *target) {
    if (!sfo_title_valid(target) || !sfo || size < 20 || size > SFO_TITLE_MAX_BYTES ||
        memcmp(sfo, "\0PSF", 4) || sfo_title_u32(sfo + 4) != 0x101) return -1;
    uint32_t keys = sfo_title_u32(sfo + 8), data = sfo_title_u32(sfo + 12);
    uint32_t count = sfo_title_u32(sfo + 16);
    if (!count || count > (size - 20) / 16 || keys < 20 + count * 16 ||
        keys >= data || data > size) return -1;
    char source[10] = {0};
    unsigned title_fields = 0;
    for (uint32_t i = 0; i < count; i++) {
        const uint8_t *entry = sfo + 20 + i * 16;
        uint32_t relative = sfo_title_u16(entry), length = sfo_title_u32(entry + 4);
        uint32_t capacity = sfo_title_u32(entry + 8), offset = sfo_title_u32(entry + 12);
        if (relative >= data - keys || length > capacity || offset > size - data ||
            capacity > size - data - offset) return -1;
        const uint8_t *key = sfo + keys + relative;
        const uint8_t *end = memchr(key, 0, data - keys - relative);
        if (!end || end == key) return -1;
        for (const uint8_t *p = key; p < end; p++) if (*p < 32 || *p > 126) return -1;
        for (uint32_t j = 0; j < i; j++) {
            const uint8_t *other = sfo + 20 + j * 16;
            uint32_t start = sfo_title_u32(other + 12), span = sfo_title_u32(other + 8);
            if (capacity && span && offset < start + (uint64_t)span && start < offset + (uint64_t)capacity)
                return -1;
        }
        if (end - key == 8 && !memcmp(key, "TITLE_ID", 8)) {
            if (++title_fields != 1 || sfo_title_u16(entry + 2) != 0x0204 ||
                !((length == 9) || (length == 10 && sfo[data + offset + 9] == 0))) return -1;
            memcpy(source, sfo + data + offset, 9);
            if (!sfo_title_valid(source)) return -1;
        }
    }
    if (title_fields != 1) return -1;
    /* Check every value before changing any bytes. */
    int changed = 0;
    for (unsigned pass = 0; pass < 2; pass++) {
        for (uint32_t i = 0; i < count; i++) {
            const uint8_t *entry = sfo + 20 + i * 16;
            uint32_t length = sfo_title_u32(entry + 4), offset = sfo_title_u32(entry + 12);
            uint8_t *value = sfo + data + offset;
            for (uint32_t at = 0; at + 9 <= length; at++) {
                if (memcmp(value + at, "PPSA", 4) ||
                    (at && sfo_title_word(value[at - 1])) ||
                    (at + 9 < length && sfo_title_word(value[at + 9]))) continue;
                unsigned digits = 0;
                for (unsigned n = 4; n < 9; n++) digits += value[at + n] >= '0' && value[at + n] <= '9';
                if (digits != 5) continue;
                if (!pass) {
                    if (memcmp(value + at, source, 9)) return -1;
                    if (memcmp(source, target, 9)) changed++;
                } else {
                    memcpy(value + at, target, 9);
                }
                at += 8;
            }
        }
    }
    return changed;
}

/* Function Title Writing */
static int sfo_title_patch_file(const char *path, const char *target) {
    uint8_t sfo[SFO_TITLE_MAX_BYTES], check[4096];
    struct stat st;
    int fd = open(path, O_RDWR), result = -1;
    if (fd < 0) return -1;
    if (fstat(fd, &st) < 0 || !S_ISREG(st.st_mode) || st.st_size < 20 || st.st_size > SFO_TITLE_MAX_BYTES ||
        pread(fd, sfo, (size_t)st.st_size, 0) != st.st_size) goto done;
    int changed = sfo_title_patch_bytes(sfo, (size_t)st.st_size, target);
    if (changed < 0) goto done;
    if (changed && (pwrite(fd, sfo, (size_t)st.st_size, 0) != st.st_size || fsync(fd) < 0)) goto done;
    for (off_t offset = 0; offset < st.st_size; offset += sizeof(check)) {
        size_t length = (size_t)(st.st_size - offset);
        if (length > sizeof(check)) length = sizeof(check);
        if (pread(fd, check, length, offset) != (ssize_t)length || memcmp(sfo + offset, check, length)) goto done;
    }
    result = changed;
done:
    if (close(fd) < 0) result = -1;
    return result;
}

#endif
