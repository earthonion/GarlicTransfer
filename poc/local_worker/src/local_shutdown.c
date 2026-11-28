#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#include "local_shutdown.h"
#include "tcp.h"

static pthread_mutex_t state_lock = PTHREAD_MUTEX_INITIALIZER;
static int stopping;
static int clients[2] = {-1, -1};
static int owns_ppr;
static int control_listener = -1;
static int control_port;
static int control_started;
static pthread_t control_thread;
static char instance_id[33];

// Function Worker Identity
void local_shutdown_init(void) {
    static const char hex[] = "0123456789abcdef";
    unsigned char random[16];
    arc4random_buf(random, sizeof(random));
    for (size_t i = 0; i < sizeof(random); i++) {
        instance_id[i * 2] = hex[random[i] >> 4];
        instance_id[i * 2 + 1] = hex[random[i] & 15];
    }
    instance_id[32] = 0;
    stopping = owns_ppr = control_port = control_started = 0;
    clients[0] = clients[1] = control_listener = -1;
}

const char *local_instance_id(void) { return instance_id; }

// Function Worker State
int local_shutdown_requested(void) {
    pthread_mutex_lock(&state_lock);
    int result = stopping;
    pthread_mutex_unlock(&state_lock);
    return result;
}

// Function Worker Stop
void local_shutdown_request(void) {
    pthread_mutex_lock(&state_lock);
    stopping = 1;
    for (size_t i = 0; i < 2; i++)
        if (clients[i] >= 0) shutdown(clients[i], SHUT_RDWR);
    pthread_mutex_unlock(&state_lock);
}

// Function Client Tracking
int local_shutdown_track(int kind, int client) {
    if (kind < 0 || kind > 1 || client < 0) return -1;
    pthread_mutex_lock(&state_lock);
    int result = stopping || clients[kind] >= 0 ? -1 : 0;
    if (!result) clients[kind] = client;
    pthread_mutex_unlock(&state_lock);
    return result;
}

// Function Client Closing
void local_shutdown_close(int kind, int client) {
    pthread_mutex_lock(&state_lock);
    if (kind >= 0 && kind < 2 && clients[kind] == client) clients[kind] = -1;
    if (client >= 0) close(client);
    pthread_mutex_unlock(&state_lock);
}

// Function Listener Waiting
int local_shutdown_accept(int listener) {
    if (listener < 0 || listener >= FD_SETSIZE) return -1;
    while (!local_shutdown_requested()) {
        fd_set reads;
        FD_ZERO(&reads);
        FD_SET(listener, &reads);
        struct timeval wait = {0, 200000};
        int result = select(listener + 1, &reads, NULL, NULL, &wait);
        if (result < 0) { if (errno == EINTR) continue; return -1; }
        if (!result) continue;
        int client = accept(listener, NULL, NULL);
        if (client >= 0) return client;
        if (errno != EINTR && errno != EAGAIN) return -1;
    }
    return -1;
}

// Function Control Reading
static int control_read(int client, void *buffer, size_t size, const struct timespec *started) {
    unsigned char *next = buffer;
    while (size && !local_shutdown_requested()) {
        struct timespec now;
        if (clock_gettime(CLOCK_MONOTONIC, &now) != 0 || now.tv_sec - started->tv_sec >= 3) return -1;
        fd_set reads;
        FD_ZERO(&reads);
        FD_SET(client, &reads);
        struct timeval wait = {0, 100000};
        int ready = select(client + 1, &reads, NULL, NULL, &wait);
        if (ready < 0) { if (errno == EINTR) continue; return -1; }
        if (!ready) continue;
        ssize_t count = recv(client, next, size, 0);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return -1;
        next += count;
        size -= (size_t)count;
    }
    return size ? -1 : 0;
}

// Function Control Parsing
static const char *skip_space(const char *text) {
    while (*text == ' ' || *text == '\t' || *text == '\r' || *text == '\n') text++;
    return text;
}

static int control_string(const char **input, char *output, size_t capacity) {
    const char *text = skip_space(*input);
    if (*text++ != '"') return -1;
    size_t used = 0;
    while (*text && *text != '"') {
        if ((unsigned char)*text < 0x20 || *text == '\\' || used + 1 >= capacity) return -1;
        output[used++] = *text++;
    }
    if (*text++ != '"') return -1;
    output[used] = 0;
    *input = text;
    return 0;
}

