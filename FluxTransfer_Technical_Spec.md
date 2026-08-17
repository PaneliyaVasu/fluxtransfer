# FluxTransfer Protocol
### A Cross-Platform, Zero-Setup, High-Speed Wireless Data Transfer Protocol
**Technical Specification v0.1 (Concept Draft)**

---

## 1. Overview

**FluxTransfer** is a proposed wireless file transfer protocol designed to move data directly between devices — regardless of operating system — at the highest speed the underlying radio hardware allows, without requiring app installs, accounts, or cloud relays.

### 1.1 Problem Statement

Existing transfer methods each solve part of the problem but not all of it:

| Method | Cross-Platform | No Setup | No Cloud Round-Trip | High Speed |
|---|---|---|---|---|
| AirDrop | No (Apple only) | Yes | Yes | Yes |
| Nearby Share | No (Android only) | Yes | Yes | Yes |
| Cloud Storage (Drive/Dropbox) | Yes | No (account needed) | No | No |
| Bluetooth | Yes | Yes | Yes | No |
| LocalSend / Send Anywhere | Yes | No (app install) | Yes | Partial |

FluxTransfer targets the empty cell in this table: **cross-platform + no setup + no cloud + high speed, simultaneously.**

### 1.2 Design Goals

1. Discovery in under 2 seconds
2. Connection establishment in a single round trip
3. Saturate available wireless bandwidth using parallel streams
4. Resilient to packet loss without stalling
5. End-to-end encrypted, no data touches a third-party server
6. Works from any browser or OS with zero installation

---

## 2. System Architecture

FluxTransfer is organized into five layers, each targeting a specific bottleneck in traditional transfer tools.

```
┌─────────────────────────────────────┐
│   5. Security Layer (E2E encryption) │
├─────────────────────────────────────┤
│   4. Compression Layer (adaptive)    │
├─────────────────────────────────────┤
│   3. Transport Layer (QUIC, multi-   │
│      stream, FEC)                    │
├─────────────────────────────────────┤
│   2. Connection Layer (key exchange, │
│      channel negotiation)            │
├─────────────────────────────────────┤
│   1. Discovery Layer (BLE + Wi-Fi    │
│      Aware / Wi-Fi Direct)           │
└─────────────────────────────────────┘
```

---

## 3. Layer 1 — Discovery

**Goal:** Find nearby devices in under 2 seconds without draining battery.

- Devices emit a low-power **BLE advertisement packet** (~every 100ms) containing a device ID, capability flags, and signal strength.
- On detection, both devices negotiate the best shared channel in this priority order:
 1. Wi-Fi Aware / Wi-Fi Direct (highest throughput, no router needed)
 2. Shared local Wi-Fi network (if both already connected to the same AP)
 3. Ultra-Wideband (UWB), where supported — high bandwidth, very short range
 4. Bluetooth 5.x (fallback, small files only, capped at low speed)

**Design note:** BLE is used only for discovery, never for the actual transfer — this avoids the classic mistake of using a low-bandwidth radio for bulk data.

---

## 4. Layer 2 — Connection Setup

**Goal:** Eliminate the multi-round-trip handshake delay common in TCP + TLS.

- Uses **QUIC** (the transport protocol behind HTTP/3) instead of raw TCP.
- QUIC combines connection establishment and encryption negotiation into a **single round trip**, versus the 3–4 round trips typical of TCP + TLS 1.2/1.3.
- An ephemeral key pair is generated locally on each device at the moment of discovery — no pre-existing account, certificate authority, or server is involved.

---

## 5. Layer 3 — Transport

**Goal:** Use as much of the available physical bandwidth as possible, and stay resilient to wireless interference.

### 5.1 Parallel Streaming
Rather than sending data as one continuous stream, the file is split into multiple independent QUIC streams sent in parallel. A single TCP-style stream rarely saturates real-world Wi-Fi throughput; parallel streams better utilize the channel, similar to how multi-threaded download managers outperform single-threaded ones.

### 5.2 Adaptive Chunk Sizing
- Stable connection → larger chunks (lower overhead per byte)
- Unstable/noisy connection → smaller chunks (cheaper to retransmit)
- The protocol continuously measures packet loss and RTT, adjusting chunk size in real time.

