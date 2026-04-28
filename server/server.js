const http = require('http');
const crypto = require('crypto');
const puppeteer = require('puppeteer-core');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const PLAYERS_FILE = '/app/players.json';

function loadData() {
  try {
    if (fs.existsSync(PLAYERS_FILE)) {
      return JSON.parse(fs.readFileSync(PLAYERS_FILE, 'utf8'));
    }
  } catch(e) {}
  return { sessions: [], activeSessionId: null };
}

function saveData(data) {
  try {
    fs.writeFileSync(PLAYERS_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch(e) { return false; }
}

function generateId() {
  return Math.random().toString(36).substr(2, 8).toUpperCase();
}

function generatePin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function assignRoles(players, nbTraitres) {
  var ids = players.map(function(p) { return p.id; });
  var shuffled = ids.slice().sort(function() { return Math.random() - 0.5; });
  var traitres = shuffled.slice(0, nbTraitres);
  players.forEach(function(p) {
    p.role = traitres.indexOf(p.id) >= 0 ? 'traitre' : 'fidele';
    p.pin = generatePin();
  });
  return players;
}

const clients = new Map();

// ===== WEBSOCKET =====
function handshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
}

function decode(buf) {
  let offset = 2;
  let len = buf[1] & 0x7f;
  if (len === 126) { len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  const mask = buf.slice(offset, offset + 4);
  offset += 4;
  const data = Buffer.alloc(len);
  for (let i = 0; i < len; i++) data[i] = buf[offset + i] ^ mask[i % 4];
  return data.toString();
}

function encode(msg) {
  const data = Buffer.from(msg);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81; header[1] = len;
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(len, 2);
  }
  return Buffer.concat([header, data]);
}

function send(socket, obj) {
  try { socket.write(encode(JSON.stringify(obj))); } catch(e) {}
}

function broadcast(sessionId, data, excludeSocket=null) {
  clients.forEach((client, socket) => {
    if (client.sessionId === sessionId && socket !== excludeSocket) send(socket, data);
  });
}
function broadcastToRole(sessionId, role, data) {
  clients.forEach((client, socket) => {
    if (client.sessionId === sessionId && client.role === role) send(socket, data);
  });
}
function broadcastToPlayer(sessionId, playerId, data) {
  clients.forEach((client, socket) => {
    if (client.sessionId === sessionId && client.playerId == playerId) send(socket, data);
  });
}
function broadcastToAdmin(sessionId, data) {
  clients.forEach((client, socket) => {
    if (client.sessionId === sessionId && client.isAdmin) send(socket, data);
  });
}

// ===== PDF =====
async function generatePDF(html) {
  const browser = await puppeteer.launch({
    executablePath: '/opt/google/chrome/chrome',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--single-process']
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500));
    await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 2 });
    const pdf = await page.pdf({
      format: 'A4',
      landscape: false,
      printBackground: true,
      margin: { top: '0', bottom: '0', left: '0', right: '0' }
    });
    return pdf;
  } finally {
    await browser.close();
  }
}

