const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });

console.log("🔥 BUZ Sunucusu (Akıllı Harf Düzeltme Modu) Çalışıyor...");

let users = {};

wss.on('connection', function connection(ws) {
  
  // Bağlantı kopmasın diye kalp atışı
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', function incoming(message) {
    let data;
    try {
        data = JSON.parse(message);
    } catch (e) { return; }

    // --- KRİTİK DÜZELTME: HER ŞEYİ BÜYÜK HARFE ÇEVİR ---
    // Gelen ID ne olursa olsun (buz, BuZ, bUz) hepsini BUZ yapar.
    if (data.userId) data.userId = data.userId.trim().toUpperCase();
    if (data.to) data.to = data.to.trim().toUpperCase();
    if (data.from) data.from = data.from.trim().toUpperCase();
    // ----------------------------------------------------

    // 1. GİRİŞ (LOGIN)
    if (data.type === 'login') {
        users[data.userId] = ws;
        ws.userId = data.userId;
        
        console.log("✅ GİRİŞ: [" + data.userId + "]");
        printOnlineUsers(); 
    } 
    
    // 2. SES GÖNDERİMİ
    else if (data.type === 'audio_msg') {
        console.log("📨 MESAJ: [" + data.from + "] --> [" + data.to + "]");
        
        const targetClient = users[data.to];
        
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
            // Mesajı hedefe ilet (Veriyi string olarak tekrar paketle)
            targetClient.send(JSON.stringify(data));
            console.log("🚀 BAŞARILI: İletildi.");
        } else {
            console.log("⛔ HATA: Hedef [" + data.to + "] bulunamadı!");
            printOnlineUsers(); // Listeyi göster ki hatayı görelim
        }
    }
    
    // 3. PING (Boş geç)
    else if (data.type === 'ping') { }
  });

  ws.on('close', function() {
      if (ws.userId) {
          delete users[ws.userId];
          console.log("🔻 KOPTU: [" + ws.userId + "]");
      }
  });
});

function printOnlineUsers() {
    const onlineList = Object.keys(users);
    console.log("📋 ONLİNE LİSTESİ: " + onlineList.join(", "));
    console.log("------------------------------------------------");
}

// 30 saniyede bir ölü bağlantıları temizle
setInterval(function ping() {
  wss.clients.forEach(function each(ws) {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
