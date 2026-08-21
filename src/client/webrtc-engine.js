/**
 * FluxTransfer — Canonical Client-Side WebRTC File Transfer Engine
 * 
 * Features:
 * - Native WebRTC RTCPeerConnection & RTCDataChannel
 * - WebSocket Signaling client for room pairing & SDP/ICE exchange
 * - Application-level E2EE (AES-256-GCM via Web Crypto API, derived using PBKDF2 with 100k iterations)
 * - Unique 12-byte random IV/nonce per encrypted chunk
 * - Zero-RAM OPFS streaming storage on receiver side (with RAM chunk fallback for legacy environments)
 * - Off-main-thread SHA-256 file integrity calculation & verification via hash-worker.js
 * - Event-driven, non-bypassing backpressure management
 * - Deterministic transfer state machine (idle, connecting, connected, transferring, completed, failed, cancelled)
 * - Application-level P2P control messaging interface (for Flux Zen multiplayer)
 * - Zero logging of secrets, keys, PINs, or plaintext data
 */

(function (global) {
  'use strict';

  const DEFAULT_CHUNK_SIZE = 64 * 1024; // 64 KB chunk size for WebRTC DataChannel frames
  const BUFFER_HIGH_WATERMARK = 4 * 1024 * 1024; // 4 MB high watermark
  const BUFFER_LOW_WATERMARK = 1 * 1024 * 1024;  // 1 MB low watermark
  const PBKDF2_ITERATIONS = 100000;

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
    if (typeof self !== 'undefined' && self.crypto && self.crypto.subtle) {
      return self.crypto;
    }
    if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
      return globalThis.crypto;
    }
    if (typeof require !== 'undefined') {
      try {
        const nodeCrypto = require('crypto');
        if (nodeCrypto.webcrypto && nodeCrypto.webcrypto.subtle) {
          return nodeCrypto.webcrypto;
        }
      } catch (_) {}
    }
    return null;
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
        if (window.location.protocol === 'https:') {
          defaultSignalingUrl = `wss://${window.location.host}`;
        } else {
          defaultSignalingUrl = `ws://${window.location.hostname}:8080`;
        }
      } else {
        defaultSignalingUrl = 'ws://localhost:8080';
      }

      this.signalingUrl = config.signalingUrl || defaultSignalingUrl;
      this.iceServers = config.iceServers || DEFAULT_ICE_SERVERS;

      // Event Callbacks
      this.onStatusChange = config.onStatusChange || (() => {});
      this.onProgress = config.onProgress || (() => {});
      this.onFileMetadata = config.onFileMetadata || (() => {});
      this.onFileComplete = config.onFileComplete || (() => {});
      this.onError = config.onError || (() => {});
      this.onPeerJoined = config.onPeerJoined || (() => {});
      this.onDataChannelOpen = config.onDataChannelOpen || (() => {});
      this.onPeerLeft = config.onPeerLeft || (() => {});
      this.onControlMessage = config.onControlMessage || (() => {});

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
      this.transferState = state;
      console.log(`[WebRTC Engine] State transition -> ${state}`);
    }

    /**
     * Derive AES-256-GCM Key from Session Code / PIN and Salt using PBKDF2
     */
    async deriveKey(sessionCode, salt) {
      const cryptoObj = getCrypto();
      if (!cryptoObj || !cryptoObj.subtle) {
        throw new Error('Web Crypto API is unavailable in this environment');
      }
      const cleanCode = String(sessionCode || '').trim();
      if (!cleanCode) throw new Error('Missing session code for key derivation');

      const keyMaterial = await cryptoObj.subtle.importKey(
        'raw',
        new TextEncoder().encode(cleanCode),
        'PBKDF2',
        false,
        ['deriveKey']
      );

      return await cryptoObj.subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt: salt,
          iterations: PBKDF2_ITERATIONS,
          hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    }

    /**
     * Encrypt a chunk ArrayBuffer with AES-256-GCM using a fresh unique 12-byte IV
     * Frame format: [ChunkIndex (4B, BigEndian)][IV (12B)][Ciphertext + Tag]
     */
    async encryptChunk(chunkBuffer, chunkIndex, aesKey) {
      const cryptoObj = getCrypto();
      const iv = cryptoObj.getRandomValues(new Uint8Array(12));
      const encrypted = await cryptoObj.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        aesKey,
        chunkBuffer
      );

      const frame = new Uint8Array(4 + 12 + encrypted.byteLength);
      const view = new DataView(frame.buffer);
      view.setUint32(0, chunkIndex, false);
      frame.set(iv, 4);
      frame.set(new Uint8Array(encrypted), 16);
      return frame;
    }

    /**
     * Decrypt a chunk frame buffer with AES-256-GCM using derived key and chunk IV
     */
    async decryptFrame(frameBuffer, aesKey) {
      const cryptoObj = getCrypto();
      const buffer = frameBuffer instanceof ArrayBuffer
        ? frameBuffer
        : frameBuffer.buffer.slice(frameBuffer.byteOffset, frameBuffer.byteOffset + frameBuffer.byteLength);

      if (buffer.byteLength < 32) {
        throw new Error('Invalid transfer frame: undersized payload');
      }

      const view = new DataView(buffer);
      const chunkIndex = view.getUint32(0, false);
      const iv = new Uint8Array(buffer, 4, 12);
      const encryptedPayload = buffer.slice(16);

      const decrypted = await cryptoObj.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        aesKey,
        encryptedPayload
      );

      return { chunkIndex, chunkData: decrypted };
    }

    /**
     * Off-main-thread SHA-256 file hashing via hash-worker.js (or SubtleCrypto fallback)
     */
    async _computeHash(payload) {
      if (typeof Worker !== 'undefined') {
        try {
          return await new Promise((resolve, reject) => {
            const worker = new Worker('/hash-worker.js');
            const id = Math.random().toString(36).slice(2);
            let totalSize = 0;
            if (payload instanceof Blob) {
              totalSize = payload.size;
            } else if (Array.isArray(payload)) {
              for (let c of payload) {
                if (c) totalSize += (c.byteLength || 0);
              }
            }
            const timeoutDuration = Math.max(180000, (totalSize / (1024 * 1024)) * 3000);
            const timer = setTimeout(() => {
              worker.terminate();
              reject(new Error('SHA-256 calculation timed out'));
            }, timeoutDuration);

            worker.onmessage = (event) => {
              if (event.data && event.data.id === id) {
                clearTimeout(timer);
                worker.terminate();
                if (event.data.status === 'success') resolve(event.data.hash);
                else reject(new Error(event.data.error || 'Hashing failed'));
              }
            };
            worker.onerror = (err) => {
              clearTimeout(timer);
              worker.terminate();
              reject(new Error(err.message || 'Hash worker failed'));
            };

            if (payload instanceof Blob) worker.postMessage({ id, file: payload });
            else worker.postMessage({ id, chunks: payload });
          });
        } catch (workerErr) {
          console.warn('[WebRTC Engine] Hash worker unavailable, falling back:', workerErr);
        }
      }

      return await this._canonicalHashFallback(payload);
    }

    async _canonicalHashFallback(fileOrChunks) {
      const cryptoObj = getCrypto();
      if (!cryptoObj || !cryptoObj.subtle) throw new Error('Crypto unavailable for hashing');

      if (fileOrChunks instanceof Blob) {
        const arrayBuf = await fileOrChunks.arrayBuffer();
        const digest = await cryptoObj.subtle.digest('SHA-256', arrayBuf);
        return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
      }

      if (Array.isArray(fileOrChunks)) {
        let totalLen = 0;
        for (let c of fileOrChunks) if (c) totalLen += c.byteLength || 0;
        const combined = new Uint8Array(totalLen);
        let pos = 0;
        for (let c of fileOrChunks) {
          if (!c) continue;
          const arr = ArrayBuffer.isView(c) ? new Uint8Array(c.buffer, c.byteOffset, c.byteLength) : new Uint8Array(c);
          combined.set(arr, pos);
          pos += arr.byteLength;
        }
        const digest = await cryptoObj.subtle.digest('SHA-256', combined.buffer);
        return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
      }

      throw new Error('Unsupported payload for hash fallback');
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
        iceCandidatePoolSize: 2
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
          this._setState('failed');
          this.onStatusChange('P2P connection failed', 'error');
          this.onError('WebRTC P2P connection failed.', 'ERR_ICE_FAILED');
          this.disconnect();
        } else if (state === 'disconnected') {
          this.onStatusChange('P2P connection interrupted', 'warning');
        }
      };

      this.pc.onicecandidate = (event) => {
        if (event.candidate) {
          this._sendSignaling({ type: 'ice-candidate', candidate: event.candidate });
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
      this.dataChannel = this.pc.createDataChannel('flux-file-channel', { ordered: true });
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
      if (!candidate) return;
      let RTCIceCandidateImpl;
      if (typeof window !== 'undefined' && window.RTCIceCandidate) {
        RTCIceCandidateImpl = window.RTCIceCandidate;
      } else {
        const wrtc = require('@koush/wrtc') || require('wrtc');
        RTCIceCandidateImpl = wrtc.RTCIceCandidate;
      }

      const rtcCandidate = new RTCIceCandidateImpl(candidate);
      if (this.pc && this.pc.remoteDescription && this.pc.remoteDescription.type) {
        try { await this.pc.addIceCandidate(rtcCandidate); } catch (e) {}
      } else {
        this.pendingIceCandidates.push(rtcCandidate);
      }
    }

    _flushPendingIceCandidates() {
      while (this.pendingIceCandidates.length > 0) {
        const candidate = this.pendingIceCandidates.shift();
        this.pc.addIceCandidate(candidate).catch(() => {});
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

            // Init Receiver Streaming Storage (OPFS worker with memory chunk fallback)
            const isOpfsSupported = typeof Worker !== 'undefined'
              && typeof navigator !== 'undefined'
              && navigator.storage
              && typeof navigator.storage.getDirectory === 'function';

            this.opfsActive = false;
            this.memoryChunks = null;

            if (isOpfsSupported) {
              try {
                this.opfsWorker = new Worker('/opfs-writer-worker.js');
                await this._postOpfsWorkerCmd('init', {
                  name: msg.name,
                  size: msg.size,
                  mime: msg.mimeType
                });
                this.opfsActive = true;
              } catch (opfsErr) {
                console.warn('[WebRTC Engine] OPFS writer initialization failed, using RAM chunk fallback:', opfsErr);
                this.opfsActive = false;
                if (this.opfsWorker) {
                  try { this.opfsWorker.terminate(); } catch (_) {}
                  this.opfsWorker = null;
                }
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

        // Store chunk via OPFS worker or memory fallback
        let storedInOpfs = false;
        if (this.opfsActive) {
          try {
            await this._postOpfsWorkerCmd('write', {
              position: chunkIndex * meta.chunkSize,
              data: chunkData
            });
            storedInOpfs = true;
          } catch (writeErr) {
            console.error('[WebRTC Engine] OPFS write failed, falling back to RAM:', writeErr);
            this.opfsActive = false;
          }
        }

        if (!storedInOpfs) {
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
        let fileObj = null;

        if (this.opfsActive && this.opfsWorker) {
          await this._postOpfsWorkerCmd('finalize');
          fileObj = await this._postOpfsWorkerCmd('get-file');
        } else {
          // Assembling from memory chunk fallback
          const chunks = this.memoryChunks || [];
          const combined = [];
          let currentBlock = new Uint8Array(Math.min(16 * 1024 * 1024, meta.size));
          let currentPos = 0;
          let bytesWritten = 0;

          for (let i = 0; i < chunks.length; i++) {
            if (!chunks[i]) throw new Error(`Missing chunk index ${i}`);
            const arr = new Uint8Array(chunks[i]);
            let chunkPos = 0;
            while (chunkPos < arr.byteLength) {
              const remaining = 16 * 1024 * 1024 - currentPos;
              const copyLen = Math.min(arr.byteLength - chunkPos, remaining);
              currentBlock.set(arr.subarray(chunkPos, chunkPos + copyLen), currentPos);
              currentPos += copyLen;
              chunkPos += copyLen;
              bytesWritten += copyLen;

              if (currentPos === 16 * 1024 * 1024) {
                combined.push(currentBlock);
                currentBlock = new Uint8Array(Math.min(16 * 1024 * 1024, meta.size - bytesWritten));
                currentPos = 0;
              }
            }
            chunks[i] = null;
          }
          if (currentPos > 0) combined.push(currentBlock.subarray(0, currentPos));
          fileObj = new Blob(combined, { type: meta.mimeType || 'application/octet-stream' });
          this.memoryChunks = null;
        }

        // SHA-256 Integrity Verification off-thread
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

    _postOpfsWorkerCmd(type, payload) {
      return new Promise((resolve, reject) => {
        if (!this.opfsWorker) return reject(new Error('OPFS worker unavailable'));
        const id = Math.random().toString(36).slice(2);
        const onMsg = (e) => {
          if (e.data && e.data.id === id) {
            this.opfsWorker.removeEventListener('message', onMsg);
            if (e.data.ok) resolve(e.data.result);
            else reject(new Error(e.data.error));
          }
        };
        this.opfsWorker.addEventListener('message', onMsg);
        this.opfsWorker.postMessage({ id, type, payload });
      });
    }

    _cleanupReceiverStorage(deleteFile = false) {
      if (this.opfsWorker) {
        try {
          if (deleteFile) this.opfsWorker.postMessage({ type: 'delete' });
          else this.opfsWorker.postMessage({ type: 'abort' });
          this.opfsWorker.terminate();
        } catch (_) {}
        this.opfsWorker = null;
      }
      this.opfsActive = false;
      this.memoryChunks = null;
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

      // Derive AES key
      try {
        this.aesKey = await this.deriveKey(this.sessionCode, this.salt);
      } catch (keyErr) {
        this._handleTransferFailure(`Failed to derive encryption key: ${keyErr.message}`, 'ERR_KEY_DERIVATION');
        return;
      }

      // Compute SHA-256 hash of plaintext file before/during streaming
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

      // Read, encrypt, and stream chunks with Event-Driven Backpressure
      let offset = 0;
      let chunkIndex = 0;
      this.lastProgressTime = Date.now();
      this.lastProgressBytes = 0;
      this.currentSpeedBps = 0;
      this._lastSendUiUpdate = 0;

      while (offset < file.size && this.isTransferring) {
        if (this.dataChannel.bufferedAmount > BUFFER_HIGH_WATERMARK) {
          await this._waitForBufferLow();
        }

        const slice = file.slice(offset, offset + chunkSize);
        const chunkBuffer = await slice.arrayBuffer();

        let encryptedFrame;
        try {
          encryptedFrame = await this.encryptChunk(chunkBuffer, chunkIndex, this.aesKey);
        } catch (encErr) {
          this._handleTransferFailure(`Failed to encrypt chunk ${chunkIndex}: ${encErr.message}`, 'ERR_ENCRYPT_CHUNK');
          return;
        }

        try {
          this.dataChannel.send(encryptedFrame.buffer);
        } catch (err) {
          this._handleTransferFailure(`Failed to send chunk frame: ${err.message}`, 'ERR_CHUNK_SEND');
          return;
        }

        offset += chunkBuffer.byteLength;
        chunkIndex++;

        const now = Date.now();
        const timeDiff = (now - this.lastProgressTime) / 1000;

        if (timeDiff >= 0.5) {
          const bytesDiff = offset - this.lastProgressBytes;
          this.currentSpeedBps = timeDiff > 0 ? (bytesDiff / timeDiff) : 0;
          this.lastProgressTime = now;
          this.lastProgressBytes = offset;
        }

        const isComplete = offset >= file.size;
        if (isComplete || (now - this._lastSendUiUpdate) > 100) {
          this._lastSendUiUpdate = now;
          const percent = Math.min(100, (offset / file.size) * 100);
          this.onProgress({
            percent: percent.toFixed(1),
            transferredBytes: offset,
            totalBytes: file.size,
            speedBps: this.currentSpeedBps,
            role: 'sender'
          });
        }

        if (chunkIndex % 50 === 0) {
          if (typeof requestAnimationFrame !== 'undefined') {
            await new Promise(r => requestAnimationFrame(r));
          } else {
            await new Promise(r => setTimeout(r, 0));
          }
        }
      }
    }

    /**
     * Event-driven Backpressure wait. Resolves ONLY when bufferedAmount <= BUFFER_LOW_WATERMARK.
     * Rejects immediately if DataChannel closes or transfer is cancelled.
     */
    _waitForBufferLow() {
      if (!this.dataChannel || this.dataChannel.bufferedAmount <= BUFFER_LOW_WATERMARK) {
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        let checkTimer = null;

        const cleanup = () => {
          if (checkTimer) clearInterval(checkTimer);
          if (this.dataChannel) this.dataChannel.onbufferedamountlow = null;
        };

        const done = () => {
          cleanup();
          if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
            reject(new Error('DataChannel closed while waiting for backpressure buffer'));
            return;
          }
          if (!this.isTransferring) {
            reject(new Error('Transfer cancelled while waiting for backpressure buffer'));
            return;
          }
          resolve();
        };

        if (this.dataChannel) {
          this.dataChannel.onbufferedamountlow = () => {
            if (!this.dataChannel || this.dataChannel.bufferedAmount <= BUFFER_LOW_WATERMARK) {
              done();
            }
          };
        }

        checkTimer = setInterval(() => {
          if (!this.dataChannel || this.dataChannel.readyState !== 'open' || !this.isTransferring) {
            done();
          } else if (this.dataChannel.bufferedAmount <= BUFFER_LOW_WATERMARK) {
            done();
          }
        }, 25);
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
      if (this.isTransferring) {
        this._cleanupReceiverStorage(true);
        this._handleTransferFailure(`Transfer aborted: ${reason}`, 'ERR_PEER_DISCONNECTED');
      }
    }

    _handleTransferFailure(errorMessage, errorCode) {
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
        try { this.dataChannel.close(); } catch (e) {}
        this.dataChannel = null;
      }

      if (this.pc) {
        try { this.pc.close(); } catch (e) {}
        this.pc = null;
      }

      if (this.ws) {
        if (this.ws.readyState === (typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1) && this.roomCode) {
          this._sendSignaling({ type: 'leave-room' });
        }
        try { this.ws.close(); } catch (e) {}
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
  } else {
    global.FluxWebRTCEngine = FluxWebRTCEngine;
  }
})(typeof window !== 'undefined' ? window : globalThis);
