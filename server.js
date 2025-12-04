const WebSocket = require('ws');

// Sunucuyu başlat
const wss = new WebSocket.Server({ port: 8080 });

console.log("BUZ Telsiz Sunucusu (v2.0) Çalışıyor...");

let users = {};

wss.on('connection', function connection(ws) {
  
  // Bağlantı canlı mı kontrolü (Ping/Pong)
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', function incoming(message) {
    let data;
    try {
        // Gelen mesajı oku
        data = JSON.parse(message);
    } catch (e) {
        console.log("⚠️ HATA: Geçersiz veri formatı geldi, yoksayılıyor.");
        return; // Hata varsa sunucuyu çökertme, sadece çık.
    }

    // 1. GİRİŞ (LOGIN)
    if (data.type === 'login') {
        users[data.userId] = ws;
        ws.userId = data.userId;
        console.log("✅ GİRİŞ: " + data.userId);
    } 
    
    // 2. SES DOSYASI İLETİMİ (Base64)
    else if (data.type === 'audio_msg') {
        const targetClient = users[data.to];
        
        console.log("📨 SES PAKETİ: " + data.from + " -> " + data.to);

        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
            targetClient.send(message); // Mesajı aynen ilet
            console.log("🚀 İLETİLDİ.");
        } else {
            console.log("⛔ HEDEF BULUNAMADI: " + data.to);
        }
    }

    // 3. WEBRTC SİNYALLERİ (Hala desteklesin)
    else if (['offer', 'answer', 'candidate'].includes(data.type)) {
        const targetClient = users[data.to];
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
            targetClient.send(message);
        }
    }
  });

  // Kullanıcı ayrılınca
  ws.on('close', function() {
      if (ws.userId) {
          delete users[ws.userId];
          console.log("🔻 ÇIKIŞ: " + ws.userId);
      }
  });

  // Hata yakalama (Sunucunun kapanmaması için)
  ws.on('error', function(error) {
      console.log("⚠️ SOCKET HATASI: " + error);
  });
});

// -- BAĞLANTIYI CANLI TUTMA (KEEP-ALIVE) --
// Render.com gibi yerlerde bağlantı kopmaması için her 30 saniyede bir kontrol
const interval = setInterval(function ping() {
  wss.clients.forEach(function each(ws) {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', function close() {
  clearInterval(interval);
});
