/**
 * FluxTransfer — Unified Server (Static Files + WebRTC Signaling)
 *
 * Serves compiled production client files AND WebSocket signaling on ONE port.
 * Static files: GET /  → serves dist/
 * Signaling:    WS /   → WebSocket upgrade
 *
 * ZERO file data passes through this server.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const distDir = path.join(__dirname, '..', '..', 'dist');
const STATIC_DIR = distDir;
const ROOM_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes of inactivity before signaling cleanup

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:8080',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:8080'
];

function getAllowedOrigins() {
  if (process.env.ALLOWED_ORIGINS) {
    return process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean);
  }
  return DEFAULT_ALLOWED_ORIGINS;
}

function isOriginAllowed(originHeader) {
  if (!originHeader) return true; // Non-browser clients or local tests without Origin header
  const allowed = getAllowedOrigins();
  const cleanOrigin = originHeader.trim().replace(/\/$/, '');
  return allowed.some(allowedOrigin => allowedOrigin.replace(/\/$/, '') === cleanOrigin);
}

// ─── Client IP Extraction (Direct vs Trusted Proxy) ─────────────────────────
function getClientIp(req) {
  const trustProxy = process.env.TRUST_PROXY === 'true';
  if (trustProxy && req && req.headers && req.headers['x-forwarded-for']) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      const clientIp = forwarded.split(',')[0].trim();
      if (clientIp) return clientIp;
    }
  }
  return (req && req.socket && req.socket.remoteAddress) || '127.0.0.1';
}

// ─── MIME Types ───────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain',
  '.xml': 'text/xml'
};

function getSecurityHeaders(contentType, extra = {}) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...extra
  };
}

function serveStatic(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  let reqPath = req.url.split('?')[0].split('#')[0];

  if (reqPath.endsWith('/') && reqPath !== '/') {
    reqPath += 'index.html';
  }
  if (reqPath === '/') {
    reqPath = '/index.html';
  }

  const filePath = path.join(STATIC_DIR, reqPath);

  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403, getSecurityHeaders('text/plain'));
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err) {
      const fallback = path.join(STATIC_DIR, 'index.html');
      fs.readFile(fallback, (e, data) => {
        if (e) {
          res.writeHead(404, getSecurityHeaders('text/plain'));
          res.end('Not found');
          return;
        }
        res.writeHead(200, getSecurityHeaders('text/html', { 'Content-Length': data.length }));
        res.end(data);
      });
      return;
    }

    if (stat.isDirectory()) {
      const dirIndex = path.join(filePath, 'index.html');
      fs.readFile(dirIndex, (e, data) => {
        if (e) {
          const fallback = path.join(STATIC_DIR, 'index.html');
          fs.readFile(fallback, (errFallback, fallbackData) => {
            if (errFallback) {
              res.writeHead(404, getSecurityHeaders('text/plain'));
              res.end('Not found');
              return;
            }
            res.writeHead(200, getSecurityHeaders('text/html', { 'Content-Length': fallbackData.length }));
            res.end(fallbackData);
          });
          return;
        }
        res.writeHead(200, getSecurityHeaders('text/html', { 'Content-Length': data.length }));
        res.end(data);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const headers = getSecurityHeaders(contentType, { 'Content-Length': stat.size });

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/api/health') {
    const healthData = JSON.stringify({
      status: 'ok',
      service: 'FluxTransfer Signaling Server',
      activeRooms: rooms.size,
      connectedClients: wss.clients.size
    });
    res.writeHead(200, getSecurityHeaders('application/json', {
      'Access-Control-Allow-Origin': '*',
      'Content-Length': Buffer.byteLength(healthData)
    }));
    res.end(healthData);
    return;
  }

  serveStatic(req, res);
});

// ─── Room Store & Security Configuration ─────────────────────────────────────
// Map<roomCode, { peers: Set<WebSocket>, roles: Map<peerToken, role>, lastActivityTime: number }>
const rooms = new Map();

const MAX_MESSAGE_SIZE_BYTES = 16 * 1024; // 16 KB max message payload
const IP_JOIN_LIMIT_PER_MIN = 30; // Max 30 room joins per IP per minute
const SOCKET_MSG_LIMIT_PER_MIN = 120; // Max 120 messages per minute per socket
const ipRateLimits = new Map(); // Map<ip, { count, resetTime }>

function checkIpRateLimit(ip) {
  const now = Date.now();
  const entry = ipRateLimits.get(ip) || { count: 0, resetTime: now + 60000 };
  if (now > entry.resetTime) {
    entry.count = 1;
    entry.resetTime = now + 60000;
  } else {
    entry.count++;
  }
  ipRateLimits.set(ip, entry);
  return entry.count <= IP_JOIN_LIMIT_PER_MIN;
}

function cleanupExpiredIpRateLimits(now = Date.now()) {
  let cleanedCount = 0;
  for (const [ip, entry] of ipRateLimits.entries()) {
    if (now > entry.resetTime) {
      ipRateLimits.delete(ip);
      cleanedCount++;
    }
  }
  return cleanedCount;
}

function touchRoomActivity(roomCode) {
  const roomData = rooms.get(roomCode);
  if (roomData) {
    roomData.lastActivityTime = Date.now();
  }
}

// ─── WebSocket Server ────────────────────────────────────────────────────────
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_MESSAGE_SIZE_BYTES
});

server.on('upgrade', (request, socket, head) => {
  const origin = request.headers.origin;

  if (!isOriginAllowed(origin)) {
    console.warn(`[Signaling Server] Rejected WebSocket upgrade request from unauthorized Origin: ${origin}`);
    socket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nForbidden: Unauthorized Origin');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function relayToPeer(roomCode, senderWs, data) {
  const roomData = rooms.get(roomCode);
  if (!roomData) return;
  for (const client of roomData.peers) {
    if (client !== senderWs && client.readyState === WebSocket.OPEN) {
      send(client, data);
    }
  }
}

function leaveRoom(ws) {
  if (!ws.roomCode) return;

  const roomCode = ws.roomCode;
  const roomData = rooms.get(roomCode);

  if (roomData) {
    roomData.peers.delete(ws);
    relayToPeer(roomCode, ws, { type: 'peer-left' });
    touchRoomActivity(roomCode);

    if (roomData.peers.size === 0) {
      rooms.delete(roomCode);
    }
  }

  ws.roomCode = null;
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.roomCode = null;
  ws.peerToken = null;
  ws.msgCount = 0;
  ws.msgResetTime = Date.now() + 60000;
  const clientIp = getClientIp(req);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (rawMessage) => {
    if (Buffer.byteLength(rawMessage) > MAX_MESSAGE_SIZE_BYTES) {
      send(ws, { type: 'error', message: 'Payload size limit exceeded' });
      return;
    }

    const now = Date.now();
    if (now > ws.msgResetTime) {
      ws.msgCount = 1;
      ws.msgResetTime = now + 60000;
    } else {
      ws.msgCount++;
      if (ws.msgCount > SOCKET_MSG_LIMIT_PER_MIN) {
        send(ws, { type: 'error', message: 'Rate limit exceeded. Please slow down.' });
        return;
      }
    }

    try {
      const message = JSON.parse(rawMessage.toString());
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
        send(ws, { type: 'error', message: 'Invalid payload structure' });
        return;
      }

      const { type, room, peerToken: msgPeerToken, offer, answer, candidate } = message;

      switch (type) {
        case 'join-room': {
          if (!room || typeof room !== 'string' || !/^[a-zA-Z0-9_-]{4,64}$/.test(room.trim())) {
            send(ws, { type: 'error', message: 'Invalid room code format' });
            return;
          }

          if (!checkIpRateLimit(clientIp)) {
            send(ws, { type: 'error', message: 'Too many room connection attempts from this IP' });
            return;
          }

          const cleanRoom = room.trim();
          const token = (typeof msgPeerToken === 'string' && msgPeerToken.trim())
            ? msgPeerToken.trim()
            : (ws.peerToken || `token_${Math.random()}`);
          ws.peerToken = token;

          if (ws.roomCode && ws.roomCode !== cleanRoom) {
            leaveRoom(ws);
          }

          if (!rooms.has(cleanRoom)) {
            rooms.set(cleanRoom, {
              peers: new Set(),
              roles: new Map(),
              lastActivityTime: Date.now()
            });
          }

          const roomData = rooms.get(cleanRoom);
          roomData.lastActivityTime = Date.now();

          if (roomData.peers.has(ws)) {
            const role = roomData.roles.get(token) || (roomData.peers.size === 1 ? 'initiator' : 'joiner');
            send(ws, { type: 'joined', room: cleanRoom, role, peerPresent: roomData.peers.size === 2 });
            return;
          }

          if (roomData.peers.size >= 2) {
            send(ws, { type: 'room-full', room: cleanRoom });
            return;
          }

          // Stable Role Model
          let assignedRole;
          if (roomData.roles.has(token)) {
            assignedRole = roomData.roles.get(token);
          } else {
            const hasInitiator = Array.from(roomData.roles.values()).includes('initiator');
            assignedRole = !hasInitiator ? 'initiator' : 'joiner';
            roomData.roles.set(token, assignedRole);
          }

          roomData.peers.add(ws);
          ws.roomCode = cleanRoom;

          send(ws, {
            type: 'joined',
            room: cleanRoom,
            role: assignedRole,
            peerPresent: roomData.peers.size === 2
          });

          if (roomData.peers.size === 2) {
            relayToPeer(cleanRoom, ws, { type: 'peer-joined' });
          }
          break;
        }

        case 'offer': {
          if (!ws.roomCode) { send(ws, { type: 'error', message: 'Not in a room' }); return; }
          if (!offer || typeof offer !== 'object' || typeof offer.sdp !== 'string') {
            send(ws, { type: 'error', message: 'Invalid offer schema' });
            return;
          }
          touchRoomActivity(ws.roomCode);
          relayToPeer(ws.roomCode, ws, { type: 'offer', offer });
          break;
        }

        case 'answer': {
          if (!ws.roomCode) { send(ws, { type: 'error', message: 'Not in a room' }); return; }
          if (!answer || typeof answer !== 'object' || typeof answer.sdp !== 'string') {
            send(ws, { type: 'error', message: 'Invalid answer schema' });
            return;
          }
          touchRoomActivity(ws.roomCode);
          relayToPeer(ws.roomCode, ws, { type: 'answer', answer });
          break;
        }

        case 'ice-candidate': {
          if (!ws.roomCode) return;
          if (!candidate || typeof candidate !== 'object') return;
          touchRoomActivity(ws.roomCode);
          relayToPeer(ws.roomCode, ws, { type: 'ice-candidate', candidate });
          break;
        }

        case 'leave-room': {
          leaveRoom(ws);
          send(ws, { type: 'left' });
          break;
        }

        default:
          send(ws, { type: 'error', message: `Unknown message type` });
      }
    } catch (err) {
      send(ws, { type: 'error', message: 'Invalid JSON format' });
    }
  });

  ws.on('close', () => { leaveRoom(ws); });
  ws.on('error', () => { leaveRoom(ws); });
});

// ─── Heartbeat & Activity-Based Stale Room Cleanup ─────────────────────────────
const pingInterval = setInterval(() => {
  const now = Date.now();

  rooms.forEach((roomData, roomCode) => {
    if (now - roomData.lastActivityTime > ROOM_INACTIVITY_TIMEOUT_MS) {
      roomData.peers.forEach(client => {
        send(client, { type: 'error', message: 'Room signaling session expired due to inactivity' });
        leaveRoom(client);
      });
      rooms.delete(roomCode);
    }
  });

  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      leaveRoom(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

const ipRateLimitCleanupTimer = setInterval(() => {
  cleanupExpiredIpRateLimits();
}, 10 * 60 * 1000);

wss.on('close', () => {
  clearInterval(pingInterval);
  clearInterval(ipRateLimitCleanupTimer);
});

// ─── Start ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 FluxTransfer running on http://0.0.0.0:${PORT}`);
    console.log(`📡 WebSocket signaling ready on port ${PORT}`);
    console.log(`📁 Serving static files from: ${STATIC_DIR}\n`);
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    server,
    wss,
    rooms,
    ipRateLimits,
    checkIpRateLimit,
    cleanupExpiredIpRateLimits,
    getClientIp,
    getSecurityHeaders,
    isOriginAllowed,
    getAllowedOrigins
  };
}
