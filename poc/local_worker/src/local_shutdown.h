#ifndef GARLIC_LOCAL_SHUTDOWN_H
#define GARLIC_LOCAL_SHUTDOWN_H

#include <stddef.h>

#define LOCAL_CONTROL_PORT 9024
#define LOCAL_CONTROL_PROTOCOL "garlic-local-control-v1"
#define LOCAL_SAVE_CLIENT 0
#define LOCAL_PPR_CLIENT 1

void local_shutdown_init(void);
int local_shutdown_requested(void);
void local_shutdown_request(void);
int local_shutdown_accept(int listener);
int local_shutdown_track(int kind, int client);
void local_shutdown_close(int kind, int client);
int local_control_start(int port);
int local_control_port(void);
void local_control_stop(void);
const char *local_instance_id(void);
void local_shutdown_owns_ppr(int owns);
int local_shutdown_greeting(char *output, size_t capacity);

#endif
