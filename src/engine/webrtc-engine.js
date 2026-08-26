/**
 * FluxTransfer — Canonical Client-Side WebRTC File Transfer Engine
 * 
 * Features:
 * - Native WebRTC RTCPeerConnection & RTCDataChannel
 * - WebSocket Signaling client for room pairing & SDP/ICE exchange with Stable PeerToken Role Preservation
 * - Application-level E2EE (AES-256 / SHA-256 via Web Crypto API, derived with PBKDF2 salt)
 * - Unique 12-byte random IV/nonce per encrypted chunk
 * - ReceiverStorage abstraction (OPFS streaming writer + safe Memory fallback)
 * - Deterministic Metadata Readiness Protocol (Sender wait for metadata-ack with timeout; Bounded Receiver Early Chunk Queue)
 * - SHA-256 file integrity calculation & verification
 * - Event-driven, non-bypassing backpressure management
 * - Authoritative transfer state machine (idle, connecting, connected, transferring, completed, failed, cancelled)
 * - Conceptual separation of signaling and WebRTC DataChannel lifecycles
 * - Idempotent cleanup handling multiple close/error triggers safely
 * - Zero logging of secrets, keys, PINs, or plaintext data
 */

import APP_CONFIG, { getIceServers, getDefaultSignalingUrl } from '../config/app-config.js';
import CryptoService, { deriveKey, encryptChunk, decryptFrame, base64ToBytes, bytesToBase64 } from '../services/crypto-service.js';
import HashService, { computeHash, sha256 } from '../services/hash-service.js';
import ReceiverStorage, { createReceiverStorage } from '../storage/receiver-storage.js';

class FluxWebRTCEngine {
  /**
   * @param {Object} config
   * @param {string} [config.signalingUrl]
   * @param {Array<RTCIceServer>} [config.iceServers]
   * @param {Function} [config.onStatusChange]
   * @param {Function} [config.onProgress]
   * @param {Function} [config.onFileMetadata]
   * @param {Function} [config.onFileComplete]
   * @param {Function} [config.onError]
   * @param {Function} [config.onPeerJoined]
   * @param {Function} [config.onDataChannelOpen]
   * @param {Function} [config.onPeerLeft]
   * @param {Function} [config.onControlMessage]
   */
  constructor(config = {}) {
    this.signalingUrl = config.signalingUrl || getDefaultSignalingUrl();
    this.iceServers = config.iceServers || getIceServers();

    // Stable Peer Token per session for reconnect role preservation
    this.peerToken = 'peer_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now();

    // Listener Registry
    this._listeners = new Map();

    // Event Callbacks (Direct properties kept as backward-compatible wrappers)
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
    this.pendingIceCandidates = [];

    // Authoritative Transfer Lifecycle State Machine
    this.transferState = 'idle'; // 'idle'|'connecting'|'connected'|'transferring'|'completed'|'cancelled'|'failed'
    this.isTransferring = false;
    this.transferId = null;
    this._isDisconnecting = false;

    // Readiness Protocol & Early Chunk Queue
    this._receiverReady = false;
    this._earlyChunkQueue = null;
    this._onMetadataAckResolver = null;
    this._onMetadataAckRejecter = null;

    // Encryption Key & Salt
    this.aesKey = null;
    this.salt = null;

    // Receiver Storage Abstraction
    this.storage = null;
    this.incomingMeta = null;
    this.receivedChunksCount = 0;
    this.receivedBytes = 0;
    this.finishStarted = false;

    // Speed & UI state
    this.transferStartTime = 0;
    this.lastProgressTime = 0;
    this.lastProgressBytes = 0;
    this.currentSpeedBps = 0;

    // Sender state
    this.currentFile = null;
  }

  /**
   * Deterministic state transition — Authoritative Single Source of Truth
   */
  _setState(state, extraInfo = {}) {
    if (this.transferState === 'completed' && (state === 'failed' || state === 'idle' || state === 'connecting' || state === 'connected')) {
      console.log(`[WebRTC Engine] Suppressing state transition to ${state} because transfer is already completed.`);
      return;
    }

    this.transferState = state;
    this.isTransferring = (state === 'transferring');
    console.log(`[WebRTC Engine] State transition -> ${state}`);

    this.emit('stateChange', state, extraInfo);
  }

