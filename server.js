const WebSocket = require('ws');

// Sunucuyu 8080 portunda başlat
const wss = new WebSocket.Server({ port: 8080 });

console.log("BUZ Sinyalleşme ve Ses Sunucusu çalışıyor...");

let users = {};

wss.on('connection', function connection(ws) {
  
  ws.on('message', function incoming(message) {
    let data;
    try {
        data = JSON.parse(message);
    } catch (e) {
        console.log("Hatalı JSON");
        return;
    }

    // 1. GİRİŞ (LOGIN)
    if (data.type === 'login') {
        console.log("Kullanıcı Girdi: " + data.userId);
        users[data.userId] = ws;
        ws.userId = data.userId;
    } 
    
    // 2. SES DOSYASI İLETİMİ (YENİ EKLENEN KISIM)
    else if (data.type === 'audio_msg') {
        console.log("SES Dosyası Gönderiliyor -> " + data.to);
        
        const targetClient = users[data.to];
        
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
            // Mesajı (Ses verisini) olduğu gibi hedefe ilet
            targetClient.send(message); 
        } else {
            console.log("Hedef bulunamadı: " + data.to);
        }
    }

    // 3. DİĞER SİNYALLER (Eski WebRTC sinyalleri kalsın, zararı yok)
    else if (data.type === 'offer' || data.type === 'answer' || data.type === 'candidate') {
        const targetClient = users[data.to];
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
            targetClient.send(message);
        }
    }
  });

  ws.on('close', function() {
      if (ws.userId) {
          delete users[ws.userId];
          console.log("Kullanıcı Ayrıldı: " + ws.userId);
      }
  });
});
