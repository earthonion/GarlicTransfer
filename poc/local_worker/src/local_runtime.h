#ifndef GARLIC_LOCAL_RUNTIME_H
#define GARLIC_LOCAL_RUNTIME_H

#include <pthread.h>
#include <stddef.h>
#include <stdint.h>
#include "local_shutdown.h"

#define LOCAL_SAVE_PORT 9023
#define LOCAL_PPR_PORT 9022
#define LOCAL_PROTOCOL "garlic-local-v1"

typedef struct {
    uint64_t authid;
    uint8_t caps[16];
    uint8_t attrs[32];
} local_credentials_t;

extern pthread_mutex_t local_operation_mutex;

void local_credentials_save(local_credentials_t *saved);
void local_credentials_restore(const local_credentials_t *saved);
void local_json_escape(const char *text, char *output, size_t capacity);
int local_validate_zip(const char *filename, const char *destination);
void worker_loop_local(int listener);

#endif
