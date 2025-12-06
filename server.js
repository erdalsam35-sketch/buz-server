// server.js
// Modern, robust WebSocket server for "Buz" (walkie-talkie) style messaging.
// Usage: NODE_ENV=production PORT=8080 WS_PATH=/ws ENABLE_ECHO=false node server.js

const WebSocket = require('ws');
const http = require('http');
const url = require('url');

// CONFIG
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8080;
const WS_PATH = process.env.WS_PATH || '/ws';
const PING_INTERVAL_MS = 30000;       // Heartbeat interval
const MAX_MESSAGE_BYTES = 1_200_000;  // ~1.2MB max payload (adjust as needed)
const ENABLE_ECHO = (process.env.ENABLE_ECHO === 'true'); // if true, sender also receives its own audio (dangerous if client re-sends on receive)

// In-memory stores:
// users: Map<userId, Set<ws>>
// groups: Map<groupName, Set<userId>>
const users = new Map();
const groups = new Map();

// Helper functions
function safeSend(ws, obj) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch (e) {
    console.warn('safeSend failed', e);
  }
}

function broadcastToGroup(groupName, messageObj, { excludeUserId = null, includeSender = false } = {}) {
  const members = groups.get(groupName);
  if (!members) return 0;
  let sent = 0;
  for (const memberId of members) {
    if (!includeSender && memberId === excludeUserId) continue;
    const conns = users.get(memberId);
    if (!conns) continue;
    for (const clientWs of conns) {
      safeSend(clientWs, messageObj);
      sent++;
    }
  }
  return sent;
}

function addUserConnection(userId, ws) {
  let set = users.get(userId);
  if (!set) {
    set = new Set();
    users.set(userId, set);
  }
  set.add(ws);
}

function removeUserConnection(userId, ws) {
  const set = users.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) users.delete(userId);
}

function addUserToGroup(groupName, userId) {
  let set = groups.get(groupName);
  if (!set) {
    set = new Set();
    groups.set(groupName, set);
  }
  set.add(userId);
}

function removeUserFromGroup(groupName, userId) {
  const set = groups.get(groupName);
  if (!set) return;
  set.delete(userId);
  if (set.size === 0) groups.delete(groupName);
}

function sendUserStatus(userId, isOnline) {
  // notify all connections of all users about this user's status
  const payload = { type: 'user_status', userId, isOnline };
  for (const conns of users.values()) {
    for (const ws of conns) safeSend(ws, payload);
  }
}

// HTTP server (needed for production reverse proxies that expect HTTP upgrade on a path)
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Buz WebSocket server\n');
});

