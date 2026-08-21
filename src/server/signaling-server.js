/**
 * FluxTransfer — Unified Server (Static Files + WebRTC Signaling)
 *
 * Serves static client files AND WebSocket signaling on ONE port.
 * This is the correct setup for cross-network deployment:
 *   - Static files: GET /  → serves src/client/
 *   - Signaling:    WS /   → WebSocket upgrade
 *
 * Deploy on any cloud (Render, Railway, Fly.io, Heroku) and both
 * the website AND the WebSocket signaling are publicly reachable.
 *
 * ZERO file data passes through this server.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;
const STATIC_DIR = path.join(__dirname, '..', 'client');

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
  '.xml': 'text/xml',
  '.apk': 'application/vnd.android.package-archive',
};

function serveStatic(req, res) {
  // CORS headers for signaling health check
  res.setHeader('Access-Control-Allow-Origin', '*');

  let reqPath = req.url.split('?')[0].split('#')[0];

  // SPA-style routing: trailing-slash pages load their index.html
  if (reqPath.endsWith('/') && reqPath !== '/') {
    reqPath += 'index.html';
  }
  if (reqPath === '/') {
    reqPath = '/index.html';
  }

  const filePath = path.join(STATIC_DIR, reqPath);

  // Prevent path traversal
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err) {
      // For unknown paths, serve root index.html (client-side routing)
      const fallback = path.join(STATIC_DIR, 'index.html');
      fs.readFile(fallback, (e, data) => {
        if (e) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
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
            if (errFallback) { res.writeHead(404); res.end('Not found'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(fallbackData);
          });
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';

    const headers = {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
    };

    if (ext === '.apk') {
      headers['Content-Disposition'] = 'attachment; filename="FluxTransfer.apk"';
    }

    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  });
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Health check endpoint for uptime monitors
  if (req.url === '/health' || req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'FluxTransfer Signaling Server',
      activeRooms: rooms.size,
      connectedClients: wss.clients.size
    }));
    return;
  }

  serveStatic(req, res);
});

// ─── Room Store & Security Configuration ─────────────────────────────────────
const rooms = new Map(); // Map<roomCode, Set<WebSocket>>
const roomTimestamps = new Map(); // Map<roomCode, timestamp>

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

// ─── WebSocket Server (upgrade on same HTTP server) ───────────────────────────
const wss = new WebSocketServer({
  server,
  maxPayload: MAX_MESSAGE_SIZE_BYTES
});

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function relayToPeer(roomCode, senderWs, data) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const client of room) {
    if (client !== senderWs && client.readyState === WebSocket.OPEN) {
      send(client, data);
    }
  }
}

function leaveRoom(ws) {
  if (!ws.roomCode) return;

  const roomCode = ws.roomCode;
  const room = rooms.get(roomCode);

  if (room) {
    room.delete(ws);
    relayToPeer(roomCode, ws, { type: 'peer-left' });

    if (room.size === 0) {
      rooms.delete(roomCode);
      roomTimestamps.delete(roomCode);
    }
  }

  ws.roomCode = null;
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.roomCode = null;
  ws.msgCount = 0;
  ws.msgResetTime = Date.now() + 60000;
  const clientIp = (req.socket && req.socket.remoteAddress) || '127.0.0.1';

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (rawMessage) => {
    // 1. Message size check
    if (Buffer.byteLength(rawMessage) > MAX_MESSAGE_SIZE_BYTES) {
      send(ws, { type: 'error', message: 'Payload size limit exceeded' });
      return;
    }

    // 2. Per-socket message rate limit check
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

    // 3. Schema validation & handling
    try {
      const message = JSON.parse(rawMessage.toString());
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
        send(ws, { type: 'error', message: 'Invalid payload structure' });
        return;
      }

      const { type, room, offer, answer, candidate } = message;

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

          if (ws.roomCode && ws.roomCode !== cleanRoom) {
            leaveRoom(ws);
          }

          if (!rooms.has(cleanRoom)) {
            rooms.set(cleanRoom, new Set());
            roomTimestamps.set(cleanRoom, Date.now());
          }

          const targetRoom = rooms.get(cleanRoom);

          if (targetRoom.has(ws)) {
            send(ws, { type: 'joined', room: cleanRoom, role: targetRoom.size === 1 ? 'initiator' : 'joiner' });
            return;
          }

          if (targetRoom.size >= 2) {
            send(ws, { type: 'room-full', room: cleanRoom });
            return;
          }

          targetRoom.add(ws);
          ws.roomCode = cleanRoom;

          const isInitiator = targetRoom.size === 1;
          send(ws, {
            type: 'joined',
            room: cleanRoom,
            role: isInitiator ? 'initiator' : 'joiner',
            peerPresent: targetRoom.size === 2
          });

          if (targetRoom.size === 2) {
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
          relayToPeer(ws.roomCode, ws, { type: 'offer', offer });
          break;
        }

        case 'answer': {
          if (!ws.roomCode) { send(ws, { type: 'error', message: 'Not in a room' }); return; }
          if (!answer || typeof answer !== 'object' || typeof answer.sdp !== 'string') {
            send(ws, { type: 'error', message: 'Invalid answer schema' });
            return;
          }
          relayToPeer(ws.roomCode, ws, { type: 'answer', answer });
          break;
        }

        case 'ice-candidate': {
          if (!ws.roomCode) return;
          if (!candidate || typeof candidate !== 'object') return;
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

// ─── Heartbeat & Stale Room Cleanup ─────────────────────────────────────────
const pingInterval = setInterval(() => {
  const now = Date.now();

  // Cleanup inactive rooms (> 15 mins)
  roomTimestamps.forEach((createdTime, roomCode) => {
    if (now - createdTime > 15 * 60 * 1000) {
      const room = rooms.get(roomCode);
      if (room) {
        room.forEach(client => {
          send(client, { type: 'error', message: 'Room session expired' });
          leaveRoom(client);
        });
      }
      rooms.delete(roomCode);
      roomTimestamps.delete(roomCode);
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

wss.on('close', () => clearInterval(pingInterval));

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 FluxTransfer running on http://localhost:${PORT}`);
  console.log(`📡 WebSocket signaling at ws://localhost:${PORT}`);
  console.log(`📁 Serving static files from: ${STATIC_DIR}\n`);
});