static int control_request(const char *text) {
    char key[32], value[64];
    unsigned seen = 0;
    text = skip_space(text);
    if (*text++ != '{') return -1;
    for (unsigned i = 0; i < 2; i++) {
        if (control_string(&text, key, sizeof(key))) return -1;
        text = skip_space(text);
        if (*text++ != ':' || control_string(&text, value, sizeof(value))) return -1;
        if (!strcmp(key, "type") && !(seen & 1) && !strcmp(value, "shutdown")) seen |= 1;
        else if (!strcmp(key, "instance_id") && !(seen & 2) && !strcmp(value, instance_id)) seen |= 2;
        else return -1;
        text = skip_space(text);
        if (*text++ != (i ? '}' : ',')) return -1;
    }
    return seen == 3 && !*skip_space(text) ? 0 : -1;
}

// Function Control Loading
static void *control_loop(void *unused) {
    (void)unused;
    while (!local_shutdown_requested()) {
        tcp_conn_t connection = {local_shutdown_accept(control_listener), 1};
        if (connection.sock < 0) break;
        if (connection.sock >= FD_SETSIZE) { close(connection.sock); continue; }
        struct timeval timeout = {2, 0};
        setsockopt(connection.sock, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
        char message[512];
        int length = snprintf(message, sizeof(message),
            "{\"type\":\"hello\",\"protocol\":\"%s\",\"platform\":\"ps5\",\"instance_id\":\"%s\"}",
            LOCAL_CONTROL_PROTOCOL, instance_id);
        struct timespec started;
        uint32_t size;
        int valid = length > 0 && (size_t)length < sizeof(message) &&
                    tcp_send_msg(&connection, message) == 0 &&
                    clock_gettime(CLOCK_MONOTONIC, &started) == 0 &&
                    control_read(connection.sock, &size, sizeof(size), &started) == 0;
        size = valid ? ntohl(size) : 0;
        if (valid && size && size < sizeof(message) &&
            control_read(connection.sock, message, size, &started) == 0) {
            message[size] = 0;
            if (strlen(message) == size && control_request(message) == 0) {
                local_shutdown_request();
                snprintf(message, sizeof(message),
                    "{\"type\":\"shutdown_accepted\",\"instance_id\":\"%s\"}", instance_id);
                tcp_send_msg(&connection, message);
            }
        }
        tcp_disconnect(&connection);
    }
    return NULL;
}

// Function Control Starting
int local_control_start(int port) {
    if (control_started || port < 0 || port > 65535) return -1;
    int listener = socket(AF_INET, SOCK_STREAM, 0);
    if (listener < 0 || listener >= FD_SETSIZE) { if (listener >= 0) close(listener); return -1; }
    int one = 1;
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_ANY);
    address.sin_port = htons((uint16_t)port);
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) || listen(listener, 4)) {
        close(listener); return -1;
    }
    socklen_t length = sizeof(address);
    if (getsockname(listener, (struct sockaddr *)&address, &length)) { close(listener); return -1; }
    control_listener = listener;
    control_port = ntohs(address.sin_port);
    if (pthread_create(&control_thread, NULL, control_loop, NULL)) {
        close(listener); control_listener = -1; control_port = 0; return -1;
    }
    control_started = 1;
    return 0;
}

int local_control_port(void) { return control_port; }
void local_shutdown_owns_ppr(int owns) { owns_ppr = !!owns; }

// Function Worker Greeting
int local_shutdown_greeting(char *output, size_t capacity) {
    return snprintf(output, capacity,
        "{\"type\":\"hello\",\"protocol\":\"garlic-local-v1\",\"platform\":\"ps5\","
        "\"instance_id\":\"%s\",\"shutdown_port\":%d,\"owns_ppr\":%s,"
        "\"capabilities\":[\"target_title_id\"%s]}",
        instance_id, control_started ? control_port : 0, owns_ppr ? "true" : "false",
        control_started ? ",\"shutdown\"" : "");
}

// Function Control Closing
void local_control_stop(void) {
    local_shutdown_request();
    if (control_started) pthread_join(control_thread, NULL);
    control_started = 0;
    if (control_listener >= 0) close(control_listener);
    control_listener = -1;
    control_port = 0;
}
