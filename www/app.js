
// ===================================================
// VARIABLES GLOBALES
// ===================================================
const WS_URL = (location.protocol==='https:' ? 'wss://' : 'ws://') + location.hostname + ':3002';
let players = [], sessionId = '', eliminatedPlayers = new Set(), maxPlayers = 13;
let challenges = [], currentType = 'p', currentTimer = 0, currentChalTimer = 0;
let ws = null, isAdmin = false, myPlayerId = null, myRole = null, myName = null, mySession = null, myPin = null;
let timerInterval = null, pinAttempts = 0, pinBuffer = '', pendingParams = null;
let currentCanal = 'groupe';
let selectedPlayers = new Set();
let votesRecus = {};
var _registerSession = null;

// Stockage photos en mémoire
const photoStore = {};

// ===================================================
// WEBSOCKET
// ===================================================
var _wsReconnectTimer = null;
var _wsConnecting = false;

function connectWS(onOpen) {
  if (_wsConnecting) { if (onOpen && ws && ws.readyState===1) onOpen(); return; }
  if (ws && ws.readyState===1) { if (onOpen) onOpen(); return; }
  if (ws && ws.readyState===0) { return; }
  _wsConnecting = true;
  ws = new WebSocket(WS_URL);
  ws.onopen = function() {
    _wsConnecting = false;
    if (_wsReconnectTimer) { clearTimeout(_wsReconnectTimer); _wsReconnectTimer = null; }
    setWsStatus(true);
    if (onOpen) onOpen();
  };
  ws.onclose = function() {
    _wsConnecting = false;
    setWsStatus(false);
    if (_wsReconnectTimer) return;
    _wsReconnectTimer = setTimeout(function() {
      _wsReconnectTimer = null;
      connectWS(function() {
        if (isAdmin && sessionId) {
          wsSend({type:'identify', playerId:'admin', playerName:'Animateur', role:'admin', sessionId:sessionId, isAdmin:true});
          syncRegistry();
        } else if (myPlayerId && mySession) {
          wsSend({type:'identify', playerId:myPlayerId, playerName:myName, role:myRole, sessionId:mySession, isAdmin:false});
        }
      });
    }, isAdmin ? 4000 : 6000);
  };
  ws.onerror = function() { _wsConnecting = false; setWsStatus(false); };
  ws.onmessage = function(e) { try { handleMsg(JSON.parse(e.data)); } catch(err) {} };
}

function wsSend(obj) { if (ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

function setWsStatus(on) {
  var el = document.getElementById('ws-status');
  if (el) {
    el.className = 'ws-status ' + (on ? 'ws-on' : 'ws-off');
    el.innerHTML = '<span class="dot"></span>' + (on ? 'Connecté' : 'Hors ligne');
  }
  var pel = document.getElementById('player-ws-status');
  if (pel) {
    pel.style.background = on ? 'rgba(30,160,80,.2)' : 'rgba(192,57,43,.2)';
    pel.style.color = on ? '#50e090' : '#ff8080';
    pel.style.borderColor = on ? 'rgba(30,160,80,.3)' : 'rgba(192,57,43,.3)';
    pel.textContent = on ? '⚡ En ligne' : '⚡ Hors ligne';
  }
  var roleScreen = document.getElementById('role-screen');
  if (roleScreen) {
    roleScreen.style.outline = on ? '5px solid #00e060' : '5px solid #ff2020';
    roleScreen.style.outlineOffset = '-5px';
  }
}

// ===================================================
// INSCRIPTION JOUEUR
// ===================================================
function submitRegister() {
  var params = new URLSearchParams(window.location.search);
  var hashParams = new URLSearchParams(window.location.hash.replace(/^#/,''));
  if(!params.get('join') && hashParams.get('join')) params = hashParams;
  if (window._joinMode) {
    var pinInput = document.getElementById('join-pin-input');
    var pin = pinInput ? pinInput.value.trim() : '';
    if (pin.length !== 4 || !/^[0-9]+$/.test(pin)) {
      document.getElementById('register-error').textContent = 'PIN 4 chiffres requis.'; return;
    }
    if (pin !== params.get('pin')) {
      document.getElementById('register-error').textContent = 'PIN incorrect.'; return;
    }
    var pname = decodeURIComponent(params.get('name') || '');
    document.getElementById('waiting-screen').style.display = 'flex';
    document.getElementById('register-screen').style.display = 'none';
    document.getElementById('waiting-name').textContent = 'Bonjour ' + pname + ' !';
    isAdmin = false; sessionId = '';
    myName = pname;
    mySession = params.get('session');
    myPlayerId = parseInt(params.get('pid'));
    try {
      localStorage.setItem('register_pid', params.get('pid'));
      localStorage.setItem('register_name', pname);
      localStorage.setItem('register_session', params.get('session'));
      localStorage.setItem('register_pin', pin);
    } catch(e) {}
    connectWS(function() {
      wsSend({type:'identify', playerId:parseInt(params.get('pid')), playerName:pname, role:'fidele', sessionId:params.get('session'), isAdmin:false});
    });
    return;
  }
  var name = document.getElementById('register-name-input').value.trim();
  if (!name) { document.getElementById('register-error').textContent = 'Entre ton prénom !'; return; }
  if (name.length < 2) { document.getElementById('register-error').textContent = 'Prénom trop court.'; return; }
  _registerSession = params.get('session');
  myName = name;
  mySession = _registerSession;
  isAdmin = false;
  sessionId = '';
  connectWS(function() {
    wsSend({type:'player_register', sessionId:_registerSession, name:name});
  });
}

function signalPret() {
  var btn = document.getElementById('pret-btn');
  var confirm = document.getElementById('pret-confirm');
  wsSend({type:'msg_groupe', sessionId:mySession, from:'Système', text:'✋ ' + (myName||'Un joueur') + ' est prêt !'});
  btn.className = 'pret-btn done';
  btn.textContent = '✓ Prêt !';
  btn.disabled = true;
  if (confirm) confirm.style.display = 'block';
}

// ===== GESTION SESSIONS =====
var _currentSessionId = null;
var _sessionActive = false;

function getServerBase() {
  return location.protocol + '//' + location.hostname + ':3002';
}

function ouvrirSessionsPopup() {
  var overlay = document.getElementById('sessions-overlay');
  overlay.style.display = 'flex';
  chargerSessions();
}

function fermerSessionsPopup() {
  document.getElementById('sessions-overlay').style.display = 'none';
}

function chargerSessions() {
  fetch(getServerBase() + '/sessions')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      afficherSessions(data.sessions, data.activeSessionId);
    })
    .catch(function() {
      document.getElementById('sessions-list').innerHTML = '<div style="color:#ff8080;text-align:center;">Erreur de chargement</div>';
    });
}

function afficherSessions(sessions, activeId) {
  var list = document.getElementById('sessions-list');
  if (!sessions.length) {
    list.innerHTML = '<div style="color:var(--text-dim);font-style:italic;text-align:center;padding:20px;">Aucune session enregistrée</div>';
    return;
  }
  var html = '';
  // Session active en premier
  var sorted = sessions.slice().sort(function(a,b) {
    if (a.id === activeId) return -1;
    if (b.id === activeId) return 1;
    return new Date(b.created) - new Date(a.created);
  });
  sorted.forEach(function(s) {
    var isActive = s.id === activeId;
    var statusColor = isActive ? '#50e090' : s.status === 'finished' ? 'var(--text-dim)' : 'var(--gold)';
    var statusLabel = isActive ? '● EN COURS' : s.status === 'finished' ? '✓ Terminée' : '○ Draft';
    var date = new Date(s.created).toLocaleDateString('fr-FR');
    var nbActifs = s.players.filter(function(p) { return !p.absent; }).length;
    html += '<div style="background:#25243a;border:1px solid ' + (isActive ? 'rgba(30,160,80,.5)' : 'var(--border)') + ';border-radius:10px;padding:14px 16px;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">';
    html += '<div style="font-family:Cinzel,serif;font-size:14px;color:#fff;">' + s.name + '</div>';
    html += '<span style="font-family:Cinzel,serif;font-size:10px;color:' + statusColor + ';letter-spacing:.08em;">' + statusLabel + '</span>';
    html += '</div>';
    html += '<div style="font-size:13px;color:var(--text-dim);margin-bottom:12px;">' + nbActifs + ' joueurs · ' + date + '</div>';
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap;">';
    if (isActive) {
      html += '<button class="btn btn-teal btn-sm" onclick="reprendreSession(' + JSON.stringify(s.id) + ')">▶ Reprendre</button>';
    } else {
      html += '<button class="btn btn-gold btn-sm" onclick="chargerSession(' + JSON.stringify(s.id) + ')">Charger</button>';
    }
      html += '<button class="btn btn-ghost btn-sm" onclick="supprimerSession(' + JSON.stringify(s.id) + ',' + JSON.stringify(s.name) + ')">Supprimer</button>';
    html += '</div>';
    html += '</div>';
  });
  list.innerHTML = html;
}

function creerSessionNommee() {
  var nom = document.getElementById('new-session-name').value.trim();
  if (!nom) { alert('Saisis un nom pour la session !'); return; }
  var nb = parseInt(document.getElementById('nb-joueurs').value) || 13;
  var nbt = parseInt(document.getElementById('nb-traitres').value) || 2;
  fetch(getServerBase() + '/sessions/create', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({name:nom, nbPlayers:nb, nbTraitres:nbt})
  })
  .then(function(r) { return r.json(); })
  .then(function(session) {
    document.getElementById('new-session-name').value = '';
    chargerSessions();
  });
}

function chargerSession(sessionId) {
  fetch(getServerBase() + '/sessions/activate', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({sessionId:sessionId})
  })
  .then(function(r) { return r.json(); })
  .then(function(session) {
    _currentSessionId = session.id;
    _sessionActive = true;
    sessionId = session.id;
    players = session.players.filter(function(p) { return !p.absent; });
    maxPlayers = session.maxPlayers;
    eliminatedPlayers = new Set();
    isAdmin = true;
    connectWS(function() {
      wsSend({type:'identify', playerId:'admin', playerName:'Animateur', role:'admin', sessionId:session.id, isAdmin:true});
      syncRegistry();
    });
    renderPlayers(); updateProgress(); updateVictimSelect(); updatePrivateTarget(); renderChallenges();
    document.getElementById('scan-progress').style.display = 'block';
    document.getElementById('main-grid').style.display = 'grid';
    document.getElementById('total-count').textContent = players.length;
    document.getElementById('btn-reveal').style.display = 'inline-block';
    document.getElementById('btn-qr-accueil').style.display = 'inline-block';
    document.getElementById('btn-fin-jeu').style.display = 'inline-block';
    document.getElementById('btn-reset').style.display = 'inline-block';
    document.getElementById('btn-nouvelle-partie').disabled = true;
    document.getElementById('btn-partie-enregistree').disabled = true;
    fermerSessionsPopup();
    saveState();
  });
}

function reprendreSession(sessionId) {
  chargerSession(sessionId);
}

function supprimerSession(sessionId, nom) {
  if (!confirm('Supprimer la session "' + nom + '" ?')) return;
  fetch(getServerBase() + '/sessions/delete', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({sessionId:sessionId})
  })
  .then(function() { chargerSessions(); });
}

function nouvellePartie() {
  if (_sessionActive && !confirm('Une session est en cours. Lancer quand même une nouvelle partie sans la sauvegarder ?')) return;
  _currentSessionId = null;
  _sessionActive = false;
  initGame();
  document.getElementById('btn-reset').style.display = 'inline-block';
  document.getElementById('btn-nouvelle-partie').disabled = true;
  document.getElementById('btn-partie-enregistree').disabled = true;
}