// ===== BADGE BUILDER =====
async function buildBadgesHTML(data) {
  const { players, sessionId } = data;
  const BASE = 'http://192.168.1.30:8181';

  const RAINBOW = '#ff0000, #ff8800, #ffff00, #00cc00, #0088ff, #8800ff, #ff0088, #ff0000';

  function buildRingSVG(photoDataUrl, size) {
    size = size || 136;
    var cx = size / 2, cy = size / 2;
    var R = size / 2, r = R - 8, photoR = r - 4;
    var colors = ['#ff0000','#ff8800','#ffff00','#00cc00','#0088ff','#8800ff','#ff0088','#ff0000'];
    var segCount = colors.length - 1;
    var step = (2 * Math.PI) / segCount;
    function polar(angle, radius) {
      return { x: cx + radius * Math.cos(angle - Math.PI/2), y: cy + radius * Math.sin(angle - Math.PI/2) };
    }
    var arcs = '';
    for (var i = 0; i < segCount; i++) {
      var a1 = i * step, a2 = (i+1) * step;
      var p1o = polar(a1,R), p2o = polar(a2,R), p1i = polar(a1,r), p2i = polar(a2,r);
      var large = (a2 - a1) > Math.PI ? 1 : 0;
      var gid = 'rg'+i;
      arcs += '<defs><linearGradient id="'+gid+'" x1="'+p1o.x+'" y1="'+p1o.y+'" x2="'+p2o.x+'" y2="'+p2o.y+'" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="'+colors[i]+'"/><stop offset="100%" stop-color="'+colors[i+1]+'"/></linearGradient></defs>';
      arcs += '<path d="M '+p1o.x+' '+p1o.y+' A '+R+' '+R+' 0 '+large+' 1 '+p2o.x+' '+p2o.y+' L '+p2i.x+' '+p2i.y+' A '+r+' '+r+' 0 '+large+' 0 '+p1i.x+' '+p1i.y+' Z" fill="url(#'+gid+')"/>';
    }
    var clipId = 'pc'+Math.random().toString(36).slice(2,7);
    var photoContent = photoDataUrl
      ? '<image href="'+photoDataUrl+'" x="'+(cx-photoR)+'" y="'+(cy-photoR)+'" width="'+(photoR*2)+'" height="'+(photoR*2)+'" clip-path="url(#'+clipId+')" preserveAspectRatio="xMidYMid slice"/>'
      : '<circle cx="'+cx+'" cy="'+cy+'" r="'+photoR+'" fill="#444466"/><text x="'+cx+'" y="'+(cy+6)+'" text-anchor="middle" font-size="28" fill="#aaaacc">?</text>';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="'+size+'" height="'+size+'" viewBox="0 0 '+size+' '+size+'"><defs><clipPath id="'+clipId+'"><circle cx="'+cx+'" cy="'+cy+'" r="'+photoR+'"/></clipPath></defs><circle cx="'+cx+'" cy="'+cy+'" r="'+R+'" fill="#303040"/>'+arcs+photoContent+'</svg>';
  }

  function nameFontSize(name) {
    if (!name) return '13px';
    if (name.length <= 6)  return '15px';
    if (name.length <= 10) return '13px';
    if (name.length <= 14) return '11px';
    return '9px';
  }

  const badgesHTML = await Promise.all(players.map(async function(p) {
    var url = BASE+'?session='+sessionId+'&pid='+p.id+'&role='+p.role+'&name='+encodeURIComponent(p.name)+'&pin='+p.pin;
    var qrDataUrl = await QRCode.toDataURL(url, { width:49, margin:1, color:{dark:'#000000',light:'#ffffff'} });

    var ringSVG = buildRingSVG(p.photo || null, 136);
    var ringSVG64 = Buffer.from(ringSVG).toString('base64');
    var ringDataUrl = 'data:image/svg+xml;base64,'+ringSVG64;

    var fs = nameFontSize(p.name);

    return '<div style="width:9cm;height:6cm;position:relative;border-radius:6px;overflow:hidden;background-color:#303040;border:1.5px solid #5a5a8a;box-sizing:border-box;page-break-inside:avoid;display:flex;flex-direction:column;align-items:center;">'
      +'<div style="width:100%;height:6px;flex-shrink:0;background:linear-gradient(90deg,'+RAINBOW+');-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>'
      +'<div style="position:absolute;top:6px;left:0;width:14px;height:14px;overflow:hidden;line-height:0"><svg xmlns=\'http://www.w3.org/2000/svg\' width=\'14\' height=\'14\'><polygon points=\'0,0 14,0 0,14\' fill=\'#5533aa\' opacity=\'0.7\'/></svg></div>'
      +'<div style="position:absolute;top:6px;right:0;width:14px;height:14px;overflow:hidden;line-height:0"><svg xmlns=\'http://www.w3.org/2000/svg\' width=\'14\' height=\'14\'><polygon points=\'14,0 14,14 0,0\' fill=\'#5533aa\' opacity=\'0.7\'/></svg></div>'
      +'<div style="position:absolute;bottom:0;left:0;width:14px;height:14px;overflow:hidden;line-height:0"><svg xmlns=\'http://www.w3.org/2000/svg\' width=\'14\' height=\'14\'><polygon points=\'0,0 14,14 0,14\' fill=\'#5533aa\' opacity=\'0.7\'/></svg></div>'
      +'<div style="position:absolute;bottom:0;right:0;width:14px;height:14px;overflow:hidden;line-height:0"><svg xmlns=\'http://www.w3.org/2000/svg\' width=\'14\' height=\'14\'><polygon points=\'14,0 14,14 0,14\' fill=\'#5533aa\' opacity=\'0.7\'/></svg></div>'
      +'<span style="position:absolute;top:9px;left:4px;font-size:7px;color:#f0c040;opacity:0.6;">✦</span>'
      +'<span style="position:absolute;top:9px;right:4px;font-size:7px;color:#f0c040;opacity:0.6;">✦</span>'
      +'<div style="font-size:7.5px;letter-spacing:1.5px;color:rgba(200,180,255,0.6);text-align:center;margin-top:3px;font-family:Georgia,serif;text-transform:uppercase;">✦ LES TRAÎTRES ✦</div>'
      +'<div style="margin-top:3px;width:136px;height:136px;flex-shrink:0;"><img src="'+ringDataUrl+'" width="136" height="136" style="display:block;"/></div>'
      +'<div style="display:flex;width:44px;height:2px;margin-top:4px;flex-shrink:0;"><span style="flex:1;background:#7744cc;display:block;"></span><span style="flex:1;background:#cc2244;display:block;"></span></div>'
      +'<div style="color:#e8e0ff;font-family:Georgia,serif;font-weight:bold;letter-spacing:0.5px;text-align:center;width:100%;padding:0 8px;margin-top:4px;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:'+fs+';">'+p.name+'</div>'
      +'<div style="position:absolute;bottom:5px;right:5px;opacity:0.55;line-height:0;"><img src="'+qrDataUrl+'" width="49" height="49" style="display:block;image-rendering:pixelated;"/></div>'
      +'</div>';
  }));

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>@page{size:A4 portrait;margin:8mm}*{margin:0;padding:0;box-sizing:border-box}body{background:white;-webkit-print-color-adjust:exact;print-color-adjust:exact}.grid{display:grid;grid-template-columns:repeat(2,9cm);grid-auto-rows:6cm;gap:4mm;justify-content:center}</style></head><body><div class="grid">'+badgesHTML.join('')+'</div></body></html>';
}
// ===== AFFICHE BUILDER =====
async function buildAfficheHTML(data) {
  const { players } = data;
  const RAINBOW = '#ff0000, #ff8800, #ffff00, #00cc00, #0088ff, #8800ff, #ff0088, #ff0000';

  function nameFontSize(name) {
    if (!name) return '52pt';
    if (name.length <= 5)  return '72pt';
    if (name.length <= 8)  return '58pt';
    if (name.length <= 12) return '46pt';
    return '36pt';
  }

  const pages = players.map(function(p) {
    var fs = nameFontSize(p.name);
    var isTreason = p.role === 'traitre';

    var photoHTML = p.photo
      ? '<img src="'+(p.photoFull||p.photo)+'" style="position:absolute;top:22mm;left:10mm;right:10mm;bottom:38mm;width:calc(100% - 20mm);height:calc(100% - 60mm);object-fit:cover;object-position:center 20%;filter:sepia(0.75) contrast(1.05) brightness(0.95);display:block;">'
      : '<div style="position:absolute;top:22mm;left:10mm;right:10mm;bottom:38mm;background:#1e1e2e;display:flex;align-items:center;justify-content:center;font-size:100px;opacity:.15;border-radius:4px;mix-blend-mode:luminosity;">👤</div>';

    return '<div style="width:210mm;height:297mm;position:relative;overflow:hidden;background:#303040;page-break-after:always;box-sizing:border-box;">'

      // Liseré arc-en-ciel haut
      +'<div style="position:absolute;top:0;left:0;right:0;height:8px;background:linear-gradient(90deg,'+RAINBOW+');-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>'

      // Liseré arc-en-ciel bas
      +'<div style="position:absolute;bottom:0;left:0;right:0;height:8px;background:linear-gradient(90deg,'+RAINBOW+');-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>'

      // Coins décoratifs violets
      +'<div style="position:absolute;top:8px;left:0;width:20px;height:20px;overflow:hidden;line-height:0;"><svg xmlns=\'http://www.w3.org/2000/svg\' width=\'20\' height=\'20\'><polygon points=\'0,0 20,0 0,20\' fill=\'#5533aa\' opacity=\'0.8\'/></svg></div>'
      +'<div style="position:absolute;top:8px;right:0;width:20px;height:20px;overflow:hidden;line-height:0;"><svg xmlns=\'http://www.w3.org/2000/svg\' width=\'20\' height=\'20\'><polygon points=\'20,0 20,20 0,0\' fill=\'#5533aa\' opacity=\'0.8\'/></svg></div>'
      +'<div style="position:absolute;bottom:8px;left:0;width:20px;height:20px;overflow:hidden;line-height:0;"><svg xmlns=\'http://www.w3.org/2000/svg\' width=\'20\' height=\'20\'><polygon points=\'0,0 20,20 0,20\' fill=\'#5533aa\' opacity=\'0.8\'/></svg></div>'
      +'<div style="position:absolute;bottom:8px;right:0;width:20px;height:20px;overflow:hidden;line-height:0;"><svg xmlns=\'http://www.w3.org/2000/svg\' width=\'20\' height=\'20\'><polygon points=\'20,0 20,20 0,20\' fill=\'#5533aa\' opacity=\'0.8\'/></svg></div>'

      // Étoiles dorées coins
      +'<span style="position:absolute;top:12px;left:6px;font-size:11px;color:#f0c040;opacity:0.6;">✦</span>'
      +'<span style="position:absolute;top:12px;right:6px;font-size:11px;color:#f0c040;opacity:0.6;">✦</span>'

      // Titre haut
      +'<div style="position:absolute;top:10px;left:0;right:0;text-align:center;font-family:Georgia,serif;font-size:11pt;letter-spacing:.3em;color:rgba(200,180,255,0.6);font-weight:bold;">✦ &nbsp; LES TRAÎTRES &nbsp; ✦</div>'

      // Photo (réduite, marges haut/bas pour les titres)
      + photoHTML

      // Dégradé bas sur la photo pour faire ressortir le nom
      +'<div style="position:absolute;left:10mm;right:10mm;bottom:38mm;height:60mm;background:linear-gradient(to top,#303040 0%,rgba(48,48,64,0.85) 30%,rgba(48,48,64,0.3) 60%,transparent 100%);border-radius:0 0 4px 4px;"></div>'

      // Séparateur bicolore
      +'<div style="position:absolute;bottom:34mm;left:50%;transform:translateX(-50%);display:flex;width:60px;height:2px;">'
      +'<span style="flex:1;background:#7744cc;display:block;"></span>'
      +'<span style="flex:1;background:#cc2244;display:block;"></span>'
      +'</div>'

      // Nom
      +'<div style="position:absolute;bottom:14mm;left:0;right:0;text-align:center;font-family:Georgia,serif;font-size:'+fs+';font-weight:900;color:#f0c040;letter-spacing:.04em;line-height:1;text-shadow:2px 2px 8px rgba(0,0,0,.9),0 0 30px rgba(240,192,64,.3);">'+p.name+'</div>'

      // Mention rôle bas discret
      

      +'</div>';
  });

  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>@page{size:A4 portrait;margin:0}*{margin:0;padding:0;box-sizing:border-box}body{-webkit-print-color-adjust:exact;print-color-adjust:exact;background:#303040}</style></head><body>'+pages.join('')+'</body></html>';
}
// ===== HTTP SERVER =====
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // ===== ROUTES SESSIONS =====

  if (req.url === '/sessions' && req.method === 'GET') {
    var data = loadData();
    res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
    res.end(JSON.stringify(data));
    return;
  }

  if (req.url === '/sessions/create' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      var msg = JSON.parse(body);
      var data = loadData();
      if (data.sessions.length >= 10) {
        res.writeHead(400, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({error:'Maximum 10 sessions'}));
        return;
      }
      var nbPlayers = msg.nbPlayers || 13;
      var nbTraitres = msg.nbTraitres || 2;
      var players = [];
      for (var i = 1; i <= nbPlayers; i++) {
        players.push({id:i, name:'', role:'fidele', pin:generatePin(), photo:null, photoFull:null, absent:false});
      }
      players = assignRoles(players, nbTraitres);
      var session = {
        id: generateId(),
        name: msg.name || ('Partie du ' + new Date().toLocaleDateString('fr-FR')),
        created: new Date().toISOString(),
        status: 'draft',
        players: players,
        maxPlayers: nbPlayers,
        nbTraitres: nbTraitres,
        lastSaved: new Date().toISOString()
      };
      data.sessions.push(session);
      saveData(data);
      res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify(session));
    });
    return;
  }

  if (req.url === '/sessions/activate' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      var msg = JSON.parse(body);
      var data = loadData();
      var session = data.sessions.find(function(s) { return s.id === msg.sessionId; });
      if (!session) {
        res.writeHead(404, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({error:'Session non trouvee'}));
        return;
      }
      global._gameRegistry = global._gameRegistry || {};
      global._gameRegistry[session.id] = {
        players: session.players.filter(function(p) { return !p.absent; }),
        nextId: session.maxPlayers + 1,
        maxPlayers: session.maxPlayers
      };
      data.activeSessionId = session.id;
      session.status = 'active';
      session.lastSaved = new Date().toISOString();
      saveData(data);
      res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify(session));
    });
    return;
  }

  if (req.url === '/sessions/save' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      var msg = JSON.parse(body);
      var data = loadData();
      var idx = data.sessions.findIndex(function(s) { return s.id === msg.sessionId; });
      if (idx < 0) {
        res.writeHead(404, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({error:'Session non trouvee'}));
        return;
      }
      data.sessions[idx].players = msg.players || data.sessions[idx].players;
      data.sessions[idx].nbTraitres = msg.nbTraitres || data.sessions[idx].nbTraitres;
      data.sessions[idx].lastSaved = new Date().toISOString();
      saveData(data);
      res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({ok:true}));
    });
    return;
  }

  if (req.url === '/sessions/save-player' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      var msg = JSON.parse(body);
      var data = loadData();
      var session = data.sessions.find(function(s) { return s.id === msg.sessionId; });
      if (!session) {
        res.writeHead(404, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({error:'Session non trouvee'}));
        return;
      }
      var player = session.players.find(function(p) { return p.id === msg.playerId; });
      if (!player) {
        res.writeHead(404, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
        res.end(JSON.stringify({error:'Joueur non trouve'}));
        return;
      }
      if (msg.name !== undefined) player.name = msg.name;
      if (msg.photo !== undefined) player.photo = msg.photo;
      if (msg.photoFull !== undefined) player.photoFull = msg.photoFull;
      session.lastSaved = new Date().toISOString();
      saveData(data);
      res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({ok:true}));
    });
    return;
  }

  if (req.url === '/sessions/toggle-absent' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      var msg = JSON.parse(body);
      var data = loadData();
      var session = data.sessions.find(function(s) { return s.id === msg.sessionId; });
      if (!session) { res.writeHead(404,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify({error:'Session non trouvee'})); return; }
      var player = session.players.find(function(p) { return p.id === msg.playerId; });
      if (!player) { res.writeHead(404,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify({error:'Joueur non trouve'})); return; }
      player.absent = !player.absent;
      session.lastSaved = new Date().toISOString();
      saveData(data);
      res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({ok:true, absent:player.absent}));
    });
    return;
  }

  if (req.url === '/sessions/reassign-roles' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      var msg = JSON.parse(body);
      var data = loadData();
      var session = data.sessions.find(function(s) { return s.id === msg.sessionId; });
      if (!session) { res.writeHead(404,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}); res.end(JSON.stringify({error:'Session non trouvee'})); return; }
      var actifs = session.players.filter(function(p) { return !p.absent; });
      var nbT = session.nbTraitres || 2;
      // Redistribuer rôles sur les actifs uniquement, préserver noms/photos
      var ids = actifs.map(function(p){return p.id;});
      var shuffled = ids.slice().sort(function(){return Math.random()-.5;});
      var traitres = shuffled.slice(0, nbT);
      actifs.forEach(function(p){
        p.role = traitres.indexOf(p.id) >= 0 ? 'traitre' : 'fidele';
        p.pin = generatePin();
      });
      session.lastSaved = new Date().toISOString();
      saveData(data);
      res.writeHead(200,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({ok:true, players:session.players}));
    });
    return;
  }

  if (req.url === '/sessions/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      var msg = JSON.parse(body);
      var data = loadData();
      data.sessions = data.sessions.filter(function(s) { return s.id !== msg.sessionId; });
      if (data.activeSessionId === msg.sessionId) data.activeSessionId = null;
      saveData(data);
      res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({ok:true}));
    });
    return;
  }

  if (req.url === '/sessions/finish' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      var msg = JSON.parse(body);
      var data = loadData();
      var session = data.sessions.find(function(s) { return s.id === msg.sessionId; });
      if (session) {
        session.status = 'finished';
        session.lastSaved = new Date().toISOString();
        if (data.activeSessionId === msg.sessionId) data.activeSessionId = null;
      }
      saveData(data);
      res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({ok:true}));
    });
    return;
  }

  if (req.url === '/sessions/reset-all' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      var msg = JSON.parse(body);
      var data = loadData();
      var session = data.sessions.find(function(s) { return s.id === msg.sessionId; });
      if (session) {
        session.players = assignRoles(
          session.players.map(function(p) {
            return {id:p.id, name:'', role:'fidele', pin:generatePin(), photo:null, photoFull:null, absent:false};
          }),
          session.nbTraitres
        );
        session.status = 'draft';
        session.lastSaved = new Date().toISOString();
        if (data.activeSessionId === msg.sessionId) data.activeSessionId = null;
      }
      saveData(data);
      res.writeHead(200, {'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});
      res.end(JSON.stringify({ok:true}));
    });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST','Access-Control-Allow-Headers':'Content-Type'});
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/generate-badges') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const html = await buildBadgesHTML(data);
        const pdf = await generatePDF(html);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="badges-traitres.pdf"',
          'Content-Length': pdf.length
        });
        res.end(pdf);
      } catch(e) {
        console.error('Badge PDF error:', e);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/generate-affiches') {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const html = await buildAfficheHTML(data);
        const pdf = await generatePDF(html);
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'inline; filename="affiches-traitres.pdf"',
          'Content-Length': pdf.length
        });
        res.end(pdf);
      } catch(e) {
        console.error('Affiche PDF error:', e);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'OK' }));
});