const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', function upgrade(request, socket, head) {
  const { pathname } = url.parse(request.url);
  if (pathname === WS_PATH) {
    wss.handleUpgrade(request, socket, head, function done(ws) {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', function connection(ws, request) {
  // metadata on ws
  ws.isAlive = true;
  ws.userId = null;
  ws.currentGroup = null;
  ws.id = Math.random().toString(36).slice(2, 9);

  ws.on('pong', () => { ws.isAlive = true; });

  // safe message parser with size check
  ws.on('message', function incoming(raw) {
    try {
      if (typeof raw === 'string') {
        if (raw.length > MAX_MESSAGE_BYTES) {
          safeSend(ws, { type: 'error', reason: 'message_too_large' });
          return;
        }
      } else if (raw instanceof Buffer) {
        if (raw.length > MAX_MESSAGE_BYTES) {
          safeSend(ws, { type: 'error', reason: 'message_too_large' });
          return;
        }
      }

      const text = raw.toString();
      const data = JSON.parse(text);

      if (!data || typeof data.type !== 'string') {
        safeSend(ws, { type: 'error', reason: 'invalid_payload' });
        return;
      }

      switch (data.type) {
        // client announces identity
        case 'login': {
          const userId = (data.userId || '').toString().trim().toUpperCase();
          if (!userId) {
            safeSend(ws, { type: 'error', reason: 'missing_userId' });
            return;
          }
          ws.userId = userId;
          addUserConnection(userId, ws);
          safeSend(ws, { type: 'login_ack', userId });
          sendUserStatus(userId, true);
          console.log(`LOGIN: ${userId} [conn:${ws.id}]`);
          break;
        }

        // join a group (channel)
        case 'join_group': {
          if (!ws.userId) { safeSend(ws, { type: 'error', reason: 'not_logged_in' }); return; }
          const groupName = (data.groupName || '').toString().trim().toUpperCase();
          if (!groupName) { safeSend(ws, { type: 'error', reason: 'missing_groupName' }); return; }

          // remove from previous group if exists
          if (ws.currentGroup && ws.currentGroup !== groupName) {
            removeUserFromGroup(ws.currentGroup, ws.userId);
            // optionally notify old group
            broadcastToGroup(ws.currentGroup, { type: 'user_left', userId: ws.userId, groupName: ws.currentGroup }, { includeSender: true });
          }

          addUserToGroup(groupName, ws.userId);
          ws.currentGroup = groupName;
          safeSend(ws, { type: 'join_ack', groupName });
          broadcastToGroup(groupName, { type: 'user_joined', userId: ws.userId, groupName }, { includeSender: true });
          console.log(`JOIN: ${ws.userId} -> ${groupName} [conn:${ws.id}]`);
          break;
        }

        case 'leave_group': {
          if (!ws.userId) { safeSend(ws, { type: 'error', reason: 'not_logged_in' }); return; }
          const groupName = (data.groupName || ws.currentGroup || '').toString().trim().toUpperCase();
          if (!groupName) { safeSend(ws, { type: 'error', reason: 'missing_groupName' }); return; }
          removeUserFromGroup(groupName, ws.userId);
          if (ws.currentGroup === groupName) ws.currentGroup = null;
          safeSend(ws, { type: 'leave_ack', groupName });
          broadcastToGroup(groupName, { type: 'user_left', userId: ws.userId, groupName }, { includeSender: true });
          console.log(`LEAVE: ${ws.userId} -/-> ${groupName} [conn:${ws.id}]`);
          break;
        }

        // audio payload - expect base64 string in data.data
        case 'audio_msg': {
          if (!ws.userId) { safeSend(ws, { type: 'error', reason: 'not_logged_in' }); return; }
          const groupName = (data.to || data.groupName || data.channel || '').toString().trim().toUpperCase();
          if (!groupName) { safeSend(ws, { type: 'error', reason: 'missing_target_group' }); return; }

          // validate payload
          const base64 = data.data;
          if (!base64 || typeof base64 !== 'string' || base64.length < 10) {
            safeSend(ws, { type: 'error', reason: 'invalid_audio_payload' });
            return;
          }

          // Do not allow clients to craft arbitrary 'from' field
          const payload = {
            type: 'audio_msg',
            from: ws.userId,
            groupName,
            data: base64,
            timestamp: Date.now()
          };

          // distribute to group (exclude sender unless ENABLE_ECHO true)
          const sent = broadcastToGroup(groupName, payload, { excludeUserId: ws.userId, includeSender: ENABLE_ECHO });
          safeSend(ws, { type: 'audio_ack', groupName, recipients: sent });
          console.log(`AUDIO: ${ws.userId} -> ${groupName} | sent: ${sent}`);
          break;
        }

        default:
          safeSend(ws, { type: 'error', reason: 'unknown_type' });
          break;
      }
    } catch (err) {
      console.warn('message handling error', err);
      safeSend(ws, { type: 'error', reason: 'server_error' });
    }
  });

  ws.on('close', function(code, reason) {
    try {
      const u = ws.userId;
      if (u) {
        // remove connection
        removeUserConnection(u, ws);
        // remove from groups where present
        if (ws.currentGroup) {
          removeUserFromGroup(ws.currentGroup, u);
          broadcastToGroup(ws.currentGroup, { type: 'user_left', userId: u, groupName: ws.currentGroup }, { includeSender: true });
        }
        // if user has no more connections, broadcast offline
        if (!users.has(u)) {
          sendUserStatus(u, false);
          console.log(`OFFLINE: ${u}`);
        }
      }
    } catch (e) {
      console.warn('error on close cleanup', e);
    }
  });

  ws.on('error', (e) => {
    console.warn('ws error', e);
  });
});

// Heartbeat ping/pong
const interval = setInterval(function ping() {
  wss.clients.forEach(function each(ws) {
    if (ws.isAlive === false) {
      try { ws.terminate(); } catch (e) {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(() => {}); } catch (e) {}
  });
}, PING_INTERVAL_MS);

wss.on('close', function close() {
  clearInterval(interval);
});

server.listen(PORT, () => {
  console.log(`🔥 BUZ Server listening on port ${PORT}, ws_path=${WS_PATH}, echo=${ENABLE_ECHO}`);
});
