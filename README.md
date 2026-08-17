# FluxTransfer ⚡

> **Internet-first, browser-based peer-to-peer file transfer**

FluxTransfer uses **PeerJS for signaling** and **WebRTC DataChannels for the actual file transfer**. The transfer code is an **8-digit numeric code** and the data path uses up to **4 independent WebRTC streams in parallel**.

## Current architecture

```text
Sender browser
    │
    │ PeerJS signaling / connection setup
    ▼
PeerJS signaling service
    │
    │ SDP / ICE negotiation only
    ▼
Receiver browser

After connection:

Sender ──┬── WebRTC stream 1 ──┐
         ├── WebRTC stream 2 ──┤
         ├── WebRTC stream 3 ──┼──► Receiver
         └── WebRTC stream 4 ──┘

File bytes do NOT go through PeerJS signaling or the hosting site.
```

## Pairing

1. Sender selects a file and generates an **8-digit numeric code**.
2. Receiver enters the code or scans the QR code.
3. Receiver opens up to four PeerJS connections to the sender using the same code.
4. Receiver sends a stream handshake containing the stream indexes that actually opened.
5. Sender waits for that handshake and transfers only over the agreed streams.

## Transfer protocol

- Transport: WebRTC `RTCDataChannel`
- Signaling: PeerJS
- Parallel streams: up to 4 independent PeerJS/WebRTC connections
- Chunk size: 64 KiB
- Encryption: AES-256-GCM
- Key derivation: PBKDF2-SHA-256 from the 8-digit session code + per-transfer random salt
- Integrity: SHA-256 verification after reconstruction
- Flow control: `bufferedAmount` backpressure
- Pairing: numeric code + QR URL
- No local UDP discovery
- No local HTTP upload/download
- No file-transfer relay/fallback path

## Why four streams?

The implementation uses four independent WebRTC data connections rather than relying on PeerJS internals to create hidden extra `RTCDataChannel`s. Each stream gets a disjoint subset of file chunks, while every frame contains its original chunk index, so the receiver can reassemble chunks in any arrival order.

The number of usable streams is negotiated at connection time. If a network/device can only establish fewer than four, the transfer proceeds with the streams that successfully opened instead of remaining stuck waiting for a fixed channel count.

Parallel streams can improve throughput on some networks, but WebRTC performance is still bounded by the device, browser, Wi-Fi/mobile network, NAT path, and congestion control.

## Deployment

The app is static and can be deployed to Netlify, Vercel, GitHub Pages, or any HTTPS static host.

```bash
npm install
npm run dev
```

For production, serve `src/client` over HTTPS. Web Crypto and WebRTC features should be tested in the actual target browsers/devices.

## Important network note

The signaling service is not a file-storage service. It is used to establish the peer connection. Direct peer-to-peer connectivity depends on the network path. Difficult NAT/firewall environments may require a TURN service to achieve reliable connectivity.
