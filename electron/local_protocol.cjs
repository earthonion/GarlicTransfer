const PROTOCOL = 'garlic-local-v1';
const PLATFORM = 'ps5';
const SAVE_PORT = 9023;
const CONTROL_PORT = 9024;
const CONTROL_PROTOCOL = 'garlic-local-control-v1';
const PPR_PORT = 9022;
const LOADER_PORT = 9021;
const MAX_GREETING_BYTES = 8192;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_JOB_BYTES = 8191;
const MAX_ARCHIVE_BYTES = 0xffffffff;
const CHUNK_BYTES = 64 * 1024;

// Function Worker Greeting
function isWorkerGreeting(message) {
  return Boolean(message && typeof message === 'object' && !Array.isArray(message)
    && message.type === 'hello' && message.protocol === PROTOCOL && message.platform === PLATFORM);
}

module.exports = Object.freeze({ PROTOCOL, PLATFORM, SAVE_PORT, CONTROL_PORT, CONTROL_PROTOCOL, PPR_PORT, LOADER_PORT,
  MAX_GREETING_BYTES, MAX_MESSAGE_BYTES, MAX_JOB_BYTES, MAX_ARCHIVE_BYTES, CHUNK_BYTES, isWorkerGreeting });