### 5.3 Forward Error Correction (FEC)
A small amount of redundant data is transmitted alongside the original data. If a small percentage of packets are lost (common on Wi-Fi due to interference), the receiver can reconstruct the missing pieces from the redundancy **without a retransmission round trip** — this avoids the classic "stall and wait" behavior of standard TCP retransmission.

---

## 6. Layer 4 — Compression

**Goal:** Reduce bytes actually transmitted, without wasting CPU on data that won't compress.

- **Content-aware compression:** text, documents, and uncompressed formats are compressed aggressively; already-compressed formats (JPEG, MP4, ZIP) are passed through raw, since attempting to recompress them wastes CPU time for negligible size reduction.
- **Delta transfer (optional):** if the receiving device already holds a previous version of a file, only the changed bytes are transmitted, similar to how version control systems or sync tools like rsync operate.

---

## 7. Layer 5 — Security

**Goal:** Full end-to-end encryption without slowing down the transfer.

- Cipher: **ChaCha20-Poly1305** — chosen over AES-GCM because it performs faster on devices without dedicated AES hardware acceleration (common on budget Android devices and IoT hardware).
- Keys are ephemeral and generated per-session; nothing is stored server-side because there is no server in the data path — only a discovery/rendezvous step, and even that can occur peer-to-peer.
- No account, login, or persistent identity is required to use the protocol.

---

## 8. Estimated Performance

| Scenario | Estimated Throughput | Time for 10GB |
|---|---|---|
| Same Wi-Fi 6 network | 600–900 Mbps | ~1.5–2 min |
| Wi-Fi Direct, close range | 400–700 Mbps | ~2–3 min |
| UWB (supported devices) | 1 Gbps+ | ~80–90 sec |
| Bluetooth fallback only | ~2 Mbps | Not recommended; protocol should force an upgrade path |

These figures assume the protocol removes software-level inefficiencies (slow handshakes, single-stream transfer, cloud round-trips) — the radios in modern phones and laptops are already capable of these speeds; most existing tools simply don't use them efficiently.

---

## 9. Comparison to Existing Protocols

| Feature | AirDrop | Nearby Share | FluxTransfer (proposed) |
|---|---|---|---|
| Cross-platform | No | No | Yes |
| Zero install | Yes (Apple devices) | Yes (Android devices) | Yes (browser-based) |
| Parallel streaming | Unknown/limited | Unknown/limited | Yes |
| FEC for loss resilience | No | No | Yes |
| Delta transfer | No | No | Yes (optional) |
| Open cross-platform standard | No | No | Yes (proposed) |

---

## 10. Practical Browser Prototype Implementation

The current prototype implements the **internet-only WebRTC architecture**:

- **Signaling Layer**: PeerJS is used only to exchange the information required to establish WebRTC peer connections.
- **Pairing**: The sender generates an **8-digit numeric code** and a QR URL containing `?code=12345678`.
- **Parallel Transport**: The receiver opens up to **4 independent PeerJS/WebRTC data connections**. A handshake tells the sender which stream indexes successfully opened.
- **Chunking**: Files are encrypted and divided into 64 KiB frames. Each frame carries a chunk index so the receiver can reassemble data arriving concurrently across streams.
- **Flow Control**: Each data channel uses `bufferedAmount` backpressure to avoid unbounded buffering.
- **Security**: AES-256-GCM encryption uses a per-transfer random salt and a key derived from the numeric session code with PBKDF2-SHA-256.
- **Integrity**: The receiver reconstructs the file and verifies the SHA-256 hash before acknowledging completion.
- **Removed paths**: UDP discovery, local HTTP transfer, local-server staging, and insecure transfer fallbacks are not part of this build.

## 11. Open Questions / Future Work

- How to standardize the discovery layer across manufacturers who currently keep protocols proprietary (Apple/AirDrop, Google/Nearby Share).
- Battery impact of continuous BLE broadcasting on mobile devices.
- Fallback behavior when only Bluetooth is available (small-file mode vs. refusal).
- Multi-device (one-to-many) broadcast transfer mode.

---

*This document is a conceptual technical specification, not an implemented or certified protocol.*