function resetPartie() {
  if (!confirm('Tout effacer ? Noms, photos, rôles — la partie sera complètement réinitialisée.')) return;
  if (_currentSessionId) {
    fetch(getServerBase() + '/sessions/reset-all', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({sessionId:_currentSessionId})
    });
  }
  _currentSessionId = null;
  _sessionActive = false;
  resetGame();
  document.getElementById('btn-reset').style.display = 'none';
  document.getElementById('btn-nouvelle-partie').disabled = false;
  document.getElementById('btn-partie-enregistree').disabled = false;
}

function addChallengeToHistory(type, text) {
  var miniCard = document.getElementById('role-mini-card');
  if (!miniCard) return;
  var hist = document.getElementById('challenge-history-list');
  if (!hist) {
    hist = document.createElement('div');
    hist.id = 'challenge-history-list';
    hist.className = 'challenge-history';
    miniCard.appendChild(hist);
  }
  var item = document.createElement('div');
  var cls = type === 'traitres' ? 'traitres' : type === 'individual' ? 'individual' : 'group';
  item.className = 'challenge-history-item ' + cls;
  var label = type === 'traitres' ? 'Mission secrete : ' : type === 'individual' ? 'Pour toi : ' : 'Groupe : ';
  item.textContent = label + text;
  hist.insertBefore(item, hist.firstChild);
  while (hist.children.length > 5) hist.removeChild(hist.lastChild);
}

function printQRAccueil() {
  var url = document.getElementById('qr-accueil-url').textContent;
  var win = window.open('', '_blank', 'width=400,height=500');
  win.document.write('<html><head><title>QR Accueil</title><style>body{font-family:sans-serif;text-align:center;padding:30px;background:#fff;}h2{margin-bottom:8px;}p{font-size:12px;color:#555;word-break:break-all;margin-top:10px;}</style></head><body>');
  win.document.write('<h2>✦ Les Traîtres ✦</h2>');
  win.document.write('<p style="font-size:13px;color:#333;margin-bottom:16px;">Scanne ce QR code pour rejoindre la partie</p>');
  win.document.write(document.getElementById('qrcode-accueil').innerHTML);
  win.document.write('<p>' + url + '</p>');
  win.document.write('</body></html>');
  win.document.close();
  setTimeout(function() { win.print(); }, 500);
}

// ===================================================
// MESSAGE HANDLER
// ===================================================
function handleMsg(msg) {
  if (isAdmin) {
    switch (msg.type) {
      case 'player_connected': markScanned(msg.playerId); break;
      case 'player_registered': handlePlayerRegistered(msg.playerId, msg.playerName, msg.role, msg.pin); break;
      case 'msg_group': addMsgToArea('msg-group-area', 'group', msg.from, msg.text); break;
      case 'msg_traitres': addMsgToArea('msg-traitres-area', 'traitres', msg.from, msg.text); break;
      case 'challenge_individual_sent': addMsgToArea('msg-private-area', 'private', '⚡ Challenge individuel', msg.text); break;
      case 'vote_nuit': handleVoteNuit(msg.fromId, msg.targetId); break;
    }
  } else {
    switch (msg.type) {
      case 'register_error':
        document.getElementById('register-error').textContent = msg.message || 'Inscription impossible.';
        break;
      case 'register_ok':
        myPlayerId = msg.playerId; myRole = msg.role; myPin = msg.pin; mySession = msg.sessionId;
        wsSend({type:'identify', playerId:msg.playerId, playerName:myName, role:msg.role, sessionId:msg.sessionId, isAdmin:false});
        try {
          localStorage.setItem('register_pid', msg.playerId);
          localStorage.setItem('register_name', myName);
          localStorage.setItem('register_session', msg.sessionId);
          localStorage.setItem('register_pin', msg.pin);
          localStorage.setItem('register_role', msg.role);
        } catch(e) {}
        document.getElementById('register-screen').style.display = 'none';
        document.getElementById('waiting-screen').style.display = 'flex';
        document.getElementById('waiting-name').textContent = 'Bonjour ' + myName + ' !';
        break;
      case 'connected':
        if (!document.getElementById('waiting-screen') || document.getElementById('waiting-screen').style.display === 'none') {
          showChatMode();
        }
        break;
      case 'msg_group': addChatMsg(msg.from, msg.text, 'group'); break;
      case 'msg_traitres':
        addChatMsgTo('chat-messages-traitres', '🗡 ' + msg.from, msg.text, 'traitres');
        if (currentCanal !== 'traitres') {
          document.getElementById('tab-traitres-btn').style.boxShadow = '0 0 0 2px #ff6060';
        }
        break;
      case 'msg_private':
        addChatMsgTo('chat-messages-prive', "Animateur", msg.text, 'group');
        if (currentCanal !== 'prive') {
          var _pbtn = document.getElementById('tab-prive-btn');
          if (_pbtn) {
            var _pb = _pbtn.querySelector('.unread-badge');
            if (!_pb) { _pb = document.createElement('span'); _pb.className='unread-badge'; _pb.style.cssText='position:absolute;top:4px;right:4px;min-width:14px;height:14px;border-radius:7px;background:#ff3333;color:#fff;font-size:9px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 3px;'; _pbtn.appendChild(_pb); }
            _pb.textContent = parseInt(_pb.textContent||'0')+1;
          }
        }
        break;
      case 'challenge': if(msg.canal!=='individual' && msg.canal!=='traitres'){try{if(navigator.vibrate)navigator.vibrate([200,100,200]);}catch(e){}} addChallengeToHistory(msg.canal||'group', msg.text); showNotif(msg.canal==='traitres'?'traitres':msg.canal==='individual'?'individual':'challenge', msg.canal==='traitres' ? 'Mission secrète — Traîtres' : msg.canal==='individual' ? 'Mission secrète — Pour toi' : 'Challenge — Tout le groupe', msg.text, msg.timer, msg.endsAt||null); break;
      case 'nuit_ouverte': showVoteNuit(msg.players, msg.endsAt); break;
      case 'nuit_fermee': hideVoteNuit(); break;
      case 'reveal_role':
        myRole = msg.role; myPin = msg.pin;
        if (!myName) myName = localStorage.getItem('register_name') || 'Joueur';
        if (!myPlayerId) myPlayerId = localStorage.getItem('register_pid');
        if (!mySession) mySession = localStorage.getItem('register_session');
        try { localStorage.setItem('register_role', msg.role); localStorage.setItem('register_pin', msg.pin); if(myPlayerId) localStorage.setItem('register_pid', String(myPlayerId)); if(mySession) localStorage.setItem('register_session', mySession); if(myName) localStorage.setItem('register_name', myName); } catch(e) {}
        document.getElementById('waiting-screen').style.cssText = 'display:none!important';
        document.getElementById('register-screen').style.cssText = 'display:none!important';
        document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); s.style.cssText = 'display:none!important'; });
        var rs = document.getElementById('role-screen');
        rs.style.cssText = 'display:flex!important;flex-direction:column;min-height:100vh;';
        renderRolePage(new URLSearchParams('role='+msg.role+'&name='+encodeURIComponent(myName)+'&pid='+myPlayerId+'&session='+mySession+'&pin='+msg.pin));
        break;
      case 'fin_jeu':
        var rsDiv = document.createElement('div');
        rsDiv.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:#0a0508;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:30px;';
        var trophy = msg.vainqueur === 'traitres' ? '🗡' : '🛡';
        var couleur = msg.vainqueur === 'traitres' ? '#ff6060' : 'var(--gold)';
        rsDiv.innerHTML = '<div style="font-size:72px;margin-bottom:24px">'+trophy+'</div>'
          +'<div style="font-family:Cinzel,serif;font-size:28px;font-weight:900;color:'+couleur+';margin-bottom:16px;letter-spacing:.06em">'+(msg.vainqueur==='traitres'?'LES TRAÎTRES ONT GAGNÉ !':'LES LOYAUX ONT GAGNÉ !')+'</div>'
          +'<div style="font-size:18px;color:rgba(255,255,255,.6);font-style:italic;margin-bottom:32px">Merci d\'avoir participé !</div>'
          +'<div style="height:2px;width:60px;background:'+couleur+';margin:0 auto;"></div>';
        document.body.appendChild(rsDiv);
        if (ws) ws.close();
        break;
      case 'you_are_eliminated':
        try { ['register_pid','register_name','register_session','register_pin','register_role'].forEach(function(k){ localStorage.removeItem(k); }); } catch(e) {}
        myPlayerId = null; myRole = null; mySession = null; myPin = null;
        try { if (ws) { ws.onclose = null; ws.close(); } } catch(e) {}
        document.querySelectorAll('.screen').forEach(function(s){ s.classList.remove('active'); s.style.cssText='display:none!important'; });
        (function(){
          var ov = document.createElement('div');
          ov.style.cssText = 'position:fixed;inset:0;background:#0a0305;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:40px 24px;';
          var ic = document.createElement('div'); ic.style.cssText='font-size:64px;margin-bottom:24px;'; ic.textContent='⚔';
          var ti = document.createElement('div'); ti.style.cssText='font-family:Cinzel,serif;font-size:22px;color:#ff4040;letter-spacing:.1em;margin-bottom:20px;'; ti.textContent='TU AS ÉTÉ BANNI';
          var bo = document.createElement('div'); bo.style.cssText='font-size:18px;color:rgba(255,255,255,0.75);line-height:1.7;max-width:300px;'; bo.textContent=msg.message||'Les traîtres t\'ont banni cette nuit.';
          ov.appendChild(ic); ov.appendChild(ti); ov.appendChild(bo);
          document.body.appendChild(ov);
        })();
        break;
      case 'session_reset':
        ws.close();
        try { ['register_pid','register_name','register_session','register_pin','register_role'].forEach(function(k) { localStorage.removeItem(k); }); } catch(e) {}
        var _savedRegSession = _registerSession || '';
        myPlayerId = null; myName = null; myRole = null; mySession = null; myPin = null;
        window.location.href = window.location.pathname + '?session=' + _savedRegSession + '&register=1';
        break;
    }
  }
}

// ===================================================
// PIN
// ===================================================
function generatePin() { return String(Math.floor(1000 + Math.random() * 9000)); }

function showPinScreen(params) {
  pendingParams = params; pinAttempts = 0; pinBuffer = '';
  document.getElementById('pin-player-name').textContent = 'Code secret pour ' + decodeURIComponent(params.get('name') || 'Joueur');
  document.getElementById('pin-error').textContent = '';
  document.getElementById('pin-attempts').textContent = '';
  updatePinDots();
  document.getElementById('admin-screen').classList.remove('active');
  /* pin-screen removed */
}

function pinPress(d) {
  if (pinBuffer.length >= 4) return;
  pinBuffer += d; updatePinDots();
  if (pinBuffer.length === 4) setTimeout(pinValidate, 200);
}

function pinClear() {
  pinBuffer = pinBuffer.slice(0, -1); updatePinDots();
  document.getElementById('pin-error').textContent = '';
}

function updatePinDots() {
  for (var i = 0; i < 4; i++) {
    document.getElementById('pd' + i).className = 'pin-dot' + (i < pinBuffer.length ? ' filled' : '');
  }
}