// ===== WEBSOCKET =====
server.on('upgrade', (req, socket) => {
  handshake(req, socket);
  let buffer = Buffer.alloc(0);
  clients.set(socket, {});

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 6) {
      let offset = 2;
      let len = buffer[1] & 0x7f;
      if (len === 126) { if (buffer.length < 4) break; len = buffer.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (buffer.length < 10) break; len = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      const totalLen = offset + 4 + len;
      if (buffer.length < totalLen) break;
      const frame = buffer.slice(0, totalLen);
      buffer = buffer.slice(totalLen);
      const opcode = frame[0] & 0x0f;
      if (opcode === 0x08 || opcode === 0x09 || opcode === 0x0a) { continue; }
      let msg;
      try {
        const text = decode(frame);
        msg = JSON.parse(text);
      } catch(e) { continue; }
      switch(msg.type) {
        case 'identify':
          // Conserver le rôle mis à jour par role_update si déjà connu
          var identifyRole = msg.role;
          if(!msg.isAdmin){
            // Priorité au registre serveur — source de vérité pour les rôles
            if(global._gameRegistry && global._gameRegistry[msg.sessionId]){
              var regP = global._gameRegistry[msg.sessionId].players.find(function(x){ return x.id==msg.playerId; });
              if(regP && regP.role) identifyRole = regP.role;
            }
            // Fermer les éventuels doublons de connexion pour ce joueur
            clients.forEach(function(c, s){
              if(s !== socket && c.sessionId===msg.sessionId && c.playerId==msg.playerId && c.role && c.role!=='admin'){
                try{ s.destroy(); }catch(e){}
                clients.delete(s);
              }
            });
          }
          clients.set(socket, { playerId:msg.playerId, playerName:msg.playerName, role:identifyRole, sessionId:msg.sessionId, isAdmin:msg.isAdmin||false });
          send(socket, {type:'connected', playerName:msg.playerName});
          if (!msg.isAdmin) broadcastToAdmin(msg.sessionId, {type:'player_connected', playerId:msg.playerId, playerName:msg.playerName});
          break;
        case 'msg_group': broadcast(msg.sessionId, {type:'msg_group', from:msg.from, text:msg.text, timestamp:Date.now()}); break;
        case 'msg_traitres': broadcastToRole(msg.sessionId, 'traitre', {type:'msg_traitres', from:msg.from, text:msg.text, timestamp:Date.now()}); broadcastToAdmin(msg.sessionId, {type:'msg_traitres', from:msg.from, text:msg.text, timestamp:Date.now()}); break;
        case 'msg_private': broadcastToPlayer(msg.sessionId, msg.targetId, {type:'msg_private', from:'Animateur', text:msg.text, timer:msg.timer||null, timestamp:Date.now()}); break;
        case 'challenge_individual': broadcastToPlayer(msg.sessionId, msg.targetId, {type:'challenge', canal:'individual', text:msg.text, timer:msg.timer||null, endsAt:msg.endsAt||null, timestamp:Date.now()}); broadcastToAdmin(msg.sessionId, {type:'challenge_individual_sent', text:msg.text}); break;
        case 'challenge_group': broadcast(msg.sessionId, {type:'challenge', canal:'group', text:msg.text, timer:msg.timer||null, endsAt:msg.endsAt||null, timestamp:Date.now()}); break;
        case 'challenge_traitres': broadcastToRole(msg.sessionId, 'traitre', {type:'challenge', canal:'traitres', text:msg.text, timer:msg.timer||null, endsAt:msg.endsAt||null, timestamp:Date.now()}); break;
        case 'nuit_ouverte': broadcastToRole(msg.sessionId, 'traitre', {type:'nuit_ouverte', players:msg.players, endsAt:msg.endsAt}); break;
        case 'nuit_fermee': broadcastToRole(msg.sessionId, 'traitre', {type:'nuit_fermee'}); break;
        case 'vote_nuit': broadcastToAdmin(msg.sessionId, {type:'vote_nuit', fromId:msg.fromId, targetId:msg.targetId}); break;
        case 'sync_registry':
          if(!global._gameRegistry) global._gameRegistry = {};
          global._gameRegistry[msg.sessionId] = {players: msg.players, nextId: msg.nextId||999, maxPlayers: msg.maxPlayers||999};
          break;
        case 'player_register': {
          if(!global._gameRegistry) global._gameRegistry = {};
          if(!global._gameRegistry[msg.sessionId]){
            send(socket, {type:'register_error', message:'Partie introuvable.'});
            break;
          }
          var reg = global._gameRegistry[msg.sessionId];
          // Chercher le premier slot vide (name vide ou absent)
          var slot = reg.players.find(function(p){ return !p.name || p.name.trim() === ''; });
          if(!slot){
            send(socket, {type:'register_error', message:'La partie est complète.'});
            break;
          }
          // Remplir le slot existant
          slot.name = msg.name;
          clients.set(socket, {playerId:slot.id, playerName:msg.name, role:slot.role, sessionId:msg.sessionId, isAdmin:false});
          send(socket, {type:'register_ok', playerId:slot.id, playerName:msg.name, role:slot.role, pin:slot.pin, sessionId:msg.sessionId});
          broadcastToAdmin(msg.sessionId, {type:'player_registered', playerId:slot.id, playerName:msg.name, role:slot.role, pin:slot.pin});
          break;
        }
        case 'role_update':
          // Mettre à jour dans clients
          clients.forEach(function(c, s){
            if(c.sessionId===msg.sessionId && c.playerId==msg.playerId){
              c.role = msg.role;
              clients.set(s, c);
            }
          });
          // Mettre à jour dans le registre si présent
          if(global._gameRegistry && global._gameRegistry[msg.sessionId]){
            var pl = global._gameRegistry[msg.sessionId].players.find(function(x){return x.id===msg.playerId;});
            if(pl){ pl.role=msg.role; }
          }
          break;
        case 'reveal_roles':
          var count = 0;
          clients.forEach(function(client, sock){
            if(client.sessionId===msg.sessionId && !client.isAdmin && client.playerId){
              // Priorité au registre qui contient les rôles modifiés par l'animateur
              var revealRole = client.role;
              if(global._gameRegistry && global._gameRegistry[msg.sessionId]){
                var regPlayer = global._gameRegistry[msg.sessionId].players.find(function(p){ return p.id==client.playerId; });
                if(regPlayer) revealRole = regPlayer.role;
              }
              send(sock, {type:'reveal_role', role:revealRole, pin:client.pin||'0000'});
              count++;
            }
          });

          break;
        case 'player_eliminated':
          // Debug : lister les clients connectés
          broadcastToPlayer(msg.sessionId, msg.playerId, {type:'you_are_eliminated', message:msg.message});
          setTimeout(function(){
            clients.forEach(function(c, s){
              if(c.sessionId===msg.sessionId && c.playerId==msg.playerId && !c.isAdmin){
                try{ s.destroy(); }catch(e){}
                clients.delete(s);
              }
            });
          }, 3000);
          break;
        case 'fin_jeu':
          broadcast(msg.sessionId, {type:'fin_jeu', vainqueur:msg.vainqueur});
          break;
        case 'reset_session':
          var socketsToClose = [];
          clients.forEach(function(client, sock){
            if(client.sessionId && client.sessionId !== msg.newSessionId){
              send(sock, {type:'session_reset'});
              socketsToClose.push(sock);
            }
          });
          setTimeout(function(){
            socketsToClose.forEach(function(sock){
              try{ sock.destroy(); }catch(e){}
              clients.delete(sock);
            });
          }, 500);
          if(global._gameRegistry) global._gameRegistry = {};
          break;
      }
    } // end while
  });

  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

// Ping WS toutes les 25s — évite la coupure Safari iOS après 30s d'inactivité
setInterval(function() {
  clients.forEach(function(client, socket) {
    try { socket.write(Buffer.from([0x89, 0x00])); } catch(e) { clients.delete(socket); }
  });
}, 25000);

server.listen(3002, () => console.log('Traîtres server on port 3002'));
