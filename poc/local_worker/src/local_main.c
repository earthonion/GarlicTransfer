#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <signal.h>
#include <pthread.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <sys/sysctl.h>
#include <sys/stat.h>
#include <netinet/in.h>
#include <ps5/kernel.h>

#include "local_runtime.h"
#include "savedata.h"
#include "zip.h"
#include "log.h"

int sceUserServiceInitialize(void *);
int sceKernelSetProcessName(const char *);
pthread_mutex_t local_operation_mutex = PTHREAD_MUTEX_INITIALIZER;

// Function Credential Backup
void local_credentials_save(local_credentials_t *saved) {
    pid_t self = getpid();
    saved->authid = kernel_get_ucred_authid(self);
    kernel_get_ucred_caps(self, saved->caps);
    kernel_get_ucred_attrs(self, saved->attrs);
}

// Function Credential Restore
void local_credentials_restore(const local_credentials_t *saved) {
    pid_t self = getpid();
    kernel_set_ucred_authid(self, saved->authid);
    kernel_set_ucred_caps(self, saved->caps);
    kernel_set_ucred_attrs(self, saved->attrs);
}

// Function Message Encoding
void local_json_escape(const char *text, char *output, size_t capacity) {
    static const char digits[] = "0123456789abcdef";
    size_t used = 0;
    if (!capacity) return;
    for (const unsigned char *p = (const unsigned char *)(text ? text : ""); *p; p++) {
        size_t needed = (*p == '"' || *p == '\\') ? 2 : (*p < 0x20 ? 6 : 1);
        if (needed >= capacity - used) break;
        if (*p == '"' || *p == '\\') {
            output[used++] = '\\';
            output[used++] = (char)*p;
        } else if (*p < 0x20) {
            output[used++] = '\\'; output[used++] = 'u';
            output[used++] = '0'; output[used++] = '0';
            output[used++] = digits[*p >> 4]; output[used++] = digits[*p & 15];
        } else output[used++] = (char)*p;
    }
    output[used] = 0;
}

// Function Socket Loading
static int local_listener(int port) {
    int listener = socket(AF_INET, SOCK_STREAM, 0);
    if (listener < 0) return -1;
    int one = 1;
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_port = htons((uint16_t)port);
    address.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) < 0 ||
        listen(listener, 4) < 0) {
        int saved_errno = errno;
        close(listener);
        errno = saved_errno;
        return -1;
    }
    return listener;
}

// Function Shell Loading
static pid_t local_shellcore(void) {
    int mib[4] = {1, 14, 8, 0};
    size_t size = 0;
    if (sysctl(mib, 4, NULL, &size, NULL, 0) || !size) return -1;
    unsigned char *buffer = malloc(size);
    if (!buffer) return -1;
    if (sysctl(mib, 4, buffer, &size, NULL, 0)) { free(buffer); return -1; }
    pid_t pid = -1;
    for (size_t at = 0; at + 4 <= size;) {
        int length;
        memcpy(&length, buffer + at, 4);
        if (length < 460 || (size_t)length > size - at) break;
        if (!memcmp(buffer + at + 447, "SceShellCore", 13)) {
            memcpy(&pid, buffer + at + 72, sizeof(pid));
            break;
        }
        at += (size_t)length;
    }
    free(buffer);
    return pid;
}