  /**
   * Standardized Event Dispatch System
   */
  emit(event, ...args) {
    try {
      switch (event) {
        case 'stateChange':
          if (typeof this._onStateChangeCb === 'function') this._onStateChangeCb(...args);
          break;
        case 'statusChange':
          if (typeof this.onStatusChange === 'function') this.onStatusChange(...args);
          break;
        case 'progress':
          if (typeof this.onProgress === 'function') this.onProgress(...args);
          break;
        case 'fileMetadata':
          if (typeof this.onFileMetadata === 'function') this.onFileMetadata(...args);
          break;
        case 'fileComplete':
          if (typeof this.onFileComplete === 'function') this.onFileComplete(...args);
          break;
        case 'error':
          if (typeof this.onError === 'function') this.onError(...args);
          break;
        case 'peerJoined':
          if (typeof this.onPeerJoined === 'function') this.onPeerJoined(...args);
          break;
        case 'peerLeft':
          if (typeof this.onPeerLeft === 'function') this.onPeerLeft(...args);
          break;
        case 'dataChannelOpen':
          if (typeof this.onDataChannelOpen === 'function') this.onDataChannelOpen(...args);
          break;
        case 'controlMessage':
          if (typeof this.onControlMessage === 'function') this.onControlMessage(...args);
          break;
      }
    } catch (e) {
      console.error(`[WebRTC Engine] Error in property callback for event "${event}":`, e);
    }

    const handlers = this._listeners.get(event);
    if (handlers) {
      for (const fn of handlers) {
        try {
          fn(...args);
        } catch (e) {
          console.error(`[WebRTC Engine] Error in event listener for "${event}":`, e);
        }
      }
    }
  }

