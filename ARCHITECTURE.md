# FluxTransfer Architecture Documentation

FluxTransfer is an internet-first, browser-based peer-to-peer (P2P) file transfer application built with React, WebRTC DataChannel, WebSocket signaling, AES-256-GCM encryption, SHA-256 integrity verification, Web Workers, and OPFS storage.

---

## 1. System Layer Flow

```
React Frontend (TransferDashboard / useFluxTransfer)
  ↓
Transfer Controller / Engine (FluxWebRTCEngine)
  ↓                                  ↓
Signaling Client (WebSocket)      WebRTC PeerConnection (ICE / SDP)
                                     ↓
                                  DataChannel (Encrypted Stream)
                                     ↓
                                  CryptoService (AES-256-GCM)
                                     ↓
                                  Chunk Transport & Backpressure
                                     ↓
                                  HashService (SHA-256 Checksum)
                                     ↓
                                  ReceiverStorage (OPFS / Memory)
```

---

## 2. Component Ownership Matrix

| Subsystem Component | Responsible Module | Ownership & Scope Description |
| :--- | :--- | :--- |
| **Transfer Lifecycle State** | `FluxWebRTCEngine._setState` | Authoritative single source of truth for transfer state (`idle`, `connecting`, `connected`, `transferring`, `completed`, `failed`, `cancelled`). React hook `useFluxTransfer` subscribes to `stateChange` events. |
| **Connection & Cleanup** | `FluxWebRTCEngine.disconnect` / `cancelTransfer` | Idempotent cleanup manager ensuring DataChannel, PeerConnection, WebSocket, and Storage teardowns are non-destructive and re-entrant safe without overwriting `completed` states or firing duplicate errors. |
| **Receiver Storage** | `ReceiverStorage` (`OPFSStorage` / `MemoryStorage`) | Manages disk streaming via `FileSystemSyncAccessHandle` worker (`/opfs-writer-worker.js`) or safe in-memory fallback (enforcing a 300MB limit on non-OPFS browsers). |
| **WebSocket Signaling** | `signaling-server.js` & `FluxWebRTCEngine` | Handles room creation, 6-digit numeric pairing, SDP offer/answer relay, and ICE candidate exchange. Zero file payload or key material passes through signaling. |
| **End-to-End Encryption** | `CryptoService` (`crypto-service.js`) | Derives 256-bit AES-GCM keys from pairing PIN + 16-byte salt via PBKDF2 (100,000 iterations). Encrypts chunks with unique 12-byte IVs and authenticated tag verification. |
| **Integrity Checksum** | `HashService` (`hash-service.js`) | Calculates streaming SHA-256 hashes off-main-thread via `/hash-worker.js` for sender metadata pre-computation and receiver post-assembly verification. |
| **Configuration** | `APP_CONFIG` (`app-config.js`) | Centralized configuration layer for STUN/TURN servers, buffer watermarks (4MB/1MB), chunk sizes (64KB), memory fallback limits, and worker path resolution. |

---

## 3. Supported Deployment Modes

1. **Unified Server Mode (Standard Node.js)**
   - `signaling-server.js` serves static bundled frontend assets from `dist/` and handles WebSocket upgrades on a single HTTP/WS port.
   - Compatible with Render, Railway, Fly.io, Heroku, or direct Node.js VPS deployment.

2. **Decoupled Frontend / Backend Mode**
   - Static client built via Vite (`dist/`) hosted on Vercel, Netlify, Cloudflare Pages, or AWS S3.
   - External WebSocket signaling server configured via `VITE_SIGNALING_URL`.
