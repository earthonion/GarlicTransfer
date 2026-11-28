#include <ctype.h>
#include <sys/socket.h>
#include <sys/time.h>

// Function Job Checking
static int local_job_id(const char *id) {
    if (strlen(id) != 36) return 0;
    for (size_t i = 0; i < 36; i++) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (id[i] != '-') return 0;
        } else if (!isxdigit((unsigned char)id[i])) return 0;
    }
    return 1;
}

// Function Job Closing
static void local_job_close(tcp_conn_t *connection) {
    local_shutdown_close(LOCAL_SAVE_CLIENT, connection->sock);
    connection->sock = -1;
    connection->connected = 0;
    g_tcp = NULL;
}

// Function Local Jobs
void worker_loop_local(int listener) {
    worker_config_t cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.connection_mode = 1;
    g_transport_mode = 1;
    while (!local_shutdown_requested()) {
        tcp_conn_t connection;
        connection.sock = local_shutdown_accept(listener);
        if (connection.sock < 0) break;
        if (local_shutdown_track(LOCAL_SAVE_CLIENT, connection.sock)) {
            close(connection.sock); break;
        }
        connection.connected = 1;
        struct timeval timeout = {120, 0};
        setsockopt(connection.sock, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
        setsockopt(connection.sock, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
        g_tcp = &connection;
        char request[8192], type[32] = {0}, id[64] = {0}, operation[32] = {0};
        char params[8192] = {0};
        char greeting[512];
        int greeting_length = local_shutdown_greeting(greeting, sizeof(greeting));
        if (greeting_length < 0 || (size_t)greeting_length >= sizeof(greeting) ||
            tcp_send_msg(&connection, greeting) < 0 ||
            tcp_recv_msg(&connection, request, sizeof(request)) < 0) {
            local_job_close(&connection); continue;
        }
        json_get_string(request, "type", type, sizeof(type));
        json_get_string(request, "id", id, sizeof(id));
        json_get_string(request, "operation", operation, sizeof(operation));
        json_get_object(request, "params", params, sizeof(params));
        if (strcmp(type, "job") || !local_job_id(id)) {
            local_job_close(&connection); continue;
        }
        int valid_operation = !strcmp(operation, "decrypt") || !strcmp(operation, "encrypt") ||
                              !strcmp(operation, "resign");
        if (!valid_operation) {
            worker_set_status(&cfg, id, "failed", "Unsupported local save operation");
            local_job_close(&connection); continue;
        }
        if (strcmp(operation, "decrypt")) {
            char account[64] = {0};
            json_get_string(params, "account_id", account, sizeof(account));
            int valid_account = strlen(account) == 16;
            for (size_t i = 0; account[i]; i++)
                if (!isxdigit((unsigned char)account[i])) valid_account = 0;
            if (!valid_account) {
                worker_set_status(&cfg, id, "failed", "A 16-digit hexadecimal account ID is required");
                local_job_close(&connection); continue;
            }
        }
        char work_dir[MAX_PATH_LEN];
        snprintf(work_dir, sizeof(work_dir), "/data/garlic/local-work/%s-XXXXXX", id);
        if (!mkdtemp(work_dir)) {
            worker_set_status(&cfg, id, "failed", "Could not create local job folder");
            local_job_close(&connection); continue;
        }
        pthread_mutex_lock(&local_operation_mutex);
        if (local_shutdown_requested()) {
            pthread_mutex_unlock(&local_operation_mutex);
            local_job_close(&connection);
            delete_recursive(work_dir);
            break;
        }
        local_credentials_t saved;
        local_credentials_save(&saved);
        g_last_error[0] = 0;
        worker_set_status(&cfg, id, "running", NULL);
        int result;
        if (!strcmp(operation, "decrypt")) result = process_decrypt(&cfg, id, params, work_dir);
        else if (!strcmp(operation, "encrypt")) result = process_encrypt(&cfg, id, params, work_dir, 0);
        else result = process_resign(&cfg, id, params, work_dir, 0);
        int unmount_warning = 0;
        while (save_is_mounted()) {
            if (save_unmount() == 0) break;
            if (!unmount_warning) {
                garlic_log("[local] Waiting for save unmount before cleanup; worker will remain running\n");
                unmount_warning = 1;
            }
            usleep(250000);
        }
        local_credentials_restore(&saved);
        pthread_mutex_unlock(&local_operation_mutex);
        if (result == 0) worker_set_status(&cfg, id, "done", NULL);
        else worker_set_status(&cfg, id, "failed",
                g_last_error[0] ? g_last_error : "Local save operation failed");
        local_job_close(&connection);
        delete_recursive(work_dir);
    }
}
