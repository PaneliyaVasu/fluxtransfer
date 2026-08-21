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

// ─── Room Store ───────────────────────────────────────────────────────────────
const rooms = new Map(); // Map<roomCode, Set<WebSocket>>

// ─── WebSocket Server (upgrade on same HTTP server) ───────────────────────────
const wss = new WebSocketServer({ server });

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
      // No logging for empty room cleanup
    }
  }

  ws.roomCode = null;
}

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.roomCode = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (rawMessage) => {
    try {
      const message = JSON.parse(rawMessage.toString());
      const { type, room, offer, answer, candidate } = message;

      switch (type) {
        case 'join-room': {
          if (!room || typeof room !== 'string') {
            send(ws, { type: 'error', message: 'Invalid room code' });
            return;
          }

          if (ws.roomCode && ws.roomCode !== room) {
            leaveRoom(ws);
          }

          if (!rooms.has(room)) {
            rooms.set(room, new Set());
          }

          const targetRoom = rooms.get(room);

          if (targetRoom.has(ws)) {
            send(ws, { type: 'joined', room, role: targetRoom.size === 1 ? 'initiator' : 'joiner' });
            return;
          }

          if (targetRoom.size >= 2) {
            send(ws, { type: 'room-full', room });
            return;
          }

          targetRoom.add(ws);
          ws.roomCode = room;

          const isInitiator = targetRoom.size === 1;
          send(ws, {
            type: 'joined',
            room,
            role: isInitiator ? 'initiator' : 'joiner',
            peerPresent: targetRoom.size === 2
          });

          if (targetRoom.size === 2) {
            relayToPeer(room, ws, { type: 'peer-joined' });
          }
          break;
        }

        case 'offer': {
          if (!ws.roomCode) { send(ws, { type: 'error', message: 'Not in a room' }); return; }
          relayToPeer(ws.roomCode, ws, { type: 'offer', offer });
          break;
        }

        case 'answer': {
          if (!ws.roomCode) { send(ws, { type: 'error', message: 'Not in a room' }); return; }
          relayToPeer(ws.roomCode, ws, { type: 'answer', answer });
          break;
        }

        case 'ice-candidate': {
          if (!ws.roomCode) return;
          relayToPeer(ws.roomCode, ws, { type: 'ice-candidate', candidate });
          break;
        }

        case 'leave-room': {
          leaveRoom(ws);
          send(ws, { type: 'left' });
          break;
        }

        default:
          send(ws, { type: 'error', message: `Unknown message type: ${type}` });
      }
    } catch (err) {
      send(ws, { type: 'error', message: 'Invalid JSON format' });
    }
  });

  ws.on('close', () => { leaveRoom(ws); });
  ws.on('error', () => { leaveRoom(ws); });
});

// ─── Heartbeat — detect dead connections ─────────────────────────────────────
const pingInterval = setInterval(() => {
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