function pinValidate() {
  if (window._joinMode) {
    var jparams = new URLSearchParams(window.location.search);
    var jexpected = jparams.get('pin');
    if (pinBuffer === jexpected) {
      /* pin-screen removed */
      document.getElementById('waiting-screen').style.display = 'flex';
      document.getElementById('waiting-name').textContent = 'Bonjour ' + decodeURIComponent(jparams.get('name') || '') + ' !';
      isAdmin = false; sessionId = '';
      myName = decodeURIComponent(jparams.get('name') || '');
      mySession = jparams.get('session');
      myPlayerId = parseInt(jparams.get('pid'));
      connectWS(function() {
        wsSend({type:'identify', playerId:parseInt(jparams.get('pid')), playerName:myName, role:'fidele', sessionId:jparams.get('session'), isAdmin:false});
      });
    } else {
      pinAttempts++; pinBuffer = '';
      updatePinDots();
      document.getElementById('pin-error').textContent = 'Code incorrect !';
      if (pinAttempts >= 3) {
        document.querySelectorAll('.pin-key').forEach(function(k) { k.disabled = true; });
        document.getElementById('pin-error').textContent = '🔒 Accès bloqué';
      }
    }
    return;
  }
  var pinExpected = pendingParams.get('pin');
  if (pinBuffer === pinExpected) {
    /* pin-screen removed */
    document.getElementById('role-screen').classList.add('active');
    renderRolePage(pendingParams);
  } else {
    pinAttempts++; pinBuffer = ''; updatePinDots();
    document.getElementById('pin-error').textContent = 'Code incorrect !';
    document.getElementById('pin-attempts').textContent = pinAttempts >= 3
      ? "Accès bloqué — demande à l'animateur"
      : 'Tentative ' + pinAttempts + '/3';
    if (pinAttempts >= 3) {
      document.querySelectorAll('.pin-key').forEach(function(k) { k.disabled = true; });
      document.getElementById('pin-error').textContent = '🔒 Accès bloqué';
    }
  }
}

// ===================================================
// ADMIN — INIT / RESET
// ===================================================
function shuffle(arr) {
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

// Point 4 — fonction centralisée sync_registry
function syncRegistry() {
  wsSend({type:'sync_registry', sessionId:sessionId,
    players: players.map(function(p) { return {id:p.id, name:p.name, role:p.role, pin:p.pin}; }),
    nextId: players.length + 1,
    maxPlayers: maxPlayers
  });
}

function initGame() {
  challenges = [];
  ['msg-group-area','msg-traitres-area','msg-private-area','challenge-list'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.innerHTML = '';
  });
  document.getElementById('eliminated-list').innerHTML = '';
  document.getElementById('votes-nuit-display').innerHTML = '';
  votesRecus = {};
  var n = parseInt(document.getElementById('nb-joueurs').value) || 13;
  var t = parseInt(document.getElementById('nb-traitres').value) || 2;
  var roles = Array(n).fill('fidele');
  var indices = [];
  for (var k = 0; k < n; k++) indices.push(k);
  shuffle(indices).slice(0, t).forEach(function(i) { roles[i] = 'traitre'; });
  maxPlayers = n;
  players = roles.map(function(role, i) { return {id:i+1, name:'', role:role, scanned:false, pin:generatePin()}; });
  eliminatedPlayers = new Set();
  sessionId = Math.random().toString(36).substr(2, 8).toUpperCase();
  isAdmin = true;
  // Point 1 — boutons QR et Révéler affichés immédiatement
  document.getElementById('btn-qr-accueil').style.display = 'inline-block';
  document.getElementById('btn-reveal').style.display = 'inline-block';
  document.getElementById('btn-fin-jeu').style.display = 'inline-block';
  connectWS(function() {
    wsSend({type:'identify', playerId:'admin', playerName:'Animateur', role:'admin', sessionId:sessionId, isAdmin:true});
    syncRegistry();
  });
  // Forcer syncRegistry si WS déjà connecté
  if (ws && ws.readyState === WebSocket.OPEN) syncRegistry();
  renderPlayers(); updateProgress();
  document.getElementById('scan-progress').style.display = 'block';
  document.getElementById('main-grid').style.display = 'grid';
  document.getElementById('total-count').textContent = n;
  updateVictimSelect(); updatePrivateTarget(); renderChallenges();
  saveState();
  renderPlayersBar();
}

function resetGame() {
  if (!confirm('Réinitialiser la partie ? Tout sera effacé.')) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    wsSend({type:'reset_session', sessionId:sessionId, newSessionId:''});
  }
  players = [];
  challenges = [];
  eliminatedPlayers = new Set();
  sessionId = '';
  votesRecus = {};
  localStorage.removeItem('traitres_state');
  Object.keys(localStorage).forEach(function(k) {
    if (k.startsWith('photo_') || k.startsWith('chat_')) localStorage.removeItem(k);
  });
  document.getElementById('eliminated-list').innerHTML = '';
  document.getElementById('votes-nuit-display').innerHTML = '';
  ['msg-group-area','msg-traitres-area','msg-private-area','challenge-list'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.innerHTML = '';
  });
  document.getElementById('scan-progress').style.display = 'none';
  document.getElementById('main-grid').style.display = 'none';
  document.getElementById('nb-joueurs').value = 13;
  document.getElementById('nb-traitres').value = 2;
  document.getElementById('btn-qr-accueil').style.display = 'none';
  document.getElementById('btn-reveal').style.display = 'none';
  document.getElementById('btn-fin-jeu').style.display = 'none';
}

function showQRAccueil() {
  var url = 'http://' + location.hostname + ':8182?session=' + sessionId + '&register=1';
  document.getElementById('qr-accueil-url').textContent = url;
  document.getElementById('qrcode-accueil').innerHTML = '';
  new QRCode(document.getElementById('qrcode-accueil'), {text:url, width:210, height:210, colorDark:'#000', colorLight:'#fff', correctLevel:QRCode.CorrectLevel.H});
  document.getElementById('qr-accueil-modal').classList.add('open');
}

function handlePlayerRegistered(pid, name, role, pin) {
  var existing = players.find(function(p) { return p.id == pid; });
  if (existing) {
    existing.name = name; existing.role = role; existing.pin = pin; existing.scanned = true;
  }
  renderPlayers(); updateProgress(); updateVictimSelect(); updatePrivateTarget();
  saveState();
  syncRegistry();
}

function finDeJeu() {
  var traitresVivants = players.filter(function(p) { return p.role==='traitre' && !eliminatedPlayers.has(p.id); });
  var vainqueur = traitresVivants.length > 0 ? 'traitres' : 'loyaux';
  var msg = vainqueur === 'traitres' ? 'Les traîtres ont gagné !' : 'Les loyaux ont gagné !';
  if (!confirm(msg + '\n\nEnvoyer ce résultat à tous les joueurs et terminer la partie ?')) return;
  wsSend({type:'fin_jeu', sessionId:sessionId, vainqueur:vainqueur});
  // Affichage admin aussi
  var rsDiv = document.createElement('div');
  rsDiv.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:#0a0508;z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:30px;';
  var trophy = vainqueur === 'traitres' ? '🗡' : '🛡';
  var couleur = vainqueur === 'traitres' ? '#ff6060' : 'var(--gold)';
  rsDiv.innerHTML = '<div style="font-size:72px;margin-bottom:24px">'+trophy+'</div>'
    +'<div style="font-family:Cinzel,serif;font-size:28px;font-weight:900;color:'+couleur+';margin-bottom:16px;letter-spacing:.06em">'+(vainqueur==='traitres'?'LES TRAÎTRES ONT GAGNÉ !':'LES LOYAUX ONT GAGNÉ !')+'</div>'
    +'<div style="font-size:18px;color:rgba(255,255,255,.6);font-style:italic;margin-bottom:32px">Merci d\'avoir participé !</div>'
    +'<div style="height:2px;width:60px;background:'+couleur+';margin:0 auto;margin-bottom:32px;"></div>'
    +'<button onclick="location.reload()" style="font-family:Cinzel,serif;font-size:13px;padding:10px 28px;border-radius:20px;background:rgba(240,192,64,.15);border:1px solid var(--gold-dim);color:var(--gold);cursor:pointer;">↺ Nouvelle partie</button>';
  document.body.appendChild(rsDiv);
}

function revealRoles() {
  if (!confirm('Révéler les rôles à tous les joueurs ?')) return;
  wsSend({type:'reveal_roles', sessionId:sessionId});
}

function updateName(id, name) {
  var p = players.find(function(x) { return x.id === id; });
  if (p) { p.name = name || 'Joueur ' + id; updateVictimSelect(); updatePrivateTarget(); saveState(); }
}

function updateProgress() {
  var total = players.filter(function(p) { return !eliminatedPlayers.has(p.id); }).length;
  var scanned = players.filter(function(p) { return !eliminatedPlayers.has(p.id) && p.scanned; }).length;
  document.getElementById('scanned-count').textContent = scanned;
  document.getElementById('total-count').textContent = total;
  document.getElementById('progress-fill').style.width = (total > 0 ? scanned / total * 100 : 0) + '%';
}

function buildURL(player) {
  return 'http://' + location.hostname + ':8182#join=1&session=' + sessionId + '&pid=' + player.id + '&name=' + encodeURIComponent(player.name) + '&pin=' + player.pin;
}

// ===================================================
// RENDER PLAYERS
// ===================================================
function renderPlayers() {
  var grid = document.getElementById('players-grid');
  grid.innerHTML = '';
  players.forEach(function(p) {
    var isElim = eliminatedPlayers.has(p.id);
    var card = document.createElement('div');
    card.className = 'player-card' + (isElim ? ' eliminated-card' : p.scanned ? ' scanned' : '');
    card.id = 'pcard-' + p.id;
    card.innerHTML =
      (isElim ? '<div style="background:rgba(192,57,43,.7);color:#fff;font-family:Cinzel,serif;font-size:10px;letter-spacing:.1em;text-align:center;padding:3px;margin:-16px -16px 10px;border-radius:10px 10px 0 0;">⚔ ÉLIMINÉ</div>' : '') +
      '<div class="player-num">JOUEUR ' + p.id + '</div>' +
      '<input class="player-name-input" value="' + p.name + '" oninput="updateName(' + p.id + ',this.value)" onclick="event.stopPropagation()" placeholder="Prénom">' +
      '<div class="role-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
        '<span class="player-role-badge role-' + p.role + '">' + (p.role==='traitre' ? '🗡 Traître' : '⚔ Fidèle') + '</span>' +
        '<button class="btn btn-ghost btn-sm toggle-role-btn" style="font-size:10px;padding:3px 8px;">⇄</button>' +
      '</div>' +
      // Case "Éliminer cette nuit" visible uniquement sur les cartes traître non éliminées
      (p.role==='traitre' && !isElim
        ? '<label class="traitor-elim-label" style="display:flex;align-items:center;gap:7px;margin-top:8px;cursor:pointer;user-select:none;">' +
            '<input type="checkbox" class="traitor-elim-check" style="width:16px;height:16px;accent-color:#ff6060;cursor:pointer;" onclick="event.stopPropagation()">' +
            '<span style="font-family:\'Cinzel\',serif;font-size:10px;color:rgba(255,120,120,.8);letter-spacing:.06em;">Éliminé cette nuit</span>' +
          '</label>'
        : '') +
      '<div class="player-pin-label">Code PIN</div>' +
      '<div class="player-pin">' + p.pin + '</div>' +
      '<div class="scan-status ' + (p.scanned ? '' : 'waiting') + '"><div class="dot"></div><span>' + (p.scanned ? 'Connecté' : 'En attente') + '</span></div>' +
      '<div class="card-actions"><button class="btn btn-ghost btn-sm" onclick="showQR(' + p.id + ')">QR Code</button></div>';

    // Toggle rôle
    (function(pid) {
      card.querySelector('.toggle-role-btn').addEventListener('click', function(e) {
        e.stopPropagation(); toggleRole(pid);
      });
    })(p.id);

    // Case "Éliminé cette nuit" — traître seulement
    if (p.role === 'traitre' && !isElim) {
      (function(pid) {
        var chkElim = card.querySelector('.traitor-elim-check');
        if (chkElim) {
          chkElim.addEventListener('change', function(e) {
            if (this.checked) {
              if (confirm('Marquer ' + (players.find(function(x){return x.id===pid;}) || {}).name + ' comme éliminé cette nuit ?')) {
                eliminateTraitreDirectement(pid);
              } else {
                this.checked = false;
              }
            }
          });
        }
      })(p.id);
    }

    // Checkbox sélection
    var chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'player-select-check';
    chk.checked = selectedPlayers.has(p.id);
    (function(pid, c) { c.onchange = function() { toggleSelect(pid, c.checked); }; })(p.id, chk);
    card.appendChild(chk);

    // Photo preview + upload
    var photoRow = document.createElement('div');
    photoRow.style.cssText = 'display:flex;flex-direction:column;align-items:stretch;gap:6px;margin-top:8px';
    var circle = document.createElement('div');
    circle.className = 'player-photo-preview';
    circle.id = 'photo-prev-' + p.id;
    circle.innerHTML = p.photo
      ? '<img src="' + (p.photoFull || p.photo) + '" style="width:100%;height:100%;object-fit:cover;">'
      : '<span class="player-photo-placeholder">📷</span>';
    var uploadBtn = document.createElement('label');
    uploadBtn.className = 'btn btn-ghost btn-sm';
    uploadBtn.style.cssText = 'cursor:pointer;text-align:center;width:100%;display:block';
    uploadBtn.textContent = p.photo ? '✓ Changer photo' : '+ Ajouter photo';
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.className = 'photo-upload-input';
    (function(pid) { fileInput.onchange = function(e) { handlePhotoUpload(pid, e); }; })(p.id);
    uploadBtn.appendChild(fileInput);
    photoRow.appendChild(circle);
    photoRow.appendChild(uploadBtn);
    var actions = card.querySelector('.card-actions');
    if (actions) card.insertBefore(photoRow, actions);
    else card.appendChild(photoRow);

    grid.appendChild(card);
  });
  updatePrintBar();
  renderPlayersBar();
}