  /**
   * Standardized Event Listener Registration
   */
  on(event, fn) {
    if (typeof fn !== 'function') return this;

    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(fn);

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

  off(event, fn) {
    const handlers = this._listeners.get(event);
    if (handlers) {
      handlers.delete(fn);
    }
    return this;
  }

  async deriveKey(sessionCode, salt) {
    return await deriveKey(sessionCode, salt, APP_CONFIG.PBKDF2_ITERATIONS);
  }

  async encryptChunk(chunkBuffer, chunkIndex, key) {
    return await encryptChunk(chunkBuffer, chunkIndex, key);
  }

  async decryptFrame(frameBuffer, key) {
    return await decryptFrame(frameBuffer, key);
  }

  async _computeHash(payload) {
    return await computeHash(payload);
  }

  _sha256(data) {
    return sha256(data);
  }

  connect(roomCode, sessionCode = null) {
    if (!roomCode) {
      this.emit('error', 'Room code is required', 'ERR_INVALID_ROOM');
      return;
    }

    this.disconnect();
    this.roomCode = String(roomCode).trim();
    this.sessionCode = sessionCode ? String(sessionCode).trim() : this.roomCode;
    this._setState('connecting');
    this.emit('statusChange', 'Connecting to signaling server…', 'info');

    try {
      const WebSocketImpl = typeof window !== 'undefined' ? window.WebSocket : require('ws');
      this.ws = new WebSocketImpl(this.signalingUrl);
    } catch (err) {
      this._setState('failed');
      this.emit('error', `Failed to connect to signaling server: ${err.message}`, 'ERR_WS_CONNECT');
      return;
    }

    this.ws.onopen = () => {
      this._hasTriedFallback = false;
      this.emit('statusChange', 'Connected to signaling server. Joining room…', 'info');
      this._sendSignaling({
        type: 'join-room',
        room: this.roomCode,
        peerToken: this.peerToken
      });
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
      if (this.transferState === 'completed' || this.transferState === 'transferring') {
        // Signaling closure does NOT abort an active P2P DataChannel transfer!
        return;
      }
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
      this.emit('statusChange', 'Signaling server connection error', 'error');
      this.emit('error', 'WebSocket connection to signaling server failed.', 'ERR_WS_ERROR');
    };

    this.ws.onclose = () => {
      console.log('[WebRTC Engine] WebSocket closed');
    };
  }

  _handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'joined':
        this.role = msg.role;
        this.emit('statusChange', `Room joined. Waiting for peer…`, 'info');
        if (msg.peerPresent && this.role === 'initiator') {
          this.emit('peerJoined');
          this._initiatePeerConnection();
        }
        break;

      case 'peer-joined':
        this.emit('statusChange', 'Peer connected! Negotiating P2P link…', 'info');
        this.emit('peerJoined');
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
        this.emit('statusChange', 'Peer disconnected from room', 'warning');
        this.emit('peerLeft');
        this._handlePeerDisconnect('Peer left the signaling room mid-session.');
        break;

      case 'room-full':
        this.emit('statusChange', 'Room is full (Maximum 2 peers)', 'error');
        this.emit('error', `Room is full. Please try another code.`, 'ERR_ROOM_FULL');
        this.disconnect();
        break;

      case 'error':
        if (msg.message && msg.message.includes('expired')) {
          if (this.transferState === 'transferring') {
            console.log('[WebRTC Engine] Signaling room expired during active P2P DataChannel transfer. Continuing transfer.');
            return;
          }
        }
        this.emit('error', msg.message, 'ERR_SIGNALING');
        break;
    }
  }

  _createPeerConnection() {
    const pcConfig = {
      iceServers: this.iceServers,
      iceCandidatePoolSize: 4,
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
      if (!this.pc) return;
      const state = this.pc.iceConnectionState;
      console.log(`[WebRTC Engine] ICE State: ${state}`);

      if (state === 'connected' || state === 'completed') {
        this._setState('connected');
        this._reportConnectionType();
      } else if (state === 'failed') {
        if (this.transferState === 'completed') return;
        console.warn('[WebRTC Engine] ICE connection failed');
        this._handleTransferFailure('WebRTC P2P connection failed. Check your network or firewall.', 'ERR_ICE_FAILED');
      } else if (state === 'disconnected') {
        if (this.transferState !== 'completed') {
          this.emit('statusChange', 'P2P connection interrupted', 'warning');
        }
      }
    };

    if ('onconnectionstatechange' in this.pc) {
      this.pc.onconnectionstatechange = () => {
        if (!this.pc) return;
        const state = this.pc.connectionState;
        console.log(`[WebRTC Engine] Connection State: ${state}`);
        if (state === 'connected') {
          this._setState('connected');
        } else if (state === 'failed') {
          if (this.transferState === 'completed') return;
          this._handleTransferFailure('WebRTC P2P connection failed. Please ensure both devices can communicate.', 'ERR_PEER_FAILED');
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
      this.emit('statusChange', 'WebRTC Direct P2P Connected ⚡', 'success');
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
        this.emit('statusChange', 'WebRTC Direct Same-Network Connected ⚡ (LAN)', 'success');
      } else {
        this.emit('statusChange', 'WebRTC Direct P2P Connected ⚡', 'success');
      }
    } catch (_) {
      this.emit('statusChange', 'WebRTC Direct P2P Connected ⚡', 'success');
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
      this.emit('error', `Failed to create SDP offer: ${err.message}`, 'ERR_OFFER');
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
      this.emit('error', `Failed to handle SDP offer: ${err.message}`, 'ERR_HANDLE_OFFER');
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
      this.emit('error', `Failed to set SDP answer: ${err.message}`, 'ERR_HANDLE_ANSWER');
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
    this.dataChannel.bufferedAmountLowThreshold = APP_CONFIG.BUFFER_LOW_WATERMARK;

    this.dataChannel.onopen = () => {
      console.log('[WebRTC Engine] DataChannel OPEN');
      this._setState('connected');
      this.emit('statusChange', 'P2P DataChannel open. Encrypted link ready! ⚡', 'success');
      this.emit('dataChannelOpen');
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
   * Sender helper: Wait for receiver { type: 'metadata-ack' } with configurable timeout
   */
  _waitForMetadataAck(timeoutMs = APP_CONFIG.METADATA_ACK_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      let timer = setTimeout(() => {
        this._onMetadataAckResolver = null;
        this._onMetadataAckRejecter = null;
        reject(new Error(`Receiver metadata-ack timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);

      this._onMetadataAckResolver = () => {
        clearTimeout(timer);
        this._onMetadataAckResolver = null;
        this._onMetadataAckRejecter = null;
        resolve();
      };

      this._onMetadataAckRejecter = (errMessage) => {
        clearTimeout(timer);
        this._onMetadataAckResolver = null;
        this._onMetadataAckRejecter = null;
        reject(new Error(errMessage || 'Receiver rejected metadata initialization'));
      };
    });
  }

  /**
   * Process binary chunk frame (decryption & storage write)
   */
  async _processBinaryChunkFrame(data) {
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

    if (this.storage) {
      const offset = chunkIndex * meta.chunkSize;
      try {
        await this.storage.writeChunk(chunkIndex, offset, chunkData);
      } catch (writeErr) {
        this._handleTransferFailure(`Storage write error: ${writeErr.message}`, 'ERR_STORAGE_WRITE');
        return;
      }
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
      this.emit('progress', {
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
          this.finishStarted = false;

          // Prepare readiness state & early chunk queue
          this._receiverReady = false;
          this._earlyChunkQueue = [];

          this._setState('transferring');
          this.emit('statusChange', `Initializing receiver for "${msg.name}"…`, 'info');
          this.emit('fileMetadata', msg);

          // 1. Derive key
          try {
            this.aesKey = await this.deriveKey(this.sessionCode, this.salt);
          } catch (keyErr) {
            this._sendControlMessage({ type: 'metadata-error', error: keyErr.message });
            this._handleTransferFailure(`Failed to derive encryption key: ${keyErr.message}`, 'ERR_KEY_DERIVATION');
            return;
          }

          // 2. Initialize receiver storage (OPFS or Memory)
          try {
            this.storage = await createReceiverStorage(msg);
          } catch (storageErr) {
            this._sendControlMessage({ type: 'metadata-error', error: storageErr.message });
            this._handleTransferFailure(storageErr.message, 'ERR_STORAGE_LIMIT');
            return;
          }

          // 3. Mark receiver ready and send metadata-ack to sender
          this._receiverReady = true;
          this._sendControlMessage({ type: 'metadata-ack' });
          this.emit('statusChange', `Receiving file "${msg.name}" (${this._formatBytes(msg.size)})…`, 'info');

          // 4. Drain & process any early queued binary chunks safely
          if (this._earlyChunkQueue && this._earlyChunkQueue.length > 0) {
            const queueToProcess = [...this._earlyChunkQueue];
            this._earlyChunkQueue = null;
            for (const earlyData of queueToProcess) {
              await this._processBinaryChunkFrame(earlyData);
            }
          } else {
            this._earlyChunkQueue = null;
          }

        } else if (msg.type === 'metadata-ack') {
          console.log('[WebRTC Engine] Receiver sent metadata-ack. Starting binary stream.');
          if (typeof this._onMetadataAckResolver === 'function') {
            this._onMetadataAckResolver();
          }

        } else if (msg.type === 'metadata-error') {
          console.error('[WebRTC Engine] Receiver rejected metadata:', msg.error);
          if (typeof this._onMetadataAckRejecter === 'function') {
            this._onMetadataAckRejecter(msg.error);
          } else {
            this._handleTransferFailure(`Receiver failed to initialize: ${msg.error || 'Initialization error'}`, 'ERR_RECEIVER_INIT_FAILED');
          }

        } else if (msg.type === 'ack-complete') {
          if (this.currentFile || this.isTransferring) {
            const file = this.currentFile;
            this.currentFile = null;
            this._setState('completed');
            this.emit('statusChange', 'File transfer verified and acknowledged by receiver! 🎉', 'success');
            const meta = {
              name: file ? file.name : 'File',
              size: file ? file.size : 0,
              isSender: true
            };
            this.emit('fileComplete', null, meta);
          }
        } else if (msg.type === 'cancel') {
          if (this.storage) {
            await this.storage.abort();
            this.storage = null;
          }
          this._setState('cancelled');
          this.emit('statusChange', 'Transfer cancelled by peer.', 'warning');
          this.emit('error', 'Peer cancelled the file transfer.', 'ERR_TRANSFER_CANCELLED');
        } else if (msg.type === 'zen_game') {
          this.emit('controlMessage', msg);
        }
      } catch (e) {
        console.error('[WebRTC Engine] Failed parsing text frame');
      }
    } else if (data instanceof ArrayBuffer) {
      if (!this._receiverReady) {
        if (this._earlyChunkQueue) {
          if (this._earlyChunkQueue.length >= APP_CONFIG.MAX_EARLY_CHUNK_QUEUE_SIZE) {
            this._sendControlMessage({ type: 'metadata-error', error: 'Early chunk queue overflow' });
            this._handleTransferFailure('Early chunk queue overflow', 'ERR_EARLY_QUEUE_OVERFLOW');
            return;
          }
          console.warn(`[WebRTC Engine] Early binary chunk received before receiver ready. Queueing (${this._earlyChunkQueue.length + 1}/${APP_CONFIG.MAX_EARLY_CHUNK_QUEUE_SIZE}).`);
          this._earlyChunkQueue.push(data);
          return;
        } else {
          console.warn('[WebRTC Engine] Received chunk frame before metadata key setup');
          return;
        }
      }

      await this._processBinaryChunkFrame(data);
    }
  }

  /**
   * Finalize received file and verify SHA-256 integrity
   */
  async _finalizeReceiverTransfer() {
    const meta = this.incomingMeta;
    this.incomingMeta = null;

    try {
      let fileObj = null;
      if (this.storage) {
        fileObj = await this.storage.finalize();
        this.storage = null;
      }

      if (!fileObj) throw new Error('Failed to retrieve file from storage');

      // SHA-256 Integrity Verification
      this.emit('statusChange', 'Verifying SHA-256 file integrity checksum…', 'info');
      const computedHash = await this._computeHash(fileObj);

      if (computedHash !== meta.hash) {
        throw new Error(`SHA-256 checksum mismatch (Expected ${meta.hash.slice(0, 8)}…, got ${computedHash.slice(0, 8)}…)`);
      }

      // Verification successful
      this._setState('completed');
      this.emit('statusChange', `File "${meta.name}" received & verified successfully! 🎉`, 'success');
      this.emit('fileComplete', fileObj, meta);

      this._sendControlMessage({ type: 'ack-complete', hash: computedHash });

    } catch (err) {
      if (this.storage) {
        await this.storage.abort();
        this.storage = null;
      }
      this._handleTransferFailure(`Transfer verification failed: ${err.message}`, 'ERR_INTEGRITY_FAILED');
    }
  }

  /**
   * Send File over DataChannel with AES-256-GCM E2EE & Event-Driven Backpressure
   */
  async sendFile(file) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      this.emit('error', 'P2P DataChannel is not open. Connect to peer first.', 'ERR_NOT_CONNECTED');
      return;
    }

    if (!file) {
      this.emit('error', 'No file selected for transfer.', 'ERR_NO_FILE');
      return;
    }

    if (this.isTransferring) {
      console.warn('[WebRTC Engine] Transfer already in progress. Ignoring duplicate call.');
      return;
    }

    this.currentFile = file;
    this._setState('transferring');
    const chunkSize = APP_CONFIG.DEFAULT_CHUNK_SIZE;
    const totalChunks = Math.ceil(file.size / chunkSize);

    const cryptoObj = CryptoService.getCrypto();
    this.salt = cryptoObj.getRandomValues(new Uint8Array(16));

    try {
      this.aesKey = await this.deriveKey(this.sessionCode, this.salt);
    } catch (keyErr) {
      this._handleTransferFailure(`Failed to derive encryption key: ${keyErr.message}`, 'ERR_KEY_DERIVATION');
      return;
    }

    this.emit('statusChange', `Calculating SHA-256 hash for "${file.name}"…`, 'info');
    let fileHash = '';
    try {
      fileHash = await this._computeHash(file);
    } catch (hashErr) {
      this._handleTransferFailure(`SHA-256 calculation failed: ${hashErr.message}`, 'ERR_HASH_FAILED');
      return;
    }

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

    // 1. Send Metadata Control Header
    this.emit('statusChange', `Waiting for receiver readiness ACK…`, 'info');
    this._sendControlMessage(metadata);

    // 2. Wait for metadata-ack from receiver (with 15s timeout)
    try {
      await this._waitForMetadataAck(APP_CONFIG.METADATA_ACK_TIMEOUT_MS);
    } catch (ackErr) {
      this._handleTransferFailure(`Transfer initiation failed: ${ackErr.message}`, 'ERR_METADATA_ACK_TIMEOUT');
      return;
    }

    // 3. Metadata acknowledged -> Start binary streaming
    this.emit('statusChange', `Starting encrypted transfer of "${file.name}" (${this._formatBytes(file.size)})…`, 'info');

    let offset = 0;
    let chunkIndex = 0;
    this.lastProgressTime = Date.now();
    this.lastProgressBytes = 0;
    this.currentSpeedBps = 0;
    this._lastSendUiUpdate = 0;

    while (offset < file.size && this.isTransferring) {
      if (this.dataChannel.bufferedAmount > APP_CONFIG.BUFFER_HIGH_WATERMARK) {
        try {
          await this._waitForBufferLow();
        } catch (bufErr) {
          if (this.transferState === 'completed' || !this.isTransferring) {
            break;
          }
        }
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
        this.emit('progress', {
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

  _waitForBufferLow() {
    const lowMark = APP_CONFIG.BUFFER_LOW_WATERMARK;
    if (!this.dataChannel || this.dataChannel.bufferedAmount <= lowMark || this.transferState === 'completed') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let checkTimer = null;

      const cleanup = () => {
        if (checkTimer) clearInterval(checkTimer);
        if (this.dataChannel) this.dataChannel.onbufferedamountlow = null;
      };

      const done = () => {
        cleanup();
        resolve();
      };

      if (this.dataChannel) {
        this.dataChannel.onbufferedamountlow = () => {
          if (!this.dataChannel || this.dataChannel.bufferedAmount <= lowMark) {
            done();
          }
        };
      }

      checkTimer = setInterval(() => {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open' || !this.isTransferring || this.transferState === 'completed') {
          done();
        } else if (this.dataChannel.bufferedAmount <= lowMark) {
          done();
        }
      }, 25);
    });
  }

  sendControlMessage(msgObj) {
    this._sendControlMessage({
      type: 'zen_game',
      ...msgObj
    });
  }

  cancelTransfer() {
    if (this.transferState === 'completed' || this.transferState === 'cancelled') return;
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this._sendControlMessage({ type: 'cancel' });
    }
    if (this.storage) {
      this.storage.abort().catch(() => { });
      this.storage = null;
    }
    this._setState('cancelled');
    this.emit('statusChange', 'Transfer cancelled', 'warning');
  }

  _handlePeerDisconnect(reason) {
    if (this.transferState === 'completed' || this.transferState === 'failed' || this.transferState === 'cancelled') return;
    if (this.isTransferring) {
      if (this.storage) {
        this.storage.abort().catch(() => { });
        this.storage = null;
      }
      this._handleTransferFailure(`Transfer aborted: ${reason}`, 'ERR_PEER_DISCONNECTED');
    }
  }

  _handleTransferFailure(errorMessage, errorCode) {
    if (this.transferState === 'completed' || this.transferState === 'failed' || this.transferState === 'cancelled') return;
    if (typeof this._onMetadataAckRejecter === 'function') {
      this._onMetadataAckRejecter(errorMessage);
    }
    if (this.storage) {
      this.storage.abort().catch(() => { });
      this.storage = null;
    }
    this._setState('failed');
    this.emit('error', errorMessage, errorCode);
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
    if (this._isDisconnecting) return;
    this._isDisconnecting = true;

    if (this.storage) {
      this.storage.cleanup().catch(() => { });
      this.storage = null;
    }

    const wasCompleted = (this.transferState === 'completed');
    if (!wasCompleted) {
      this._setState('idle');
    }

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
    this._receiverReady = false;
    this._earlyChunkQueue = null;

    this._isDisconnecting = false;
  }
}

// Export compatibility
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

export { FluxWebRTCEngine };
export default FluxWebRTCEngine;
