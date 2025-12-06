const http = require('http');
const WebSocket = require('ws');
const url = require('url');
const crypto = require('crypto');

// CONFIG (env override)
const PORT = parseInt(process.env.PORT || '10000', 10);
const WS_PATH = process.env.WS_PATH || '/ws';
const ENABLE_ECHO = (process.env.ENABLE_ECHO === 'true') || false;
const PING_INTERVAL_MS = parseInt(process.env.PING_INTERVAL_MS || '30000', 10);
const MAX_MESSAGE_BYTES = parseInt(process.env.MAX_MESSAGE_BYTES || String(1_500_000), 10); // ~1.5MB
const CHUNK_TIMEOUT_MS = parseInt(process.env.CHUNK_TIMEOUT_MS || '30000', 10); // 30s timeout for chunked uploads

// In-memory stores
// users: Map<userId, Set<ws>>
const users = new Map();
// groups: Map<groupName, Set<userId>>
const groups = new Map();

// chunkUploads: Map<uploadId, {total, receivedCount, parts: Map<index, Buffer>, timer}>
const chunkUploads = new Map();

function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  } catch (e) {
    console.warn('safeSend failed', e);
  }
}

function broadcastToGroup(groupName, messageObj, { excludeUserId = null, includeSender = false } = {}) {
  const memberSet = groups.get(groupName);
  if (!memberSet) return 0;
  let sent = 0;
  for (const memberId of memberSet) {
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
  const payload = { type: 'user_status', userId, isOnline };
  for (const conns of users.values()) {
    for (const ws of conns) safeSend(ws, payload);
  }
}

// chunk handling
function startChunkUpload(uploadId, total) {
  const parts = new Map();
  const obj = { total, receivedCount: 0, parts, timer: null };
  // timeout cleanup
  obj.timer = setTimeout(() => {
    console.warn(`Chunk upload ${uploadId} timed out, clearing`);
    chunkUploads.delete(uploadId);
  }, CHUNK_TIMEOUT_MS);
  chunkUploads.set(uploadId, obj);
}

function addChunkPart(uploadId, index, dataBuffer) {
  const entry = chunkUploads.get(uploadId);
  if (!entry) return false;
  if (!entry.parts.has(index)) {
    entry.parts.set(index, dataBuffer);
    entry.receivedCount++;
  }
  // reset timer
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    console.warn(`Chunk upload ${uploadId} timed out (reset), clearing`);
    chunkUploads.delete(uploadId);
  }, CHUNK_TIMEOUT_MS);

  return entry.receivedCount >= entry.total;
}

function assembleChunks(uploadId) {
  const entry = chunkUploads.get(uploadId);
  if (!entry) return null;
  const total = entry.total;
  const parts = entry.parts;
  const buffers = [];
  for (let i = 0; i < total; i++) {
    const part = parts.get(i);
    if (!part) {
      console.warn(`Missing chunk ${i} for upload ${uploadId}`);
      return null;
    }
    buffers.push(part);
  }
  const combined = Buffer.concat(buffers);
  // cleanup
  clearTimeout(entry.timer);
  chunkUploads.delete(uploadId);
  return combined;
}

// HTTP server + upgrade handling
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('BUZ WebSocket Server\n');
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

