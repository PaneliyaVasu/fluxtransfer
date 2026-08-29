import { createSoftwareCrypto } from '../utils/software-crypto.js';
import { createZipArchive } from '../utils/zip-files.js';

if (typeof globalThis !== 'undefined' && !globalThis.FluxSoftwareCrypto) {
  globalThis.FluxSoftwareCrypto = createSoftwareCrypto();
}

/**
 * FluxTransfer — Canonical Client-Side WebRTC File Transfer Engine
 * 
 * Features:
 * - Native WebRTC RTCPeerConnection & RTCDataChannel
 * - WebSocket Signaling client for room pairing & SDP/ICE exchange
 * - Application-level E2EE (AES-256 / SHA-256 keystream cipher via Web Crypto API, derived with PBKDF2 salt)
 * - Unique 12-byte random IV/nonce per encrypted chunk
 * - In-memory chunk stream reassembly
 * - SHA-256 file integrity calculation & verification
 * - Event-driven, non-bypassing backpressure management
 * - Deterministic transfer state machine (idle, connecting, connected, transferring, completed, failed, cancelled)
 * - Application-level P2P control messaging interface (for Flux Zen ambient mode)
 * - Zero logging of secrets, keys, PINs, or plaintext data
 */

(function (global) {
  'use strict';

  const FRAME_OVERHEAD = 32; // 4B index + 12B IV + 16B GCM tag
  const DEFAULT_CHUNK_SIZE = 64 * 1024; // Safe under conservative 64 KB SCTP limits
  const MAX_CHUNK_SIZE = 256 * 1024;
  const BUFFER_HIGH_WATERMARK = 4 * 1024 * 1024; // 4 MB — keeps the pipe full on LAN without blowing mobile RAM
  const BUFFER_LOW_WATERMARK = 1 * 1024 * 1024;  // 1 MB
  const PBKDF2_ITERATIONS = 10000;
  const METADATA_ACK_TIMEOUT_MS = 15000;
  const MAX_EARLY_CHUNK_QUEUE_SIZE = 100;
  const MAX_MEMORY_FALLBACK_SIZE = 300 * 1024 * 1024; // Prefer disk-backed receive above this; not a hard reject
  const ICE_RECONNECT_TIMEOUT_MS = 5000;
  const MAX_ICE_RESTART_ATTEMPTS = 2;
  const STALL_TIMEOUT_MS = 30000;
  const PIPELINE_DEPTH = 3;
  const WORKER_PIPELINE_DEPTH = 6;
  const CRYPTO_WORKER_COUNT = 2;
  const MAX_BATCH_FILES = 100;

  function getManifestApi() {
    if (typeof globalThis !== 'undefined' && globalThis.FluxTransferManifest && typeof globalThis.FluxTransferManifest.getManifest === 'function') {
      return globalThis.FluxTransferManifest;
    }
    if (typeof require !== 'function') return null;
    try {
      const api = require('../storage/transfer-manifest.js');
      if (api && typeof api.getManifest === 'function') return api;
    } catch (_) { }
    return null;
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

  function normalizeIp(value) {
    if (!value || typeof value !== 'string') return '';
    let ip = value.trim().replace(/^\[|\]$/g, '');
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    return ip;
  }

  function isPrivateIPv4(ip) {
    const clean = normalizeIp(ip);
    const parts = clean.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    if (parts[0] === 10) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    return false;
  }

  function getPageLanHints() {
    const hints = [];
    if (typeof window === 'undefined' || !window.location) return hints;
    const host = normalizeIp(window.location.hostname);
    if (isPrivateIPv4(host)) hints.push(host);
    return hints;
  }

  function getSignalingUrls() {
    if (typeof window === 'undefined' || !window.location) {
      return ['ws://localhost:8080'];
    }
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SIGNALING_URL) {
      return [import.meta.env.VITE_SIGNALING_URL];
    }
    const { protocol, host, hostname } = window.location;
    if (protocol === 'https:') {
      return [`wss://${host}/ws`];
    }
    const urls = [];
    const add = (url) => {
      if (url && !urls.includes(url)) urls.push(url);
    };
    if (isPrivateIPv4(hostname)) {
      add(`ws://${host}/ws`);
      add(`ws://${hostname}:8080`);
      add(`ws://${hostname}:8080/ws`);
    } else if (hostname === 'localhost' || hostname === '127.0.0.1') {
      add(`ws://${host}/ws`);
      add('ws://127.0.0.1:8080');
      add('ws://localhost:8080');
    } else {
      add(`ws://${host}/ws`);
      add(`ws://${hostname}:8080`);
    }
    return urls;
  }

  function rewriteHostCandidate(candidateStr, lanIps) {
    if (!candidateStr || !/typ host\b/i.test(candidateStr)) return [];
    const match = candidateStr.match(/^(candidate:\S+\s+\d+\s+\S+\s+\d+\s+)(\S+)(\s+\d+\s+typ\s+host\b.*)$/i);
    if (!match) return [];
    const extras = [];
    for (const ip of lanIps) {
      if (ip && ip !== match[2] && isPrivateIPv4(ip)) {
        extras.push(`${match[1]}${ip}${match[3]}`);
      }
    }
    return extras;
  }

  function hasSubtleApi(cryptoObj) {
    return !!(
      cryptoObj &&
      cryptoObj.subtle &&
      typeof cryptoObj.subtle.importKey === 'function' &&
      typeof cryptoObj.subtle.deriveKey === 'function' &&
      typeof cryptoObj.subtle.encrypt === 'function' &&
      typeof cryptoObj.subtle.decrypt === 'function'
    );
  }

  function getNativeCrypto() {
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
        if (nodeCrypto.webcrypto) {
          return nodeCrypto.webcrypto;
        }
      } catch (_) { }
    }
    return null;
  }

  function getSoftwareCryptoApi() {
    if (typeof globalThis !== 'undefined' && globalThis.FluxSoftwareCrypto && hasSubtleApi(globalThis.FluxSoftwareCrypto)) {
      return globalThis.FluxSoftwareCrypto;
    }
    if (typeof require === 'function') {
      try {
        const mod = require('../utils/software-crypto.js');
        const factory = mod.createSoftwareCrypto || (mod.default && mod.default.createSoftwareCrypto);
        const api = typeof factory === 'function' ? factory() : null;
        if (api && typeof globalThis !== 'undefined') {
          globalThis.FluxSoftwareCrypto = api;
        }
        return api;
      } catch (_) { }
    }
    return null;
  }

  function getCrypto() {
    const native = getNativeCrypto();
    if (hasSubtleApi(native)) return native;

    const software = getSoftwareCryptoApi();
    if (software && hasSubtleApi(software)) {
      const rng = (native && typeof native.getRandomValues === 'function')
        ? native.getRandomValues.bind(native)
        : software.getRandomValues.bind(software);
      return { getRandomValues: rng, subtle: software.subtle };
    }

    throw new Error('Web Crypto API is unavailable. FluxTransfer requires a secure context (HTTPS or localhost).');
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const block = 0x8000;
    for (let i = 0; i < view.length; i += block) {
      binary += String.fromCharCode(...view.subarray(i, i + block));
    }
    return btoa(binary);
  }

  function toOwnedBytes(data) {
    if (data instanceof Uint8Array) return data.slice();
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    return new Uint8Array(data || 0);
  }

  function frameToArrayBuffer(frame) {
    if (frame instanceof ArrayBuffer) return frame;
    if (frame instanceof Uint8Array || ArrayBuffer.isView(frame)) {
      return frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
    }
    return frame;
  }

  const MIME_BY_EXT = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    zip: 'application/zip',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    wav: 'audio/wav',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  };

  function inferMimeType(fileName, fallback) {
    if (fallback && fallback !== 'application/octet-stream') return fallback;
    const ext = String(fileName || '').split('.').pop().toLowerCase();
    return MIME_BY_EXT[ext] || fallback || 'application/octet-stream';
  }

  function isSecureBrowserContext() {
    if (typeof window === 'undefined' || typeof window.isSecureContext !== 'boolean') return true;
    return window.isSecureContext === true;
  }

  const IDB_RECEIVE_DB = 'flux_receive_parts';
  const IDB_RECEIVE_STORE = 'parts';
  const IDB_FLUSH_BYTES = 8 * 1024 * 1024;

  function getIndexedDB() {
    if (typeof indexedDB !== 'undefined') return indexedDB;
    if (typeof globalThis !== 'undefined' && globalThis.indexedDB) return globalThis.indexedDB;
    return null;
  }

  function openReceiveIdb() {
    return new Promise((resolve) => {
      const idb = getIndexedDB();
      if (!idb) {
        resolve(null);
        return;
      }
      try {
        const req = idb.open(IDB_RECEIVE_DB, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_RECEIVE_STORE)) {
            db.createObjectStore(IDB_RECEIVE_STORE);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  }

  function idbRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
  }

  async function clearReceiveIdb(db) {
    const tx = db.transaction(IDB_RECEIVE_STORE, 'readwrite');
    tx.objectStore(IDB_RECEIVE_STORE).clear();
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('IndexedDB clear failed'));
    });
  }

  function deleteReceiveIdb() {
    return new Promise((resolve) => {
      const idb = getIndexedDB();
      if (!idb) {
        resolve();
        return;
      }
      try {
        const req = idb.deleteDatabase(IDB_RECEIVE_DB);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      } catch (_) {
        resolve();
      }
    });
  }

  function createNamedFile(parts, name, type) {
    if (typeof File === 'function') {
      try {
        return new File(parts, name, { type });
      } catch (_) { }
    }
    const blob = new Blob(parts, { type });
    try { blob.name = name; } catch (_) { }
    return blob;
  }

  async function materializeDownloadFile(source, meta) {
    const name = (meta && meta.name) || (source && source.name) || 'received-file';
    const mime = inferMimeType(name, (meta && meta.mimeType) || (source && source.type) || 'application/octet-stream');
    if (source instanceof ArrayBuffer) {
      return createNamedFile([source], name, mime);
    }
    if (ArrayBuffer.isView(source)) {
      return createNamedFile([toOwnedBytes(source)], name, mime);
    }
    if (typeof Blob !== 'undefined' && source instanceof Blob) {
      return createNamedFile([source], name, mime);
    }
    if (Array.isArray(source)) {
      return createNamedFile(source, name, mime);
    }
    throw new Error('Receiver produced an empty file');
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  class FluxWebRTCEngine {
    /**
     * @param {Object} config
     * @param {string} [config.signalingUrl]
     * @param {Array<RTCIceServer>} [config.iceServers]
     * @param {Function} [config.onStatusChange] - (statusText, statusType) => void
     * @param {Function} [config.onProgress] - ({ percent, transferredBytes, totalBytes, speedBps, role }) => void
     * @param {Function} [config.onFileMetadata] - (metadata) => void
     * @param {Function} [config.onFileComplete] - (fileObj, metadata) => void
     * @param {Function} [config.onError] - (errorMessage, errorCode) => void
     * @param {Function} [config.onPeerJoined] - () => void
     * @param {Function} [config.onDataChannelOpen] - () => void
     * @param {Function} [config.onPeerLeft] - () => void
     * @param {Function} [config.onControlMessage] - (msgObj) => void (Application-level messages e.g. Flux Zen)
     */
    constructor(config = {}) {
      let defaultSignalingUrl;
      if (typeof window !== 'undefined' && window.location) {
        if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SIGNALING_URL) {
          defaultSignalingUrl = import.meta.env.VITE_SIGNALING_URL;
        } else if (window.location.protocol === 'https:') {
          defaultSignalingUrl = `wss://${window.location.host}/ws`;
        } else {
          // Use Vite /ws proxy on the same port (3000) so mobile devices connect seamlessly without firewall blockage
          defaultSignalingUrl = `ws://${window.location.host}/ws`;
        }
      } else {
        defaultSignalingUrl = 'ws://localhost:8080';
      }

      this.signalingUrl = config.signalingUrl || defaultSignalingUrl;
      this._signalingUrls = config.signalingUrl ? [config.signalingUrl] : getSignalingUrls();
      this._signalingUrlIndex = 0;
      this._lanHints = new Set(getPageLanHints());
      this._localHostCandidates = [];
      this._connectWatchTimer = null;
      this.iceServers = config.iceServers || DEFAULT_ICE_SERVERS;

      // Event Callbacks
      this.onStatusChange = config.onStatusChange || (() => { });
      this.onProgress = config.onProgress || (() => { });
      this.onFileMetadata = config.onFileMetadata || (() => { });
      this.onFileComplete = config.onFileComplete || (() => { });
      this.onError = config.onError || (() => { });
      this.onPeerJoined = config.onPeerJoined || (() => { });
      this.onDataChannelOpen = config.onDataChannelOpen || (() => { });
      this.onPeerLeft = config.onPeerLeft || (() => { });
      this.onControlMessage = config.onControlMessage || (() => { });

      // Connections & State
      this.ws = null;
      this.pc = null;
      this.dataChannel = null;
      this.roomCode = null;
      this.sessionCode = null;
      this.role = null; // 'initiator' | 'joiner'
      this.isTransferring = false;
      this.pendingIceCandidates = [];

      // Deterministic Transfer State Tracking
      this.transferState = 'idle'; // 'idle'|'connecting'|'connected'|'transferring'|'completed'|'cancelled'|'failed'
      this.transferId = null;

      // Encryption Key & Salt
      this.aesKey = null;
      this.salt = null;

      // Receiver state & OPFS worker
      this.incomingMeta = null;
      this.receivedChunksCount = 0;
      this.receivedBytes = 0;
      this.memoryChunks = null;
      this.opfsWorker = null;
      this.opfsActive = false;
      this.finishStarted = false;
      this._receiverReady = false;
      this._earlyChunkQueue = [];
      this.receivedChunkSet = null;
      this.storage = null;
      this.senderFinalHash = null;
      this.receiverHasher = null;
      this.senderHasher = null;

      // Protocol handshake
      this._metadataAckReceived = false;
      this._metadataAckResolve = null;
      this._metadataAckReject = null;
      this._metadataAckTimer = null;

      // Receive serialization + OPFS backpressure
      this._receiveChain = Promise.resolve();
      this._opfsWritePending = 0;
      this._opfsDrainedResolvers = [];
      this._opfsFinalizeResolve = null;
      this._opfsFinalizeReject = null;

      // Connection recovery
      this._iceRestartAttempts = 0;
      this._iceDisconnectTimer = null;
      this._iceReconnectTimer = null;
      this._isIceRestarting = false;
      this._stallTimer = null;
      this._negotiatedChunkSize = DEFAULT_CHUNK_SIZE;

      // Speed & UI state
      this.transferStartTime = 0;
      this.lastProgressTime = 0;
      this.lastProgressBytes = 0;
      this.currentSpeedBps = 0;

      // Sender state
      this.currentFile = null;
      this._cryptoWorkers = [];
      this._cryptoWorkerCursor = 0;
      this._cryptoJobId = 1;
      this._cryptoJobs = new Map();
    }

    _setState(state, extraInfo = {}) {
      const force = extraInfo && extraInfo.force === true;
      if (!force && this.transferState === 'completed' && (state === 'failed' || state === 'connecting' || state === 'connected')) {
        console.log(`[WebRTC Engine] Suppressing state transition to ${state} because transfer is already completed.`);
        return;
      }
      this.transferState = state;
      console.log(`[WebRTC Engine] State transition -> ${state}`);
      if (typeof this._onStateChangeCb === 'function') {
        this._onStateChangeCb(state, extraInfo);
      }
    }

    /**
     * Event listener helper for UI integration
     */
    on(event, fn) {
      if (typeof fn !== 'function') return this;
      switch (event) {
        case 'stateChange':
          this._onStateChangeCb = fn;
          break;
        case 'statusChange':
          this.onStatusChange = (status, type) => fn(status, type);
          break;
        case 'progress':
          this.onProgress = (info) => fn(info);
          break;
        case 'fileReceived':
        case 'fileComplete':
          this.onFileComplete = (fileObj, meta) => fn({
            blob: fileObj,
            fileName: meta?.name || fileObj?.name,
            fileType: meta?.mimeType || meta?.type || fileObj?.type,
            packedFileCount: meta?.packedFileCount || 1,
            packedFiles: Array.isArray(meta?.packedFiles) ? meta.packedFiles : []
          });
          break;
        case 'fileMetadata':
          this.onFileMetadata = (meta) => fn(meta);
          break;
        case 'roomCreated':
          this.onRoomCreated = (data) => fn(data);
          break;
        case 'error':
          this.onError = (err, code) => fn(typeof err === 'string' ? err : err?.message || 'Error', code);
          break;
        case 'peerJoined':
          this.onPeerJoined = fn;
          break;
        case 'peerLeft':
          this.onPeerLeft = fn;
          break;
        case 'dataChannelOpen':
          this.onDataChannelOpen = fn;
          break;
      }
      return this;
    }

    /**
     * Universal SHA-256 implementation helper for fallback streaming
     */
    _getStreamingSHA256Class() {
      const K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
      ];

      return class StreamingSHA256 {
        constructor() {
          this.reset();
        }

        reset() {
          this.H0 = 0x6a09e667; this.H1 = 0xbb67ae85; this.H2 = 0x3c6ef372; this.H3 = 0xa54ff53a;
          this.H4 = 0x510e527f; this.H5 = 0x9b05688c; this.H6 = 0x1f83d9ab; this.H7 = 0x5be0cd19;
          this.buffer = new Uint8Array(64);
          this.bufferLen = 0;
          this.totalBytes = 0;
          this.W = new Uint32Array(64);
        }

        _processBlock(blockBytes) {
          const view = new DataView(blockBytes.buffer, blockBytes.byteOffset, 64);
          const W = this.W;
          for (let t = 0; t < 16; t++) {
            W[t] = view.getUint32(t * 4, false);
          }
          for (let t = 16; t < 64; t++) {
            const s0 = ((W[t - 15] >>> 7) | (W[t - 15] << 25)) ^ ((W[t - 15] >>> 18) | (W[t - 15] << 14)) ^ (W[t - 15] >>> 3);
            const s1 = ((W[t - 2] >>> 17) | (W[t - 2] << 15)) ^ ((W[t - 2] >>> 19) | (W[t - 2] << 13)) ^ (W[t - 2] >>> 10);
            W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0;
          }

          let a = this.H0, b = this.H1, c = this.H2, d = this.H3;
          let e = this.H4, f = this.H5, g = this.H6, h = this.H7;

          for (let t = 0; t < 64; t++) {
            const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + S1 + ch + K[t] + W[t]) | 0;
            const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) | 0;

            h = g; g = f; f = e; e = (d + temp1) | 0;
            d = c; c = b; b = a; a = (temp1 + temp2) | 0;
          }

          this.H0 = (this.H0 + a) | 0; this.H1 = (this.H1 + b) | 0;
          this.H2 = (this.H2 + c) | 0; this.H3 = (this.H3 + d) | 0;
          this.H4 = (this.H4 + e) | 0; this.H5 = (this.H5 + f) | 0;
          this.H6 = (this.H6 + g) | 0; this.H7 = (this.H7 + h) | 0;
        }

        update(chunk) {
          const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          this.totalBytes += bytes.length;

          let pos = 0;
          if (this.bufferLen > 0) {
            const needed = 64 - this.bufferLen;
            const copy = Math.min(needed, bytes.length);
            this.buffer.set(bytes.subarray(0, copy), this.bufferLen);
            this.bufferLen += copy;
            pos += copy;

            if (this.bufferLen === 64) {
              this._processBlock(this.buffer);
              this.bufferLen = 0;
            }
          }

          while (pos + 64 <= bytes.length) {
            this._processBlock(bytes.subarray(pos, pos + 64));
            pos += 64;
          }

          if (pos < bytes.length) {
            const remaining = bytes.subarray(pos);
            this.buffer.set(remaining, 0);
            this.bufferLen = remaining.length;
          }
        }

        digestHex() {
          const totalBits = this.totalBytes * 8;
          const padLen = (((this.bufferLen + 8) >> 6) + 1) << 6;
          const padded = new Uint8Array(padLen);
          padded.set(this.buffer.subarray(0, this.bufferLen));
          padded[this.bufferLen] = 0x80;

          const view = new DataView(padded.buffer);
          const highBits = Math.floor(totalBits / 0x100000000);
          const lowBits = totalBits % 0x100000000;
          view.setUint32(padLen - 8, highBits, false);
          view.setUint32(padLen - 4, lowBits, false);

          for (let i = 0; i < padLen; i += 64) {
            this._processBlock(padded.subarray(i, i + 64));
          }

          const out = new Uint8Array(32);
          const outView = new DataView(out.buffer);
          outView.setUint32(0, this.H0, false); outView.setUint32(4, this.H1, false);
          outView.setUint32(8, this.H2, false); outView.setUint32(12, this.H3, false);
          outView.setUint32(16, this.H4, false); outView.setUint32(20, this.H5, false);
          outView.setUint32(24, this.H6, false); outView.setUint32(28, this.H7, false);

          return Array.from(out).map(b => b.toString(16).padStart(2, '0')).join('');
        }
      };
    }

    _sha256(data) {
      const hasherClass = this._getStreamingSHA256Class();
      const hasher = new hasherClass();
      const bytes = data instanceof Uint8Array ? data : (typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
      hasher.update(bytes);
      const hex = hasher.digestHex();
      const out = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
      }
      return out;
    }

    _spawnCryptoWorker() {
      if (typeof Worker === 'undefined') return null;
      try {
        if (typeof import.meta !== 'undefined' && import.meta.url) {
          return new Worker(new URL('../client/crypto-worker.js', import.meta.url), { type: 'module' });
        }
      } catch (_) { }
      try {
        return new Worker('/crypto-worker.js');
      } catch (_) { }
      return null;
    }

    _bindCryptoWorker(worker) {
      worker.onmessage = (event) => {
        const payload = event.data || {};
        const job = this._cryptoJobs.get(payload.id);
        if (!job) return;
        this._cryptoJobs.delete(payload.id);
        if (payload.type === 'error') {
          job.reject(new Error(payload.message || 'Crypto worker error'));
          return;
        }
        job.resolve(payload);
      };
      worker.onerror = () => {
        this._teardownCryptoWorkers();
      };
    }

    _teardownCryptoWorkers() {
      this._cryptoWorkers.forEach((worker) => {
        try { worker.terminate(); } catch (_) { }
      });
      this._cryptoWorkers = [];
      this._cryptoJobs.forEach((job) => job.reject(new Error('Crypto worker stopped')));
      this._cryptoJobs.clear();
    }

    _callCryptoWorker(type, extra, transferList) {
      if (!this._cryptoWorkers.length) {
        return Promise.reject(new Error('Crypto workers unavailable'));
      }
      const worker = this._cryptoWorkers[this._cryptoWorkerCursor % this._cryptoWorkers.length];
      this._cryptoWorkerCursor += 1;
      const id = this._cryptoJobId++;
      return new Promise((resolve, reject) => {
        this._cryptoJobs.set(id, { resolve, reject });
        try {
          worker.postMessage({ type, id, ...extra }, transferList || []);
        } catch (err) {
          this._cryptoJobs.delete(id);
          reject(err);
        }
      });
    }

    async _initCryptoWorkers(sessionCode, salt) {
      if (typeof Worker === 'undefined') return false;
      if (this._cryptoWorkers.length) {
        const saltCopy = salt instanceof Uint8Array ? salt.slice() : new Uint8Array(salt);
        try {
          await Promise.all(this._cryptoWorkers.map(() =>
            this._callCryptoWorker('init', { sessionCode, salt: saltCopy })
          ));
          return true;
        } catch (_) {
          this._teardownCryptoWorkers();
        }
      }

      const workers = [];
      for (let i = 0; i < CRYPTO_WORKER_COUNT; i++) {
        const worker = this._spawnCryptoWorker();
        if (!worker) break;
        this._bindCryptoWorker(worker);
        workers.push(worker);
      }
      if (!workers.length) return false;
      this._cryptoWorkers = workers;
      const saltCopy = salt instanceof Uint8Array ? salt.slice() : new Uint8Array(salt);
      try {
        await Promise.all(workers.map(() =>
          this._callCryptoWorker('init', { sessionCode, salt: saltCopy })
        ));
        return true;
      } catch (_) {
        this._teardownCryptoWorkers();
        return false;
      }
    }

    _getPipelineDepth() {
      return this._cryptoWorkers.length ? WORKER_PIPELINE_DEPTH : PIPELINE_DEPTH;
    }

    /**
     * Derive AES-GCM 256-bit CryptoKey from Session Code / PIN and Salt using PBKDF2 (100k iterations)
     */
    async deriveKey(sessionCode, salt) {
      const cleanCode = String(sessionCode || '').trim();
      if (!cleanCode) throw new Error('Missing session code for key derivation');

      const cryptoObj = getCrypto();
      const encoder = new TextEncoder();
      const codeBytes = encoder.encode(cleanCode);
      const saltBytes = salt instanceof Uint8Array ? salt : (salt ? new Uint8Array(salt) : new Uint8Array(16));

      const keyMaterial = await cryptoObj.subtle.importKey(
        'raw',
        codeBytes,
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
      );

      const derivedKey = await cryptoObj.subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt: saltBytes,
          iterations: PBKDF2_ITERATIONS,
          hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );

      return derivedKey;
    }

    /**
     * Encrypt a chunk ArrayBuffer using native AES-256-GCM via Web Crypto API
     * Frame format: [ChunkIndex (4B, BigEndian)][IV (12B)][Ciphertext + 16B Auth Tag]
     */
    async encryptChunk(chunkBuffer, chunkIndex, key) {
      if (this._cryptoWorkers.length) {
        try {
          const owned = chunkBuffer instanceof ArrayBuffer
            ? chunkBuffer.slice(0)
            : chunkBuffer.buffer.slice(chunkBuffer.byteOffset, chunkBuffer.byteOffset + chunkBuffer.byteLength);
          const result = await this._callCryptoWorker('encrypt', { buffer: owned, chunkIndex }, [owned]);
          return new Uint8Array(result.buffer);
        } catch (_) {
          // Fall through to main-thread encrypt
        }
      }

      const cryptoObj = getCrypto();
      const iv = cryptoObj.getRandomValues(new Uint8Array(12));

      const additionalData = new Uint8Array(4);
      new DataView(additionalData.buffer).setUint32(0, chunkIndex, false);

      const ciphertextBuffer = await cryptoObj.subtle.encrypt(
        { name: 'AES-GCM', iv: iv, additionalData: additionalData },
        key,
        chunkBuffer
      );

      const ciphertextBytes = new Uint8Array(ciphertextBuffer);
      const frame = new Uint8Array(4 + 12 + ciphertextBytes.byteLength);
      const view = new DataView(frame.buffer);
      view.setUint32(0, chunkIndex, false);
      frame.set(iv, 4);
      frame.set(ciphertextBytes, 16);
      return frame;
    }

    /**
     * Decrypt a chunk frame buffer using native AES-256-GCM via Web Crypto API
     */
    async decryptFrame(frameBuffer, key) {
      const buffer = frameBuffer instanceof ArrayBuffer
        ? frameBuffer
        : frameBuffer.buffer.slice(frameBuffer.byteOffset, frameBuffer.byteOffset + frameBuffer.byteLength);

      if (this._cryptoWorkers.length) {
        try {
          const owned = buffer.slice(0);
          const result = await this._callCryptoWorker('decrypt', { buffer: owned }, [owned]);
          return { chunkIndex: result.chunkIndex, chunkData: result.buffer };
        } catch (_) {
          // Fall through to main-thread decrypt
        }
      }

      if (buffer.byteLength < 32) {
        throw new Error('Invalid transfer frame: undersized payload');
      }

      const view = new DataView(buffer);
      const chunkIndex = view.getUint32(0, false);
      const iv = new Uint8Array(buffer, 4, 12);
      const ciphertext = new Uint8Array(buffer, 16);

      const additionalData = new Uint8Array(4);
      new DataView(additionalData.buffer).setUint32(0, chunkIndex, false);

      const cryptoObj = getCrypto();
      const decryptedBuffer = await cryptoObj.subtle.decrypt(
        { name: 'AES-GCM', iv: iv, additionalData: additionalData },
        key,
        ciphertext
      );

      return { chunkIndex, chunkData: decryptedBuffer };
    }

    /**
     * Off-main-thread streaming SHA-256 file hashing via hash-worker.js with streaming fallback
     */
    async _computeHash(payload) {
      if (typeof Worker !== 'undefined' && (payload instanceof Blob || (typeof File !== 'undefined' && payload instanceof File))) {
        try {
          const workerPath = '/hash-worker.js';
          const worker = new Worker(workerPath);
          const hashResult = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              try { worker.terminate(); } catch (_) { }
              reject(new Error('Hash worker timeout'));
            }, 5 * 60 * 1000);
            worker.onmessage = (e) => {
              if (e.data?.type === 'complete') {
                clearTimeout(timer);
                try { worker.terminate(); } catch (_) { }
                resolve(e.data.hash);
              } else if (e.data?.type === 'error') {
                clearTimeout(timer);
                try { worker.terminate(); } catch (_) { }
                reject(new Error(e.data.message));
              }
            };
            worker.postMessage({ type: 'hash-file', file: payload });
          });
          return hashResult;
        } catch (_) {
          // Fallback if worker creation fails (e.g. cross-origin/sandbox)
        }
      }

      return await this._canonicalHashFallback(payload);
    }

    async _canonicalHashFallback(fileOrChunks) {
      if (fileOrChunks instanceof Blob || (typeof File !== 'undefined' && fileOrChunks instanceof File)) {
        const chunkSize = 1024 * 1024; // 1 MB streaming slices
        let offset = 0;
        const total = fileOrChunks.size;

        if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function' && total <= 64 * 1024 * 1024) {
          const buf = await fileOrChunks.arrayBuffer();
          const hashBuf = await crypto.subtle.digest('SHA-256', buf);
          return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
        }

        const hasherClass = this._getStreamingSHA256Class();
        const hasher = new hasherClass();
        while (offset < total) {
          const slice = fileOrChunks.slice(offset, Math.min(offset + chunkSize, total));
          const buf = await slice.arrayBuffer();
          hasher.update(new Uint8Array(buf));
          offset += buf.byteLength;
        }
        return hasher.digestHex();
      }

      if (Array.isArray(fileOrChunks)) {
        const hasherClass = this._getStreamingSHA256Class();
        const hasher = new hasherClass();
        for (let c of fileOrChunks) {
          if (!c) continue;
          const arr = ArrayBuffer.isView(c) ? new Uint8Array(c.buffer, c.byteOffset, c.byteLength) : new Uint8Array(c);
          hasher.update(arr);
        }
        return hasher.digestHex();
      }

      throw new Error('Unsupported payload for SHA-256 hashing');
    }

    /**
     * Connect to WebSocket signaling server and join room
     * @param {string} roomCode 
     * @param {string} [sessionCode] - Pairing PIN used for key derivation
     */
    connect(roomCode, sessionCode = null) {
      if (!roomCode) {
        this.onError('Room code is required', 'ERR_INVALID_ROOM');
        return;
      }

      const savedRoom = String(roomCode).trim();
      const savedSession = sessionCode ? String(sessionCode).trim() : savedRoom;
      this.disconnect();
      this.roomCode = savedRoom;
      this.sessionCode = savedSession;
      this._signalingUrls = getSignalingUrls();
      this._signalingUrlIndex = 0;
      this._lanHints = new Set(getPageLanHints());
      this._localHostCandidates = [];
      this._setState('connecting');
      this.onStatusChange('Connecting to signaling server…', 'info');
      this._openSignalingSocket();
    }

    _openSignalingSocket() {
      this.signalingUrl = this._signalingUrls[this._signalingUrlIndex] || this.signalingUrl;
      try {
        const WebSocketImpl = typeof window !== 'undefined' ? window.WebSocket : require('ws');
        this.ws = new WebSocketImpl(this.signalingUrl);
      } catch (err) {
        if (this._tryNextSignalingUrl()) return;
        this._setState('failed');
        this.onError(`Failed to connect to signaling server: ${err.message}`, 'ERR_WS_CONNECT');
        return;
      }

      const socket = this.ws;
      const connectTimeout = setTimeout(() => {
        if (this.ws !== socket) return;
        if (socket.readyState !== (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1)) {
          try { socket.close(); } catch (_) { }
          if (!this._tryNextSignalingUrl()) {
            this._setState('failed');
            this.onError('WebSocket connection to signaling server timed out.', 'ERR_WS_TIMEOUT');
          }
        }
      }, 4000);

      socket.onopen = () => {
        if (this.ws !== socket) return;
        clearTimeout(connectTimeout);
        this.onStatusChange('Connected to signaling server. Joining room…', 'info');
        this._sendSignaling({ type: 'join-room', room: this.roomCode });
      };

      socket.onmessage = (event) => {
        if (this.ws !== socket) return;
        try {
          const msg = JSON.parse(event.data);
          this._handleSignalingMessage(msg);
        } catch (e) {
          console.error('[WebRTC Engine] Bad signaling message');
        }
      };

      socket.onerror = () => {
        if (this.ws !== socket) return;
        clearTimeout(connectTimeout);
        if (this.transferState === 'completed' || this.role) return;
        if (this._tryNextSignalingUrl()) return;
        this._setState('failed');
        this.onStatusChange('Signaling server connection error', 'error');
        this.onError('WebSocket connection to signaling server failed.', 'ERR_WS_ERROR');
      };

      socket.onclose = () => {
        if (this.ws !== socket) return;
        clearTimeout(connectTimeout);
        console.log('[WebRTC Engine] WebSocket closed');
        if (this.transferState === 'connecting' && !this.role && this._tryNextSignalingUrl()) return;
      };
    }

    _tryNextSignalingUrl() {
      if (this.role) return false;
      if (this._signalingUrlIndex >= this._signalingUrls.length - 1) return false;
      this._signalingUrlIndex += 1;
      const nextUrl = this._signalingUrls[this._signalingUrlIndex];
      console.log(`[WebRTC Engine] Signaling retry ${this._signalingUrlIndex + 1}/${this._signalingUrls.length}: ${nextUrl}`);
      this.onStatusChange('Retrying signaling connection…', 'info');
      const old = this.ws;
      this.ws = null;
      try { if (old) old.close(); } catch (_) { }
      this._openSignalingSocket();
      return true;
    }

    _handleSignalingMessage(msg) {
      switch (msg.type) {
        case 'joined':
          this.role = msg.role;
          this._addLanHints(msg.lanHints);
          this._shareLanHints();
          this.onStatusChange(`Room joined. Waiting for peer…`, 'info');
          if (msg.peerPresent && this.role === 'initiator') {
            this.onPeerJoined();
            this._armConnectWatch();
            this._initiatePeerConnection();
          }
          break;

        case 'peer-joined':
          this._addLanHints(msg.lanHints);
          this._shareLanHints();
          this.onStatusChange('Peer found. Connecting devices…', 'info');
          this.onPeerJoined();
          this._armConnectWatch();
          if (this.role === 'initiator') {
            this._initiatePeerConnection();
          }
          break;

        case 'lan-hint':
          this._addLanHints(msg.ips || msg.lanHints);
          break;

        case 'offer':
          this._armConnectWatch();
          this._handleOffer(msg.offer);
          break;

        case 'answer':
          this._handleAnswer(msg.answer);
          break;

        case 'ice-candidate':
          this._handleRemoteIceCandidate(msg.candidate);
          break;

        case 'peer-left':
          this.onStatusChange('Peer disconnected from room', 'warning');
          this.onPeerLeft();
          this._handlePeerDisconnect('Peer left the signaling room mid-session.');
          break;

        case 'room-full':
          this.onStatusChange('Room is full (Maximum 2 peers)', 'error');
          this.onError(`Room is full. Please try another code.`, 'ERR_ROOM_FULL');
          this.disconnect();
          break;

        case 'error':
          this.onError(msg.message, 'ERR_SIGNALING');
          break;
      }
    }

    _createPeerConnection() {
      const pcConfig = {
        iceServers: this.iceServers,
        iceCandidatePoolSize: 0,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        iceTransportPolicy: 'all'
      };

      let RTCPeerConnectionImpl;
      if (typeof window !== 'undefined' && (window.RTCPeerConnection || window.webkitRTCPeerConnection)) {
        RTCPeerConnectionImpl = window.RTCPeerConnection || window.webkitRTCPeerConnection;
      } else {
        try {
          RTCPeerConnectionImpl = require('@koush/wrtc').RTCPeerConnection || require('wrtc').RTCPeerConnection;
        } catch (_) {
          throw new Error('RTCPeerConnection is unavailable in this environment');
        }
      }

      this.pc = new RTCPeerConnectionImpl(pcConfig);

      this.pc.oniceconnectionstatechange = () => {
        const state = this.pc.iceConnectionState;
        console.log(`[WebRTC Engine] ICE State: ${state}`);

        if (state === 'connected' || state === 'completed') {
          this._clearIceReconnectTimer();
          this._iceRestartAttempts = 0;
          this._isIceRestarting = false;
          this._clearConnectWatch();
          this._setState('connected');
          this._reportConnectionType();
        } else if (state === 'failed') {
          if (this._iceRestartAttempts < MAX_ICE_RESTART_ATTEMPTS) {
            this._attemptIceRestart();
            return;
          }
          console.warn('[WebRTC Engine] ICE connection failed, checking connectionState');
          if (this.pc.connectionState === 'failed') {
            this._setState('failed');
            this.onStatusChange('P2P connection failed', 'error');
            this.onError('WebRTC P2P connection failed. Check your network or firewall.', 'ERR_ICE_FAILED');
            this.disconnect();
          }
        } else if (state === 'disconnected') {
          this.onStatusChange('P2P connection interrupted — attempting recovery…', 'warning');
          this._scheduleIceRecovery();
        }
      };

      if ('onconnectionstatechange' in this.pc) {
        this.pc.onconnectionstatechange = () => {
          const state = this.pc.connectionState;
          console.log(`[WebRTC Engine] Connection State: ${state}`);
          if (state === 'connected') {
            this._clearIceReconnectTimer();
            this._isIceRestarting = false;
            this._clearConnectWatch();
            this._setState('connected');
          } else if (state === 'failed') {
            if (this._iceRestartAttempts < MAX_ICE_RESTART_ATTEMPTS) {
              this._attemptIceRestart();
              return;
            }
            this._setState('failed');
            this.onStatusChange('P2P connection failed', 'error');
            this.onError('WebRTC P2P connection failed. Please ensure both devices can communicate.', 'ERR_PEER_FAILED');
            this.disconnect();
          }
        };
      }

      this.pc.onicecandidate = (event) => {
        if (!event.candidate || !event.candidate.candidate) return;
        this._sendIceCandidateObject(event.candidate);
        if (/typ host\b/i.test(event.candidate.candidate)) {
          this._localHostCandidates.push(event.candidate);
          this._sendRewrittenHostCandidates(event.candidate);
        }
      };

      this.pc.ondatachannel = (event) => {
        console.log('[WebRTC Engine] Received remote DataChannel');
        this.dataChannel = event.channel;
        this._setupDataChannelEvents();
      };
    }

    async _reportConnectionType() {
      if (!this.pc || typeof this.pc.getStats !== 'function') {
        this.onStatusChange('WebRTC Direct P2P Connected ⚡', 'success');
        return;
      }
      try {
        const stats = await this.pc.getStats();
        let isHostPair = false;
        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            const local = stats.get(report.localCandidateId);
            const remote = stats.get(report.remoteCandidateId);
            if (local && remote && local.candidateType === 'host' && remote.candidateType === 'host') {
              isHostPair = true;
            }
          }
        });
        if (isHostPair) {
          this.onStatusChange('WebRTC Direct Same-Network Connected ⚡ (LAN)', 'success');
        } else {
          this.onStatusChange('WebRTC Direct P2P Connected ⚡', 'success');
        }
      } catch (_) {
        this.onStatusChange('WebRTC Direct P2P Connected ⚡', 'success');
      }
    }

    async _initiatePeerConnection() {
      if (this.pc && this.pc.signalingState !== 'closed') return;

      this._createPeerConnection();
      // Reliable + ordered: SCTP retransmits lost packets so the transfer cannot
      // hang on a missing chunk. Unreliable unordered dropped frames silently.
      this.dataChannel = this.pc.createDataChannel('flux-file-channel', {
        ordered: true
      });
      this._setupDataChannelEvents();

      try {
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        this._sendSignaling({ type: 'offer', offer: this.pc.localDescription });
      } catch (err) {
        this.onError(`Failed to create SDP offer: ${err.message}`, 'ERR_OFFER');
      }
    }

    async _handleOffer(offer) {
      if (this.pc && this.pc.signalingState === 'closed') {
        this.pc = null;
        this.dataChannel = null;
      }
      if (this.pc && this.pc.signalingState !== 'stable') return;
      if (!this.pc) this._createPeerConnection();

      try {
        let RTCSessionDescriptionImpl;
        if (typeof window !== 'undefined' && window.RTCSessionDescription) {
          RTCSessionDescriptionImpl = window.RTCSessionDescription;
        } else {
          const wrtc = require('@koush/wrtc') || require('wrtc');
          RTCSessionDescriptionImpl = wrtc.RTCSessionDescription;
        }

        await this.pc.setRemoteDescription(new RTCSessionDescriptionImpl(offer));
        this._flushPendingIceCandidates();

        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this._sendSignaling({ type: 'answer', answer: this.pc.localDescription });
      } catch (err) {
        this.onError(`Failed to handle SDP offer: ${err.message}`, 'ERR_HANDLE_OFFER');
      }
    }

    async _handleAnswer(answer) {
      if (!this.pc || this.pc.signalingState !== 'have-local-offer') return;
      try {
        let RTCSessionDescriptionImpl;
        if (typeof window !== 'undefined' && window.RTCSessionDescription) {
          RTCSessionDescriptionImpl = window.RTCSessionDescription;
        } else {
          const wrtc = require('@koush/wrtc') || require('wrtc');
          RTCSessionDescriptionImpl = wrtc.RTCSessionDescription;
        }

        await this.pc.setRemoteDescription(new RTCSessionDescriptionImpl(answer));
        this._flushPendingIceCandidates();
      } catch (err) {
        this.onError(`Failed to set SDP answer: ${err.message}`, 'ERR_HANDLE_ANSWER');
      }
    }

    async _handleRemoteIceCandidate(candidate) {
      if (!candidate || !candidate.candidate) return;
      let RTCIceCandidateImpl;
      if (typeof window !== 'undefined' && window.RTCIceCandidate) {
        RTCIceCandidateImpl = window.RTCIceCandidate;
      } else {
        const wrtc = require('@koush/wrtc') || require('wrtc');
        RTCIceCandidateImpl = wrtc.RTCIceCandidate;
      }

      const payload = {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid == null ? '0' : candidate.sdpMid,
        sdpMLineIndex: typeof candidate.sdpMLineIndex === 'number' ? candidate.sdpMLineIndex : 0
      };

      try {
        const rtcCandidate = new RTCIceCandidateImpl(payload);
        if (this.pc && this.pc.remoteDescription && this.pc.remoteDescription.type) {
          await this.pc.addIceCandidate(rtcCandidate);
        } else {
          this.pendingIceCandidates.push(rtcCandidate);
        }
      } catch (_) { }
    }

    _sendIceCandidateObject(candidate) {
      const candidateData = {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid == null ? '0' : candidate.sdpMid,
        sdpMLineIndex: typeof candidate.sdpMLineIndex === 'number' ? candidate.sdpMLineIndex : 0
      };
      this._sendSignaling({ type: 'ice-candidate', candidate: candidateData });
    }

    _sendRewrittenHostCandidates(candidate) {
      const extras = rewriteHostCandidate(candidate.candidate, [...this._lanHints]);
      for (const extra of extras) {
        this._sendSignaling({
          type: 'ice-candidate',
          candidate: {
            candidate: extra,
            sdpMid: candidate.sdpMid == null ? '0' : candidate.sdpMid,
            sdpMLineIndex: typeof candidate.sdpMLineIndex === 'number' ? candidate.sdpMLineIndex : 0
          }
        });
      }
    }

    _addLanHints(ips) {
      if (!Array.isArray(ips) || !ips.length) return;
      let added = false;
      for (const ip of ips) {
        const clean = normalizeIp(ip);
        if (isPrivateIPv4(clean) && !this._lanHints.has(clean)) {
          this._lanHints.add(clean);
          added = true;
        }
      }
      if (added) {
        for (const local of this._localHostCandidates) {
          this._sendRewrittenHostCandidates(local);
        }
      }
    }

    _shareLanHints() {
      const ips = [...this._lanHints];
      if (!ips.length) return;
      this._sendSignaling({ type: 'lan-hint', ips });
    }

    _armConnectWatch() {
      this._clearConnectWatch();
      this._connectWatchTimer = setTimeout(() => {
        if (this.transferState !== 'connecting' && this.transferState !== 'idle') return;
        if (this.dataChannel && this.dataChannel.readyState === 'open') return;
        this.onStatusChange('Still connecting — retrying LAN path…', 'warning');
        for (const local of this._localHostCandidates) {
          this._sendRewrittenHostCandidates(local);
        }
        this._shareLanHints();
        if (this.pc && this.role === 'initiator') {
          this._attemptIceRestart();
        }
      }, 8000);
    }

    _clearConnectWatch() {
      if (this._connectWatchTimer) {
        clearTimeout(this._connectWatchTimer);
        this._connectWatchTimer = null;
      }
    }

    _flushPendingIceCandidates() {
      while (this.pendingIceCandidates.length > 0) {
        const candidate = this.pendingIceCandidates.shift();
        this.pc.addIceCandidate(candidate).catch(() => { });
      }
    }

    _setupDataChannelEvents() {
      if (!this.dataChannel) return;

      this.dataChannel.binaryType = 'arraybuffer';
      this.dataChannel.bufferedAmountLowThreshold = BUFFER_LOW_WATERMARK;

      this.dataChannel.onopen = () => {
        console.log('[WebRTC Engine] DataChannel OPEN');
        this._negotiatedChunkSize = this._getSafeChunkSize();
        this._clearConnectWatch();
        this._setState('connected');
        this.onStatusChange('P2P DataChannel open. Encrypted link ready! ⚡', 'success');
        this.onDataChannelOpen();
      };

      this.dataChannel.onclose = () => {
        console.log('[WebRTC Engine] DataChannel CLOSED');
        if (this.isTransferring) {
          this._handlePeerDisconnect('DataChannel closed unexpectedly during file transfer.');
        }
      };

      this.dataChannel.onerror = (err) => {
        console.error('[WebRTC Engine] DataChannel Error:', err);
      };

      this.dataChannel.onmessage = (event) => {
        this._receiveChain = this._receiveChain
          .then(() => this._handleDataChannelMessage(event.data))
          .catch((err) => {
            if (this.transferState !== 'completed' && this.transferState !== 'failed') {
              this._handleTransferFailure(err.message || 'Receive pipeline error', 'ERR_RECEIVE');
            }
          });
      };
    }

    /**
     * Handle incoming DataChannel messages (Control JSON vs Binary Encrypted Frames)
     */
    async _handleDataChannelMessage(data) {
      if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data);

          if (msg.type === 'metadata') {
            await this._initReceiverFromMetadata(msg);
          } else if (msg.type === 'metadata-ack') {
            this._resolveMetadataAck();
          } else if (msg.type === 'metadata-error') {
            this._rejectMetadataAck(new Error(msg.error || 'Receiver rejected metadata'));
            this._handleTransferFailure(msg.error || 'Receiver metadata error', 'ERR_METADATA');
          } else if (msg.type === 'transfer-complete') {
            this.senderFinalHash = msg.hash || null;
            await this._maybeFinalizeReceiver();
          } else if (msg.type === 'ack-complete') {
            this._clearStallTimer();
            if (this.currentFile || this.isTransferring) {
              const file = this.currentFile;
              const packedCount = Number(file?.fluxPacked?.count) || 1;

              this.currentFile = null;
              this.isTransferring = false;

              this.onFileComplete(null, {
                name: file ? file.name : 'File',
                size: file ? file.size : 0,
                isSender: true,
                packedFileCount: packedCount
              });
              this._setState('completed');
              this.onStatusChange(
                packedCount > 1
                  ? `Zip archive with ${packedCount} files verified and acknowledged! 🎉`
                  : 'File transfer verified and acknowledged by receiver! 🎉',
                'success'
              );
            }
          } else if (msg.type === 'cancel') {
            this._cleanupReceiverStorage(true);
            this.isTransferring = false;
            this._setState('cancelled');
            this.onStatusChange('Transfer cancelled by peer.', 'warning');
            this.onError('Peer cancelled the file transfer.', 'ERR_TRANSFER_CANCELLED');
          } else if (msg.type === 'resume-request') {
            await this._handleResumeRequest(msg);
          } else if (msg.type === 'zen_game') {
            this.onControlMessage(msg);
          }
        } catch (e) {
          console.error('[WebRTC Engine] Failed parsing text frame');
        }
      } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const buffer = data instanceof ArrayBuffer
          ? data
          : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

        if (!this._receiverReady || !this.incomingMeta || !this.aesKey) {
          if (!this._earlyChunkQueue) this._earlyChunkQueue = [];
          if (this._earlyChunkQueue.length >= MAX_EARLY_CHUNK_QUEUE_SIZE) {
            this._handleTransferFailure('Too many chunks arrived before receiver was ready', 'ERR_EARLY_QUEUE_FULL');
            return;
          }
          this._earlyChunkQueue.push(buffer);
          return;
        }

        await this._processBinaryChunkFrame(buffer);
      }
    }

    async _initReceiverFromMetadata(msg) {
      this.incomingMeta = msg;
      this.salt = base64ToBytes(msg.salt);
      this.receivedChunksCount = 0;
      this.receivedBytes = 0;
      this.transferStartTime = Date.now();
      this.isTransferring = true;
      this.finishStarted = false;
      this._receiverReady = false;
      this.senderFinalHash = msg.hash || this.senderFinalHash || null;
      this.receivedChunkSet = new Set();
      this.receiverHasher = new (this._getStreamingSHA256Class())();
      this._setState('transferring');
      this._armStallTimer();

      try {
        this.aesKey = await this.deriveKey(this.sessionCode, this.salt);
        await this._initCryptoWorkers(this.sessionCode, this.salt);
      } catch (keyErr) {
        this._sendControlMessage({ type: 'metadata-error', error: keyErr.message });
        this._handleTransferFailure(`Failed to derive encryption key: ${keyErr.message}`, 'ERR_KEY_DERIVATION');
        return;
      }

      try {
        await this._initReceiverStorage(msg);
      } catch (storageErr) {
        this._sendControlMessage({ type: 'metadata-error', error: storageErr.message });
        this._handleTransferFailure(storageErr.message, 'ERR_STORAGE_INIT');
        return;
      }

      this._receiverReady = true;
      this.onStatusChange(`Receiving file "${msg.name}" (${this._formatBytes(msg.size)})…`, 'info');
      this.onFileMetadata(msg);
      this._sendControlMessage({ type: 'metadata-ack', totalChunks: msg.totalChunks });

      const queued = this._earlyChunkQueue || [];
      this._earlyChunkQueue = null;
      for (const frame of queued) {
        await this._processBinaryChunkFrame(frame);
      }
    }

    async _tryInitOpfsStorage(msg) {
      if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.getDirectory !== 'function' || typeof Worker === 'undefined') {
        return false;
      }
      try {
        const worker = new Worker('/opfs-writer-worker.js');
        const isInitialized = await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), 5000);
          worker.onmessage = (e) => {
            if (e.data?.type === 'init-ack') {
              clearTimeout(timer);
              resolve(true);
            } else if (e.data?.type === 'error') {
              clearTimeout(timer);
              resolve(false);
            }
          };
          worker.onerror = () => {
            clearTimeout(timer);
            resolve(false);
          };
          worker.postMessage({ type: 'init', fileName: msg.name, totalSize: msg.size });
        });
        if (isInitialized) {
          this._attachOpfsWorker(worker);
          this.opfsActive = true;
          return true;
        }
        try { worker.terminate(); } catch (_) { }
      } catch (_) {
        this.opfsActive = false;
      }
      return false;
    }

    async _tryInitIdbStorage(msg) {
      const db = await openReceiveIdb();
      if (!db) return null;
      try {
        await clearReceiveIdb(db);
      } catch (_) {
        try { db.close(); } catch (__) { }
        return null;
      }

      const state = {
        db,
        pending: [],
        pendingBytes: 0,
        nextKey: 0,
        mime: msg.mimeType || 'application/octet-stream'
      };

      const flush = () => new Promise((resolve, reject) => {
        if (!state.pending.length) {
          resolve();
          return;
        }
        const blob = new Blob(state.pending);
        const key = state.nextKey;
        state.nextKey += 1;
        state.pending = [];
        state.pendingBytes = 0;
        try {
          const tx = state.db.transaction(IDB_RECEIVE_STORE, 'readwrite');
          tx.objectStore(IDB_RECEIVE_STORE).put(blob, key);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
        } catch (err) {
          reject(err);
        }
      });

      const closeAndDelete = async () => {
        try { state.db.close(); } catch (_) { }
        await deleteReceiveIdb();
      };

      return {
        async writeChunk(_index, _offset, chunkData) {
          state.pending.push(chunkData);
          state.pendingBytes += chunkData.byteLength || 0;
          if (state.pendingBytes >= IDB_FLUSH_BYTES) {
            await flush();
          }
        },
        async finalize() {
          await flush();
          const blobs = [];
          for (let key = 0; key < state.nextKey; key++) {
            const tx = state.db.transaction(IDB_RECEIVE_STORE, 'readonly');
            const part = await idbRequest(tx.objectStore(IDB_RECEIVE_STORE).get(key));
            if (part) blobs.push(part);
          }
          await closeAndDelete();
          return new Blob(blobs, { type: state.mime });
        },
        async purge() {
          await closeAndDelete();
        },
        async abort() {
          await closeAndDelete();
        }
      };
    }

    async _initReceiverStorage(msg) {
      this.opfsActive = false;
      this.storage = null;
      this.memoryChunks = null;

      const fileSize = Number(msg.size) || 0;
      const largeFile = fileSize > MAX_MEMORY_FALLBACK_SIZE;
      const canTryOpfs = typeof navigator !== 'undefined'
        && navigator.storage
        && typeof navigator.storage.getDirectory === 'function'
        && typeof Worker !== 'undefined';

      if (canTryOpfs && (largeFile || isSecureBrowserContext())) {
        await this._tryInitOpfsStorage(msg);
      }

      if (this.opfsActive) {
        const self = this;
        this.storage = {
          async finalize() {
            await self._waitForOpfsWrites();
            const fileObj = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error('OPFS worker finalize timed out')), 15000);
              self._opfsFinalizeResolve = (file) => { clearTimeout(timer); resolve(file); };
              self._opfsFinalizeReject = (err) => { clearTimeout(timer); reject(err); };
              self.opfsWorker.postMessage({ type: 'finalize' });
            });
            try { self.opfsWorker.terminate(); } catch (_) { }
            self.opfsWorker = null;
            self.opfsActive = false;
            return fileObj;
          },
          async purge() {
            self._cleanupReceiverStorage(true);
          },
          async abort() {
            self._cleanupReceiverStorage(true);
          }
        };
        return;
      }

      if (largeFile) {
        const idbStorage = await this._tryInitIdbStorage(msg);
        if (idbStorage) {
          this.storage = idbStorage;
          this.onStatusChange(
            `Receiving large file (${this._formatBytes(fileSize)}) with disk-backed storage…`,
            'info'
          );
          return;
        }
      }

      this.memoryChunks = new Array(msg.totalChunks || 0);
      const self = this;
      this.storage = {
        async finalize() {
          const chunks = self.memoryChunks || [];
          for (let i = 0; i < chunks.length; i++) {
            if (!chunks[i]) throw new Error(`Missing chunk index ${i}`);
          }
          const blob = new Blob(chunks, { type: msg.mimeType || 'application/octet-stream' });
          self.memoryChunks = null;
          return blob;
        },
        async purge() {
          self._cleanupReceiverStorage(true);
        },
        async abort() {
          self._cleanupReceiverStorage(true);
        }
      };
    }

    _attachOpfsWorker(worker) {
      this.opfsWorker = worker;
      this._opfsWritePending = 0;
      worker.onmessage = (e) => {
        const payload = e.data || {};
        if (payload.type === 'write-ack') {
          this._opfsWritePending = Math.max(0, this._opfsWritePending - 1);
          if (this._opfsWritePending === 0) {
            const waiters = this._opfsDrainedResolvers.splice(0);
            waiters.forEach((resolve) => resolve());
          }
        } else if (payload.type === 'finalize-ack' && this._opfsFinalizeResolve) {
          this._opfsFinalizeResolve(payload.buffer || payload.file);
          this._opfsFinalizeResolve = null;
          this._opfsFinalizeReject = null;
        } else if (payload.type === 'error' && this._opfsFinalizeReject) {
          this._opfsFinalizeReject(new Error(payload.message || 'OPFS worker error'));
          this._opfsFinalizeResolve = null;
          this._opfsFinalizeReject = null;
        }
      };
    }

    _waitForOpfsWrites() {
      if (!this._opfsWritePending) return Promise.resolve();
      return new Promise((resolve) => {
        this._opfsDrainedResolvers.push(resolve);
      });
    }

    async _processBinaryChunkFrame(frameBuffer) {
      if (!this.incomingMeta || !this.aesKey) {
        if (!this._earlyChunkQueue) this._earlyChunkQueue = [];
        this._earlyChunkQueue.push(frameBuffer);
        return;
      }

      let decryptedObj;
      try {
        decryptedObj = await this.decryptFrame(frameBuffer, this.aesKey);
      } catch (decryptErr) {
        this._handleTransferFailure(`Decryption failed — authentication or key mismatch: ${decryptErr.message}`, 'ERR_DECRYPT_FAILED');
        return;
      }

      const { chunkIndex } = decryptedObj;
      const chunkBytes = toOwnedBytes(decryptedObj.chunkData);
      const meta = this.incomingMeta;

      if (chunkIndex < 0 || chunkIndex >= meta.totalChunks) {
        this._handleTransferFailure('Invalid chunk index received', 'ERR_INVALID_CHUNK_INDEX');
        return;
      }

      if (chunkIndex !== this.receivedChunksCount) {
        this._handleTransferFailure(
          `Out-of-order chunk (got ${chunkIndex} when expecting ${this.receivedChunksCount})`,
          'ERR_OUT_OF_ORDER_CHUNK'
        );
        return;
      }

      if (this.receivedChunkSet && this.receivedChunkSet.has(chunkIndex)) {
        return;
      }

      if (this.receiverHasher) {
        this.receiverHasher.update(chunkBytes);
      }

      if (this.opfsActive && this.opfsWorker) {
        const offset = chunkIndex * meta.chunkSize;
        this._opfsWritePending += 1;
        const writeCopy = chunkBytes.slice();
        this.opfsWorker.postMessage({ type: 'write', chunkIndex, offset, buffer: writeCopy.buffer }, [writeCopy.buffer]);
      } else if (this.memoryChunks) {
        this.memoryChunks[chunkIndex] = chunkBytes;
      } else if (this.storage && typeof this.storage.writeChunk === 'function') {
        await this.storage.writeChunk(chunkIndex, chunkIndex * meta.chunkSize, chunkBytes);
      } else {
        this.memoryChunks = new Array(meta.totalChunks);
        this.memoryChunks[chunkIndex] = chunkBytes;
      }

      if (this.receivedChunkSet) this.receivedChunkSet.add(chunkIndex);
      this.receivedChunksCount += 1;
      this.receivedBytes += chunkBytes.byteLength;
      this._armStallTimer();

      const totalBytes = meta.size;
      const now = Date.now();
      const timeDiff = (now - this.lastProgressTime) / 1000;

      if (timeDiff >= 0.5 || this.lastProgressTime === 0) {
        const bytesDiff = this.receivedBytes - this.lastProgressBytes;
        this.currentSpeedBps = timeDiff > 0 ? (bytesDiff / timeDiff) : 0;
        this.lastProgressTime = now;
        this.lastProgressBytes = this.receivedBytes;
      }

      if ((now - (this._lastRecvUiUpdate || 0)) > 100 || this.receivedChunksCount >= meta.totalChunks) {
        this._lastRecvUiUpdate = now;
        this._emitTransferProgress({
          currentBytes: this.receivedBytes,
          currentTotal: totalBytes,
          role: 'receiver'
        });
      }

      await this._maybeFinalizeReceiver();
    }

    async _maybeFinalizeReceiver() {
      const meta = this.incomingMeta;
      if (!meta || this.finishStarted) return;
      const expectedHash = this.senderFinalHash || meta.hash;
      if (this.receivedChunksCount >= meta.totalChunks && expectedHash) {
        this.finishStarted = true;
        await this._finalizeReceiverTransfer();
      }
    }

    /**
     * Finalize received file: extract File/Blob, verify SHA-256, ack sender
     */
    async _finalizeReceiverTransfer() {
      const meta = this.incomingMeta;
      this.incomingMeta = null;
      this._clearStallTimer();

      try {
        let source;
        const memoryReady = Array.isArray(this.memoryChunks) &&
          this.memoryChunks.length === (meta.totalChunks || 0) &&
          this.memoryChunks.every(Boolean);

        if (memoryReady) {
          source = this.memoryChunks;
        } else if (this.storage && typeof this.storage.finalize === 'function') {
          source = await this.storage.finalize();
        } else if (this.opfsActive && this.opfsWorker) {
          await this._waitForOpfsWrites();
          source = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('OPFS worker finalize timed out')), 15000);
            this._opfsFinalizeResolve = (file) => { clearTimeout(timer); resolve(file); };
            this._opfsFinalizeReject = (err) => { clearTimeout(timer); reject(err); };
            this.opfsWorker.postMessage({ type: 'finalize' });
          });
          try { this.opfsWorker.terminate(); } catch (_) { }
          this.opfsWorker = null;
          this.opfsActive = false;
        } else {
          throw new Error('Receiver storage is empty');
        }

        const fileObj = await materializeDownloadFile(source, meta);
        this.memoryChunks = null;

        if (typeof meta.size === 'number' && fileObj.size !== meta.size) {
          throw new Error(`Received file size mismatch (expected ${meta.size}, got ${fileObj.size})`);
        }

        this.onStatusChange('Verifying SHA-256 file integrity checksum…', 'info');
        let computedHash;
        if (this.receiverHasher && this.receivedChunksCount >= (meta.totalChunks || 0) && this.receiverHasher.totalBytes === meta.size) {
          computedHash = this.receiverHasher.digestHex();
        } else {
          computedHash = await this._computeHash(fileObj);
        }

        const expectedHash = this.senderFinalHash || meta.hash;
        if (!expectedHash || computedHash !== expectedHash) {
          throw new Error(
            `SHA-256 checksum mismatch (Expected ${(expectedHash || 'none').slice(0, 8)}…, got ${computedHash.slice(0, 8)}…)`
          );
        }

        const packedCount = Number(meta.packedFileCount) || (Array.isArray(meta.packedFiles) ? meta.packedFiles.length : 1);

        this.isTransferring = false;
        this.onFileComplete(fileObj, {
          ...meta,
          packedFileCount: packedCount
        });
        this._sendControlMessage({ type: 'ack-complete', hash: computedHash });
        this.storage = null;
        this.receiverHasher = null;

        this._setState('completed');
        this.onStatusChange(
          packedCount > 1
            ? `Zip archive "${meta.name}" with ${packedCount} files received & verified! 🎉`
            : `File "${meta.name}" received & verified successfully! 🎉`,
          'success'
        );
      } catch (err) {
        if (this.storage && typeof this.storage.purge === 'function') {
          try { await this.storage.purge(); } catch (_) { }
        } else {
          this._cleanupReceiverStorage(true);
        }
        this.storage = null;
        this._handleTransferFailure(`Transfer verification failed: ${err.message}`, 'ERR_INTEGRITY_FAILED');
      }
    }

    _cleanupReceiverStorage(deleteFile = false) {
      this.memoryChunks = null;
      this._receiverReady = false;
      this.receivedChunkSet = null;
      const storage = this.storage;
      this.storage = null;
      if (storage && typeof storage.writeChunk === 'function' && typeof storage.purge === 'function') {
        try { Promise.resolve(storage.purge()).catch(() => {}); } catch (_) { }
      }
      if (this.opfsWorker) {
        if (deleteFile) {
          try { this.opfsWorker.postMessage({ type: 'abort' }); } catch (_) { }
        }
        try { this.opfsWorker.terminate(); } catch (_) { }
        this.opfsWorker = null;
      }
      this.opfsActive = false;
    }

    async _handleResumeRequest(msg) {
      const api = getManifestApi();
      if (!api || typeof api.getManifest !== 'function') {
        this._sendControlMessage({ type: 'resume-response', ok: false });
        return;
      }
      const manifest = await api.getManifest(msg.transferId);
      if (manifest && manifest.resumeToken && manifest.resumeToken === msg.resumeToken) {
        this._sendControlMessage({
          type: 'resume-response',
          ok: true,
          lastContiguousChunk: manifest.lastContiguousChunk
        });
      } else {
        this._sendControlMessage({ type: 'resume-response', ok: false });
      }
    }

    _waitForMetadataAck(timeoutMs = METADATA_ACK_TIMEOUT_MS) {
      if (this._metadataAckReceived) return Promise.resolve();
      return new Promise((resolve, reject) => {
        this._metadataAckResolve = resolve;
        this._metadataAckReject = reject;
        this._metadataAckTimer = setTimeout(() => {
          this._metadataAckTimer = null;
          this._metadataAckResolve = null;
          this._metadataAckReject = null;
          reject(new Error('metadata-ack timed out'));
        }, timeoutMs);
      });
    }

    _resolveMetadataAck() {
      this._metadataAckReceived = true;
      if (this._metadataAckTimer) {
        clearTimeout(this._metadataAckTimer);
        this._metadataAckTimer = null;
      }
      const resolve = this._metadataAckResolve;
      this._metadataAckResolve = null;
      this._metadataAckReject = null;
      if (resolve) resolve();
    }

    _rejectMetadataAck(err) {
      if (this._metadataAckTimer) {
        clearTimeout(this._metadataAckTimer);
        this._metadataAckTimer = null;
      }
      const reject = this._metadataAckReject;
      this._metadataAckResolve = null;
      this._metadataAckReject = null;
      if (reject) reject(err);
    }

    _getSafeChunkSize() {
      let maxMsg = 65536;
      if (this.pc && this.pc.sctp && this.pc.sctp.maxMessageSize) {
        maxMsg = this.pc.sctp.maxMessageSize;
      }
      if (this.dataChannel && this.dataChannel.maxMessageSize) {
        maxMsg = Math.min(maxMsg, this.dataChannel.maxMessageSize) || maxMsg;
      }
      if (!Number.isFinite(maxMsg) || maxMsg <= FRAME_OVERHEAD) {
        return DEFAULT_CHUNK_SIZE;
      }
      const usable = Math.max(16 * 1024, maxMsg - FRAME_OVERHEAD);
      return Math.min(MAX_CHUNK_SIZE, usable);
    }

    _scheduleIceRecovery() {
      this._clearIceReconnectTimer();
      this._iceReconnectTimer = setTimeout(() => {
        this._iceReconnectTimer = null;
        if (!this.pc) return;
        const ice = this.pc.iceConnectionState;
        if (ice === 'disconnected' || ice === 'failed') {
          this._attemptIceRestart();
        }
      }, ICE_RECONNECT_TIMEOUT_MS);
      if (this._iceReconnectTimer && typeof this._iceReconnectTimer.unref === 'function') {
        this._iceReconnectTimer.unref();
      }
    }

    _scheduleIceRestart() {
      this._scheduleIceRecovery();
    }

    _clearIceReconnectTimer() {
      if (this._iceReconnectTimer) {
        clearTimeout(this._iceReconnectTimer);
        this._iceReconnectTimer = null;
      }
      if (this._iceDisconnectTimer) {
        clearTimeout(this._iceDisconnectTimer);
        this._iceDisconnectTimer = null;
      }
    }

    _clearIceDisconnectTimer() {
      this._clearIceReconnectTimer();
    }

    async _attemptIceRestart() {
      if (!this.pc || this.role !== 'initiator') return;
      if (this._iceRestartAttempts >= MAX_ICE_RESTART_ATTEMPTS) return;
      this._iceRestartAttempts += 1;
      this._isIceRestarting = true;
      try {
        this.onStatusChange('Reconnecting P2P link…', 'warning');
        if (typeof this.pc.restartIce === 'function') {
          this.pc.restartIce();
        }
        const offer = await this.pc.createOffer({ iceRestart: true });
        await this.pc.setLocalDescription(offer);
        this._sendSignaling({ type: 'offer', offer: this.pc.localDescription });
      } catch (err) {
        this._isIceRestarting = false;
        console.warn('[WebRTC Engine] ICE restart failed', err);
      }
    }

    async _tryIceRestart() {
      return this._attemptIceRestart();
    }

    _armStallTimer() {
      this._clearStallTimer();
      this._stallTimer = setTimeout(() => {
        if (this.isTransferring && this.transferState === 'transferring') {
          this._handleTransferFailure('Transfer stalled — no data received for 30 seconds.', 'ERR_TRANSFER_STALL');
        }
      }, STALL_TIMEOUT_MS);
      if (this._stallTimer && typeof this._stallTimer.unref === 'function') {
        this._stallTimer.unref();
      }
    }

    _clearStallTimer() {
      if (this._stallTimer) {
        clearTimeout(this._stallTimer);
        this._stallTimer = null;
      }
    }

    _normalizeFileList(fileOrFiles) {
      if (!fileOrFiles) return [];
      if (typeof FileList !== 'undefined' && fileOrFiles instanceof FileList) {
        return Array.from(fileOrFiles);
      }
      if (Array.isArray(fileOrFiles)) return fileOrFiles.filter(Boolean);
      return [fileOrFiles];
    }

    _emitTransferProgress({ currentBytes, currentTotal, role }) {
      const fileName = (this.currentFile && this.currentFile.name) || (this.incomingMeta && this.incomingMeta.name) || '';
      this.onProgress({
        percent: currentTotal > 0 ? Math.min(100, (currentBytes / currentTotal) * 100) : 0,
        transferredBytes: currentBytes,
        totalBytes: currentTotal || 0,
        currentFileBytes: currentBytes,
        currentFileTotal: currentTotal,
        fileName,
        speedBps: this.currentSpeedBps,
        role
      });
    }

    /**
     * Send one or more files over the open DataChannel.
     * Multiple files are packed into a single zip archive first.
     * @param {File|Blob|File[]|FileList} fileOrFiles
     */
    async sendFiles(fileOrFiles) {
      const files = this._normalizeFileList(fileOrFiles).slice(0, MAX_BATCH_FILES);
      if (!files.length) {
        this.onError('No file selected for transfer.', 'ERR_NO_FILE');
        return;
      }
      if (files.length === 1) {
        return this.sendFile(files[0]);
      }

      try {
        this.onStatusChange(`Packing ${files.length} files into a zip archive…`, 'info');
        const zipFile = await createZipArchive(files, {
          onProgress: ({ percent, currentName }) => {
            this.onProgress({
              percent,
              transferredBytes: 0,
              totalBytes: files.reduce((sum, file) => sum + (file.size || 0), 0),
              fileName: currentName ? `Zipping ${currentName}` : 'Creating zip archive',
              speedBps: 0,
              role: 'sender',
              phase: 'zip'
            });
          }
        });
        this.onStatusChange(
          `Sending zip archive "${zipFile.name}" (${this._formatBytes(zipFile.size)})…`,
          'info'
        );
        return this.sendFile(zipFile);
      } catch (err) {
        this.onError(err.message || 'Failed to create zip archive.', 'ERR_ZIP');
      }
    }

    /**
     * Send File over DataChannel with AES-256-GCM E2EE & Event-Driven Backpressure
     * @param {File|Blob|File[]|FileList} file
     */
    async sendFile(file) {
      if (file && ((typeof FileList !== 'undefined' && file instanceof FileList) || Array.isArray(file))) {
        return this.sendFiles(file);
      }

      if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
        this.onError('P2P DataChannel is not open. Connect to peer first.', 'ERR_NOT_CONNECTED');
        return;
      }

      if (!file) {
        this.onError('No file selected for transfer.', 'ERR_NO_FILE');
        return;
      }

      if (this.isTransferring) {
        console.warn('[WebRTC Engine] Transfer already in progress. Ignoring duplicate call.');
        return;
      }

      this.currentFile = file;
      this.isTransferring = true;
      this._metadataAckReceived = false;
      this._setState('transferring');
      this._armStallTimer();

      const chunkSize = this._getSafeChunkSize();
      this._negotiatedChunkSize = chunkSize;
      const totalChunks = file.size === 0 ? 0 : Math.ceil(file.size / chunkSize);

      const cryptoObj = getCrypto();
      this.salt = cryptoObj.getRandomValues(new Uint8Array(16));

      try {
        this.aesKey = await this.deriveKey(this.sessionCode, this.salt);
        await this._initCryptoWorkers(this.sessionCode, this.salt);
      } catch (keyErr) {
        this._handleTransferFailure(`Failed to derive encryption key: ${keyErr.message}`, 'ERR_KEY_DERIVATION');
        return;
      }

      // Hash in parallel with the send — never block the first byte on a full-file digest
      const hashPromise = this._computeHash(file).catch((hashErr) => {
        throw new Error(`SHA-256 calculation failed: ${hashErr.message}`);
      });

      const packed = file.fluxPacked || null;
      const metadata = {
        type: 'metadata',
        v: 3,
        cipher: 'AES-256-GCM',
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        chunkSize: chunkSize,
        totalChunks: totalChunks,
        salt: bytesToBase64(this.salt),
        packedFileCount: packed?.count || 1,
        packedFiles: Array.isArray(packed?.files) ? packed.files.slice(0, MAX_BATCH_FILES) : undefined
      };

      this.onStatusChange(`Starting encrypted transfer of "${file.name}" (${this._formatBytes(file.size)})…`, 'info');
      this._sendControlMessage(metadata);

      try {
        await this._waitForMetadataAck(METADATA_ACK_TIMEOUT_MS);
      } catch (ackErr) {
        this._handleTransferFailure(`Receiver did not become ready: ${ackErr.message}`, 'ERR_METADATA_ACK_TIMEOUT');
        return;
      }

      let offset = 0;
      let chunkIndex = 0;
      this.lastProgressTime = Date.now();
      this.lastProgressBytes = 0;
      this.currentSpeedBps = 0;
      this._lastSendUiUpdate = 0;

      const inflight = [];
      const enqueueEncrypt = () => {
        if (offset >= file.size || inflight.length >= this._getPipelineDepth() || !this.isTransferring) return;
        const thisOffset = offset;
        const thisIndex = chunkIndex;
        const rawChunkSize = Math.min(chunkSize, file.size - thisOffset);
        offset += rawChunkSize;
        chunkIndex += 1;
        inflight.push(
          this._readAndEncryptChunk(file, thisOffset, rawChunkSize, thisIndex).then((frame) => ({
            frame,
            rawChunkSize,
            index: thisIndex
          }))
        );
      };

      for (let i = 0; i < this._getPipelineDepth(); i++) enqueueEncrypt();

      while (inflight.length > 0 && this.isTransferring) {
        let packet;
        try {
          packet = await inflight.shift();
        } catch (encErr) {
          this._handleTransferFailure(`Failed to encrypt chunk: ${encErr.message}`, 'ERR_ENCRYPT_CHUNK');
          return;
        }

        enqueueEncrypt();

        if (this.dataChannel.bufferedAmount > BUFFER_HIGH_WATERMARK) {
          try {
            await this._waitForBufferLow();
          } catch (_) {
            if (this.transferState === 'completed' || !this.isTransferring) break;
          }
        }

        try {
          this.dataChannel.send(packet.frame);
        } catch (err) {
          this._handleTransferFailure(`Failed to send chunk frame: ${err.message}`, 'ERR_CHUNK_SEND');
          return;
        }

        this._armStallTimer();

        const sentBytes = Math.min(file.size, packet.index * chunkSize + packet.rawChunkSize);
        const now = Date.now();
        const timeDiff = (now - this.lastProgressTime) / 1000;
        if (timeDiff >= 0.5) {
          this.currentSpeedBps = timeDiff > 0 ? ((sentBytes - this.lastProgressBytes) / timeDiff) : 0;
          this.lastProgressTime = now;
          this.lastProgressBytes = sentBytes;
        }

        if (sentBytes >= file.size || (now - this._lastSendUiUpdate) > 100) {
          this._lastSendUiUpdate = now;
          this._emitTransferProgress({
            currentBytes: sentBytes,
            currentTotal: file.size,
            role: 'sender'
          });
        }
      }

      if (!this.isTransferring) return;

      let fileHash;
      try {
        fileHash = await hashPromise;
      } catch (hashErr) {
        this._handleTransferFailure(hashErr.message, 'ERR_HASH_FAILED');
        return;
      }
      this._sendControlMessage({ type: 'transfer-complete', hash: fileHash });
      this.onStatusChange('All chunks sent. Waiting for receiver verification…', 'info');
    }

    /**
     * Read one file slice and encrypt it. Used by the pipelined send loop so
     * we can overlap crypto with the previous chunk's network send.
     */
    async _readAndEncryptChunk(file, offset, chunkSize, chunkIndex) {
      const slice = file.slice(offset, offset + chunkSize);
      const chunkBuffer = await slice.arrayBuffer();
      const encryptedFrame = await this.encryptChunk(chunkBuffer, chunkIndex, this.aesKey);
      return frameToArrayBuffer(encryptedFrame);
    }

    /**
     * Wait until DataChannel bufferedAmount drops to the low watermark.
     * Does not fake-unblock on a short timer — that caused send overflow and stalls.
     */
    _waitForBufferLow() {
      if (!this.dataChannel || this.dataChannel.bufferedAmount <= BUFFER_LOW_WATERMARK || this.transferState === 'completed') {
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        let pollTimer = null;
        let settled = false;

        const cleanup = () => {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          if (this.dataChannel) this.dataChannel.onbufferedamountlow = null;
        };

        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          cleanup();
          fn(value);
        };

        if (this.dataChannel) {
          this.dataChannel.onbufferedamountlow = () => finish(resolve);
        }

        pollTimer = setInterval(() => {
          if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            finish(reject, new Error('DataChannel closed during backpressure wait'));
            return;
          }
          if (this.dataChannel.bufferedAmount <= BUFFER_LOW_WATERMARK || this.transferState === 'completed' || !this.isTransferring) {
            finish(resolve);
          }
        }, 40);
      });
    }

    /**
     * Send application-level control message (e.g., Flux Zen game invite/move)
     * @param {Object} msgObj 
     */
    sendControlMessage(msgObj) {
      this._sendControlMessage({
        type: 'zen_game',
        ...msgObj
      });
    }

    cancelTransfer() {
      if (this.dataChannel && this.dataChannel.readyState === 'open') {
        this._sendControlMessage({ type: 'cancel' });
      }
      this._cleanupReceiverStorage(true);
      this.isTransferring = false;
      this._clearStallTimer();
      this._setState('cancelled');
      this.onStatusChange('Transfer cancelled', 'warning');
    }

    _handlePeerDisconnect(reason) {
      if (this.transferState === 'completed') return;
      if (this.isTransferring) {
        this._cleanupReceiverStorage(true);
        this._handleTransferFailure(`Transfer aborted: ${reason}`, 'ERR_PEER_DISCONNECTED');
      }
    }

    _handleTransferFailure(errorMessage, errorCode) {
      if (this.transferState === 'completed') return;
      this.isTransferring = false;
      this._clearStallTimer();
      this._rejectMetadataAck(new Error(errorMessage));
      this._setState('failed');
      this.onError(errorMessage, errorCode);
    }

    _sendControlMessage(obj) {
      if (this.dataChannel && this.dataChannel.readyState === 'open') {
        this.dataChannel.send(JSON.stringify(obj));
      }
    }

    _sendSignaling(data) {
      if (this.ws && this.ws.readyState === (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1)) {
        this.ws.send(JSON.stringify(data));
      }
    }

    _formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
    }

    disconnect() {
      this.isTransferring = false;
      this._clearStallTimer();
      this._clearIceReconnectTimer();
      this._clearConnectWatch();
      this._isIceRestarting = false;
      this._localHostCandidates = [];
      this._lanHints = new Set(getPageLanHints());
      this._rejectMetadataAck(new Error('Disconnected'));
      this._cleanupReceiverStorage(true);
      this._setState('idle', { force: true });

      if (this.dataChannel) {
        try { this.dataChannel.close(); } catch (e) { }
        this.dataChannel = null;
      }

      if (this.pc) {
        try { this.pc.close(); } catch (e) { }
        this.pc = null;
      }

      if (this.ws) {
        if (this.ws.readyState === (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1) && this.roomCode) {
          this._sendSignaling({ type: 'leave-room' });
        }
        try { this.ws.close(); } catch (e) { }
        this.ws = null;
      }

      this.roomCode = null;
      this.sessionCode = null;
      this.role = null;
      this.pendingIceCandidates = [];
      this.aesKey = null;
      this.salt = null;
      this.currentFile = null;
      this._teardownCryptoWorkers();
    }
  }

  // Export
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = FluxWebRTCEngine;
    module.exports.default = FluxWebRTCEngine;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.FluxWebRTCEngine = FluxWebRTCEngine;
  }
  if (typeof window !== 'undefined') {
    window.FluxWebRTCEngine = FluxWebRTCEngine;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

const FluxWebRTCEngine = (typeof window !== 'undefined' && window.FluxWebRTCEngine) ||
  (typeof globalThis !== 'undefined' && globalThis.FluxWebRTCEngine);

export { FluxWebRTCEngine };
export default FluxWebRTCEngine;




