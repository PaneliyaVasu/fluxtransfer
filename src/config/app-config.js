/**
 * FluxTransfer — Centralized Application Configuration
 */

const DEFAULT_CHUNK_SIZE = 128 * 1024; // 128 KB chunk size for WebRTC DataChannel frames
const BUFFER_HIGH_WATERMARK = 4 * 1024 * 1024; // 4 MB high watermark
const BUFFER_LOW_WATERMARK = 1 * 1024 * 1024;  // 1 MB low watermark
const PBKDF2_ITERATIONS = 100000;
const MAX_MEMORY_FALLBACK_SIZE = 300 * 1024 * 1024; // 300 MB safe limit for non-OPFS memory fallback
const METADATA_ACK_TIMEOUT_MS = 15000; // 15 seconds timeout waiting for receiver metadata-ack
const MAX_EARLY_CHUNK_QUEUE_SIZE = 100; // Maximum early binary chunks queued while receiver initializes
const ROOM_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes of inactivity before signaling room cleanup
const ICE_RECONNECT_TIMEOUT_MS = 5000; // 5 seconds recovery window for ICE disconnects before attempting restart
const MAX_ICE_RESTART_ATTEMPTS = 2; // Maximum ICE restart negotiation attempts per transfer

const ALPHANUMERIC_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function getCryptoObj() {
  if (typeof window !== 'undefined' && window.crypto && typeof window.crypto.getRandomValues === 'function') {
    return window.crypto;
  }
  if (typeof self !== 'undefined' && self.crypto && typeof self.crypto.getRandomValues === 'function') {
    return self.crypto;
  }
  if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    return globalThis.crypto;
  }
  if (typeof require !== 'undefined') {
    try {
      const nodeCrypto = require('crypto');
      if (nodeCrypto.webcrypto) return nodeCrypto.webcrypto;
    } catch (_) {}
  }
  return null;
}

/**
 * Generate a cryptographically secure, unbiased session code of specified length.
 * Default: 8 alphanumeric characters (~47.6 bits of entropy).
 * Uses rejection sampling to eliminate modulo bias.
 */
function generateSessionCode(length = 8) {
  const cryptoObj = getCryptoObj();
  const alphabetLen = ALPHANUMERIC_ALPHABET.length; // 62
  const maxUnbiasedByte = 256 - (256 % alphabetLen); // 248 (bytes >= 248 rejected)

  let code = '';
  while (code.length < length) {
    const randomBytes = new Uint8Array(length * 2);
    if (cryptoObj) {
      cryptoObj.getRandomValues(randomBytes);
    } else {
      for (let i = 0; i < randomBytes.length; i++) {
        randomBytes[i] = Math.floor(Math.random() * 256);
      }
    }

    for (let i = 0; i < randomBytes.length && code.length < length; i++) {
      const byte = randomBytes[i];
      if (byte < maxUnbiasedByte) {
        code += ALPHANUMERIC_ALPHABET[byte % alphabetLen];
      }
    }
  }

  return code;
}

function isValidSessionCode(code) {
  if (!code || typeof code !== 'string') return false;
  const trimmed = code.trim();
  return /^[a-zA-Z0-9]{8}$/.test(trimmed) || /^[0-9]{6}$/.test(trimmed);
}

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:8080',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:8080'
];

function getAllowedOrigins() {
  if (typeof process !== 'undefined' && process.env && process.env.ALLOWED_ORIGINS) {
    return process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean);
  }
  if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_ALLOWED_ORIGINS) {
    return import.meta.env.VITE_ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean);
  }
  return DEFAULT_ALLOWED_ORIGINS;
}

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
  ICE_RECONNECT_TIMEOUT_MS,
  MAX_ICE_RESTART_ATTEMPTS,
  ALPHANUMERIC_ALPHABET,
  generateSessionCode,
  isValidSessionCode,
  getAllowedOrigins,
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
  module.exports.ICE_RECONNECT_TIMEOUT_MS = ICE_RECONNECT_TIMEOUT_MS;
  module.exports.MAX_ICE_RESTART_ATTEMPTS = MAX_ICE_RESTART_ATTEMPTS;
  module.exports.ALPHANUMERIC_ALPHABET = ALPHANUMERIC_ALPHABET;
  module.exports.generateSessionCode = generateSessionCode;
  module.exports.isValidSessionCode = isValidSessionCode;
  module.exports.getAllowedOrigins = getAllowedOrigins;
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
  ICE_RECONNECT_TIMEOUT_MS,
  MAX_ICE_RESTART_ATTEMPTS,
  ALPHANUMERIC_ALPHABET,
  generateSessionCode,
  isValidSessionCode,
  getAllowedOrigins,
  DEFAULT_ICE_SERVERS,
  getIceServers,
  getDefaultSignalingUrl,
  getWorkerPath,
  APP_CONFIG
};

export default APP_CONFIG;
