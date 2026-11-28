#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>

#include "config.h"
#include "json.h"
#include "local_runtime.h"
#include "log.h"
#include "tcp.h"
#include "util.h"

pthread_mutex_t local_operation_mutex = PTHREAD_MUTEX_INITIALIZER;
static tcp_conn_t *g_tcp;
static int g_transport_mode;
static char g_last_error[128];
static atomic_int stage;
static atomic_int bad_order;
static atomic_int unmount_blocked;
static atomic_int unmount_attempts;
static int mounted;
static char job_folder[MAX_PATH_LEN];

// Function Cleanup Checking
static void advance(int before, int after) {
    int expected = before;
    if (!atomic_compare_exchange_strong(&stage, &expected, after)) atomic_store(&bad_order, 1);
}

void local_credentials_save(local_credentials_t *saved) {
    memset(saved, 0, sizeof(*saved));
    advance(0, 1);
}

void local_credentials_restore(const local_credentials_t *saved) {
    (void)saved;
    advance(3, 4);
}

static int save_is_mounted(void) { return mounted; }
static int save_unmount(void) {
    atomic_fetch_add(&unmount_attempts, 1);
    if (atomic_load(&unmount_blocked)) return -1;
    mounted = 0; advance(2, 3); return 0;
}
static void worker_set_status(worker_config_t *cfg, const char *id, const char *status, const char *error) {
    (void)cfg; (void)id; (void)error;
    if (strcmp(status, "running")) advance(4, 5);
}

void delete_recursive(const char *path) {
    if (strcmp(path, job_folder) || rmdir(path)) atomic_store(&bad_order, 1);
    advance(5, 6);
}

// Function Job Waiting
static int process_decrypt(worker_config_t *cfg, const char *id, const char *params, const char *work_dir) {
    (void)cfg; (void)id; (void)params; (void)work_dir;
    mounted = 1;
    advance(1, 2);
    char byte;
    (void)recv(g_tcp->sock, &byte, 1, 0);
    usleep(100000);
    return -1;
}

static int process_encrypt(worker_config_t *cfg, const char *id, const char *params, const char *work_dir, int ps4) {
    (void)ps4;
    return process_decrypt(cfg, id, params, work_dir);
}

static int process_resign(worker_config_t *cfg, const char *id, const char *params, const char *work_dir, int ps4) {
    return process_encrypt(cfg, id, params, work_dir, ps4);
}

static char *probe_mkdtemp(char *output) {
    const char *root = getenv("GARLIC_SHUTDOWN_TEST_DIR");
    if (!root || snprintf(job_folder, sizeof(job_folder), "%s/job-XXXXXX", root) >= (int)sizeof(job_folder)) return NULL;
    if (!mkdtemp(job_folder)) return NULL;
    strcpy(output, job_folder);
    return output;
}

#define mkdtemp probe_mkdtemp
#include "../src/local_loop.inc"
#undef mkdtemp

void probe_worker_loop(int listener) {
    worker_loop_local(listener);
    if (atomic_load(&stage)) advance(6, 7);
}

void probe_reset(void) {
    atomic_store(&stage, 0);
    atomic_store(&bad_order, 0);
    atomic_store(&unmount_blocked, 0);
    atomic_store(&unmount_attempts, 0);
    mounted = 0;
    job_folder[0] = 0;
}

int probe_stage(void) { return atomic_load(&bad_order) ? -1 : atomic_load(&stage); }
void probe_block_unmount(int blocked) { atomic_store(&unmount_blocked, blocked); }
int probe_unmount_attempts(void) { return atomic_load(&unmount_attempts); }