function toggleRole(id) {
  var p = players.find(function(x) { return x.id === id; });
  if (!p) return;
  p.role = p.role === 'traitre' ? 'fidele' : 'traitre';
  wsSend({type:'role_update', sessionId:sessionId, playerId:id, role:p.role});
  syncRegistry();
  renderPlayers();
  saveState();
}

function showQR(id) {
  var p = players.find(function(x) { return x.id === id; }); if (!p) return;
  document.getElementById('modal-pname').textContent = p.name;
  var url = buildURL(p);
  document.getElementById('modal-url').textContent = url;
  document.getElementById('qrcode').innerHTML = '';
  new QRCode(document.getElementById('qrcode'), {text:url, width:210, height:210, colorDark:'#000', colorLight:'#fff', correctLevel:QRCode.CorrectLevel.H});
  document.getElementById('qr-modal').classList.add('open');
}

function closeModal() { document.getElementById('qr-modal').classList.remove('open'); }

// ===================================================
// BARRE DE VIGNETTES ADMIN
// ===================================================
var _elimTargetId = null;

function renderPlayersBar() {
  var bar = document.getElementById('players-bar');
  if (!bar || !players.length) return;
  bar.style.display = 'flex';
  bar.innerHTML = '';
  players.forEach(function(p) {
    var isElim = eliminatedPlayers.has(p.id);
    var thumb = document.createElement('div');
    thumb.className = 'player-thumb' + (isElim ? ' eliminated' : p.scanned ? ' connected' : ' disconnected');
    thumb.title = p.name || ('Joueur ' + p.id);
    if (p.photo) {
      thumb.innerHTML = '<img src="' + p.photo + '">';
    } else {
      var initiale = (p.name || ('J'+p.id)).charAt(0).toUpperCase();
      var bg = isElim ? '#4a1010' : p.role === 'traitre' ? '#3a1010' : '#1a2a3a';
      thumb.innerHTML = '<div class="thumb-initial" style="background:' + bg + '">' + initiale + '</div>';
    }
    if (!isElim) {
      (function(pid) {
        thumb.addEventListener('click', function() { openElimModal(pid); });
      })(p.id);
    }
    bar.appendChild(thumb);
  });
}

function openElimModal(id) {
  var p = players.find(function(x) { return x.id === id; });
  if (!p || eliminatedPlayers.has(id)) return;
  _elimTargetId = id;
  document.getElementById('elim-modal-name').textContent = p.name || ('Joueur ' + id);
  document.getElementById('elim-modal-role').textContent = p.role === 'traitre' ? '⚔ Traître' : '🛡 Fidèle';
  document.getElementById('elim-modal').classList.add('open');
}

function closeElimModal() {
  document.getElementById('elim-modal').classList.remove('open');
  _elimTargetId = null;
}

function confirmElimVignette() {
  if (!_elimTargetId) return;
  var id = _elimTargetId;
  closeElimModal();
  var p = players.find(function(x) { return x.id === id; });
  if (!p) return;
  eliminatedPlayers.add(id);
  var payload = JSON.stringify({type:'player_eliminated', sessionId:sessionId, playerId:id, message:"Tu as été éliminé par le conseil. Tu es maintenant au service de Michel."});
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(payload); }
  renderPlayers(); renderPlayersBar(); updateVictimSelect(); updatePrivateTarget(); updateProgress();
  saveState();
}

function markScanned(id) {
  var p = players.find(function(x) { return x.id == id; });
  if (p && !p.scanned) {
    p.scanned = true;
    var card = document.getElementById('pcard-' + p.id);
    if (card) {
      card.classList.add('scanned');
      var s = card.querySelector('.scan-status');
      if (s) { s.classList.remove('waiting'); s.querySelector('span').textContent = 'Connecté'; }
    }
    updateProgress();
    saveState();
    renderPlayersBar();
  }
}

function updateVictimSelect() {
  var sel = document.getElementById('victim-select');
  if (!sel) return;
  var cur = sel.value;
  sel.innerHTML = '<option value="">— Choisir la victime —</option>';
  players.filter(function(p) { return !eliminatedPlayers.has(p.id); }).forEach(function(p) {
    var o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o);
  });
  if (cur) sel.value = cur;
}

function updatePrivateTarget() {
  var sel = document.getElementById('private-target'); var cur = sel.value;
  sel.innerHTML = '<option value="">— Choisir un joueur —</option>';
  players.filter(function(p) { return !eliminatedPlayers.has(p.id); }).forEach(function(p) {
    var o = document.createElement('option'); o.value = p.id; o.textContent = p.name + ' (' + p.role + ')'; sel.appendChild(o);
  });
  if (cur) sel.value = cur;
  var sel2 = document.getElementById('chal-individual-target'); if (!sel2) return;
  var cur2 = sel2.value;
  sel2.innerHTML = '<option value="">— Joueur individuel —</option>';
  players.filter(function(p) { return !eliminatedPlayers.has(p.id); }).forEach(function(p) {
    var o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel2.appendChild(o);
  });
  if (cur2) sel2.value = cur2;
}

// ===================================================
// TABS ADMIN
// ===================================================
function showMainTab(name) {
  document.querySelectorAll('.main-tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.main-tab-content').forEach(function(t) { t.classList.remove('active'); });
  document.querySelector('.main-tab[onclick*="' + name + '"]').classList.add('active');
  document.getElementById('maintab-' + name).classList.add('active');
}

// ===================================================
// MESSAGES ADMIN
// ===================================================
function addMsgToArea(areaId, type, from, text) {
  var area = document.getElementById(areaId); if (!area) return;
  var div = document.createElement('div'); div.className = 'msg-item msg-' + type;
  if (from) div.innerHTML = '<div class="msg-from ' + (type==='traitres'?'red':type==='private'?'blue':'') + '">' + from + '</div><div class="msg-text">' + text + '</div>';
  else div.innerHTML = '<div class="msg-system">' + text + '</div>';
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
}

function sendMsgGroup() {
  var input = document.getElementById('msg-group-input'); var text = input.value.trim(); if (!text) return;
  wsSend({type:'msg_group', sessionId:sessionId, from:'Animateur', text:text});
  // Pas d'addMsgToArea ici : le serveur broadcast en retour, évite le doublon
  input.value = '';
}

function sendMsgTraitres() {
  var input = document.getElementById('msg-traitres-input'); var text = input.value.trim(); if (!text) return;
  wsSend({type:'msg_traitres', sessionId:sessionId, from:'Animateur', text:text});
  // Pas d'addMsgToArea ici : le serveur broadcast en retour, évite le doublon
  input.value = '';
}

function sendMsgPrivate() {
  var input = document.getElementById('msg-private-input');
  var targetId = document.getElementById('private-target').value;
  var text = input.value.trim(); if (!text || !targetId) return;
  wsSend({type:'msg_private', sessionId:sessionId, targetId:targetId, text:text, timer:currentTimer||null});
  input.value = '';
}

// FIX BUG 1 : sélecteur corrigé — cible uniquement les boutons de la ligne timer privé
function selectTimer(t, btn) {
  currentTimer = t;
  document.querySelectorAll('#timer-row-private .timer-btn').forEach(function(b) { b.classList.remove('selected'); });
  btn.classList.add('selected');
}

// FIX BUG 2 : sélecteur corrigé — cible uniquement les boutons de la ligne timer challenge
function selectChalTimer(t, btn) {
  currentChalTimer = t;
  document.querySelectorAll('#timer-row-challenge .timer-btn').forEach(function(b) { b.classList.remove('selected'); });
  btn.classList.add('selected');
}

// ===================================================
// CHALLENGES
// ===================================================
var typeMap = {p:{cls:'tp',label:'Physique'}, q:{cls:'tq',label:'Quizz'}, b:{cls:'tb',label:'Bluff'}, c:{cls:'tc',label:'Créatif'}, a:{cls:'ta',label:'Autre'}};

function setType(t, btn) {
  currentType = t;
  document.querySelectorAll('.type-btn').forEach(function(b) { b.classList.remove('selected'); });
  btn.classList.add('selected');
}

function addChallenge() {
  var input = document.getElementById('challenge-input'); var text = input.value.trim(); if (!text) return;
  challenges.push({id:Date.now(), text:text, type:currentType, done:false});
  input.value = ''; renderChallenges();
}

function toggleChallenge(id) {
  var c = challenges.find(function(x) { return x.id === id; });
  if (c) { c.done = !c.done; renderChallenges(); }
}

function deleteChallenge(id) {
  challenges = challenges.filter(function(x) { return x.id !== id; });
  renderChallenges();
}

function launchChallenge(canal) {
  var input = document.getElementById('challenge-input'); var text = input.value.trim();
  if (!text) { alert("Écris d'abord un challenge !"); return; }
  var endsAt=(currentChalTimer&&currentChalTimer>0)?Date.now()+currentChalTimer*1000:null;
  if (canal === 'individual') {
    var targetId = document.getElementById('chal-individual-target').value;
    if (!targetId) { alert("Choisis un joueur !"); return; }
    wsSend({type:'challenge_individual', sessionId:sessionId, targetId:targetId, text:text, timer:currentChalTimer||null, endsAt:endsAt});
  } else {
    wsSend({type: canal==='traitres' ? 'challenge_traitres' : 'challenge_group', sessionId:sessionId, text:text, timer:currentChalTimer||null, endsAt:endsAt});
  }
  challenges.push({id:Date.now(), text:text, type:currentType, canal:canal, done:false});
  input.value = ''; renderChallenges();
}

