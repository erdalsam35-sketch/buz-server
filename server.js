const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

console.log("🔥 BUZ Grup Telsiz Sunucusu (V3.0 - Güvenli) Çalışıyor...");

let users = {}; // { USER_ID: ws }
let groups = {}; // { GRUP_ADI: [USER_ID_1, USER_ID_2] }

wss.on('connection', function connection(ws) {
  
  // Bağlantı canlılık kontrolü
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', function incoming(message) {
    let data;
    try { 
        data = JSON.parse(message); 
    } catch (e) { 
        console.log("⚠️ Geçersiz JSON verisi geldi.");
        return; 
    }

    // Gelen verinin tipini kontrol et
    if (!data.type) return;

    // --- 1. GİRİŞ (LOGIN) ---
    if (data.type === 'login') {
        // Güvenlik: userId var mı diye bak
        if (!data.userId) return;

        const userId = data.userId.toString().trim().toUpperCase();
        users[userId] = ws;
        ws.userId = userId;
        console.log("✅ GİRİŞ: [" + userId + "]");
    } 
    
    // --- 2. KANALA GİRİŞ (JOIN GROUP) ---
    else if (data.type === 'join_group') {
        if (!data.userId || !data.groupName) return;

        const userId = data.userId.toString().trim().toUpperCase();
        const groupName = data.groupName.toString().trim().toUpperCase();
        
        if (!groups[groupName]) groups[groupName] = [];
        
        // Kullanıcı zaten listede yoksa ekle
        if (!groups[groupName].includes(userId)) {
            groups[groupName].push(userId);
        }
        ws.currentGroup = groupName; 
        
        console.log("➕ GRUP: [" + userId + "] --> [" + groupName + "]");
        console.log("   📊 Üyeler: " + groups[groupName].join(", "));
    }

    // --- 3. SES DAĞITIMI ---
    else if (data.type === 'audio_msg') {
        // Güvenlik: to ve from var mı?
        if (!data.to || !data.from) {
            console.log("⚠️ HATA: Ses paketinde gönderen veya hedef eksik.");
            return;
        }

        const groupName = data.to.toString().trim().toUpperCase();
        const senderId = data.from.toString().trim().toUpperCase();
        
        console.log("------------------------------------------------");
        console.log("🎤 SES YAYINI: [" + senderId + "] --> Kanal: [" + groupName + "]");

        if (groups[groupName]) {
            const members = groups[groupName];
            
            let sentCount = 0;
            members.forEach(memberId => {
                // Gönderen kişi hariç diğerlerine yolla
                if (memberId !== senderId) {
                    const targetClient = users[memberId];
                    // Hedef kullanıcı bağlı mı?
                    if (targetClient && targetClient.readyState === WebSocket.OPEN) {
                        targetClient.send(message);
                        sentCount++;
                    }
                }
            });
            
            if (sentCount > 0) {
                console.log("🚀 BAŞARILI: Ses " + sentCount + " kişiye dağıtıldı.");
            } else {
                console.log("⚠️ UYARI: Grupta başka kimse yok veya herkes çevrimdışı.");
            }
        } else {
            console.log("⛔ HATA: Böyle bir grup yok! (" + groupName + ")");
        }
        console.log("------------------------------------------------");
    }

    // --- 4. MANUAL PING (Android'den gelen) ---
    else if (data.type === 'ping') {
        // Boş cevap, bağlantıyı canlı tutmak için
    }
  });

  // --- KOPMA ---
  ws.on('close', function() {
      if (ws.userId) {
          delete users[ws.userId];
          // Kullanıcıyı tüm gruplardan temizle
          for (const group in groups) {
              groups[group] = groups[group].filter(id => id !== ws.userId);
          }
          console.log("🔻 ÇIKIŞ: " + ws.userId);
      }
  });

  // Hata oluşursa sunucuyu çökertme
  ws.on('error', function(error) {
      console.log("⚠️ Socket Hatası: " + error);
  });
});

// Otomatik Temizlik (30 saniyede bir yanıt vermeyenleri at)
setInterval(function ping() {
  wss.clients.forEach(function each(ws) {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
