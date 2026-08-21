/**
 * FluxTransfer — Client-Side WebRTC File Transfer Engine
 * 
 * Features:
 * - Native WebRTC RTCPeerConnection & RTCDataChannel
 * - WebSocket Signaling client for room pairing & SDP/ICE exchange
 * - File chunking (64KB) with backpressure management (bufferedAmount)
 * - Transfer progress, speed calculation, and completion Blob construction
 * - Robust error handling (ICE failure, signaling timeout, peer disconnect)
 * - Configurable STUN & TURN server support
 */

(function (global) {
  'use strict';

  const DEFAULT_CHUNK_SIZE = 128 * 1024; // 128 KB (Zero-copy raw ArrayBuffer chunk size)
  const BUFFER_HIGH_WATERMARK = 4 * 1024 * 1024; // 4 MB high watermark
  const BUFFER_LOW_WATERMARK = 1 * 1024 * 1024;  // 1 MB low watermark
  const ICE_RESTART_DELAY_MS = 2000;  // wait before restarting ICE

  // ─── ICE Server Configuration ─────────────────────────────────────────────
  // STUN: discovers public IP (works ~60-80% of NAT types)
  // TURN: relays traffic when STUN punch-through fails (symmetric NAT, CGNAT,
  //       mobile carriers, corporate firewalls). Required for cross-network.
  const DEFAULT_ICE_SERVERS = [
    // Google STUN (no auth needed, widely available)
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    // Open Relay (metered.ca) — free STUN
    { urls: 'stun:openrelay.metered.ca:80' },
    // Open Relay (metered.ca) — free TURN (no account required)
    // Covers port 80 (HTTP-friendly, firewall bypass) and 443 (HTTPS/TLS)
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
    // Cloudflare STUN (highly reliable, global)
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];

  class FluxWebRTCEngine {
    /**
     * @param {Object} config
     * @param {string} config.signalingUrl - WebSocket signaling server URL (e.g. 'ws://localhost:8080')
     * @param {Array<RTCIceServer>} [config.iceServers] - Custom STUN/TURN servers
     * @param {Function} [config.onStatusChange] - (statusText, statusType) => void
     * @param {Function} [config.onProgress] - ({ percent, transferredBytes, totalBytes, speedBps, role }) => void
     * @param {Function} [config.onFileMetadata] - (metadata) => void
     * @param {Function} [config.onFileComplete] - (blob, metadata) => void
     * @param {Function} [config.onError] - (errorMessage, errorCode) => void
     * @param {Function} [config.onPeerJoined] - () => void  (signaling: peer entered room)
     * @param {Function} [config.onDataChannelOpen] - () => void  (P2P channel ready — safe to sendFile)
     * @param {Function} [config.onPeerLeft] - () => void
     */
    constructor(config = {}) {
      // Smart signaling URL detection:
      // - HTTPS deployment: WebSocket on same host (wss://yoursite.com)
      // - Local dev (npm start): unified server on same port
      // - Local dev (npm run dev with separate static serve): fallback to :8080
      let defaultSignalingUrl;
      if (window.location.protocol === 'https:') {
        // Production HTTPS: WebSocket on same host (wss://yoursite.com)
        defaultSignalingUrl = `wss://${window.location.host}`;
      } else {
        // Local dev (localhost or LAN IP like 192.168.x.x):
        // Always connect to the unified signaling server on port 8080.
        // Run it with: npm start  (node src/server/signaling-server.js)
        // Do NOT use `npm run dev` alone — that only serves static files (no WebSocket).
        defaultSignalingUrl = `ws://${window.location.hostname}:8080`;
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

      // Internal State
      this.ws = null;
      this.pc = null;
      this.dataChannels = [];
      this.dataChannel = null;
      this.roomCode = null;
      this.role = null; // 'initiator' | 'joiner'
      this.isTransferring = false;
      this.pendingIceCandidates = [];
      this._hasFiredOpen = false;

      // Receiver state
      this.incomingMeta = null;
      this.receivedChunks = [];
      this.receivedBytes = 0;
      this.transferStartTime = 0;

      // Performance & Rolling Speed state
      this.lastProgressTime = 0;
      this.lastProgressBytes = 0;
      this.currentSpeedBps = 0;

      // Sender state
      this.currentFile = null;
      this.isPausedForBackpressure = false;
    }

    /**
     * Connect to signaling server and join a room
     * @param {string} roomCode 
     */
    connect(roomCode) {
      if (!roomCode) {
        this.onError('Room code is required', 'ERR_INVALID_ROOM');
        return;
      }

      this.disconnect(); // Clean up existing session if any
      this.roomCode = roomCode;
      this.onStatusChange('Connecting to signaling server…', 'info');

      try {
        this.ws = new WebSocket(this.signalingUrl);
      } catch (err) {
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
          console.error('[WebRTC Engine] Bad signaling message', e);
        }
      };

      this.ws.onerror = (err) => {
        console.error('[WebRTC Engine] WebSocket error', err);
        this.onStatusChange('Signaling server connection error', 'error');
        this.onError('WebSocket connection to signaling server failed. Is the server running?', 'ERR_WS_ERROR');
      };

      this.ws.onclose = () => {
        console.log('[WebRTC Engine] WebSocket closed');
      };
    }

    /**
     * Internal Signaling Message Router
     */
    _handleSignalingMessage(msg) {
      switch (msg.type) {
        case 'joined':
          this.role = msg.role;
          this.onStatusChange(`Room ${msg.room} joined. Waiting for peer…`, 'info');
          if (msg.peerPresent) {
            this.onPeerJoined();
            // Only the INITIATOR creates an offer. The joiner waits for the offer.
            if (this.role === 'initiator') {
              this._initiatePeerConnection();
            }
          }
          break;

        case 'peer-joined':
          this.onStatusChange('Peer connected! Negotiating P2P WebRTC link…', 'info');
          this.onPeerJoined();
          // Only the INITIATOR creates the offer — joiner waits and responds.
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
          this.onError(`Room "${msg.room}" is full. Please try another room code.`, 'ERR_ROOM_FULL');
          this.disconnect();
          break;

        case 'error':
          this.onError(msg.message, 'ERR_SIGNALING');
          break;
      }
    }

    /**
     * Create RTCPeerConnection with STUN/TURN servers
     */
    _createPeerConnection() {
      const pcConfig = {
        iceServers: this.iceServers,
        iceCandidatePoolSize: 2
      };

      this.pc = new RTCPeerConnection(pcConfig);

      // Relay ICE candidates to peer via signaling server — now moved inside _createPeerConnection body

      // Handle ICE Connection State changes
      this.pc.oniceconnectionstatechange = () => {
        const state = this.pc.iceConnectionState;
        console.log(`[WebRTC Engine] ICE State: ${state}`);

        if (state === 'connected' || state === 'completed') {
          this._reportConnectionType();
        } else if (state === 'failed') {
          this.onStatusChange('Connection failed — devices must be on the same Wi-Fi network', 'error');
          this.onError(
            'Devices are not on the same Wi-Fi network. Both devices must be connected to the same Wi-Fi network to transfer files.',
            'ERR_NOT_SAME_NETWORK'
          );
          this.disconnect();
        } else if (state === 'disconnected') {
          this.onStatusChange('P2P connection interrupted', 'warning');
        }
      };

      // Track ICE candidate types gathered (host/srflx/relay)
      this.pc.onicegatheringstatechange = () => {
        console.log(`[WebRTC Engine] ICE Gathering: ${this.pc.iceGatheringState}`);
      };

      this.pc.onicecandidate = (event) => {
        if (event.candidate) {
          const type = event.candidate.type || '';
          console.log(`[WebRTC Engine] ICE Candidate gathered: ${type} — ${event.candidate.address || event.candidate.candidate}`);
          this._sendSignaling({ type: 'ice-candidate', candidate: event.candidate });
        }
      };

      // Receiver listens for incoming DataChannel
      this.pc.ondatachannel = (event) => {
        console.log('[WebRTC Engine] Received remote DataChannel');
        this.dataChannel = event.channel;
        this._setupDataChannelEvents();
      };
    }

    /**
     * Inspect the active ICE candidate pair to verify same Wi-Fi / local network connection.
     * Rejects connections that rely on STUN/TURN across different networks.
     */
    async _reportConnectionType() {
      if (!this.pc) return;
      try {
        const stats = await this.pc.getStats();
        let localType = 'unknown';
        let remoteType = 'unknown';
        let isHostPair = false;

        stats.forEach((report) => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            const local = stats.get(report.localCandidateId);
            const remote = stats.get(report.remoteCandidateId);
            if (local) localType = local.candidateType || 'unknown';
            if (remote) remoteType = remote.candidateType || 'unknown';
            if (localType === 'host' && remoteType === 'host') {
              isHostPair = true;
            }
          }
        });

        if (!isHostPair) {
          console.warn(`[WebRTC Engine] Connection rejected: local candidate=${localType}, remote candidate=${remoteType}. Devices are not on the same Wi-Fi.`);
          this.onStatusChange('Error: Devices are on different networks.', 'error');
          this.onError(
            'Devices are not on the same Wi-Fi network. Both devices must be connected to the same Wi-Fi network to transfer files.',
            'ERR_NOT_SAME_NETWORK'
          );
          this.disconnect();
          return;
        }

        this.onStatusChange('WebRTC Direct Same-Network Connected ⚡ (Same Wi-Fi)', 'success');
        console.log('%c[WebRTC Engine] 🚀 Connection Mode: WebRTC DIRECT SAME-NETWORK (Same Wi-Fi / LAN)', 'color: #10b981; font-weight: bold; font-size: 12px;');
      } catch (err) {
        this.onStatusChange('WebRTC Direct P2P Connected ⚡', 'success');
        console.log('[WebRTC Engine] Connection Mode: WebRTC DIRECT P2P');
      }
    }

    /**
     * ICE Restart — retry ICE negotiation with relay-only (TURN) policy.
     * Called automatically on first ICE failure.
     */
    async _restartICE() {
      if (!this.pc || this.pc.connectionState === 'closed') return;
      console.log('[WebRTC Engine] Attempting ICE restart with relay-only policy…');

      const pcConfig = {
        iceServers: this.iceServers,
        iceTransportPolicy: 'relay', // Force TURN relay — bypasses symmetric NAT
        iceCandidatePoolSize: 4
      };

      try {
        this.pc.close();
        this.pc = new RTCPeerConnection(pcConfig);

        // Re-bind all handlers on new PC
        this.pc.oniceconnectionstatechange = this._createICEStateHandler();
        this.pc.onicegatheringstatechange = () => {
          console.log(`[WebRTC Engine] ICE Gathering (restart): ${this.pc.iceGatheringState}`);
        };
        this.pc.onicecandidate = (event) => {
          if (event.candidate) {
            this._sendSignaling({ type: 'ice-candidate', candidate: event.candidate });
          }
        };
        this.pc.ondatachannel = (event) => {
          this.dataChannel = event.channel;
          this._setupDataChannelEvents();
        };

        if (this.role === 'initiator') {
          this.dataChannel = this.pc.createDataChannel('flux-file-channel', { ordered: true });
          this._setupDataChannelEvents();
          const offer = await this.pc.createOffer({ iceRestart: true });
          await this.pc.setLocalDescription(offer);
          this._sendSignaling({ type: 'offer', offer: this.pc.localDescription });
        }
      } catch (err) {
        console.error('[WebRTC Engine] ICE restart failed:', err);
        this.onError('Relay fallback failed: ' + err.message, 'ERR_ICE_RESTART');
      }
    }

    /**
     * Build an ICE state change handler for use after restart.
     * Does not attempt another restart (prevents infinite loop).
     */
    _createICEStateHandler() {
      return () => {
        const state = this.pc && this.pc.iceConnectionState;
        console.log(`[WebRTC Engine] ICE State (after restart): ${state}`);
        if (state === 'connected' || state === 'completed') {
          this._reportConnectionType();
        } else if (state === 'failed') {
          this.onStatusChange('All connection paths failed', 'error');
          this.onError(
            'Connection failed: Both direct P2P (STUN) and relayed (TURN) paths failed. Try a different network or check firewall.',
            'ERR_ICE_FINAL_FAIL'
          );
        } else if (state === 'disconnected') {
          this.onStatusChange('P2P connection interrupted', 'warning');
        }
      };
    }

    /**
     * Initiator starts offer negotiation
     */
    async _initiatePeerConnection() {
      // Guard: don't create a new connection if one is already in progress
      if (this.pc && this.pc.signalingState !== 'closed') {
        console.warn('[WebRTC Engine] _initiatePeerConnection called but PC already exists — ignoring duplicate.');
        return;
      }

      this._createPeerConnection();
      this._iceRestartAttempted = false;

      // Only the initiator creates the DataChannel
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

    /**
     * Handle incoming SDP Offer (Receiver)
     */
    async _handleOffer(offer) {
      // Only accept an offer when we haven't set a remote description yet
      if (this.pc && this.pc.signalingState !== 'stable' && this.pc.signalingState !== 'closed') {
        console.warn(`[WebRTC Engine] _handleOffer ignored — bad signalingState: ${this.pc.signalingState}`);
        return;
      }

      if (!this.pc) {
        this._createPeerConnection();
      }

      try {
        await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
        this._flushPendingIceCandidates();

        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this._sendSignaling({ type: 'answer', answer: this.pc.localDescription });
      } catch (err) {
        this.onError(`Failed to handle SDP offer: ${err.message}`, 'ERR_HANDLE_OFFER');
      }
    }

    /**
     * Handle incoming SDP Answer (Initiator)
     */
    async _handleAnswer(answer) {
      if (!this.pc) return;
      // Only accept an answer when we're waiting for one (have-local-offer state)
      if (this.pc.signalingState !== 'have-local-offer') {
        console.warn(`[WebRTC Engine] _handleAnswer ignored — bad signalingState: ${this.pc.signalingState}`);
        return;
      }
      try {
        await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
        this._flushPendingIceCandidates();
      } catch (err) {
        this.onError(`Failed to set SDP answer: ${err.message}`, 'ERR_HANDLE_ANSWER');
      }
    }

    /**
     * Handle trickled Remote ICE candidate
     */
    async _handleRemoteIceCandidate(candidate) {
      if (!candidate) return;
      const rtcCandidate = new RTCIceCandidate(candidate);

      if (this.pc && this.pc.remoteDescription && this.pc.remoteDescription.type) {
        try {
          await this.pc.addIceCandidate(rtcCandidate);
        } catch (e) {
          console.error('[WebRTC Engine] Error adding ICE candidate', e);
        }
      } else {
        this.pendingIceCandidates.push(rtcCandidate);
      }
    }

    _flushPendingIceCandidates() {
      while (this.pendingIceCandidates.length > 0) {
        const candidate = this.pendingIceCandidates.shift();
        this.pc.addIceCandidate(candidate).catch((e) => console.error(e));
      }
    }

    /**
     * Configure DataChannel events and backpressure thresholds
     */
    _setupDataChannelEvents() {
      if (!this.dataChannel) return;

      this.dataChannel.binaryType = 'arraybuffer';
      this.dataChannel.bufferedAmountLowThreshold = BUFFER_LOW_WATERMARK;

      this.dataChannel.onopen = () => {
        console.log('[WebRTC Engine] DataChannel OPEN');
        this.onStatusChange('P2P DataChannel open. Ready for file transfer! ⚡', 'success');
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
     * Route incoming DataChannel frames (Metadata text vs Binary file chunks)
     */
    _handleDataChannelMessage(data) {
      if (typeof data === 'string') {
        try {
          const msg = JSON.parse(data);

          if (msg.type === 'metadata') {
            this.incomingMeta = msg;
            this.receivedChunks = [];
            this.receivedBytes = 0;
            this.transferStartTime = Date.now();
            this.isTransferring = true;

            this.onStatusChange(`Receiving file "${msg.name}" (${this._formatBytes(msg.size)})…`, 'info');
            this.onFileMetadata(msg);
          } else if (msg.type === 'ack-complete') {
            // Guard: ensure ack-complete is processed only ONCE per transfer on Sender side
            if (this.currentFile || this.isTransferring) {
              const file = this.currentFile;
              this.currentFile = null;
              this.isTransferring = false;
              this.onStatusChange('File transfer verified and acknowledged by receiver! 🎉', 'success');
              const meta = {
                name: file ? file.name : 'File',
                size: file ? file.size : 0,
                isSender: true
              };
              this.onFileComplete(null, meta);
            }
          } else if (msg.type === 'cancel') {
            this.isTransferring = false;
            this.onStatusChange('Transfer cancelled by peer.', 'warning');
            this.onError('Peer cancelled the file transfer.', 'ERR_TRANSFER_CANCELLED');
          }
        } catch (e) {
          console.error('[WebRTC Engine] Failed parsing text frame', e);
        }
      } else if (data instanceof ArrayBuffer) {
        // Binary Chunk Frame (Zero-copy raw ArrayBuffer)
        if (!this.incomingMeta) {
          console.warn('[WebRTC Engine] Received chunk before metadata header');
          return;
        }

        this.receivedChunks.push(data);
        this.receivedBytes += data.byteLength;

        const totalBytes = this.incomingMeta.size;
        const now = Date.now();
        const timeDiff = (now - this.lastProgressTime) / 1000;

        // Calculate instant rolling speed every ~500ms
        if (timeDiff >= 0.5 || this.lastProgressTime === 0) {
          const bytesDiff = this.receivedBytes - this.lastProgressBytes;
          this.currentSpeedBps = timeDiff > 0 ? (bytesDiff / timeDiff) : 0;
          this.lastProgressTime = now;
          this.lastProgressBytes = this.receivedBytes;
        }

        // Throttle UI updates to max once per 100ms (or on final 100% completion)
        const isComplete = this.receivedBytes >= totalBytes;
        if (isComplete || (now - (this._lastRecvUiUpdate || 0)) > 100) {
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

        // Reassembly on complete (Guard: process completion exactly once per file)
        if (this.incomingMeta && this.receivedBytes >= totalBytes) {
          const meta = this.incomingMeta;
          this.incomingMeta = null; // Clear immediately to prevent re-entrancy on extra chunks
          this.isTransferring = false;

          const fileBlob = new Blob(this.receivedChunks, { type: meta.mimeType || 'application/octet-stream' });
          this.receivedChunks = [];
          this.receivedBytes = 0;

          this.onStatusChange(`File "${meta.name}" received successfully!`, 'success');
          this.onFileComplete(fileBlob, meta);

          // Send acknowledgment to sender ONCE
          this._sendControlMessage({ type: 'ack-complete' });
        }
      }
    }

    /**
     * Send file over DataChannel with Chunking and Backpressure Handling
     * @param {File} file 
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
        console.warn('[WebRTC Engine] Transfer already in progress. Ignoring duplicate sendFile call.');
        return;
      }

      this.currentFile = file;
      this.isTransferring = true;
      const chunkSize = DEFAULT_CHUNK_SIZE;
      const totalChunks = Math.ceil(file.size / chunkSize);

      // 1. Send Metadata Header
      const metadata = {
        type: 'metadata',
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        chunkSize: chunkSize,
        totalChunks: totalChunks
      };

      this.onStatusChange(`Starting transfer of "${file.name}" (${this._formatBytes(file.size)})…`, 'info');
      this._sendControlMessage(metadata);

      // 2. Read and Stream Chunks Zero-Copy with Event-Driven Backpressure
      let offset = 0;
      let chunkCount = 0;
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

        try {
          this.dataChannel.send(chunkBuffer);
        } catch (err) {
          this.onError(`Failed to send chunk: ${err.message}`, 'ERR_CHUNK_SEND');
          this.isTransferring = false;
          return;
        }

        offset += chunkBuffer.byteLength;
        chunkCount++;

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

        if (chunkCount % 100 === 0) {
          if (typeof requestAnimationFrame !== 'undefined') {
            await new Promise(r => requestAnimationFrame(r));
          } else {
            await new Promise(r => setTimeout(r, 0));
          }
        }
      }
    }

    /**
     * Wait for bufferedAmountLow event when backpressure high watermark hit.
     * Uses event-driven Promise with a 20ms safety fallback timer to guarantee no stalls.
     */
    _waitForBufferLow() {
      if (!this.dataChannel || this.dataChannel.bufferedAmount <= BUFFER_LOW_WATERMARK) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        let fallbackTimer = null;
        const done = () => {
          if (fallbackTimer) clearTimeout(fallbackTimer);
          if (this.dataChannel) this.dataChannel.onbufferedamountlow = null;
          resolve();
        };
        this.dataChannel.onbufferedamountlow = done;
        fallbackTimer = setTimeout(() => {
          if (!this.dataChannel || this.dataChannel.bufferedAmount <= BUFFER_LOW_WATERMARK) {
            done();
          }
        }, 20);
      });
    }

    /**
     * Cancel active transfer
     */
    cancelTransfer() {
      if (this.dataChannel && this.dataChannel.readyState === 'open') {
        this.isTransferring = false;
        this._sendControlMessage({ type: 'cancel' });
        this.onStatusChange('Transfer cancelled', 'warning');
      }
    }

    /**
     * Handle unexpected peer disconnect during transfer
     */
    _handlePeerDisconnect(reason) {
      if (this.isTransferring) {
        this.isTransferring = false;
        this.onError(`Transfer aborted: ${reason}`, 'ERR_PEER_DISCONNECTED');
      }
    }

    _sendControlMessage(obj) {
      if (this.dataChannel && this.dataChannel.readyState === 'open') {
        this.dataChannel.send(JSON.stringify(obj));
      }
    }

    _sendSignaling(data) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
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

    /**
     * Clean up and close all connection instances
     */
    disconnect() {
      this.isTransferring = false;

      if (this.dataChannel) {
        try { this.dataChannel.close(); } catch (e) {}
        this.dataChannel = null;
      }

      if (this.pc) {
        try { this.pc.close(); } catch (e) {}
        this.pc = null;
      }

      if (this.ws) {
        if (this.ws.readyState === WebSocket.OPEN && this.roomCode) {
          this._sendSignaling({ type: 'leave-room' });
        }
        try { this.ws.close(); } catch (e) {}
        this.ws = null;
      }

      this.roomCode = null;
      this.role = null;
      this.pendingIceCandidates = [];
    }
  }

  // Export to window
  global.FluxWebRTCEngine = FluxWebRTCEngine;
})(typeof window !== 'undefined' ? window : this);