function renderChallenges() {
  var list = document.getElementById('challenge-list'); list.innerHTML = '';
  if (!challenges.length) {
    list.innerHTML = '<div style="font-size:12px;color:var(--text-dim);text-align:center;padding:14px;font-style:italic">Aucun challenge</div>';
    return;
  }
  challenges.forEach(function(c) {
    var tm = typeMap[c.type] || typeMap.a;
    var item = document.createElement('div'); item.className = 'challenge-item' + (c.done ? ' done' : '');
    item.innerHTML =
      '<input type="checkbox" class="challenge-check" ' + (c.done ? 'checked' : '') + ' onchange="toggleChallenge(' + c.id + ')">' +
      '<div style="flex:1"><span class="challenge-type-badge ' + tm.cls + '">' + tm.label + '</span><div class="challenge-text">' + c.text + '</div></div>' +
      '<button class="challenge-del" onclick="deleteChallenge(' + c.id + ')">×</button>';
    list.appendChild(item);
  });
}

// ===================================================
// VOTE NUIT
// ===================================================
// Élimination directe depuis une carte traître (onglet Joueurs)
function eliminateTraitreDirectement(id) {
  var p = players.find(function(x) { return x.id === id; }); if (!p) return;
  if (eliminatedPlayers.has(id)) return;
  eliminatedPlayers.add(id);
  var item = document.createElement('div'); item.className = 'eliminated-item';
  item.innerHTML = '<div class="dot" style="background:#8b1a1a"></div>' + p.name + ' — Traître (nuit)';
  document.getElementById('eliminated-list').appendChild(item);
  renderPlayers(); updateVictimSelect(); updatePrivateTarget(); updateProgress();
  // Si un vote est en cours, vérifier si tous les traîtres restants ont voté
  var traitresActifs = players.filter(function(p) { return p.role==='traitre' && !eliminatedPlayers.has(p.id); });
  var tousVote = traitresActifs.length > 0 && traitresActifs.every(function(t) { return votesRecus[t.id] !== undefined; });
  if (tousVote) {
    var cibles = Object.values(votesRecus);
    var unanime = cibles.length > 0 && cibles.every(function(v) { return v == cibles[0]; });
    if (unanime) {
      if (_countdownAdminInterval) clearInterval(_countdownAdminInterval);
      fermerVoteNuit();
      highlightVictime(parseInt(cibles[0]));
    } else {
      wsSend({type:'msg_traitres', sessionId:sessionId, from:'⚠ Système', text:'Vous n\'êtes pas d\'accord ! Choisissez la même personne.'});
      votesRecus = {};
    }
  }
  renderVotesNuit();
  saveState();
}

function ouvrirVoteNuit() {
  // Seuls les joueurs non éliminés sont proposés comme cibles
  var actifs = players.filter(function(p) { return !eliminatedPlayers.has(p.id); });
  votesRecus = {};
  var endsAt = Date.now() + 7 * 60 * 1000;
  wsSend({type:'nuit_ouverte', sessionId:sessionId, endsAt:endsAt, players:actifs.map(function(p) { return {id:p.id, name:p.name, photo:p.photo||null}; })});
  renderVotesNuit();
  startCountdownAdmin(endsAt);
}

var _countdownAdminInterval = null;

function startCountdownAdmin(endsAt) {
  if (_countdownAdminInterval) clearInterval(_countdownAdminInterval);
  _countdownAdminInterval = setInterval(function() {
    var remaining = Math.max(0, endsAt - Date.now());
    var mins = Math.floor(remaining / 60000);
    var secs = Math.floor((remaining % 60000) / 1000);
    var cd = document.getElementById('nuit-countdown-admin');
    if (cd) cd.textContent = mins + ':' + String(secs).padStart(2, '0');
    if (remaining <= 0) { clearInterval(_countdownAdminInterval); fermerVoteNuit(); }
  }, 1000);
}

function handleVoteNuit(fromId, targetId) {
  votesRecus[fromId] = targetId;
  renderVotesNuit();
  var traitresActifs = players.filter(function(p) { return p.role==='traitre' && !eliminatedPlayers.has(p.id); });
  var tousVote = traitresActifs.length > 0 && traitresActifs.every(function(t) { return votesRecus[t.id] !== undefined; });
  if (tousVote) {
    // Vérifier l'unanimité : tous doivent voter pour la même cible
    var cibles = Object.values(votesRecus);
    var unanime = cibles.length > 0 && cibles.every(function(v) { return v == cibles[0]; });
    if (unanime) {
      if (_countdownAdminInterval) clearInterval(_countdownAdminInterval);
      fermerVoteNuit();
      highlightVictime(parseInt(cibles[0]));
    } else {
      // Pas d'accord : notifier les traîtres et remettre les votes à zéro
      wsSend({type:'msg_traitres', sessionId:sessionId, from:'⚠ Système', text:'Vous n\'êtes pas d\'accord ! Choisissez la même personne.'});
      votesRecus = {};
      renderVotesNuit();
    }
  }
}

function highlightVictime(id) {
  var card = document.getElementById('pcard-' + id);
  if (card) {
    card.style.border = '3px solid #ff0000';
    card.style.boxShadow = '0 0 20px rgba(255,0,0,0.5)';
    var banner = document.createElement('div');
    banner.style.cssText = 'background:rgba(192,57,43,.9);color:#fff;font-family:Cinzel,serif;font-size:11px;letter-spacing:.1em;text-align:center;padding:4px;margin:-16px -16px 10px;border-radius:10px 10px 0 0;';
    banner.textContent = '🗡 DÉSIGNÉ PAR LES TRAÎTRES';
    card.insertBefore(banner, card.firstChild);
    showMainTab('joueurs');
  }
}

function renderVotesNuit() {
  var el = document.getElementById('votes-nuit-display'); if (!el) return;
  // Tous les traîtres, actifs ET éliminés, pour avoir une vue complète
  var traitors = players.filter(function(p) { return p.role==='traitre'; });
  var html = '<div style="font-family:Cinzel,serif;font-size:13px;color:#ff8080;margin-bottom:8px;">⏱ <span id="nuit-countdown-admin">7:00</span></div><div>';
  traitors.forEach(function(t) {
    var isElim = eliminatedPlayers.has(t.id);
    var vote = votesRecus[t.id];
    var target = vote ? players.find(function(p) { return p.id == vote; }) : null;
    html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);' + (isElim ? 'opacity:0.4;' : '') + '">';
    html += '<span style="font-family:Cinzel,serif;font-size:12px;color:#ff8080;flex:1;">' + t.name + (isElim ? ' <span style="font-size:10px;color:var(--text-dim)">(éliminé)</span>' : '') + '</span>';
    html += '<span style="font-size:12px;color:var(--text-dim)">' + (isElim ? '—' : target ? '⚔ ' + target.name : 'En attente...') + '</span>';
    html += '</div>';
  });
  html += '</div>';
  el.innerHTML = html;
}

function fermerVoteNuit() { wsSend({type:'nuit_fermee', sessionId:sessionId}); }

function eliminate() {
  var sel = document.getElementById('victim-select'); var id = parseInt(sel.value); if (!id) return;
  var p = players.find(function(x) { return x.id === id; }); if (!p) return;
  eliminatedPlayers.add(id);
  var item = document.createElement('div'); item.className = 'eliminated-item';
  item.innerHTML = '<div class="dot" style="background:#8b1a1a"></div>' + p.name + ' — ' + (p.role==='traitre' ? 'Traître' : 'Fidèle');
  document.getElementById('eliminated-list').appendChild(item);
  var payload = JSON.stringify({type:'player_eliminated', sessionId:sessionId, playerId:id, message:"Les traîtres t'ont banni cette nuit, tu es maintenant au service de Michel jusqu'à la fin du jeu."});
  if (ws && ws.readyState === WebSocket.OPEN) { ws.send(payload); } else { connectWS(function() { wsSend({type:'identify',playerId:'admin',playerName:'Animateur',role:'admin',sessionId:sessionId,isAdmin:true}); setTimeout(function(){ if(ws&&ws.readyState===WebSocket.OPEN) ws.send(payload); },400); }); }
  renderPlayers(); updateVictimSelect(); updatePrivateTarget(); updateProgress();
  sel.value = '';
  saveState();
}

// ===================================================
// VOTE NUIT CÔTÉ JOUEUR
// ===================================================
var _countdownInterval = null;

function showVoteNuit(playersList, endsAt) {
  var notif = document.getElementById('vote-nuit-notif');
  if (notif) notif.remove();
  notif = document.createElement('div');
  notif.id = 'vote-nuit-notif';
  notif.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:#0a0508;z-index:999;display:flex;flex-direction:column;align-items:center;overflow-y:auto;padding:20px 16px;';
  document.body.appendChild(notif);
  var titre = document.createElement('div');
  titre.style.cssText = 'font-family:Cinzel,serif;font-size:22px;color:#ff6060;margin-bottom:4px;text-align:center;';
  titre.textContent = '⚔ Nuit des Traîtres';
  notif.appendChild(titre);
  var cd = document.createElement('div');
  cd.id = 'vote-countdown';
  cd.style.cssText = 'font-family:Cinzel,serif;font-size:42px;font-weight:900;color:#fff;margin:8px 0 16px;letter-spacing:.05em;';
  cd.textContent = '7:00';
  notif.appendChild(cd);
  var sub = document.createElement('div');
  sub.style.cssText = 'font-size:13px;color:rgba(255,255,255,.4);margin-bottom:20px;text-align:center;';
  sub.textContent = 'Choisissez votre victime';
  notif.appendChild(sub);
  var grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(2,1fr);gap:12px;width:100%;max-width:400px;';
  notif.appendChild(grid);
  playersList.forEach(function(p) {
    var btn = document.createElement('button');
    btn.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px 8px;background:rgba(192,57,43,.15);border:1px solid rgba(192,57,43,.3);border-radius:10px;cursor:pointer;width:100%;';
    (function(pid) { btn.onclick = function() { envoyerVote(pid); }; })(p.id);
    if (p.photo) {
      var img = document.createElement('img');
      img.src = p.photo;
      img.style.cssText = 'width:70px;height:70px;border-radius:50%;object-fit:cover;border:2px solid rgba(192,57,43,.5);';
      btn.appendChild(img);
    } else {
      var ph = document.createElement('div');
      ph.style.cssText = 'width:70px;height:70px;border-radius:50%;background:#2a1a1a;display:flex;align-items:center;justify-content:center;font-size:28px;border:2px solid rgba(192,57,43,.3);';
      ph.textContent = '?';
      btn.appendChild(ph);
    }
    var nom = document.createElement('span');
    nom.style.cssText = 'font-family:Cinzel,serif;font-size:13px;color:#ffaaaa;text-align:center;';
    nom.textContent = p.name;
    btn.appendChild(nom);
    grid.appendChild(btn);
  });
  if (_countdownInterval) clearInterval(_countdownInterval);
  var end = endsAt || (Date.now() + 7 * 60 * 1000);
  _countdownInterval = setInterval(function() {
    var remaining = Math.max(0, end - Date.now());
    var mins = Math.floor(remaining / 60000);
    var secs = Math.floor((remaining % 60000) / 1000);
    var el = document.getElementById('vote-countdown');
    if (el) el.textContent = mins + ':' + String(secs).padStart(2, '0');
    if (remaining <= 0) { clearInterval(_countdownInterval); hideVoteNuit(); }
  }, 1000);
}

