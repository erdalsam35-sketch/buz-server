const WebSocket = require('ws');

// Sunucuyu başlat
const wss = new WebSocket.Server({ port: 8080 });

console.log("BUZ Telsiz Sunucusu (Sabit Bağlantı) Çalışıyor...");

let users = {};

wss.on('connection', function connection(ws) {
  
  // Kalp atışı (Heartbeat) - Sadece log için, bağlantıyı kesmez.
  ws.isAlive = true;
  ws.on('pong', () => { 
      ws.isAlive = true; 
      // console.log("Pong alındı: " + ws.userId); // İsterseniz açabilirsiniz
  });

  ws.on('message', function incoming(message) {
    let data;
    try {
        data = JSON.parse(message);
    } catch (e) { return; }

    // 1. GİRİŞ
    if (data.type === 'login') {
        users[data.userId] = ws;
        ws.userId = data.userId;
        console.log("✅ GİRİŞ: " + data.userId);
    } 
    
    // 2. SES DOSYASI
    else if (data.type === 'audio_msg') {
        console.log("📨 SES: " + data.from + " -> " + data.to);
        const targetClient = users[data.to];
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
            targetClient.send(message);
            console.log("🚀 İLETİLDİ.");
        } else {
            console.log("⛔ HEDEF BULUNAMADI: " + data.to);
        }
    }
    
    // 3. PING (Android'den gelen "Ben buradayım" mesajı)
    else if (data.type === 'ping') {
        // Boş cevap, sadece bağlantı kopmasın diye
    }
  });

  ws.on('close', function() {
      if (ws.userId) {
          delete users[ws.userId];
          console.log("🔻 ÇIKIŞ: " + ws.userId);
      }
  });
});

// Otomatik atma kodunu kaldırdık. 
// Sunucu artık pasif duran kullanıcıları atmaz.
