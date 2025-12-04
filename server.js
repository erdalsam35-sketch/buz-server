const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

console.log("🔍 DETAYLI GRUP TELSİZ SUNUCUSU ÇALIŞIYOR...");

let users = {}; // { USER_ID: ws }
let groups = {}; // { GRUP_ADI: [USER_ID_1, USER_ID_2] }

wss.on('connection', function connection(ws) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', function incoming(message) {
    let data;
    try { data = JSON.parse(message); } catch (e) { return; }

    // --- 1. GİRİŞ ---
    if (data.type === 'login') {
        const userId = data.userId.trim().toUpperCase();
        users[userId] = ws;
        ws.userId = userId;
        console.log("✅ GİRİŞ: [" + userId + "]");
    } 
    
    // --- 2. KANALA GİRİŞ (KRİTİK NOKTA) ---
    else if (data.type === 'join_group') {
        const userId = data.userId.trim().toUpperCase();
        const groupName = data.groupName.trim().toUpperCase();
        
        if (!groups[groupName]) groups[groupName] = [];
        
        // Kullanıcıyı listeye ekle (Eğer yoksa)
        if (!groups[groupName].includes(userId)) {
            groups[groupName].push(userId);
        }
        ws.currentGroup = groupName; // Kullanıcının bulunduğu odayı kaydet
        
        console.log("➕ GRUP: [" + userId + "] --> [" + groupName + "] kanalına girdi.");
        console.log("   📊 [" + groupName + "] Üyeleri: " + groups[groupName].join(", "));
    }

    // --- 3. SES DAĞITIMI ---
    else if (data.type === 'audio_msg') {
        // Android'den gelen veride 'to' kısmı GRUP ADI olmalı
        const groupName = data.to ? data.to.trim().toUpperCase() : null;
        const senderId = data.from.trim().toUpperCase();
        
        console.log("------------------------------------------------");
        console.log("🎤 SES YAYINI İSTEĞİ: [" + senderId + "] --> Kanal: [" + groupName + "]");

        if (groupName && groups[groupName]) {
            const members = groups[groupName];
            console.log("   👥 Gruptaki Kişiler: " + members.join(", "));
            
            let sentCount = 0;
            members.forEach(memberId => {
                // Kendine gönderme, diğerlerine gönder
                if (memberId !== senderId) {
                    const targetClient = users[memberId];
                    if (targetClient && targetClient.readyState === WebSocket.OPEN) {
                        targetClient.send(message);
                        sentCount++;
                    }
                }
            });
            
            if (sentCount > 0) {
                console.log("🚀 BAŞARILI: Ses " + sentCount + " kişiye gönderildi.");
            } else {
                console.log("⚠️ UYARI: Grupta senden başka kimse yok veya diğerleri çevrimdışı!");
            }
        } else {
            console.log("⛔ HATA: Böyle bir grup yok veya boş! (" + groupName + ")");
        }
        console.log("------------------------------------------------");
    }
  });

  // --- KOPMA ---
  ws.on('close', function() {
      if (ws.userId) {
          delete users[ws.userId];
          // Gruplardan da çıkar
          for (const group in groups) {
              groups[group] = groups[group].filter(id => id !== ws.userId);
          }
          console.log("🔻 ÇIKIŞ: " + ws.userId);
      }
  });
});

setInterval(function ping() {
  wss.clients.forEach(function each(ws) {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
