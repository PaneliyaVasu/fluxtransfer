# FluxTransfer ⚡

> **Direct. Secure. Swift. Internet-first peer-to-peer file transfer.**

FluxTransfer uses **Native WebRTC DataChannels for P2P file transfer** and a **Custom WebSocket Server for signaling**. No file data passes through the signaling server or any third-party relay.

## Architecture

```text
Sender Browser                           Receiver Browser
     │                                           │
     ├────────── WebSocket Signaling ───────────┤ (SDP & ICE Candidates only)
     │         (signaling-server.js)             │
     │                                           │
     ▼                                           ▼
┌────────────────────────────────────────────────────────┐
│  Direct WebRTC RTCDataChannel (AES-256-GCM Encrypted)  │
└────────────────────────────────────────────────────────┘
```

## Core Technical Features

- **Transport**: Native WebRTC `RTCPeerConnection` & `RTCDataChannel` with custom STUN/TURN configuration.
- **Signaling**: Lightweight unified WebSocket server (`src/server/signaling-server.js`) with message size limits (16 KB), JSON schema validation, per-IP rate limiting, and automatic stale room cleanup.
- **End-to-End Encryption (E2EE)**: Application-level AES-256-GCM encryption. Each chunk is encrypted using a unique 12-byte cryptographically random IV/nonce (`crypto.getRandomValues`).
- **Key Derivation**: PBKDF2 with 100,000 iterations and a 16-byte cryptographically random salt derived from the pairing code.
- **Receiver Memory Safety**: Receiver streams decrypted chunks directly to **Origin Private File System (OPFS)** via `opfs-writer-worker.js` (`FileSystemSyncAccessHandle`), avoiding RAM accumulation and preventing Safari/iOS crashes. (Falls back to RAM stream for legacy browsers).
- **Integrity Verification**: Off-main-thread SHA-256 windowed Merkle hashing via `hash-worker.js`. File transfers are only marked complete after full hash verification.
- **Flow Control & Backpressure**: Event-driven `RTCDataChannel.bufferedAmount` backpressure with hard low-watermark thresholds (`BUFFER_LOW_WATERMARK`).
- **Session Security**: Pair codes are generated via `window.crypto.getRandomValues()`. No secrets, keys, or plaintext data are logged or sent over signaling.

## Getting Started

### Development

```bash
# Start unified HTTP static + WebSocket signaling server on port 8080
npm start
```

Visit `http://localhost:8080` in your browser.

### Test Suites

```bash
# Run signaling server automated tests
node src/server/test-signaling.js

# Run complete transfer flow test suite
node src/server/test-transfer-flow.js

# Run security verification test suite
node src/server/test-security.js
```

## Security & Privacy

- **Zero Server Uploads**: Files move strictly peer-to-peer.
- **Cryptographic Nonce Uniqueness**: AES-GCM IVs are never reused across chunks.
- **Integrity Guarantee**: Tampered ciphertext or mismatched SHA-256 checksums cause immediate transfer rejection and cleanup.
- **Zero Secret Leakage**: Encryption keys and plaintext chunks are never logged to console or sent across signaling.

