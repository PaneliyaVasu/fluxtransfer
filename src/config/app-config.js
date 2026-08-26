/**
 * FluxTransfer — Centralized Application Configuration
 */

const DEFAULT_CHUNK_SIZE = 64 * 1024; // 64 KB chunk size for WebRTC DataChannel frames
const BUFFER_HIGH_WATERMARK = 4 * 1024 * 1024; // 4 MB high watermark
const BUFFER_LOW_WATERMARK = 1 * 1024 * 1024;  // 1 MB low watermark
const PBKDF2_ITERATIONS = 100000;
const MAX_MEMORY_FALLBACK_SIZE = 300 * 1024 * 1024; // 300 MB safe limit for non-OPFS memory fallback
const METADATA_ACK_TIMEOUT_MS = 15000; // 15 seconds timeout waiting for receiver metadata-ack
const MAX_EARLY_CHUNK_QUEUE_SIZE = 100; // Maximum early binary chunks queued while receiver initializes
const ROOM_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes of inactivity before signaling room cleanup

const DEFAULT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:openrelay.metered.ca:80' },
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turns:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:80?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  { urls: 'stun:stun.cloudflare.com:3478' }
];

function getIceServers() {
  if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_ICE_SERVERS) {
    try {
      const parsed = JSON.parse(import.meta.env.VITE_ICE_SERVERS);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch (_) {}
  }
  return DEFAULT_ICE_SERVERS;
}

function getDefaultSignalingUrl() {
  if (typeof window !== 'undefined' && window.location) {
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SIGNALING_URL) {
      return import.meta.env.VITE_SIGNALING_URL;
    }
    const host = window.location.host;
    if (window.location.protocol === 'https:') {
      return `wss://${host}/ws`;
    }
    return `ws://${host}/ws`;
  }
  return 'ws://localhost:8080';
}

function getWorkerPath(workerName) {
  const cleanName = workerName.startsWith('/') ? workerName : `/${workerName}`;
  if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL) {
    const base = import.meta.env.BASE_URL.replace(/\/$/, '');
    return `${base}${cleanName}`;
  }
  return cleanName;
}

const APP_CONFIG = {
  DEFAULT_CHUNK_SIZE,
  BUFFER_HIGH_WATERMARK,
  BUFFER_LOW_WATERMARK,
  PBKDF2_ITERATIONS,
  MAX_MEMORY_FALLBACK_SIZE,
  METADATA_ACK_TIMEOUT_MS,
  MAX_EARLY_CHUNK_QUEUE_SIZE,
  ROOM_INACTIVITY_TIMEOUT_MS,
  DEFAULT_ICE_SERVERS,
  getIceServers,
  getDefaultSignalingUrl,
  getWorkerPath
};

if (typeof process !== 'undefined' && process.versions && process.versions.node && typeof module !== 'undefined' && module.exports) {
  module.exports = APP_CONFIG;
  module.exports.default = APP_CONFIG;
  module.exports.APP_CONFIG = APP_CONFIG;
  module.exports.DEFAULT_CHUNK_SIZE = DEFAULT_CHUNK_SIZE;
  module.exports.BUFFER_HIGH_WATERMARK = BUFFER_HIGH_WATERMARK;
  module.exports.BUFFER_LOW_WATERMARK = BUFFER_LOW_WATERMARK;
  module.exports.PBKDF2_ITERATIONS = PBKDF2_ITERATIONS;
  module.exports.MAX_MEMORY_FALLBACK_SIZE = MAX_MEMORY_FALLBACK_SIZE;
  module.exports.METADATA_ACK_TIMEOUT_MS = METADATA_ACK_TIMEOUT_MS;
  module.exports.MAX_EARLY_CHUNK_QUEUE_SIZE = MAX_EARLY_CHUNK_QUEUE_SIZE;
  module.exports.ROOM_INACTIVITY_TIMEOUT_MS = ROOM_INACTIVITY_TIMEOUT_MS;
  module.exports.DEFAULT_ICE_SERVERS = DEFAULT_ICE_SERVERS;
  module.exports.getIceServers = getIceServers;
  module.exports.getDefaultSignalingUrl = getDefaultSignalingUrl;
  module.exports.getWorkerPath = getWorkerPath;
}

export {
  DEFAULT_CHUNK_SIZE,
  BUFFER_HIGH_WATERMARK,
  BUFFER_LOW_WATERMARK,
  PBKDF2_ITERATIONS,
  MAX_MEMORY_FALLBACK_SIZE,
  METADATA_ACK_TIMEOUT_MS,
  MAX_EARLY_CHUNK_QUEUE_SIZE,
  ROOM_INACTIVITY_TIMEOUT_MS,
  DEFAULT_ICE_SERVERS,
  getIceServers,
  getDefaultSignalingUrl,
  getWorkerPath,
  APP_CONFIG
};

export default APP_CONFIG;