// Function Oracle Derivation
static int local_derive(const uint8_t input[32], uint8_t output[40]) {
    int result = -1;
    pthread_mutex_lock(&local_operation_mutex);
    if (local_shutdown_requested()) {
        pthread_mutex_unlock(&local_operation_mutex);
        return -1;
    }
    local_credentials_t saved;
    local_credentials_save(&saved);
    pid_t shellcore = local_shellcore();
    if (shellcore >= 0) {
        uint8_t caps[16], attrs[32], request[0x4c] = {0};
        kernel_get_ucred_caps(shellcore, caps);
        kernel_get_ucred_attrs(shellcore, attrs);
        kernel_set_ucred_authid(getpid(), kernel_get_ucred_authid(shellcore));
        kernel_set_ucred_caps(getpid(), caps);
        kernel_set_ucred_attrs(getpid(), attrs);
        memcpy(request, input, 32);
        int device = open("/dev/ncdt", O_RDWR);
        if (device >= 0) {
            uint32_t status = 1;
            int code = ioctl(device, 0xc04c4e03, request);
            memcpy(&status, request + 0x48, sizeof(status));
            close(device);
            if (code == 0 && status == 0) {
                memcpy(output, request + 0x20, 40);
                result = 0;
            }
        }
    }
    local_credentials_restore(&saved);
    pthread_mutex_unlock(&local_operation_mutex);
    return result;
}

// Function Oracle Transfer
static int local_bytes(int client, uint8_t *buffer, size_t length, int writing) {
    size_t done = 0;
    while (done < length) {
        ssize_t count = writing ? write(client, buffer + done, length - done)
                                : read(client, buffer + done, length - done);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return -1;
        done += (size_t)count;
    }
    return 0;
}

// Function Oracle Loading
static void *local_oracle(void *argument) {
    int listener = *(int *)argument;
    while (!local_shutdown_requested()) {
        int client = local_shutdown_accept(listener);
        if (client < 0) break;
        if (local_shutdown_track(LOCAL_PPR_CLIENT, client)) { close(client); break; }
        struct timeval timeout = {30, 0};
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
        setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
        uint8_t request[32], response[40];
        while (!local_shutdown_requested() &&
               local_bytes(client, request, sizeof(request), 0) == 0 &&
               !local_shutdown_requested() &&
               local_derive(request, response) == 0 &&
               local_bytes(client, response, sizeof(response), 1) == 0) {}
        local_shutdown_close(LOCAL_PPR_CLIENT, client);
    }
    return NULL;
}

// Function Helper Loading
int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    signal(SIGPIPE, SIG_IGN);
    local_shutdown_init();
    int save_listener = local_listener(LOCAL_SAVE_PORT);
    if (save_listener < 0) { perror("local save listener"); return 1; }
    int ppr_listener = local_listener(LOCAL_PPR_PORT);

    sceUserServiceInitialize(NULL);
    kernel_set_ucred_authid(getpid(), 0x4800000000000010ULL);
    mkdir("/data/garlic", 0777);
    mkdir("/data/garlic/local-work", 0777);
    mkdir("/data/save_files", 0777);
    log_init();
    int name_result = sceKernelSetProcessName("GarlicWorker.elf");
    if (name_result != 0)
        garlic_log("[local] Could not name worker process: 0x%08x\n", (unsigned)name_result);
    savedata_init();
    zip_init_crc();
    pthread_t ppr_thread;
    int ppr_started = 0;
    if (ppr_listener >= 0) {
        if (pthread_create(&ppr_thread, NULL, local_oracle, &ppr_listener) != 0) {
            close(ppr_listener);
            ppr_listener = -1;
            garlic_log("[local] Could not start the PPR listener\n");
        } else ppr_started = 1;
    } else garlic_log("[local] Keeping the existing PPR listener on 9022\n");
    local_shutdown_owns_ppr(ppr_started);
    if (local_control_start(LOCAL_CONTROL_PORT))
        garlic_log("[local] Shutdown control unavailable on %d\n", LOCAL_CONTROL_PORT);
    garlic_log("[local] Save jobs ready on %d (%s)\n", LOCAL_SAVE_PORT, LOCAL_PROTOCOL);
    worker_loop_local(save_listener);
    local_shutdown_request();
    close(save_listener);
    if (ppr_started) pthread_join(ppr_thread, NULL);
    if (ppr_listener >= 0) close(ppr_listener);
    local_control_stop();
    garlic_log("[local] Worker stopped\n");
    log_flush();
    return 0;
}
