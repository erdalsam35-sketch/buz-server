// server.js
// BUZ Server - FINAL STABLE v3.0
// Özellikler: Grup Desteği, Parçalı Yükleme (Chunking), Ping/Pong, Render Uyumu

const http = require('http');
const WebSocket = require('ws');
const url = require('url');
const crypto = require('crypto');

// AYARLAR (Render.com otomatik port atar, yoksa 10000 kullanır)
const PORT = parseInt(process.env.PORT || '10000', 10);
const WS_PATH = process.env.WS_PATH || '/ws'; // Android'de wss://.../ws kullanmalısınız!
const PING_INTERVAL_MS = parseInt(process.env.PING_INTERVAL_MS || '30000', 10); // 30 sn
const MAX_MESSAGE_BYTES = parseInt(process.env.MAX_MESSAGE_BYTES || String(5_000_000), 10); // 5MB Limit
const CHUNK_TIMEOUT_MS = parseInt(process.env.CHUNK_TIMEOUT_MS || '30000', 10); // 30 sn zaman aşımı

// HAFIZA (Veritabanı yerine RAM kullanılır)
const users = new Map();   // { userId: Set<ws> }
const groups = new Map();  // { groupName: Set<userId> }
const chunkUploads = new Map(); // Parçalı yüklemeler

// --- YARDIMCI FONKSİYONLAR ---

function safeSend(ws, obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  } catch (e) {
    console.warn('Mesaj gönderme hatası:', e);
  }
}

function broadcastToGroup(groupName, messageObj, { excludeUserId = null } = {}) {
  const memberSet = groups.get(groupName);
  if (!memberSet) return 0;
  
  let sent = 0;
  for (const memberId of memberSet) {
    if (memberId === excludeUserId) continue; // Gönderene geri yollama
    
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

// --- PARÇALI YÜKLEME (CHUNKING) MANTIĞI ---

function startChunkUpload(uploadId, total) {
  const parts = new Map();
  const obj = { total, receivedCount: 0, parts, timer: null };
  
  // Zaman aşımı temizliği
  obj.timer = setTimeout(() => {
    console.warn(`Upload zaman aşımı: ${uploadId}`);
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
  
  // Zamanlayıcıyı sıfırla
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    chunkUploads.delete(uploadId);
  }, CHUNK_TIMEOUT_MS);

  return entry.receivedCount >= entry.total;
}

function assembleChunks(uploadId) {
  const entry = chunkUploads.get(uploadId);
  if (!entry) return null;
  
  const buffers = [];
  for (let i = 0; i < entry.total; i++) {
    const part = entry.parts.get(i);
    if (!part) return null; // Eksik parça var
    buffers.push(part);
  }
  
  const combined = Buffer.concat(buffers);
  clearTimeout(entry.timer);
  chunkUploads.delete(uploadId);
  return combined;
}

// --- SUNUCU BAŞLATMA ---

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('BUZ WebSocket Sunucusu Calisiyor\n');
});

const wss = new WebSocket.Server({ noServer: true });

// HTTP Upgrade (ws:// adresini WebSocket'e çevirir)
server.on('upgrade', function upgrade(request, socket, head) {
  const { pathname } = url.parse(request.url);
  
  // Sadece /ws yolundan gelenleri kabul et
  if (pathname === WS_PATH) {
    wss.handleUpgrade(request, socket, head, function done(ws) {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Otomatik Ping (Bağlantı Canlı Tutma)
function noop() {}
const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(noop); } catch (e) {}
  });
}, PING_INTERVAL_MS);

