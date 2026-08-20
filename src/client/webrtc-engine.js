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

  const DEFAULT_CHUNK_SIZE = 64 * 1024; // 64 KB
  const BUFFER_HIGH_WATERMARK = 1024 * 1024; // 1 MB
  const BUFFER_LOW_WATERMARK = 256 * 1024; // 256 KB
  const SIGNALING_TIMEOUT_MS = 30000; // 30 seconds

  const DEFAULT_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' }
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
     * @param {Function} [config.onPeerJoined] - () => void
     * @param {Function} [config.onPeerLeft] - () => void
     */
    constructor(config = {}) {
      this.signalingUrl = config.signalingUrl || (window.location.protocol === 'https:' ? `wss://${window.location.host}` : `ws://${window.location.hostname}:8080`);
      this.iceServers = config.iceServers || DEFAULT_ICE_SERVERS;

      // Event Callbacks
      this.onStatusChange = config.onStatusChange || (() => {});
      this.onProgress = config.onProgress || (() => {});
      this.onFileMetadata = config.onFileMetadata || (() => {});
      this.onFileComplete = config.onFileComplete || (() => {});
      this.onError = config.onError || (() => {});
      this.onPeerJoined = config.onPeerJoined || (() => {});
      this.onPeerLeft = config.onPeerLeft || (() => {});

      // Internal State
      this.ws = null;
      this.pc = null;
      this.dataChannel = null;
      this.roomCode = null;
      this.role = null; // 'initiator' | 'joiner'
      this.isTransferring = false;
      this.pendingIceCandidates = [];
      this.signalingTimer = null;

      // Receiver state
      this.incomingMeta = null;
      this.receivedChunks = [];
      this.receivedBytes = 0;
      this.transferStartTime = 0;

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

      // Setup signaling connection timeout
      this.signalingTimer = setTimeout(() => {
        if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
          this.onStatusChange('Signaling timed out waiting for peer', 'warning');
          this.onError('Signaling timeout: Peer did not respond within 30 seconds.', 'ERR_SIGNALING_TIMEOUT');
        }
      }, SIGNALING_TIMEOUT_MS);

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
            this._initiatePeerConnection();
          }
          break;

        case 'peer-joined':
          this.onStatusChange('Peer connected! Negotiating P2P WebRTC link…', 'info');
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

      // Relay ICE candidates to peer via signaling server
      this.pc.onicecandidate = (event) => {
        if (event.candidate) {
          this._sendSignaling({ type: 'ice-candidate', candidate: event.candidate });
        }
      };

      // Handle ICE Connection State changes
      this.pc.oniceconnectionstatechange = () => {
        const state = this.pc.iceConnectionState;
        console.log(`[WebRTC Engine] ICE State: ${state}`);

        if (state === 'connected' || state === 'completed') {
          this.onStatusChange('P2P Direct Connection Established! ⚡', 'success');
          if (this.signalingTimer) clearTimeout(this.signalingTimer);
        } else if (state === 'failed') {
          this.onStatusChange('Direct P2P connection failed', 'error');
          this.onError(
            'WebRTC connection failed. Direct STUN hole-punching was unsuccessful due to restrictive/symmetric NAT. Consider configuring a TURN relay server.',
            'ERR_ICE_FAILED'
          );
        } else if (state === 'disconnected') {
          this.onStatusChange('P2P connection interrupted', 'warning');
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
     * Initiator starts offer negotiation
     */
    async _initiatePeerConnection() {
      this._createPeerConnection();

      // Create DataChannel (Initiator creates channel)
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

    /**
     * Handle incoming SDP Offer (Receiver)
     */
    async _handleOffer(offer) {
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
        this.onStatusChange('P2P DataChannel open. Ready for file transfer!', 'success');
      };

      this.dataChannel.onclose = () => {
        console.log('[WebRTC Engine] DataChannel CLOSED');
        if (this.isTransferring) {
          this._handlePeerDisconnect('DataChannel closed unexpectedly during file transfer.');
        }
      };

      this.dataChannel.onerror = (err) => {
        console.error('[WebRTC Engine] DataChannel Error:', err);
        this.onError('P2P DataChannel error encountered.', 'ERR_DATACHANNEL');
      };

      this.dataChannel.onmessage = (event) => {
        this._handleDataChannelMessage(event.data);
      };

      // Backpressure handler for sender
      this.dataChannel.onbufferedamountlow = () => {
        if (this.isPausedForBackpressure) {
          this.isPausedForBackpressure = false;
          console.log('[WebRTC Engine] Backpressure relieved (bufferedAmount lowered). Resuming stream…');
        }
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
            this.isTransferring = false;
            this.onStatusChange('File transfer verified and acknowledged by receiver! 🎉', 'success');
          } else if (msg.type === 'cancel') {
            this.isTransferring = false;
            this.onStatusChange('Transfer cancelled by peer.', 'warning');
            this.onError('Peer cancelled the file transfer.', 'ERR_TRANSFER_CANCELLED');
          }
        } catch (e) {
          console.error('[WebRTC Engine] Failed parsing text frame', e);
        }
      } else if (data instanceof ArrayBuffer) {
        // Binary Chunk Frame
        if (!this.incomingMeta) {
          console.warn('[WebRTC Engine] Received chunk before metadata header');
          return;
        }

        this.receivedChunks.push(data);
        this.receivedBytes += data.byteLength;

        const totalBytes = this.incomingMeta.size;
        const percent = Math.min(100, (this.receivedBytes / totalBytes) * 100);
        const elapsedSec = (Date.now() - this.transferStartTime) / 1000 || 0.001;
        const speedBps = this.receivedBytes / elapsedSec;

        this.onProgress({
          percent: percent.toFixed(1),
          transferredBytes: this.receivedBytes,
          totalBytes: totalBytes,
          speedBps: speedBps,
          role: 'receiver'
        });

        // Reassembly on complete
        if (this.receivedBytes >= totalBytes) {
          this.isTransferring = false;
          const fileBlob = new Blob(this.receivedChunks, { type: this.incomingMeta.mimeType || 'application/octet-stream' });
          this.onStatusChange(`File "${this.incomingMeta.name}" received successfully!`, 'success');
          this.onFileComplete(fileBlob, this.incomingMeta);

          // Send acknowledgment to sender
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

      // 2. Read and Stream Chunks with Backpressure
      let offset = 0;
      const startTime = Date.now();

      while (offset < file.size && this.isTransferring) {
        // Backpressure Control: check channel buffer size
        if (this.dataChannel.bufferedAmount > BUFFER_HIGH_WATERMARK) {
          this.isPausedForBackpressure = true;
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

        const percent = Math.min(100, (offset / file.size) * 100);
        const elapsedSec = (Date.now() - startTime) / 1000 || 0.001;
        const speedBps = offset / elapsedSec;

        this.onProgress({
          percent: percent.toFixed(1),
          transferredBytes: offset,
          totalBytes: file.size,
          speedBps: speedBps,
          role: 'sender'
        });
      }
    }

    /**
     * Wait for bufferedAmountLow event when backpressure high watermark hit
     */
    _waitForBufferLow() {
      return new Promise((resolve) => {
        const check = () => {
          if (!this.dataChannel || this.dataChannel.bufferedAmount <= BUFFER_LOW_WATERMARK) {
            resolve();
          } else {
            setTimeout(check, 50);
          }
        };
        check();
      });
    }

    /**
     * Cancel active transfer
     */
    cancelTransfer() {
      if (this.isTransferring) {
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
      if (this.signalingTimer) clearTimeout(this.signalingTimer);
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
