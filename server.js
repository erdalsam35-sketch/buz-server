const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

console.log("🔥 BUZ Grup Telsiz Sunucusu Çalışıyor...");

// Kullanıcılar ve Gruplar
let users = {}; // { "USER_ID": ws }
let groups = {}; // { "GRUP_ADI": ["USER_ID_1", "USER_ID_2"] }

wss.on('connection', function connection(ws) {
  
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', function incoming(message) {
    let data;
    try { data = JSON.parse(message); } catch (e) { return; }

    // 1. GİRİŞ (LOGIN)
    if (data.type === 'login') {
        const userId = data.userId.trim().toUpperCase();
        users[userId] = ws;
        ws.userId = userId;
        console.log("✅ GİRİŞ: " + userId);
    } 
    
    // 2. GRUBA KATILMA (YENİ ÖZELLİK)
    else if (data.type === 'join_group') {
        const userId = data.userId.trim().toUpperCase();
        const groupName = data.groupName.trim().toUpperCase();
        
        // Eğer grup yoksa oluştur
        if (!groups[groupName]) {
            groups[groupName] = [];
        }
        
        // Kullanıcı zaten grupta değilse ekle
        if (!groups[groupName].includes(userId)) {
            groups[groupName].push(userId);
        }
        
        // Kullanıcının aktif grubunu socket'e kaydet
        ws.currentGroup = groupName;
        
        console.log("📢 GRUP: [" + userId + "] --> [" + groupName + "] kanalına katıldı.");
        console.log("   👥 Gruptakiler: " + groups[groupName].join(", "));
    }

    // 3. SES GÖNDERİMİ (HERKESE DAĞIT)
    else if (data.type === 'audio_msg') {
        const groupName = data.to.trim().toUpperCase(); // Hedef artık bir Grup Adı
        const senderId = data.from.trim().toUpperCase();
        
        console.log("aaa SES YAYINI: [" + groupName + "] kanalına...");

        if (groups[groupName]) {
            // Gruptaki herkesi döngüye al
            groups[groupName].forEach(memberId => {
                // Gönderen kişinin kendisine geri yollama!
                if (memberId !== senderId) {
                    const targetClient = users[memberId];
                    if (targetClient && targetClient.readyState === WebSocket.OPEN) {
                        targetClient.send(message);
                    }
                }
            });
            console.log("🚀 YAYIN YAPILDI (" + (groups[groupName].length - 1) + " kişiye).");
        } else {
            console.log("⛔ GRUP BULUNAMADIveya BOŞ.");
        }
    }
    
    // 4. PING
    else if (data.type === 'ping') { }
  });

  // KOPMA DURUMU
  ws.on('close', function() {
      if (ws.userId) {
          // Kullanıcıyı genel listeden sil
          delete users[ws.userId];
          
          // Kullanıcıyı bulunduğu gruptan da çıkar
          if (ws.currentGroup && groups[ws.currentGroup]) {
              groups[ws.currentGroup] = groups[ws.currentGroup].filter(id => id !== ws.userId);
          }
          console.log("🔻 ÇIKIŞ: " + ws.userId);
      }
  });
});

// Keep-Alive
setInterval(function ping() {
  wss.clients.forEach(function each(ws) {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