// --- BAĞLANTI OLAYLARI ---

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.userId = null;
  ws.currentGroup = null;
  ws.id = crypto.randomBytes(4).toString('hex'); // Rastgele bağlantı ID

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    try {
      // 1. Boyut Kontrolü
      let byteLen = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(raw, 'utf8');
      if (byteLen > MAX_MESSAGE_BYTES) {
        safeSend(ws, { type: 'error', reason: 'message_too_large' });
        return;
      }

      // 2. JSON Çözme
      const text = raw.toString();
      let data;
      try { data = JSON.parse(text); } catch (e) { return; }

      if (!data || !data.type) return;

      // 3. İşlem Türleri
      switch (data.type) {
        
        // GİRİŞ
        case 'login': {
          const userId = (data.userId || '').toString().trim().toUpperCase();
          if (!userId) return;
          ws.userId = userId;
          addUserConnection(userId, ws);
          safeSend(ws, { type: 'login_ack', userId });
          console.log(`✅ GİRİŞ: ${userId}`);
          break;
        }

        // GRUBA KATIL
        case 'join_group': {
          if (!ws.userId) return;
          const groupName = (data.groupName || '').toString().trim().toUpperCase();
          if (!groupName) return;

          // Eski gruptan çık
          if (ws.currentGroup && ws.currentGroup !== groupName) {
            removeUserFromGroup(ws.currentGroup, ws.userId);
          }

          addUserToGroup(groupName, ws.userId);
          ws.currentGroup = groupName;
          
          console.log(`➕ KANAL: ${ws.userId} -> ${groupName}`);
          break;
        }

        // TEK SEFERDE SES MESAJI
        case 'audio_msg': {
          if (!ws.userId) return;
          const groupName = (data.to || ws.currentGroup || '').toString().trim().toUpperCase();
          
          if (!groupName) return;

          const payload = {
            type: 'audio_msg',
            from: ws.userId,
            groupName,
            data: data.data, // Base64
            timestamp: Date.now()
          };

          // Gruba dağıt (Gönderen hariç)
          const sent = broadcastToGroup(groupName, payload, { excludeUserId: ws.userId });
          console.log(`🎤 SES: ${ws.userId} -> ${groupName} (${sent} kişiye)`);
          break;
        }

        // PARÇALI YÜKLEME BAŞLAT
        case 'audio_chunk_start': {
          if (!ws.userId) return;
          const uploadId = (data.uploadId || '').toString();
          const total = parseInt(data.total, 10);
          if (uploadId && total > 0) {
            startChunkUpload(uploadId, total);
            safeSend(ws, { type: 'chunk_start_ack', uploadId });
          }
          break;
        }

        // PARÇA AL
        case 'audio_chunk': {
          if (!ws.userId) return;
          const uploadId = (data.uploadId || '').toString();
          const index = parseInt(data.index, 10);
          const base64 = data.data;
          
          if (uploadId && base64) {
            // Parçayı ekle
            if (!chunkUploads.has(uploadId)) return; // Zaman aşımına uğramış olabilir
            
            const buffer = Buffer.from(base64, 'base64');
            const finished = addChunkPart(uploadId, index, buffer);
            
            safeSend(ws, { type: 'chunk_ack', uploadId, index });

            // Hepsi tamamlandıysa birleştir ve gönder
            if (finished) {
              const combined = assembleChunks(uploadId);
              if (combined) {
                const combinedBase64 = combined.toString('base64');
                const groupName = (data.to || ws.currentGroup || '').toString().trim().toUpperCase();
                
                const payload = {
                  type: 'audio_msg',
                  from: ws.userId,
                  groupName,
                  data: combinedBase64,
                  timestamp: Date.now()
                };
                
                const sent = broadcastToGroup(groupName, payload, { excludeUserId: ws.userId });
                console.log(`📦 DOSYA BİRLEŞTİ VE GÖNDERİLDİ: ${groupName} (${sent} kişiye)`);
              }
            }
          }
          break;
        }

        // PING (Android'den gelen)
        case 'ping': {
          safeSend(ws, { type: 'pong' });
          break;
        }
      }

    } catch (err) {
      console.warn('Hata:', err);
    }
  });

  // KOPMA
  ws.on('close', () => {
    if (ws.userId) {
      removeUserConnection(ws.userId, ws);
      if (ws.currentGroup) {
        removeUserFromGroup(ws.currentGroup, ws.userId);
      }
      console.log(`🔻 ÇIKIŞ: ${ws.userId}`);
    }
  });

  ws.on('error', (e) => console.warn('Socket hatası', e));
});

wss.on('close', () => clearInterval(interval));

// SUNUCUYU BAŞLAT
server.listen(PORT, () => {
  console.log(`✅ Sunucu Port ${PORT} üzerinde çalışıyor. Yol: ${WS_PATH}`);
});