function envoyerVote(targetId) {
  wsSend({type:'vote_nuit', sessionId:mySession, fromId:myPlayerId, targetId:targetId});
  if (_countdownInterval) clearInterval(_countdownInterval);
  var notif = document.getElementById('vote-nuit-notif');
  if (notif) {
    notif.innerHTML = '<div style="font-family:Cinzel,serif;font-size:18px;color:#ff6060;text-align:center;">⚔ Vote envoyé</div><div style="margin-top:16px;font-size:14px;color:rgba(255,255,255,.5);text-align:center;">Retour au chat...</div>';
    setTimeout(function() { hideVoteNuit(); }, 2000);
  }
}

function hideVoteNuit() {
  var notif = document.getElementById('vote-nuit-notif');
  if (notif) notif.remove();
}

// ===================================================
// PRINT BAR & PHOTOS
// ===================================================
function toggleSelect(id, checked) {
  if (checked) selectedPlayers.add(id);
  else selectedPlayers.delete(id);
  updatePrintBar();
}

function updatePrintBar() {
  var bar = document.getElementById('print-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'print-bar';
    bar.id = 'print-bar';
    bar.innerHTML =
      '<span class="print-bar-label" id="print-bar-label"></span>' +
      '<button class="btn btn-ghost btn-sm" onclick="selectAll()">Tout sélectionner</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="deselectAll()">Effacer</button>' +
      '<button class="btn btn-teal" id="btn-affiche" onclick="printAffiches()">🖼 Affiches mur</button>' +
      '<button class="btn btn-gold" onclick="printSelected()">🖨 Imprimer les badges</button>';
    document.body.appendChild(bar);
  }
  var count = selectedPlayers.size;
  document.getElementById('print-bar-label').textContent = count + ' badge' + (count > 1 ? 's' : '') + ' sélectionné' + (count > 1 ? 's' : '');
  bar.classList.toggle('visible', count > 0);
}

function selectAll() {
  players.filter(function(p) { return !eliminatedPlayers.has(p.id); }).forEach(function(p) {
    selectedPlayers.add(p.id);
    var chk = document.querySelector('#pcard-' + p.id + ' .player-select-check');
    if (chk) chk.checked = true;
  });
  updatePrintBar();
}

function deselectAll() {
  selectedPlayers.clear();
  document.querySelectorAll('.player-select-check').forEach(function(c) { c.checked = false; });
  updatePrintBar();
}

// FIX BUG 4 : downloadPDF ne dépend plus de event.target — le bouton est passé explicitement
function downloadPDF(endpoint, btnEl) {
  var selected = players.filter(function(p) { return selectedPlayers.has(p.id); });
  if (!selected.length) { alert('Sélectionne au moins un joueur !'); return; }
  var isAffiche = endpoint.includes('affiche');
  var originalLabel = btnEl ? btnEl.textContent : '';
  if (btnEl) { btnEl.textContent = '⏳ Génération...'; btnEl.disabled = true; }
  var payload = {
    players: selected.map(function(p) {
      return {id:p.id, name:p.name, role:p.role, pin:p.pin, photo: isAffiche ? (p.photoFull||p.photo||null) : (p.photo||null)};
    }),
    sessionId: sessionId
  };
  fetch(location.protocol + '//' + location.hostname + ':3002/' + endpoint, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload)
  }).then(function(response) {
    if (!response.ok) throw new Error('Erreur serveur');
    return response.blob();
  }).then(function(blob) {
    var url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(function() { URL.revokeObjectURL(url); }, 3000);
    if (btnEl) { btnEl.textContent = '✓ PDF téléchargé !'; }
    setTimeout(function() {
      if (btnEl) { btnEl.textContent = originalLabel; btnEl.disabled = false; }
    }, 2000);
  }).catch(function(e) {
    alert('Erreur : ' + e.message);
    if (btnEl) { btnEl.textContent = originalLabel; btnEl.disabled = false; }
  });
}

// FIX BUG 5 : une seule définition propre de printSelected et printAffiches
function printSelected() { downloadPDF('generate-badges', document.querySelector('#print-bar .btn-gold')); }
function printAffiches() { downloadPDF('generate-affiches', document.getElementById('btn-affiche')); }

// ===================================================
// PHOTO EDITOR
// ===================================================
var editingPlayerId = null, editImg = null;
var editOffsetX = 0, editOffsetY = 0, editZoom = 1;
var isDragging = false, dragStartX = 0, dragStartY = 0, dragStartOX = 0, dragStartOY = 0;

function handlePhotoUpload(playerId, e) {
  var file = e.target.files[0]; if (!file) return;
  var reader = new FileReader();
  reader.onload = function(ev) { openPhotoEditor(playerId, ev.target.result); };
  reader.readAsDataURL(file);
}

function openPhotoEditor(playerId, imgSrc) {
  editingPlayerId = playerId; editOffsetX = 0; editOffsetY = 0; editZoom = 1;
  document.getElementById('photo-zoom').value = 1;
  editImg = new Image();
  editImg.onload = function() { drawEditorCanvas(); document.getElementById('photo-editor-overlay').classList.add('open'); };
  editImg.src = imgSrc;
}

function drawEditorCanvas() {
  var canvas = document.getElementById('photo-editor-canvas');
  var ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 200, 200);
  ctx.save();
  ctx.beginPath(); ctx.arc(100, 100, 100, 0, Math.PI * 2); ctx.clip();
  var w = editImg.width * editZoom, h = editImg.height * editZoom;
  ctx.drawImage(editImg, 100 - w/2 + editOffsetX, 100 - h/2 + editOffsetY, w, h);
  ctx.restore();
}

function cancelPhotoEdit() { document.getElementById('photo-editor-overlay').classList.remove('open'); }

function confirmPhotoEdit() {
  // Version badge 200x200 avec clip + sépia
  var badgeCanvas = document.createElement('canvas');
  badgeCanvas.width = 200; badgeCanvas.height = 200;
  var bctx = badgeCanvas.getContext('2d');
  bctx.beginPath(); bctx.arc(100, 100, 100, 0, Math.PI * 2); bctx.clip();
  var bw = editImg.width * editZoom, bh = editImg.height * editZoom;
  bctx.drawImage(editImg, 100 - bw/2 + editOffsetX, 100 - bh/2 + editOffsetY, bw, bh);
  var bd = bctx.getImageData(0, 0, 200, 200);
  for (var i = 0; i < bd.data.length; i += 4) {
    var g = 0.299*bd.data[i] + 0.587*bd.data[i+1] + 0.114*bd.data[i+2];
    bd.data[i] = Math.min(255, g*1.1+40); bd.data[i+1] = Math.min(255, g*0.9+20); bd.data[i+2] = Math.min(255, g*0.5);
  }
  bctx.putImageData(bd, 0, 0);
  // Version pleine résolution sans clip ni filtre
  var fullCanvas = document.createElement('canvas');
  fullCanvas.width = 2480; fullCanvas.height = 2480;
  var fctx = fullCanvas.getContext('2d');
  var fw = editImg.width * editZoom * 12.4, fh = editImg.height * editZoom * 12.4;
  fctx.fillStyle = '#303040'; fctx.fillRect(0, 0, 2480, 2480);
  fctx.drawImage(editImg, 1240 - fw/2 + editOffsetX*12.4, 1240 - fh/2 + editOffsetY*12.4, fw, fh);
  var p = players.find(function(x) { return x.id === editingPlayerId; });
  if (p) {
    p.photo = badgeCanvas.toDataURL('image/jpeg', 0.85);
    p.photoFull = fullCanvas.toDataURL('image/jpeg', 0.99);
    photoStore[p.id] = p.photo;
    photoStore['full_' + p.id] = p.photoFull;
    var prev = document.getElementById('photo-prev-' + p.id);
    if (prev) prev.innerHTML = '<img src="' + p.photoFull + '" style="width:100%;height:100%;object-fit:cover;">';
    saveState();
  }
  document.getElementById('photo-editor-overlay').classList.remove('open');
}

(function() {
  var wrap = document.getElementById('photo-editor-wrap');
  wrap.addEventListener('mousedown', function(e) { isDragging=true; dragStartX=e.clientX; dragStartY=e.clientY; dragStartOX=editOffsetX; dragStartOY=editOffsetY; });
  wrap.addEventListener('touchstart', function(e) { isDragging=true; dragStartX=e.touches[0].clientX; dragStartY=e.touches[0].clientY; dragStartOX=editOffsetX; dragStartOY=editOffsetY; }, {passive:true});
  document.addEventListener('mousemove', function(e) { if (!isDragging) return; editOffsetX=dragStartOX+(e.clientX-dragStartX); editOffsetY=dragStartOY+(e.clientY-dragStartY); drawEditorCanvas(); });
  document.addEventListener('touchmove', function(e) { if (!isDragging) return; editOffsetX=dragStartOX+(e.touches[0].clientX-dragStartX); editOffsetY=dragStartOY+(e.touches[0].clientY-dragStartY); drawEditorCanvas(); }, {passive:true});
  document.addEventListener('mouseup', function() { isDragging = false; });
  document.addEventListener('touchend', function() { isDragging = false; });
  document.getElementById('photo-zoom').addEventListener('input', function(e) { editZoom = parseFloat(e.target.value); drawEditorCanvas(); });
})();

// ===================================================
// PASTILLE MESSAGES NON LUS — CANAL TRAÎTRES
// ===================================================
(function() {
  function unreadKey() { return 'unread_traitres_' + (mySession || ''); }
  function getUnread() { try { return parseInt(localStorage.getItem(unreadKey())||'0', 10)||0; } catch(e) { return 0; } }
  function setUnread(n) {
    try { localStorage.setItem(unreadKey(), String(n)); } catch(e) {}
    renderBadge(n);
  }
  function renderBadge(n) {
    var btn = document.getElementById('tab-traitres-btn'); if (!btn) return;
    var badge = document.getElementById('traitres-unread-badge');
    if (n > 0) {
      btn.style.position = 'relative';
      if (!badge) {
        badge = document.createElement('span');
        badge.id = 'traitres-unread-badge';
        badge.style.cssText = 'position:absolute;top:4px;right:6px;min-width:18px;height:18px;border-radius:9px;background:#ff3333;color:#fff;font-family:Cinzel,serif;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 4px;pointer-events:none;box-shadow:0 0 6px rgba(255,0,0,.6);';
        btn.appendChild(badge);
      }
      badge.textContent = n > 99 ? '99+' : String(n);
    } else {
      if (badge) badge.remove();
    }
  }

  // Ces trois surcharges sont sûres car elles sont dans une IIFE exécutée après la définition des fonctions de base
  var _origAddChatMsgTo = addChatMsgTo;
  addChatMsgTo = function(containerId, from, text, type) {
    _origAddChatMsgTo(containerId, from, text, type);
    if (containerId === 'chat-messages-traitres' && currentCanal !== 'traitres') setUnread(getUnread() + 1);
  };

  var _origSwitchCanal = switchCanal;
  switchCanal = function(canal) {
    _origSwitchCanal(canal);
    if (canal === 'traitres') setUnread(0);
  };

  var _origEnterChat = enterChat;
  enterChat = function() {
    _origEnterChat();
    var count = getUnread(); if (count > 0) renderBadge(count);
  };
})();

