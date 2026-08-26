# FluxTransfer ⚡

> **Direct. Secure. Swift. Internet-first peer-to-peer file transfer.**

FluxTransfer uses **Native WebRTC DataChannels for direct P2P file transfer** and a **Custom WebSocket Server for signaling**. No file data passes through the signaling server or any third-party relay.

## Architecture

```text
Sender Browser                           Receiver Browser
     │                                           │
     ├────────── WebSocket Signaling ───────────┤ (SDP & ICE Candidates only)
     │         (signaling-server.js)             │
     │                                           │
     ▼                                           ▼
┌────────────────────────────────────────────────────────┐
│      Direct WebRTC RTCDataChannel (E2EE Encrypted)     │
└────────────────────────────────────────────────────────┘
```

## Core Technical Features

- **Transport**: Native WebRTC `RTCPeerConnection` & `RTCDataChannel` with custom STUN/TURN fallback configuration.
- **Signaling**: Lightweight unified WebSocket server (`src/server/signaling-server.js`) with message size limits (16 KB), JSON schema validation, per-IP rate limiting, and automatic stale room cleanup.
- **End-to-End Encryption (E2EE)**: Application-level authenticated keystream encryption. Each 64 KiB chunk is encrypted using a unique 12-byte cryptographically random IV/nonce and accompanied by a 16-byte authentication tag for tamper resistance.
- **Key Derivation**: PBKDF2 with 100,000 iterations and a 16-byte cryptographically random salt derived from the pairing code.
- **Receiver Stream Assembly**: Decrypted chunks are streamed directly into memory with ordered index assembly and integrity checks, preventing memory bloat during transfer.
- **Integrity Verification**: Full SHA-256 cryptographic verification over reassembled file bytes prior to completion acknowledgment.
- **Flow Control & Backpressure**: Event-driven `RTCDataChannel.bufferedAmount` backpressure with high (`BUFFER_HIGH_WATERMARK`) and low (`BUFFER_LOW_WATERMARK`) thresholds.
- **Session Security**: Pair codes are generated via `window.crypto.getRandomValues()`. No secrets, keys, or plaintext data are logged or sent over signaling.

## Getting Started

### Development

```bash
# Start both signaling server (port 8080) and Vite React client (port 3000)
npm run dev
```

Visit `http://localhost:3000` in your browser.

### Production Build & Start

```bash
# Build the React application
npm run build

# Start the unified production server (serves dist/ on port 8080)
npm start
```

### Automated Test Suites

```bash
# Run all test suites
npm test

# Or run test suites individually:
node src/server/test-signaling.js
node src/server/test-transfer-flow.js
node src/server/test-security.js
```

## Security & Privacy

- **Zero Server Uploads**: Files move strictly peer-to-peer over WebRTC.
- **Cryptographic Nonce Uniqueness**: IVs are never reused across chunks.
- **Tamper Resistance**: Any modified chunk payload fails tag validation and is rejected immediately.
- **Integrity Guarantee**: Mismatched SHA-256 checksums cause immediate transfer rejection and cleanup.
- **Zero Secret Leakage**: Encryption keys, PINs, and plaintext chunks are never logged to console or sent across signaling.
