/**
 * FluxTransfer — Lightweight WebRTC Signaling Server
 * 
 * Responsibilities:
 * - WebSocket connection management & heartbeat (ping/pong)
 * - Room pairing via shareable 6-8 digit session codes
 * - Pure metadata signaling exchange (SDP offers, answers, ICE candidates)
 * - ZERO file data passing through this server
 * - Graceful peer disconnect & room cleanup
 */

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 8080;

// HTTP Server for health checks & static ping
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ status: 'ok', service: 'FluxTransfer Signaling Server', activeRooms: rooms.size }));
});

// Create WebSocket Server
const wss = new WebSocketServer({ server });

// Room Store: Map<roomCode, Set<WebSocket>>
const rooms = new Map();

// Helper to broadcast JSON to a client
function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// Helper to broadcast to the OTHER peer in the room
function relayToPeer(roomCode, senderWs, data) {
  const room = rooms.get(roomCode);
  if (!room) return;
  for (const client of room) {
    if (client !== senderWs && client.readyState === WebSocket.OPEN) {
      send(client, data);
    }
  }
}

// Leave / Cleanup room
function leaveRoom(ws) {
  if (!ws.roomCode) return;

  const roomCode = ws.roomCode;
  const room = rooms.get(roomCode);

  if (room) {
    room.delete(ws);
    // Notify remaining peer in room
    relayToPeer(roomCode, ws, { type: 'peer-left' });

    if (room.size === 0) {
      rooms.delete(roomCode);
      console.log(`[Room ${roomCode}] Empty — cleaned up`);
    } else {
      console.log(`[Room ${roomCode}] Peer left. Remaining: ${room.size}`);
    }
  }

  ws.roomCode = null;
}

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[Client Connected] IP: ${ip}`);

  ws.isAlive = true;
  ws.roomCode = null;

  // Pong handler for heartbeat
  ws.on('pong', () => {
    ws.isAlive = true;
  });

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

          // If client is currently in another room, leave it
          if (ws.roomCode && ws.roomCode !== room) {
            leaveRoom(ws);
          }

          if (!rooms.has(room)) {
            rooms.set(room, new Set());
          }

          const targetRoom = rooms.get(room);

          if (targetRoom.has(ws)) {
            // Already in room
            send(ws, { type: 'joined', room, role: targetRoom.size === 1 ? 'initiator' : 'joiner' });
            return;
          }

          if (targetRoom.size >= 2) {
            console.log(`[Room ${room}] Refused connection: Room full (Max 2 peers)`);
            send(ws, { type: 'room-full', room });
            return;
          }

          targetRoom.add(ws);
          ws.roomCode = room;

          const isInitiator = targetRoom.size === 1;
          console.log(`[Room ${room}] Client joined as ${isInitiator ? 'initiator' : 'joiner'}. Total: ${targetRoom.size}`);

          // Response to client joining
          send(ws, {
            type: 'joined',
            room,
            role: isInitiator ? 'initiator' : 'joiner',
            peerPresent: targetRoom.size === 2
          });

          // Notify existing peer that a new peer joined
          if (targetRoom.size === 2) {
            relayToPeer(room, ws, { type: 'peer-joined' });
          }
          break;
        }

        case 'offer': {
          if (!ws.roomCode) {
            send(ws, { type: 'error', message: 'Not in a room' });
            return;
          }
          console.log(`[Room ${ws.roomCode}] Relaying SDP Offer`);
          relayToPeer(ws.roomCode, ws, { type: 'offer', offer });
          break;
        }

        case 'answer': {
          if (!ws.roomCode) {
            send(ws, { type: 'error', message: 'Not in a room' });
            return;
          }
          console.log(`[Room ${ws.roomCode}] Relaying SDP Answer`);
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
          break;
      }
    } catch (err) {
      console.error('[Signaling Error] Failed to parse message:', err.message);
      send(ws, { type: 'error', message: 'Invalid JSON format' });
    }
  });

  ws.on('close', () => {
    console.log(`[Client Disconnected] Room: ${ws.roomCode || 'none'}`);
    leaveRoom(ws);
  });

  ws.on('error', (err) => {
    console.error('[Socket Error]', err.message);
    leaveRoom(ws);
  });
});

// Heartbeat interval to detect dead WebSocket connections
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log(`[Heartbeat] Terminating inactive connection (Room: ${ws.roomCode || 'none'})`);
      leaveRoom(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(pingInterval);
});

server.listen(PORT, () => {
  console.log(`🚀 FluxTransfer WebRTC Signaling Server listening on http://localhost:${PORT}`);
  console.log(`📡 WebSocket endpoint ready at ws://localhost:${PORT}`);
});
