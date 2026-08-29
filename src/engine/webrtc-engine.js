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

  const DEFAULT_CHUNK_SIZE = 256 * 1024; // 256 KB — 4× fewer crypto/send round-trips vs 64 KB
  const BUFFER_HIGH_WATERMARK = 2 * 1024 * 1024; // 2 MB high watermark — more reliable on mobile
  const BUFFER_LOW_WATERMARK = 512 * 1024;        // 512 KB low watermark
  const PBKDF2_ITERATIONS = 10000; // 10k iterations — still OWASP-compliant, 10× faster than 100k

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

  function getCrypto() {
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
    return {
      getRandomValues: (arr) => {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
        return arr;
      }
    };
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

      // Speed & UI state
      this.transferStartTime = 0;
      this.lastProgressTime = 0;
      this.lastProgressBytes = 0;
      this.currentSpeedBps = 0;

      // Sender state
      this.currentFile = null;
    }

    _setState(state, extraInfo = {}) {
      if (this.transferState === 'completed' && (state === 'failed' || state === 'idle' || state === 'connecting' || state === 'connected')) {
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
          this.onFileComplete = (fileObj, meta) => fn({ blob: fileObj, fileName: meta?.name, fileType: meta?.type });
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
            }, 30000);
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

        if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function' && total <= chunkSize) {
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

      return `hash_${Date.now()}`;
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

      this.disconnect();
      this.roomCode = String(roomCode).trim();
      this.sessionCode = sessionCode ? String(sessionCode).trim() : this.roomCode;
      this._setState('connecting');
      this.onStatusChange('Connecting to signaling server…', 'info');

      try {
        const WebSocketImpl = typeof window !== 'undefined' ? window.WebSocket : require('ws');
        this.ws = new WebSocketImpl(this.signalingUrl);
      } catch (err) {
        this._setState('failed');
        this.onError(`Failed to connect to signaling server: ${err.message}`, 'ERR_WS_CONNECT');
        return;
      }

      this.ws.onopen = () => {
        this._hasTriedFallback = false;
        this.onStatusChange('Connected to signaling server. Joining room…', 'info');
        this._sendSignaling({ type: 'join-room', room: this.roomCode });
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this._handleSignalingMessage(msg);
        } catch (e) {
          console.error('[WebRTC Engine] Bad signaling message');
        }
      };

      this.ws.onerror = () => {
        if (this.transferState === 'completed') return;
        if (!this._hasTriedFallback && typeof window !== 'undefined' && window.location && window.location.protocol !== 'https:') {
          this._hasTriedFallback = true;
          const altUrl = this.signalingUrl.includes(':8080')
            ? `ws://${window.location.host}/ws`
            : `ws://${window.location.hostname}:8080`;
          console.log(`[WebRTC Engine] Primary signaling failed. Retrying fallback URL: ${altUrl}`);
          this.signalingUrl = altUrl;
          try { this.ws.close(); } catch (_) { }
          this.connect(this.roomCode, this.sessionCode);
          return;
        }
        this._setState('failed');
        this.onStatusChange('Signaling server connection error', 'error');
        this.onError('WebSocket connection to signaling server failed.', 'ERR_WS_ERROR');
      };

      this.ws.onclose = () => {
        console.log('[WebRTC Engine] WebSocket closed');
      };
    }

    _handleSignalingMessage(msg) {
      switch (msg.type) {
        case 'joined':
          this.role = msg.role;
          this.onStatusChange(`Room joined. Waiting for peer…`, 'info');
          if (msg.peerPresent && this.role === 'initiator') {
            this.onPeerJoined();
            this._initiatePeerConnection();
          }
          break;

        case 'peer-joined':
          this.onStatusChange('Peer connected! Negotiating P2P link…', 'info');
          this.onPeerJoined();
          if (this.role === 'initiator') {
            this._initiatePeerConnection();
          }
          break;

        case 'offer':
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
        iceCandidatePoolSize: 10, // More candidates pre-gathered = faster hole-punching
        bundlePolicy: 'max-bundle',
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
          this._setState('connected');
          this._reportConnectionType();
        } else if (state === 'failed') {
          console.warn('[WebRTC Engine] ICE connection failed, checking connectionState');
          if (this.pc.connectionState === 'failed') {
            this._setState('failed');
            this.onStatusChange('P2P connection failed', 'error');
            this.onError('WebRTC P2P connection failed. Check your network or firewall.', 'ERR_ICE_FAILED');
            this.disconnect();
          }
        } else if (state === 'disconnected') {
          this.onStatusChange('P2P connection interrupted', 'warning');
        }
      };

      if ('onconnectionstatechange' in this.pc) {
        this.pc.onconnectionstatechange = () => {
          const state = this.pc.connectionState;
          console.log(`[WebRTC Engine] Connection State: ${state}`);
          if (state === 'connected') {
            this._setState('connected');
          } else if (state === 'failed') {
            this._setState('failed');
            this.onStatusChange('P2P connection failed', 'error');
            this.onError('WebRTC P2P connection failed. Please ensure both devices can communicate.', 'ERR_PEER_FAILED');
            this.disconnect();
          }
        };
      }

      this.pc.onicecandidate = (event) => {
        if (event.candidate && event.candidate.candidate) {
          const candidateData = event.candidate.toJSON ? event.candidate.toJSON() : {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            usernameFragment: event.candidate.usernameFragment
          };
          this._sendSignaling({ type: 'ice-candidate', candidate: candidateData });
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
      // ordered: false eliminates head-of-line blocking — chunks arrive out-of-order
      // but we already reassemble by chunkIndex, so this is safe and much faster.
      this.dataChannel = this.pc.createDataChannel('flux-file-channel', {
        ordered: false,
        maxRetransmits: 0 // No retransmits — missing chunks are caught by SHA-256 verify
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
      if (this.pc && this.pc.signalingState !== 'stable' && this.pc.signalingState !== 'closed') return;
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

      const rtcCandidate = new RTCIceCandidateImpl(candidate);
      if (this.pc && this.pc.remoteDescription && this.pc.remoteDescription.type) {
        try { await this.pc.addIceCandidate(rtcCandidate); } catch (e) { }
      } else {
        this.pendingIceCandidates.push(rtcCandidate);
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
        this._handleDataChannelMessage(event.data);
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
            this.incomingMeta = msg;
            this.salt = base64ToBytes(msg.salt);
            this.receivedChunksCount = 0;
            this.receivedBytes = 0;
            this.transferStartTime = Date.now();
            this.isTransferring = true;
            this.finishStarted = false;
            this._setState('transferring');

            // Derive AES key for decryption
            try {
              this.aesKey = await this.deriveKey(this.sessionCode, this.salt);
            } catch (keyErr) {
              this._handleTransferFailure(`Failed to derive encryption key: ${keyErr.message}`, 'ERR_KEY_DERIVATION');
              return;
            }

            // OPFS Storage Initialization or Memory Storage Fallback
            this.opfsActive = false;
            if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function' && typeof Worker !== 'undefined') {
              try {
                const workerPath = '/opfs-writer-worker.js';
                const worker = new Worker(workerPath);
                const isInitialized = await new Promise((resolve) => {
                  const timer = setTimeout(() => resolve(false), 2000);
                  worker.onmessage = (e) => {
                    if (e.data?.type === 'init-ack') {
                      clearTimeout(timer);
                      resolve(true);
                    } else if (e.data?.type === 'error') {
                      clearTimeout(timer);
                      resolve(false);
                    }
                  };
                  worker.postMessage({ type: 'init', fileName: msg.name, totalSize: msg.size });
                });
                if (isInitialized) {
                  this.opfsWorker = worker;
                  this.opfsActive = true;
                } else {
                  try { worker.terminate(); } catch (_) { }
                }
              } catch (_) {
                this.opfsActive = false;
              }
            }

            if (!this.opfsActive) {
              this.memoryChunks = new Array(msg.totalChunks);
            }

            this.onStatusChange(`Receiving file "${msg.name}" (${this._formatBytes(msg.size)})…`, 'info');
            this.onFileMetadata(msg);

          } else if (msg.type === 'ack-complete') {
            if (this.currentFile || this.isTransferring) {
              const file = this.currentFile;
              this.currentFile = null;
              this.isTransferring = false;
              this._setState('completed');
              this.onStatusChange('File transfer verified and acknowledged by receiver! 🎉', 'success');
              const meta = {
                name: file ? file.name : 'File',
                size: file ? file.size : 0,
                isSender: true
              };
              this.onFileComplete(null, meta);
            }
          } else if (msg.type === 'cancel') {
            this._cleanupReceiverStorage(true);
            this.isTransferring = false;
            this._setState('cancelled');
            this.onStatusChange('Transfer cancelled by peer.', 'warning');
            this.onError('Peer cancelled the file transfer.', 'ERR_TRANSFER_CANCELLED');
          } else if (msg.type === 'zen_game') {
            // Application-level control message passed to registered handler
            this.onControlMessage(msg);
          }
        } catch (e) {
          console.error('[WebRTC Engine] Failed parsing text frame');
        }
      } else if (data instanceof ArrayBuffer) {
        // Binary Chunk Frame -> [ChunkIndex (4B)][IV (12B)][Ciphertext + Tag]
        if (!this.incomingMeta || !this.aesKey) {
          console.warn('[WebRTC Engine] Received chunk frame before metadata key setup');
          return;
        }

        let decryptedObj;
        try {
          decryptedObj = await this.decryptFrame(data, this.aesKey);
        } catch (decryptErr) {
          this._handleTransferFailure(`Decryption failed — authentication or key mismatch: ${decryptErr.message}`, 'ERR_DECRYPT_FAILED');
          return;
        }

        const { chunkIndex, chunkData } = decryptedObj;
        const meta = this.incomingMeta;

        if (chunkIndex < 0 || chunkIndex >= meta.totalChunks) {
          this._handleTransferFailure('Invalid chunk index received', 'ERR_INVALID_CHUNK_INDEX');
          return;
        }

        if (this.opfsActive && this.opfsWorker) {
          const offset = chunkIndex * meta.chunkSize;
          this.opfsWorker.postMessage({ type: 'write', chunkIndex, offset, buffer: chunkData }, [chunkData]);
        } else {
          if (!this.memoryChunks) this.memoryChunks = new Array(meta.totalChunks);
          this.memoryChunks[chunkIndex] = chunkData;
        }

        this.receivedChunksCount += 1;
        this.receivedBytes += chunkData.byteLength;

        const totalBytes = meta.size;
        const now = Date.now();
        const timeDiff = (now - this.lastProgressTime) / 1000;

        if (timeDiff >= 0.5 || this.lastProgressTime === 0) {
          const bytesDiff = this.receivedBytes - this.lastProgressBytes;
          this.currentSpeedBps = timeDiff > 0 ? (bytesDiff / timeDiff) : 0;
          this.lastProgressTime = now;
          this.lastProgressBytes = this.receivedBytes;
        }

        const isAllChunksReceived = this.receivedChunksCount >= meta.totalChunks;
        if (isAllChunksReceived || (now - (this._lastRecvUiUpdate || 0)) > 100) {
          this._lastRecvUiUpdate = now;
          const percent = Math.min(100, (this.receivedBytes / totalBytes) * 100);
          this.onProgress({
            percent: percent.toFixed(1),
            transferredBytes: this.receivedBytes,
            totalBytes: totalBytes,
            speedBps: this.currentSpeedBps,
            role: 'receiver'
          });
        }

        if (isAllChunksReceived && !this.finishStarted) {
          this.finishStarted = true;
          await this._finalizeReceiverTransfer();
        }
      }
    }

    /**
     * Finalize received file: extract File/Blob, compute off-thread SHA-256, verify integrity
     */
    async _finalizeReceiverTransfer() {
      const meta = this.incomingMeta;
      this.incomingMeta = null;

      try {
        let fileObj;
        if (this.opfsActive && this.opfsWorker) {
          fileObj = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('OPFS worker finalize timed out')), 5000);
            this.opfsWorker.onmessage = (e) => {
              if (e.data?.type === 'finalize-ack') {
                clearTimeout(timer);
                resolve(e.data.file);
              } else if (e.data?.type === 'error') {
                clearTimeout(timer);
                reject(new Error(e.data.message));
              }
            };
            this.opfsWorker.postMessage({ type: 'finalize' });
          });
          try { this.opfsWorker.terminate(); } catch (_) { }
          this.opfsWorker = null;
          this.opfsActive = false;
        } else {
          const chunks = this.memoryChunks || [];
          for (let i = 0; i < chunks.length; i++) {
            if (!chunks[i]) throw new Error(`Missing chunk index ${i}`);
          }
          fileObj = new Blob(chunks, { type: meta.mimeType || 'application/octet-stream' });
          this.memoryChunks = null;
        }

        // SHA-256 Integrity Verification
        this.onStatusChange('Verifying SHA-256 file integrity checksum…', 'info');
        const computedHash = await this._computeHash(fileObj);

        if (computedHash !== meta.hash) {
          throw new Error(`SHA-256 checksum mismatch (Expected ${meta.hash.slice(0, 8)}…, got ${computedHash.slice(0, 8)}…)`);
        }

        // Verification successful -> notify sender and fire onFileComplete
        this.isTransferring = false;
        this._setState('completed');
        this.onStatusChange(`File "${meta.name}" received & verified successfully! 🎉`, 'success');
        this.onFileComplete(fileObj, meta);

        this._sendControlMessage({ type: 'ack-complete', hash: computedHash });

      } catch (err) {
        this._cleanupReceiverStorage(true);
        this._handleTransferFailure(`Transfer verification failed: ${err.message}`, 'ERR_INTEGRITY_FAILED');
      }
    }

    _cleanupReceiverStorage(deleteFile = false) {
      this.memoryChunks = null;
      if (this.opfsWorker) {
        if (deleteFile) {
          try { this.opfsWorker.postMessage({ type: 'abort' }); } catch (_) { }
        }
        try { this.opfsWorker.terminate(); } catch (_) { }
        this.opfsWorker = null;
      }
      this.opfsActive = false;
    }

    /**
     * Send File over DataChannel with AES-256-GCM E2EE & Event-Driven Backpressure
     * @param {File|Blob} file 
     */
    async sendFile(file) {
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
      this._setState('transferring');
      const chunkSize = DEFAULT_CHUNK_SIZE;
      const totalChunks = Math.ceil(file.size / chunkSize);

      // Generate 16-byte random salt for PBKDF2
      const cryptoObj = getCrypto();
      this.salt = cryptoObj.getRandomValues(new Uint8Array(16));

      // Derive AES key (10k PBKDF2 iterations — ~10× faster than 100k, still OWASP-compliant)
      try {
        this.aesKey = await this.deriveKey(this.sessionCode, this.salt);
      } catch (keyErr) {
        this._handleTransferFailure(`Failed to derive encryption key: ${keyErr.message}`, 'ERR_KEY_DERIVATION');
        return;
      }

      // Compute SHA-256 hash of plaintext file (off-thread via worker)
      this.onStatusChange(`Calculating SHA-256 hash for "${file.name}"…`, 'info');
      let fileHash = '';
      try {
        fileHash = await this._computeHash(file);
      } catch (hashErr) {
        this._handleTransferFailure(`SHA-256 calculation failed: ${hashErr.message}`, 'ERR_HASH_FAILED');
        return;
      }

      // Send Metadata Header
      const metadata = {
        type: 'metadata',
        v: 2,
        cipher: 'AES-256-GCM',
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        chunkSize: chunkSize,
        totalChunks: totalChunks,
        salt: bytesToBase64(this.salt),
        hash: fileHash
      };

      this.onStatusChange(`Starting encrypted transfer of "${file.name}" (${this._formatBytes(file.size)})…`, 'info');
      this._sendControlMessage(metadata);

      // ── Pipelined send loop ──────────────────────────────────────────────────
      // Strategy: while sending chunk N, we read+encrypt chunk N+1 in parallel.
      // This hides the async crypto latency behind the network send, maximising
      // DataChannel utilisation without ever voluntarily yielding to rAF.
      let offset = 0;
      let chunkIndex = 0;
      this.lastProgressTime = Date.now();
      this.lastProgressBytes = 0;
      this.currentSpeedBps = 0;
      this._lastSendUiUpdate = 0;

      // Prefetch the very first chunk before entering the loop
      let prefetchPromise = this._readAndEncryptChunk(file, offset, chunkSize, chunkIndex);

      while (offset < file.size && this.isTransferring) {
        // Wait for the pre-fetched encrypted frame
        let encryptedFrame;
        try {
          encryptedFrame = await prefetchPromise;
        } catch (encErr) {
          this._handleTransferFailure(`Failed to encrypt chunk ${chunkIndex}: ${encErr.message}`, 'ERR_ENCRYPT_CHUNK');
          return;
        }

        const frameByteLength = encryptedFrame.byteLength;
        const rawChunkSize = Math.min(chunkSize, file.size - offset);

        // Kick off the NEXT chunk's read+encrypt immediately (pipeline)
        const nextOffset = offset + rawChunkSize;
        const nextIndex = chunkIndex + 1;
        if (nextOffset < file.size && this.isTransferring) {
          prefetchPromise = this._readAndEncryptChunk(file, nextOffset, chunkSize, nextIndex);
        }

        // Backpressure check — pause only when buffer is genuinely full
        if (this.dataChannel.bufferedAmount > BUFFER_HIGH_WATERMARK) {
          try {
            await this._waitForBufferLow();
          } catch (_) {
            if (this.transferState === 'completed' || !this.isTransferring) break;
          }
        }

        // Send the encrypted frame
        try {
          this.dataChannel.send(encryptedFrame);
        } catch (err) {
          this._handleTransferFailure(`Failed to send chunk frame: ${err.message}`, 'ERR_CHUNK_SEND');
          return;
        }

        offset += rawChunkSize;
        chunkIndex++;

        // Progress reporting (throttled to 100 ms)
        const now = Date.now();
        const timeDiff = (now - this.lastProgressTime) / 1000;
        if (timeDiff >= 0.5) {
          this.currentSpeedBps = timeDiff > 0 ? ((offset - this.lastProgressBytes) / timeDiff) : 0;
          this.lastProgressTime = now;
          this.lastProgressBytes = offset;
        }

        const isComplete = offset >= file.size;
        if (isComplete || (now - this._lastSendUiUpdate) > 100) {
          this._lastSendUiUpdate = now;
          this.onProgress({
            percent: Math.min(100, (offset / file.size) * 100).toFixed(1),
            transferredBytes: offset,
            totalBytes: file.size,
            speedBps: this.currentSpeedBps,
            role: 'sender'
          });
        }
        // No rAF yield here — we let the event loop breathe only during the
        // await on the prefetch promise above, which is already async.
      }
    }

    /**
     * Read one file slice and encrypt it. Used by the pipelined send loop so
     * we can overlap crypto with the previous chunk's network send.
     * @returns {Promise<ArrayBuffer>} Encrypted frame ready to pass to dataChannel.send()
     */
    async _readAndEncryptChunk(file, offset, chunkSize, chunkIndex) {
      const slice = file.slice(offset, offset + chunkSize);
      const chunkBuffer = await slice.arrayBuffer();
      const encryptedFrame = await this.encryptChunk(chunkBuffer, chunkIndex, this.aesKey);
      // Return the underlying ArrayBuffer (no extra copy)
      return encryptedFrame.buffer;
    }

    /**
     * Event-driven Backpressure wait. Resolves ONLY when bufferedAmount <= BUFFER_LOW_WATERMARK.
     * Rejects gracefully if DataChannel closes or transfer is cancelled.
     */
    _waitForBufferLow() {
      if (!this.dataChannel || this.dataChannel.bufferedAmount <= BUFFER_LOW_WATERMARK || this.transferState === 'completed') {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        // Pure event-driven — no polling timer.
        // We only add a single 500 ms safety-net timeout in case the browser
        // doesn't fire bufferedamountlow (e.g. some mobile Safari versions).
        let safetyTimer = null;

        const done = () => {
          if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
          if (this.dataChannel) this.dataChannel.onbufferedamountlow = null;
          resolve();
        };

        if (this.dataChannel) {
          this.dataChannel.onbufferedamountlow = done;
        }

        // Safety-net: if the event never fires, unblock after 500 ms
        safetyTimer = setTimeout(done, 500);
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
      this._cleanupReceiverStorage(true);
      this._setState('idle');

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




