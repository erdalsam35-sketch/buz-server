const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

console.log("🔥 BUZ Sunucusu (YANKI MODU AKTİF) Çalışıyor...");

let users = {}; 
let groups = {}; 

wss.on('connection', function connection(ws) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', function incoming(message) {
    let data;
    try { data = JSON.parse(message); } catch (e) { return; }

    if (data.type === 'login') {
        const userId = data.userId.toString().trim().toUpperCase();
        users[userId] = ws;
        ws.userId = userId;
        console.log("✅ GİRİŞ: [" + userId + "]");
    } 
    
    else if (data.type === 'join_group') {
        const userId = data.userId.toString().trim().toUpperCase();
        const groupName = data.groupName.toString().trim().toUpperCase();
        if (!groups[groupName]) groups[groupName] = [];
        if (!groups[groupName].includes(userId)) groups[groupName].push(userId);
        ws.currentGroup = groupName; 
        console.log("➕ GRUP: [" + userId + "] --> [" + groupName + "]");
    }

    else if (data.type === 'audio_msg') {
        const groupName = data.to.toString().trim().toUpperCase();
        const senderId = data.from.toString().trim().toUpperCase();
        
        console.log("🎤 SES GELDİ: [" + senderId + "] --> Kanal: [" + groupName + "]");

        if (groups[groupName]) {
            const members = groups[groupName];
            let sentCount = 0;
            
            members.forEach(memberId => {
                // --- DEĞİŞİKLİK BURADA: KENDİNE DE GÖNDER (YANKI) ---
                // if (memberId !== senderId) {  <-- BU SATIRI İPTAL ETTİK
                    const targetClient = users[memberId];
                    if (targetClient && targetClient.readyState === WebSocket.OPEN) {
                        targetClient.send(message);
                        sentCount++;
                    }
                // }
            });
            console.log("🚀 DAĞITILDI: " + sentCount + " kişiye (Siz dahil).");
        }
    }
  });

  ws.on('close', function() {
      if (ws.userId) {
          delete users[ws.userId];
          for (const group in groups) {
              groups[group] = groups[group].filter(id => id !== ws.userId);
          }
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
