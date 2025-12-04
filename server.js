const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });

console.log("BUZ Sunucusu Başlatıldı (Debug Modu)...");

// Kullanıcıları sakladığımız obje
let users = {};

wss.on('connection', function connection(ws) {
  
  ws.on('message', function incoming(message) {
    let data;
    try {
        data = JSON.parse(message);
    } catch (e) {
        console.log("❌ HATA: Gelen veri JSON değil!");
        return;
    }

    // 1. GİRİŞ (LOGIN)
    if (data.type === 'login') {
        users[data.userId] = ws;
        ws.userId = data.userId;
        
        console.log("✅ GİRİŞ: " + data.userId + " bağlandı.");
        console.log("📊 Şu an Online Olanlar: " + Object.keys(users).join(", "));
    } 
    
    // 2. SES DOSYASI İLETİMİ
    else if (data.type === 'audio_msg') {
        console.log("------------------------------------------------");
        console.log("📨 SES PAKETİ GELDİ: Gönderen " + data.from + " -> Hedef " + data.to);
        
        const targetClient = users[data.to];
        
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
            targetClient.send(message);
            console.log("🚀 BAŞARILI: Ses dosyası " + data.to + " kullanıcısına iletildi.");
        } else {
            console.log("⛔ HATA: Hedef kullanıcı (" + data.to + ") bulunamadı veya çevrimdışı!");
            console.log("🔍 İPUCU: Hedefin ID'si listede var mı? -> " + Object.keys(users).join(", "));
        }
        console.log("------------------------------------------------");
    }

    // 3. DİĞER SİNYALLER (Offer/Answer)
    else if (['offer', 'answer', 'candidate'].includes(data.type)) {
        const targetClient = users[data.to];
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
            targetClient.send(message);
            // Sinyal loglarını kalabalık etmemek için yazmıyoruz
        }
    }
});

  ws.on('close', function() {
      if (ws.userId) {
          delete users[ws.userId];
          console.log("🔻 ÇIKIŞ: " + ws.userId + " ayrıldı.");
      }
  });
  
  ws.on('error', function(error) {
      console.log("⚠️ HATA: Socket hatası: " + error);
  });
});
