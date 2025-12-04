const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });

console.log("🔍 DETAYLI LOG SUNUCUSU ÇALIŞIYOR...");

// Kullanıcı Listesi
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

    // --- GİRİŞ (LOGIN) ---
    if (data.type === 'login') {
        // ID'leri temizle (Boşlukları sil)
        const cleanId = data.userId.trim();
        users[cleanId] = ws;
        ws.userId = cleanId;
        
        console.log("✅ GİRİŞ YAPILDI: [" + cleanId + "]");
        printOnlineUsers(); // Listeyi ekrana bas
    } 
    
    // --- SES GÖNDERİMİ ---
    else if (data.type === 'audio_msg') {
        const targetId = data.to.trim();
        console.log("📨 MESAJ İSTEĞİ: [" + data.from + "] --> [" + targetId + "]");
        
        const targetClient = users[targetId];
        
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
            targetClient.send(message);
            console.log("🚀 BAŞARILI: Paket hedefe teslim edildi.");
        } else {
            console.log("⛔ HATA: Hedef [" + targetId + "] bulunamadı!");
            console.log("   👉 İPUCU: Hedef telefonun interneti kopmuş veya ID yanlış.");
            printOnlineUsers(); // Kimlerin online olduğunu göster ki hatanı anla
        }
    }
    
    // --- PING ---
    else if (data.type === 'ping') {
        // Pingleri loglayıp ekranı kirletmeyelim
    }
  });

  ws.on('close', function() {
      if (ws.userId) {
          delete users[ws.userId];
          console.log("🔻 KOPTU: [" + ws.userId + "]");
      }
  });
});

// Yardımcı Fonksiyon: Online Listesini Yazdır
function printOnlineUsers() {
    const onlineList = Object.keys(users);
    console.log("📋 ŞU AN ONLİNE OLANLAR (" + onlineList.length + "): " + onlineList.join(", "));
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