// ===================================================
// CANAL JOUEUR
// ===================================================
function switchCanal(canal) {
  currentCanal = canal;
  document.getElementById('chat-messages').style.display = canal === 'groupe' ? 'flex' : 'none';
  document.getElementById('chat-messages-traitres').style.display = canal === 'traitres' ? 'flex' : 'none';
  document.getElementById('chat-messages-prive').style.display = canal === 'prive' ? 'flex' : 'none';
  var tabs = {
    'groupe': {btn:'tab-groupe-btn', col:'var(--gold)'},
    'traitres': {btn:'tab-traitres-btn', col:'#ff6060'},
    'prive': {btn:'tab-prive-btn', col:'#80b8ff'}
  };
  ['groupe','traitres','prive'].forEach(function(t) {
    var btn = document.getElementById(tabs[t].btn);
    if (!btn) return;
    var active = (t === canal);
    btn.style.borderBottomColor = active ? tabs[t].col : 'transparent';
    btn.style.color = active ? tabs[t].col : 'var(--text-dim)';
    // Supprimer badge si canal actif
    if (active) { var b = btn.querySelector('.unread-badge'); if(b) b.remove(); var b2 = document.getElementById('traitres-unread-badge'); if(b2) b2.remove(); }
  });
  // Masquer saisie sur canal privé (lecture seule)
  var inputArea = document.getElementById('player-input-area');
  if (inputArea) inputArea.style.display = canal === 'prive' ? 'none' : 'flex';
  if (canal === 'traitres') setUnread(0);
  document.getElementById('player-msg-input').placeholder = canal === 'traitres' ? 'Message aux traîtres...' : 'Message à tous...';
}

// ===================================================
// CHAT JOUEUR
// ===================================================
function _fmtTime(ts) {
  var n = ts ? new Date(ts) : new Date();
  return String(n.getHours()).padStart(2,'0') + ':' + String(n.getMinutes()).padStart(2,'0');
}

function _saveChatMsg(canal, from, text, type) {
  if (!mySession) return;
  var key = 'chat_' + mySession + '_' + canal;
  var msgs = [];
  try { msgs = JSON.parse(localStorage.getItem(key)||'[]'); } catch(e) {}
  msgs.push({from:from, text:text, type:type, ts:Date.now()});
  if (msgs.length > 100) msgs = msgs.slice(-100);
  try { localStorage.setItem(key, JSON.stringify(msgs)); } catch(e) {}
}

