# FluxTransfer — TURN Server Setup & Configuration Guide 🌐

This guide explains how and why to set up a **TURN (Traversal Using Relays around NAT)** server for FluxTransfer WebRTC transfers when direct STUN hole-punching fails due to restrictive NATs or firewalls.

---

## 1. Why is TURN Required?

WebRTC uses **STUN (Session Traversal Utilities for NAT)** to discover public IP addresses and ports for direct Peer-to-Peer (P2P) connections. STUN works for ~80–85% of network setups (Full Cone, Address-Restricted, Port-Restricted NATs).

However, direct P2P connection fails when one or both peers are behind:
- **Symmetric NATs** (common in corporate networks, university Wi-Fi, and 4G/5G cellular CGNAT)
- **Strict Firewalls** blocking non-standard UDP ports

In these situations, WebRTC requires a **TURN server** to relay encrypted media/data packets between peers over standard ports (`80` or `443`).

```text
Direct STUN Path (P2P):
Peer A (Sender) ◄──────────────────────────────► Peer B (Receiver)

TURN Relay Path (Fallback):
Peer A (Sender) ◄─────► TURN Relay Server ◄─────► Peer B (Receiver)
```

---

## 2. Option A: Self-Hosted Coturn (Recommended for Self-Hosters)

Coturn is an open-source, high-performance TURN/STUN server for Linux.

### Installation

#### On Ubuntu / Debian:
```bash
sudo apt update
sudo apt install coturn -y
```

#### Via Docker:
```bash
docker run -d --name coturn \
  --net=host \
  coturn/coturn \
  -n --log-file=stdout \
  --min-port=49152 --max-port=65535 \
  --realm=turn.yourdomain.com \
  --user=fluxuser:fluxpassword123
```

### `/etc/turnserver.conf` Configuration Example

```ini
# Enable Coturn service
listening-port=3478
tls-listening-port=5349

# IP & Realm setup
listening-ip=0.0.0.0
external-ip=YOUR_PUBLIC_SERVER_IP
realm=turn.yourdomain.com

# Authentication (Static user credentials)
lt-cred-mech
user=fluxuser:fluxpassword123

# Dynamic Auth (Optional - REST API secret for temporary credentials)
# use-auth-secret
# static-auth-secret=your_secret_key_here

# TLS / TURNS Certificates (Required for secure WSS/HTTPS contexts)
cert=/etc/letsencrypt/live/turn.yourdomain.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.yourdomain.com/privkey.pem

# Security & Performance
fingerprint
secure-stun
no-multicast-peers
no-cli
```

### Enable Coturn as a background daemon
In `/etc/default/coturn`:
```bash
TURNSERVER_ENABLED=1
```
Start service:
```bash
sudo systemctl restart coturn
```

---

## 3. Option B: Managed TURN Services (SaaS)

If you do not want to manage Coturn server bandwidth and infrastructure, use a managed TURN provider:

### 1. Metered.ca (Free 50GB / Month)
1. Sign up at [metered.ca/webrtc](https://www.metered.ca/webrtc).
2. Obtain your free TURN server credentials from dashboard.

### 2. Twilio Network Traversal
1. Sign up at [Twilio](https://www.twilio.com/).
2. Use Twilio's Network Traversal API to request ephemeral TURN credentials.

### 3. Xirsys Cloud
1. Sign up at [Xirsys](https://xirsys.com/).
2. Retrieve ICE server array via their REST API.

---

## 4. Integrating TURN Credentials into FluxTransfer Client

In `src/client/webrtc-engine.js` or when instantiating `FluxWebRTCEngine`, pass your custom `iceServers` array:

```javascript
const customIceServers = [
  // Standard STUN servers (for direct P2P when possible)
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },

  // Self-Hosted / Managed TURN servers (UDP & TCP Fallbacks)
  {
    urls: [
      'turn:turn.yourdomain.com:3478?transport=udp',
      'turn:turn.yourdomain.com:3478?transport=tcp',
      'turns:turn.yourdomain.com:443?transport=tcp'
    ],
    username: 'fluxuser',
    credential: 'fluxpassword123'
  }
];

// Initialize FluxWebRTCEngine with TURN fallback enabled
const engine = new FluxWebRTCEngine({
  signalingUrl: 'ws://your-signaling-server.com:8080',
  iceServers: customIceServers,
  onStatusChange: (text, type) => console.log(`[Status] ${text}`),
  onError: (err, code) => console.error(`[Error ${code}] ${err}`)
});
```

---

## 5. Verification & Testing

To test if your TURN server is functioning properly:
1. Open the [Trickle ICE Test Tool](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/).
2. Add your TURN URI (`turn:turn.yourdomain.com:3478`), Username, and Password.
3. Click **Gather candidates**.
4. Verify that candidate type `relay` appears in the results table. If `relay` candidates are generated, your TURN server is working correctly!