// heartbeat
function noop() {}
const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(noop); } catch (e) {}
  });
}, PING_INTERVAL_MS);

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.userId = null;
  ws.currentGroup = null;
  ws.id = crypto.randomBytes(6).toString('hex');

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    try {
      // size check
      let byteLen = 0;
      if (typeof raw === 'string') byteLen = Buffer.byteLength(raw, 'utf8');
      else if (Buffer.isBuffer(raw)) byteLen = raw.length;
      if (byteLen > MAX_MESSAGE_BYTES) {
        safeSend(ws, { type: 'error', reason: 'message_too_large' });
        return;
      }

      const text = raw.toString();
      let data;
      try { data = JSON.parse(text); } catch (e) {
        safeSend(ws, { type: 'error', reason: 'invalid_json' });
        return;
      }

      if (!data || typeof data.type !== 'string') {
        safeSend(ws, { type: 'error', reason: 'invalid_payload' });
        return;
      }

      switch (data.type) {
        case 'login': {
          const userId = (data.userId || '').toString().trim().toUpperCase();
          if (!userId) { safeSend(ws, { type: 'error', reason: 'missing_userId' }); return; }
          ws.userId = userId;
          addUserConnection(userId, ws);
          safeSend(ws, { type: 'login_ack', userId });
          sendUserStatus(userId, true);
          console.log(`LOGIN: ${userId} [conn:${ws.id}]`);
          break;
        }

        case 'join_group': {
          if (!ws.userId) { safeSend(ws, { type: 'error', reason: 'not_logged_in' }); return; }
          const groupName = (data.groupName || '').toString().trim().toUpperCase();
          if (!groupName) { safeSend(ws, { type: 'error', reason: 'missing_groupName' }); return; }

          if (ws.currentGroup && ws.currentGroup !== groupName) {
            removeUserFromGroup(ws.currentGroup, ws.userId);
            // notify old group
            broadcastToGroup(ws.currentGroup, { type: 'user_left', userId: ws.userId, groupName: ws.currentGroup }, { includeSender: true });
          }

          addUserToGroup(groupName, ws.userId);
          ws.currentGroup = groupName;
          safeSend(ws, { type: 'join_ack', groupName });
          broadcastToGroup(groupName, { type: 'user_joined', userId: ws.userId, groupName }, { includeSender: true });
          console.log(`JOIN: ${ws.userId} -> ${groupName}`);
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
          console.log(`LEAVE: ${ws.userId} -/-> ${groupName}`);
          break;
        }

        case 'audio_msg': {
          if (!ws.userId) { safeSend(ws, { type: 'error', reason: 'not_logged_in' }); return; }
          const groupName = (data.to || data.groupName || data.channel || '').toString().trim().toUpperCase();
          if (!groupName) { safeSend(ws, { type: 'error', reason: 'missing_target_group' }); return; }

          const base64 = data.data;
          if (!base64 || typeof base64 !== 'string' || base64.length < 10) {
            safeSend(ws, { type: 'error', reason: 'invalid_audio_payload' });
            return;
          }

          const payload = {
            type: 'audio_msg',
            from: ws.userId,
            groupName,
            data: base64,
            timestamp: Date.now()
          };

          const sent = broadcastToGroup(groupName, payload, { excludeUserId: ws.userId, includeSender: ENABLE_ECHO });
          safeSend(ws, { type: 'audio_ack', groupName, recipients: sent });
          console.log(`AUDIO: ${ws.userId} -> ${groupName} | sent: ${sent}`);
          break;
        }

        // Chunked upload protocol
        // client sends initial "audio_chunk_start" with uploadId and total
        case 'audio_chunk_start': {
          if (!ws.userId) { safeSend(ws, { type: 'error', reason: 'not_logged_in' }); return; }
          const uploadId = (data.uploadId || '').toString();
          const total = parseInt(data.total, 10);
          if (!uploadId || !Number.isInteger(total) || total <= 0) {
            safeSend(ws, { type: 'error', reason: 'invalid_chunk_start' });
            return;
          }
          startChunkUpload(uploadId, total);
          safeSend(ws, { type: 'chunk_start_ack', uploadId });
          console.log(`CHUNK START: ${uploadId} total=${total}`);
          break;
        }

        // client sends "audio_chunk" messages: uploadId, index (0-based), data (base64)
        case 'audio_chunk': {
          if (!ws.userId) { safeSend(ws, { type: 'error', reason: 'not_logged_in' }); return; }
          const uploadId = (data.uploadId || '').toString();
          const index = parseInt(data.index, 10);
          const total = parseInt(data.total, 10);
          const base64 = data.data;
          const toGroup = (data.to || data.groupName || '').toString().trim().toUpperCase();

          if (!uploadId || !Number.isInteger(index) || !Number.isInteger(total) || !base64) {
            safeSend(ws, { type: 'error', reason: 'invalid_chunk' });
            return;
          }

          // ensure upload exists (or create)
          if (!chunkUploads.has(uploadId)) startChunkUpload(uploadId, total);

          const buffer = Buffer.from(base64, 'base64');
          const finished = addChunkPart(uploadId, index, buffer);

          safeSend(ws, { type: 'chunk_ack', uploadId, index });

          if (finished) {
            const combined = assembleChunks(uploadId);
            if (!combined) {
              safeSend(ws, { type: 'error', reason: 'assemble_failed', uploadId });
              return;
            }

            // convert combined buffer to base64 and broadcast
            const combinedBase64 = combined.toString('base64');
            const payload = {
              type: 'audio_msg',
              from: ws.userId,
              groupName: toGroup || ws.currentGroup,
              data: combinedBase64,
              timestamp: Date.now()
            };

            const sent = broadcastToGroup(payload.groupName, payload, { excludeUserId: ws.userId, includeSender: ENABLE_ECHO });
            safeSend(ws, { type: 'audio_ack', uploadId, recipients: sent });
            console.log(`CHUNK FINISHED: ${uploadId} -> ${payload.groupName} sent:${sent}`);
          }
          break;
        }

        case 'ping': {
          safeSend(ws, { type: 'pong', timestamp: Date.now() });
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

  ws.on('close', () => {
    try {
      const u = ws.userId;
      if (u) {
        removeUserConnection(u, ws);
        // remove from groups
        if (ws.currentGroup) {
          removeUserFromGroup(ws.currentGroup, u);
          broadcastToGroup(ws.currentGroup, { type: 'user_left', userId: u, groupName: ws.currentGroup }, { includeSender: true });
        }
        // if no more connections for that user, broadcast offline
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

wss.on('close', () => {
  clearInterval(interval);
});

// start server
server.listen(PORT, () => {
  console.log(`🔥 BUZ Server listening on port ${PORT}, ws_path=${WS_PATH}, echo=${ENABLE_ECHO}`);
});