function _loadChatHistory() {
  var session = mySession || localStorage.getItem('register_session') || '';
  ['groupe','traitres'].forEach(function(canal) {
    var key = 'chat_' + session + '_' + canal;
    var msgs = [];
    try { msgs = JSON.parse(localStorage.getItem(key)||'[]'); } catch(e) {}
    var containerId = canal === 'traitres' ? 'chat-messages-traitres' : 'chat-messages';
    var box = document.getElementById(containerId); if (!box) return;
    box.innerHTML = '';
    msgs.forEach(function(m) {
      var div = document.createElement('div');
      div.className = 'chat-msg ' + (m.type||'');
      if (m.from) div.innerHTML = '<div class="chat-msg-from">' + m.from + '<span class="chat-msg-time">' + _fmtTime(m.ts) + '</span></div><div>' + m.text + '</div>';
      else div.innerHTML = '<div style="font-style:italic;font-size:13px;color:var(--text-dim)">' + m.text + '</div>';
      box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;
  });
}

function addChatMsgTo(containerId, from, text, type) {
  var canal = containerId === 'chat-messages-traitres' ? 'traitres' : 'groupe';
  _saveChatMsg(canal, from, text, type);
  var box = document.getElementById(containerId); if (!box) return;
  var div = document.createElement('div');
  div.className = 'chat-msg ' + (type||'');
  if (from) div.innerHTML = '<div class="chat-msg-from">' + from + '<span class="chat-msg-time">' + _fmtTime() + '</span></div><div>' + text + '</div>';
  else div.innerHTML = '<div style="font-style:italic;font-size:13px;color:var(--text-dim)">' + text + '</div>';
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function addChatMsg(from, text, type) {
  var canal = (myRole === 'traitre' && currentCanal === 'traitres') ? 'traitres' : 'groupe';
  _saveChatMsg(canal, from, text, type);
  var area = document.getElementById('chat-messages');
  var div = document.createElement('div'); div.className = 'chat-msg ' + type;
  div.innerHTML = '<div class="chat-msg-from ' + (type==='traitres'?'red':'') + '">' + from + '<span class="chat-msg-time">' + _fmtTime() + '</span></div><div class="chat-msg-text">' + text + '</div>';
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
}

function playerSendMsg() {
  var input = document.getElementById('player-msg-input'); var text = input.value.trim(); if (!text) return;
  var type = (myRole === 'traitre' && currentCanal === 'traitres') ? 'msg_traitres' : 'msg_group';
  wsSend({type:type, sessionId:mySession, from:myName, text:text});
  addChatMsg('Moi', text, 'mine');
  input.value = '';
}

// ===================================================
// NOTIF
// ===================================================
var _persistentTimerRemaining = 0;
var _persistentTimerInterval = null;

// Notifications empilables
var _notifTimers = {};
var _notifEndsAt = {};
var _notifTypes = {};
var _notifTexts = {};
var _notifCount = 0;
function showNotif(type, label, text, timer, endsAt) {
  if(endsAt&&endsAt>0){timer=Math.round(Math.max(0,endsAt-Date.now())/1000);}
  var isT = (type==='traitres')||(label&&label.indexOf('Tra')>=0&&label.indexOf('tres')>=0);
  var isI = (type==='individual');
  var isP = (type==='private');
  var bc = isT?'rgba(192,57,43,.9)':isI?'rgba(50,120,220,.8)':isP?'rgba(80,150,220,.8)':'#f0c040';
  var tc = isT?'#ff6060':isI?'#80b8ff':'#fad878';
  var lc = isT?'#ff8080':isI?'#80b8ff':isP?'#80b8ff':'#f0c040';
  var container = document.getElementById('notif-stack-container');
  if (!container) return;
  var nid = 'notif-'+(++_notifCount);
  var box = document.createElement('div');
  box.id = nid;
  box.style.cssText = 'pointer-events:all;background:#1c1b2e;border:2px solid '+bc+';border-radius:14px;padding:20px 22px 16px;max-width:360px;width:100%;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.7);';
  var le = document.createElement('div'); le.style.cssText='font-family:Cinzel,serif;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:'+lc+';margin-bottom:8px;'; le.textContent=label; box.appendChild(le);
  var te = document.createElement('div'); te.style.cssText='font-size:15px;color:#fff;line-height:1.5;margin-bottom:10px;'; te.textContent=text; box.appendChild(te);
  var timerEl = null;
  if (timer&&timer>0) { timerEl=document.createElement('div'); timerEl.id=nid+'-timer'; timerEl.style.cssText='font-family:Cinzel,serif;font-size:40px;font-weight:900;color:'+tc+';margin-bottom:10px;'; timerEl.textContent=formatTimer(timer); box.appendChild(timerEl); }
  var btn = document.createElement('button'); btn.style.cssText='font-family:Cinzel,serif;font-size:11px;padding:7px 20px;border:1px solid '+bc+';border-radius:20px;background:transparent;color:'+lc+';cursor:pointer;'; btn.textContent="OK, j'ai lu";
  (function(id){ btn.addEventListener('click',function(){ closeNotifById(id); }); })(nid);
  box.appendChild(btn); container.appendChild(box);
  _notifTypes[nid]=type;
  _notifTexts[nid]=text;
  if (timer&&timer>0) {
    var _endsAt=endsAt||(Date.now()+timer*1000);
    _notifEndsAt[nid]=_endsAt;
    var rem=timer;
    _notifTimers[nid]=setInterval(function(){
      rem=Math.round(Math.max(0,_endsAt-Date.now())/1000); if(!timerEl){clearInterval(_notifTimers[nid]);return;}
      timerEl.textContent=formatTimer(rem);
      if(rem<=10) timerEl.style.color='#ff4040';
      if(rem<=0){clearInterval(_notifTimers[nid]);timerEl.textContent='⏱ Temps écoulé!';timerEl.style.fontSize='16px';}
    },1000);
  }
}
function closeNotifById(id){
  var endsAtVal = _notifEndsAt[id] || 0;
  var remMs = endsAtVal - Date.now();
  var notifType = _notifTypes[id] || '';
  var notifText = _notifTexts[id] || '';
  if(_notifTimers[id]){ clearInterval(_notifTimers[id]); delete _notifTimers[id]; }
  delete _notifEndsAt[id];
  delete _notifTexts[id];
  var el=document.getElementById(id); if(el){
    notifText = notifText || (el.querySelector && el.querySelector('div:nth-child(2)') ? el.querySelector('div:nth-child(2)').textContent : '');
    el.remove();
  }
  // Bloc challenge persistant fusionné (texte + timer)
  var _cT = notifType === 'traitres';
  var _cI = notifType === 'individual';
  delete _notifTypes[id];
  var _col = _cT?'rgba(192,57,43,.2)':_cI?'rgba(50,120,220,.2)':'rgba(240,192,64,.1)';
  var _txt = _cT?'#ff6060':_cI?'#80b8ff':'#f0c040';
  var _brd = _cT?'rgba(192,57,43,.5)':_cI?'rgba(50,120,220,.4)':'rgba(240,192,64,.3)';
  if (notifText) {
    var blockId = 'chal-block-'+id;
    var existing = document.getElementById(blockId);
    if(existing) existing.remove();
    var block = document.createElement('div');
    block.id = blockId;
    block.style.cssText = 'width:100%;margin-top:6px;padding:7px 12px;border-radius:8px;background:'+_col+';border:1px solid '+_brd+';display:flex;align-items:center;justify-content:space-between;gap:8px;';
    var textEl = document.createElement('div');
    textEl.style.cssText = 'font-size:13px;color:'+_txt+';flex:1;text-align:left;line-height:1.4;';
    textEl.textContent = notifText;
    block.appendChild(textEl);
    var timerEl2 = null;
    if (remMs > 1000) {
      timerEl2 = document.createElement('div');
      timerEl2.style.cssText = 'font-family:Cinzel,serif;font-size:13px;font-weight:700;color:'+_txt+';flex-shrink:0;';
      timerEl2.textContent = formatTimer(Math.round(remMs/1000));
      block.appendChild(timerEl2);
    }
    var miniCard = document.getElementById('role-mini-card');
    if(miniCard) miniCard.appendChild(block);
    if (remMs > 1000) {
      var _blockEndsAt = endsAtVal;
      var _sync = setInterval(function(){
        var r = Math.round(Math.max(0, _blockEndsAt - Date.now()) / 1000);
        if(timerEl2) timerEl2.textContent = formatTimer(r);
        if(r <= 0){ clearInterval(_sync); var d=document.getElementById(blockId); if(d)d.remove(); }
      }, 1000);
    } else {
      setTimeout(function(){ var d=document.getElementById(blockId); if(d)d.remove(); }, 5000);
    }
  }
}

function formatTimer(s) { var m = Math.floor(s/60); var sc = s%60; return m + ':' + (sc < 10 ? '0' : '') + sc; }
function closeNotif() {
  document.getElementById('notif-overlay').classList.remove('show');
  // Si un timer est en cours, l'afficher dans la mini-carte
  var timerEl = document.getElementById('notif-timer');
  if (timerInterval && _persistentTimerRemaining > 0) {
    var miniTimer = document.getElementById('mini-card-timer');
    if (!miniTimer) {
      miniTimer = document.createElement('div');
      miniTimer.id = 'mini-card-timer';
      miniTimer.style.cssText = 'font-family:Cinzel,serif;font-size:12px;font-weight:700;padding:3px 8px;border-radius:10px;background:rgba(240,192,64,.15);color:#f0c040;border:1px solid rgba(240,192,64,.3);margin-left:6px;flex-shrink:0;';
      var miniCard = document.getElementById('role-mini-card');
      if (miniCard) miniCard.appendChild(miniTimer);
    }
    miniTimer.textContent = timerEl.textContent;
    // Synchroniser le mini timer avec timerInterval existant
    var _origInterval = timerInterval;
    var _miniSync = setInterval(function() {
      if (!document.getElementById('notif-timer') || timerEl.style.display === 'none') {
        clearInterval(_miniSync);
        if (miniTimer) miniTimer.remove();
        return;
      }
      miniTimer.textContent = timerEl.textContent;
      if (timerEl.textContent === '⏱ Temps écoulé!') {
        clearInterval(_miniSync);
        setTimeout(function() { if (miniTimer) miniTimer.remove(); }, 2000);
      }
    }, 500);
  } else {
    if (timerInterval) clearInterval(timerInterval);
  }
}

// ===================================================
// ROLE PAGE JOUEUR
// ===================================================
function renderRolePage(params) {
  var role = params.get('role');
  var name = decodeURIComponent(params.get('name') || 'Joueur');
  var pid = params.get('pid');
  var session = params.get('session');
  myRole = role; myName = name; myPlayerId = pid; mySession = session;
  var isTreason = role === 'traitre';
  var section = document.getElementById('role-reveal-section');
  section.innerHTML =
    '<div style="text-align:center;padding-top:20px">' +
      '<div style="font-family:\'Cinzel\',serif;font-size:12px;letter-spacing:.15em;color:var(--gold);margin-bottom:24px">LES TRAÎTRES · SESSION SECRÈTE</div>' +
    '</div>' +
    '<span class="role-symbol-big">' + (isTreason ? '🗡' : '🛡') + '</span>' +
    '<div style="font-family:\'Cinzel\',serif;font-size:14px;letter-spacing:.1em;color:' + (isTreason ? '#ff9090' : 'var(--gold-soft)') + ';margin-bottom:6px">Tu es...</div>' +
    '<div style="font-family:\'Cinzel\',serif;font-size:26px;font-weight:900;color:#fff;margin-bottom:18px;letter-spacing:.08em">' + name + '</div>' +
    '<div style="font-family:\'Cinzel\',serif;font-size:11px;letter-spacing:.2em;color:' + (isTreason ? '#ff9090' : 'var(--gold-soft)') + ';margin-bottom:10px">TON RÔLE</div>' +
    '<div class="role-name-big ' + (isTreason ? 'traitre' : 'fidele') + '">' + (isTreason ? 'TRAÎTRE' : 'FIDÈLE') + '</div>' +
    '<div style="height:1px;width:50px;background:' + (isTreason ? 'rgba(255,80,80,.6)' : 'var(--gold)') + ';margin:0 auto 18px"></div>' +
    '<div style="font-size:17px;line-height:1.8;font-style:italic;color:rgba(255,255,255,.9);max-width:300px;margin:0 auto">' +
      (isTreason ? "Fais-toi passer pour un fidèle. Sabote les missions discrètement. Élimine les fidèles la nuit." : "Coopère aux missions pour accumuler des jetons. Observe. Démasque les traîtres au conseil.") +
    '</div>' +
    (isTreason ? '<div class="role-secret-box">⚠ Ne révèle ton rôle à personne. Si tu es banni au conseil, la partie est perdue pour toi.</div>' : '') +
    '<button class="btn btn-gold btn-enter-chat" onclick="enterChat()">Entrer dans la partie →</button>' +
    '<div class="role-warning">NE MONTRE PAS CET ÉCRAN · SOUVIENS-TOI BIEN</div>';
}

function enterChat() {
  var isTreason = myRole === 'traitre';
  document.getElementById('role-reveal-section').style.display = 'none';
  var rcs = document.getElementById('role-chat-section');
  rcs.style.display = 'flex'; rcs.style.flexDirection = 'column'; rcs.style.flex = '1';
  var mini = document.getElementById('role-mini-card');
  mini.innerHTML =
    '<div class="role-mini-symbol">' + (isTreason ? '🗡' : '🛡') + '</div>' +
    '<div class="role-mini-info">' +
      '<div class="role-mini-name">' + myName + '</div>' +
      '<span class="role-mini-badge ' + (isTreason ? 'traitre' : 'fidele') + '">' + (isTreason ? 'Traître' : 'Fidèle') + '</span>' +
      '<div class="role-mission-text">' + (isTreason ? 'Sabote. Élimine. Reste discret.' : 'Coopère. Observe. Démasque.') + '</div>' +
    '</div>' +
    '';
  mini.style.border = isTreason ? '1px solid rgba(192,57,43,.5)' : '1px solid var(--gold)';
  document.getElementById('canal-tabs').style.display = 'flex';
  var traitresTab = document.getElementById('tab-traitres-btn');
  if (traitresTab) traitresTab.style.display = isTreason ? 'block' : 'none';
  switchCanal('groupe');
  _loadChatHistory();
  setWsStatus(ws && ws.readyState === WebSocket.OPEN);
}

function showChatMode() {
  var revealSection = document.getElementById('role-reveal-section');
  if (revealSection && revealSection.innerHTML.length > 0 && revealSection.style.display !== 'none') return;
  if (document.getElementById('role-chat-section').style.display === 'none' || !document.getElementById('role-chat-section').style.display) {
    enterChat();
  }
  _loadChatHistory();
}

// ===================================================
// SAUVEGARDE / RESTAURATION ÉTAT
// ===================================================
function saveState() {
  try {
    var state = {
      players: players.map(function(p) { return {id:p.id, name:p.name, role:p.role, pin:p.pin, scanned:p.scanned, photo:p.photo||null, photoFull:p.photoFull||null}; }),
      sessionId: sessionId,
      eliminated: Array.from(eliminatedPlayers),
      challenges: challenges
    };
    localStorage.setItem('traitres_state', JSON.stringify(state));
  } catch(e) {}
}

function restoreState() {
  try {
    var raw = localStorage.getItem('traitres_state');
    if (!raw) return false;
    var state = JSON.parse(raw);
    if (!state.players || !state.players.length) return false;
    players = state.players.map(function(p) { return Object.assign({photoFull:null}, p); });
    sessionId = state.sessionId || '';
    eliminatedPlayers = new Set(state.eliminated || []);
    challenges = state.challenges || [];
    return true;
  } catch(e) { return false; }
}

// ===================================================
// BOOT
// ===================================================
window.addEventListener('pageshow', function(evt) {
  if(evt.persisted){ window.location.reload(); return; }
  renderChallenges();
  var params = new URLSearchParams(window.location.search);
  var _hash = new URLSearchParams(window.location.hash.replace(/^#/,''));
  if(_hash.get('join')==='1' && _hash.get('session') && _hash.get('pid')) params = _hash;

  // QR joueur connexion directe (prioritaire)
  if (params.get('join') === '1' && params.get('session') && params.get('pid')) {
    try{localStorage.removeItem('traitres_state');}catch(e){}
    var _qrpid = params.get('pid');
    var _qrsession = params.get('session');
    var _qrname = decodeURIComponent(params.get('name') || 'Joueur');
    var _qrpin = params.get('pin') || '';
    isAdmin = false;
    myPlayerId = parseInt(_qrpid);
    mySession = _qrsession;
    myPin = _qrpin;
    myName = _qrname;
    try {
      localStorage.setItem('register_pid', _qrpid);
      localStorage.setItem('register_session', _qrsession);
      localStorage.setItem('register_pin', _qrpin);
      localStorage.setItem('register_name', _qrname);
    } catch(e) {}
    var _existingRole = null;
    try {
      var _storedSession = localStorage.getItem('register_session');
      var _storedPid = localStorage.getItem('register_pid');
      if (_storedSession === _qrsession && _storedPid === _qrpid) {
        _existingRole = localStorage.getItem('register_role');
      }
    } catch(e) {}
    connectWS(function() {
      var _role = _existingRole || 'fidele';
      wsSend({type:'identify', playerId:parseInt(_qrpid), playerName:_qrname, role:_role, sessionId:_qrsession, isAdmin:false});
    });
    document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); s.style.cssText = 'display:none!important'; });
    if (_existingRole) {
      myRole = _existingRole;
      var rs = document.getElementById('role-screen');
      rs.style.cssText = 'display:flex!important;flex-direction:column;min-height:100vh;';
      renderRolePage(new URLSearchParams('role='+_existingRole+'&name='+encodeURIComponent(_qrname)+'&pid='+_qrpid+'&session='+_qrsession+'&pin='+_qrpin));
      setTimeout(function(){ enterChat(); }, 50);
    } else {
      document.getElementById('waiting-screen').style.cssText = 'display:flex!important;flex-direction:column;min-height:100vh;align-items:center;justify-content:center;';
      document.getElementById('waiting-name').textContent = 'Bonjour ' + _qrname + ' !';
    }
    return;
  }

  // Mode inscription via QR accueil
  if (params.get('register') === '1' && params.get('session')) {
    _registerSession = params.get('session');
    document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); s.style.display = 'none'; });
    document.getElementById('admin-screen').style.display = 'none';
    document.getElementById('admin-screen').classList.remove('active');
    /* pin-screen removed */
    document.getElementById('register-screen').style.display = 'flex';
    connectWS(null);
    return;
  }

  // Reconnexion automatique joueur si localStorage complet
  var _pid = localStorage.getItem('register_pid');
  var _psession = localStorage.getItem('register_session');
  var _ppin = localStorage.getItem('register_pin');
  var _prole = localStorage.getItem('register_role');
  var _pname = localStorage.getItem('register_name');
  if (_pid && _psession && _psession !== 'null' && _prole && _pname) {
    isAdmin = false;
    myPlayerId = parseInt(_pid);
    mySession = _psession;
    myPin = _ppin || '';
    myRole = _prole;
    myName = _pname;
    connectWS(function() {
      wsSend({type:'identify', playerId:myPlayerId, playerName:myName, role:myRole, sessionId:mySession, isAdmin:false});
    });
    document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); s.style.cssText = 'display:none!important'; });
    var rs = document.getElementById('role-screen');
    rs.style.cssText = 'display:flex!important;flex-direction:column;min-height:100vh;';
    renderRolePage(new URLSearchParams('role='+_prole+'&name='+encodeURIComponent(_pname)+'&pid='+_pid+'&session='+_psession+'&pin='+(_ppin||'')));
    setTimeout(function(){ enterChat(); }, 50);
    return;
  }

  // Mode joueur via URL ancienne (role dans l'URL)
  if (params.get('role')) {
    showPinScreen(params);
    return;
  }

  // FIX BUG 7 : restauration admin — ne pas bloquer si ?session absent de l'URL
  var _hasPlayerData = localStorage.getItem('register_pid') && localStorage.getItem('register_session') && localStorage.getItem('register_session') !== 'null';
  if (!params.get('register') && !params.get('join') && !_hasPlayerData && restoreState()) {
    isAdmin = true;
    connectWS(function() {
      wsSend({type:'identify', playerId:'admin', playerName:'Animateur', role:'admin', sessionId:sessionId, isAdmin:true});
    });
    renderPlayers(); updateProgress(); updateVictimSelect(); updatePrivateTarget(); renderChallenges();
    /* pin-screen removed */
    document.getElementById('admin-screen').classList.add('active');
    document.getElementById('scan-progress').style.display = 'block';
    document.getElementById('main-grid').style.display = 'grid';
    document.getElementById('total-count').textContent = players.filter(function(p) { return !eliminatedPlayers.has(p.id); }).length;
    document.getElementById('btn-qr-accueil').style.display = '';
    document.getElementById('btn-reveal').style.display = '';
    document.getElementById('btn-fin-jeu').style.display = '';
    players.forEach(function(p) { if (p.photo) photoStore[p.id] = p.photo; });
  } else {
    connectWS(null);
  }
});
