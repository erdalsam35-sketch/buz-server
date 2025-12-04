// server.js - Basit WebRTC Sinyalleşme Sunucusu

const WebSocket = require('ws');

// Sunucuyu 8080 portunda başlat
const wss = new WebSocket.Server({ port: 8080 });

console.log("BUZ Sinyalleşme Sunucusu 8080 portunda çalışıyor...");

// Bağlı kullanıcıları tutacağımız liste
// Format: { "kullanici_id": socket_baglantisi }
let users = {};

wss.on('connection', function connection(ws) {
  
  ws.on('message', function incoming(message) {
    // Gelen mesajı JSON'a çevir
    let data;
    try {
        data = JSON.parse(message);
    } catch (e) {
        console.log("Hatalı JSON formatı");
        return;
    }

    // 1. KULLANICI GİRİŞİ (LOGIN)
    if (data.type === 'login') {
        console.log("Kullanıcı bağlandı: " + data.userId);
        users[data.userId] = ws;
        ws.userId = data.userId;
    } 
    
    // 2. SİNYAL YÖNLENDİRME (OFFER, ANSWER, ICE)
    else if (data.type === 'offer' || data.type === 'answer' || data.type === 'candidate') {
        console.log("Sinyal gönderiliyor: " + data.type + " -> " + data.to);
        
        // Hedef kullanıcıyı bul
        const targetClient = users[data.to];
        
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
            // Mesajı olduğu gibi hedefe ilet
            targetClient.send(JSON.stringify(data));
        } else {
            console.log("Hedef kullanıcı bulunamadı veya çevrimdışı: " + data.to);
        }
    }
  });

  // Bağlantı koptuğunda
  ws.on('close', function() {
      if (ws.userId) {
          delete users[ws.userId];
          console.log("Kullanıcı ayrıldı: " + ws.userId);
      }
  });
});