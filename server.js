// Kahoot-style live quiz server: HTTP (static files) + WebSocket (game).
// Run:  npm install && node server.js      Optional env: PORT, HOST_KEY
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST_KEY = process.env.HOST_KEY || '';          // if set, teachers must enter it to create a game
const MAX_PLAYERS = 250;
const GAME_TTL_MS = 6 * 60 * 60 * 1000;               // drop idle games after 6 hours
const PUBLIC_DIR = path.join(__dirname, 'public');
const QUESTION_DIR = path.join(__dirname, 'questions');

// ---------------------------------------------------------------- question banks
const banks = {};
function loadBanks() {
  for (const f of fs.readdirSync(QUESTION_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(QUESTION_DIR, f), 'utf8'));
      const id = f.replace(/\.json$/, '');
      const questions = data.questions.filter(q =>
        q && typeof q.q === 'string' && Array.isArray(q.options) &&
        q.options.length >= 2 && q.options.length <= 4 &&
        Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length);
      banks[id] = { id, title: data.title || id, description: data.description || '', modules: data.modules || {}, questions };
      console.log(`Loaded bank "${id}": ${questions.length} questions`);
    } catch (e) { console.error('Could not load', f, e.message); }
  }
}
loadBanks();

function bankSummary() {
  return Object.values(banks).map(b => {
    const counts = {};
    b.questions.forEach(q => { counts[q.module] = (counts[q.module] || 0) + 1; });
    return { id: b.id, title: b.title, description: b.description, modules: b.modules, counts, total: b.questions.length };
  });
}

// ---------------------------------------------------------------- helpers
const rid = (n = 12) => crypto.randomBytes(n).toString('hex');
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 18);
}
function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

// ---------------------------------------------------------------- games
const games = new Map(); // pin -> game

function newPin() {
  for (let i = 0; i < 50; i++) {
    const pin = String(crypto.randomInt(100000, 1000000));
    if (!games.has(pin)) return pin;
  }
  throw new Error('no free pin');
}

function createGame(opts) {
  const bank = banks[opts.bank] || Object.values(banks)[0];
  if (!bank) return null;
  const mods = Array.isArray(opts.modules) && opts.modules.length ? opts.modules.map(String) : null;
  let pool = bank.questions.filter(q => !mods || mods.includes(String(q.module)));
  if (opts.shuffleQ !== false) pool = shuffle(pool);
  const count = parseInt(opts.count, 10);
  if (count > 0) pool = pool.slice(0, count);
  const baseTime = Math.min(120, Math.max(5, parseInt(opts.timeLimit, 10) || 20));
  const qs = pool.map(q => {
    let order = q.options.map((_, i) => i);
    if (opts.shuffleOpts !== false && q.options.length > 2) order = shuffle(order);
    return {
      module: q.module,
      q: q.q,
      options: order.map(i => q.options[i]),
      answer: order.indexOf(q.answer),
      explain: q.explain || '',
      time: Math.max(baseTime, parseInt(q.time, 10) || 0)
    };
  });
  if (!qs.length) return null;
  const pin = newPin();
  const g = {
    pin, hostToken: rid(), hostWs: null,
    bankTitle: bank.title,
    questions: qs,
    state: 'lobby',               // lobby | question | reveal | final
    qi: -1, qStart: 0, qDeadline: 0, timer: null,
    locked: false,
    players: new Map(),           // id -> player
    created: Date.now(), touched: Date.now()
  };
  games.set(pin, g);
  return g;
}

function publicPlayers(g) {
  return [...g.players.values()].map(p => ({ id: p.id, name: p.name, connected: p.connected }));
}
function ranked(g) {
  return [...g.players.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}
function toHost(g, msg) { send(g.hostWs, msg); }
function toPlayers(g, fn) {
  for (const p of g.players.values()) {
    const m = typeof fn === 'function' ? fn(p) : fn;
    if (m) send(p.ws, m);
  }
}
function connectedPlayers(g) { return [...g.players.values()].filter(p => p.connected); }

function startQuestion(g) {
  g.qi += 1;
  if (g.qi >= g.questions.length) return finishGame(g);
  const q = g.questions[g.qi];
  g.state = 'question';
  g.qStart = Date.now();
  g.qDeadline = g.qStart + q.time * 1000;
  for (const p of g.players.values()) p.current = null;
  clearTimeout(g.timer);
  g.timer = setTimeout(() => endQuestion(g), q.time * 1000 + 250); // small grace for latency
  toHost(g, questionMsg(g, true));
  toPlayers(g, () => questionMsg(g, false));
}

function questionMsg(g, forHost) {
  const q = g.questions[g.qi];
  return {
    t: 'question', index: g.qi, total: g.questions.length, module: q.module,
    q: q.q, options: q.options, timeLimit: q.time,
    remainingMs: Math.max(0, g.qDeadline - Date.now()),
    answered: [...g.players.values()].filter(p => p.current).length,
    players: g.players.size
  };
}

function endQuestion(g) {
  if (g.state !== 'question') return;
  clearTimeout(g.timer);
  g.state = 'reveal';
  const q = g.questions[g.qi];
  const counts = q.options.map(() => 0);
  for (const p of g.players.values()) {
    const a = p.current;
    if (a) counts[a.choice] += 1;
    if (!a) { p.streak = 0; p.history.push(null); }
  }
  const order = ranked(g);
  const top = order.slice(0, 5).map(p => ({ name: p.name, score: p.score }));
  const lastQ = g.qi === g.questions.length - 1;
  toHost(g, { t: 'reveal', index: g.qi, total: g.questions.length, module: q.module, q: q.q, options: q.options, correct: q.answer, counts, explain: q.explain, top, last: lastQ, answered: counts.reduce((a, b) => a + b, 0), players: g.players.size });
  order.forEach((p, i) => {
    const a = p.current;
    send(p.ws, {
      t: 'reveal', correct: q.answer, explain: q.explain,
      yourChoice: a ? a.choice : null,
      right: !!(a && a.right),
      gained: a ? a.points : 0,
      score: p.score, rank: i + 1, of: order.length, streak: p.streak,
      behind: i > 0 ? order[i - 1].score - p.score : 0,
      ahead: i > 0 ? order[i - 1].name : null,
      last: lastQ
    });
  });
}

function finishGame(g) {
  clearTimeout(g.timer);
  g.state = 'final';
  const order = ranked(g);
  const results = order.map((p, i) => ({
    rank: i + 1, name: p.name, score: p.score,
    correct: p.history.filter(h => h === true).length,
    history: p.history
  }));
  toHost(g, {
    t: 'final', podium: results.slice(0, 5), results,
    questions: g.questions.map(q => ({ module: q.module, q: q.q })),
    title: g.bankTitle
  });
  order.forEach((p, i) => send(p.ws, {
    t: 'final', rank: i + 1, of: order.length, score: p.score,
    correct: p.history.filter(h => h === true).length, total: g.questions.length,
    podium: results.slice(0, 3).map(r => ({ name: r.name, score: r.score }))
  }));
}

// End the current question shortly, but only if that same question is still live.
function endSoon(g, ms = 600) {
  const qi = g.qi;
  setTimeout(() => { if (g.state === 'question' && g.qi === qi) endQuestion(g); }, ms);
}

function recordAnswer(g, p, qIndex, choice) {
  if (g.state !== 'question' || qIndex !== g.qi || p.current) return;
  const q = g.questions[g.qi];
  if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return;
  const now = Date.now();
  if (now > g.qDeadline + 250) return;
  const elapsed = Math.min(now - g.qStart, q.time * 1000);
  const right = choice === q.answer;
  let points = 0;
  if (right) {
    p.streak += 1;
    points = Math.round(1000 * (1 - (elapsed / (q.time * 1000)) / 2));      // 500..1000 for speed
    if (p.streak >= 2) points += Math.min(p.streak - 1, 5) * 100;           // streak bonus up to +500
    p.score += points;
  } else {
    p.streak = 0;
  }
  p.current = { choice, right, points, ms: elapsed };
  p.history.push(right);
  send(p.ws, { t: 'ack', choice });
  const answered = [...g.players.values()].filter(x => x.current).length;
  toHost(g, { t: 'answered', answered, players: g.players.size });
  // End early once every connected player has answered.
  const waiting = connectedPlayers(g).filter(x => !x.current).length;
  if (waiting === 0) endSoon(g);
}

// ---------------------------------------------------------------- HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ hostKeyRequired: !!HOST_KEY, banks: bankSummary() }));
  }
  if (url.pathname === '/qr.svg') {
    const text = (url.searchParams.get('text') || '').slice(0, 300);
    return QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }, (err, svg) => {
      if (err) { res.writeHead(400); return res.end('bad'); }
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' });
      res.end(svg);
    });
  }
  if (url.pathname === '/healthz') { res.writeHead(200); return res.end('ok'); }
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (p === '/host') p = '/host.html';
  if (p === '/play') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------------------------------------------------------------- WebSocket
const wss = new WebSocketServer({ server, maxPayload: 4096 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.role = null; ws.game = null; ws.player = null;

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(ws, m); } catch (e) { console.error('handler error', e); }
  });

  ws.on('close', () => {
    if (ws.role === 'player' && ws.player && ws.player.ws === ws) {
      ws.player.connected = false;
      const g = ws.game;
      if (g) {
        toHost(g, { t: 'lobby', players: publicPlayers(g), locked: g.locked });
        if (g.state === 'question') {
          const waiting = connectedPlayers(g).filter(x => !x.current).length;
          if (connectedPlayers(g).length && waiting === 0) endSoon(g);
        }
      }
    }
    if (ws.role === 'host' && ws.game && ws.game.hostWs === ws) ws.game.hostWs = null;
  });
});

function handle(ws, m) {
  switch (m.t) {
    // ------------------------------------------------ host
    case 'host:create': {
      if (HOST_KEY && m.key !== HOST_KEY) return send(ws, { t: 'error', code: 'key', msg: 'Wrong teacher key.' });
      const g = createGame(m);
      if (!g) return send(ws, { t: 'error', code: 'create', msg: 'No questions match those settings.' });
      g.hostWs = ws; ws.role = 'host'; ws.game = g;
      return send(ws, { t: 'host:created', pin: g.pin, hostToken: g.hostToken, total: g.questions.length, title: g.bankTitle });
    }
    case 'host:resume': {
      const g = games.get(String(m.pin));
      if (!g || g.hostToken !== m.hostToken) return send(ws, { t: 'error', code: 'resume', msg: 'That game has ended.' });
      g.hostWs = ws; ws.role = 'host'; ws.game = g; g.touched = Date.now();
      send(ws, { t: 'host:created', pin: g.pin, hostToken: g.hostToken, total: g.questions.length, title: g.bankTitle, resumed: true });
      if (g.state === 'lobby') send(ws, { t: 'lobby', players: publicPlayers(g), locked: g.locked });
      else if (g.state === 'question') send(ws, questionMsg(g, true));
      else if (g.state === 'reveal') {
        // Re-send the reveal view for the current question.
        const q = g.questions[g.qi];
        const counts = q.options.map(() => 0);
        for (const p of g.players.values()) if (p.current) counts[p.current.choice] += 1;
        send(ws, { t: 'reveal', index: g.qi, total: g.questions.length, module: q.module, q: q.q, options: q.options, correct: q.answer, counts, explain: q.explain, top: ranked(g).slice(0, 5).map(p => ({ name: p.name, score: p.score })), last: g.qi === g.questions.length - 1, answered: counts.reduce((a, b) => a + b, 0), players: g.players.size });
      } else if (g.state === 'final') finishGame(g);
      return;
    }
    case 'host:start': case 'host:next': {
      const g = ws.game; if (!g || ws.role !== 'host') return;
      g.touched = Date.now();
      if (g.state === 'lobby') { if (g.players.size === 0) return send(ws, { t: 'error', code: 'noplayers', msg: 'Wait for at least one player to join.' }); return startQuestion(g); }
      if (g.state === 'reveal') return startQuestion(g);
      return;
    }
    case 'host:skip': { const g = ws.game; if (g && ws.role === 'host') endQuestion(g); return; }
    case 'host:lock': { const g = ws.game; if (g && ws.role === 'host') { g.locked = !!m.locked; toHost(g, { t: 'lobby', players: publicPlayers(g), locked: g.locked }); } return; }
    case 'host:kick': {
      const g = ws.game; if (!g || ws.role !== 'host') return;
      const p = g.players.get(String(m.id)); if (!p) return;
      send(p.ws, { t: 'kicked' });
      g.players.delete(p.id);
      try { p.ws && p.ws.close(); } catch {}
      toHost(g, { t: 'lobby', players: publicPlayers(g), locked: g.locked });
      return;
    }
    case 'host:end': {
      const g = ws.game; if (!g || ws.role !== 'host') return;
      if (g.state !== 'final') finishGame(g);
      return;
    }
    case 'host:close': {
      const g = ws.game; if (!g || ws.role !== 'host') return;
      toPlayers(g, { t: 'closed' });
      clearTimeout(g.timer); games.delete(g.pin); return;
    }

    // ------------------------------------------------ player
    case 'p:join': {
      const g = games.get(String(m.pin || '').replace(/\D/g, ''));
      if (!g) return send(ws, { t: 'error', code: 'pin', msg: 'Game not found. Check the code.' });
      g.touched = Date.now();
      // Rejoin with token
      if (m.token) {
        for (const p of g.players.values()) {
          if (p.token === m.token) {
            if (p.ws && p.ws !== ws) try { p.ws.close(); } catch {}
            p.ws = ws; p.connected = true; ws.role = 'player'; ws.game = g; ws.player = p;
            send(ws, { t: 'joined', id: p.id, token: p.token, name: p.name, rejoined: true, state: g.state });
            toHost(g, { t: 'lobby', players: publicPlayers(g), locked: g.locked });
            if (g.state === 'question') {
              send(ws, questionMsg(g, false));
              if (p.current) send(ws, { t: 'ack', choice: p.current.choice });
            }
            if (g.state === 'final') finishGame(g);
            return;
          }
        }
      }
      if (g.state !== 'lobby' && !m.token) {
        // Late joins are allowed mid-game (they simply start with 0 points).
      }
      if (g.locked) return send(ws, { t: 'error', code: 'locked', msg: 'This game is locked.' });
      if (g.state === 'final') return send(ws, { t: 'error', code: 'over', msg: 'This game has finished.' });
      if (g.players.size >= MAX_PLAYERS) return send(ws, { t: 'error', code: 'full', msg: 'This game is full.' });
      const name = cleanName(m.name);
      if (!name) return send(ws, { t: 'error', code: 'name', msg: 'Please enter a nickname.' });
      for (const p of g.players.values()) {
        if (p.name.toLowerCase() === name.toLowerCase()) return send(ws, { t: 'error', code: 'name', msg: 'That nickname is taken. Try another.' });
      }
      const p = { id: rid(4), token: rid(), name, ws, connected: true, score: 0, streak: 0, current: null, history: [] };
      // Late joiners get "missed" history so CSV columns line up.
      for (let i = 0; i < Math.max(0, g.qi + (g.state === 'question' ? 0 : 1)); i++) p.history.push(null);
      g.players.set(p.id, p);
      ws.role = 'player'; ws.game = g; ws.player = p;
      send(ws, { t: 'joined', id: p.id, token: p.token, name: p.name, state: g.state });
      toHost(g, { t: 'lobby', players: publicPlayers(g), locked: g.locked });
      if (g.state === 'question') send(ws, questionMsg(g, false));
      return;
    }
    case 'p:answer': {
      const g = ws.game, p = ws.player; if (!g || !p || ws.role !== 'player') return;
      recordAnswer(g, p, m.q, m.choice);
      return;
    }
  }
}

// Heartbeat + cleanup
setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch {} });
  const now = Date.now();
  for (const [pin, g] of games) if (now - g.touched > GAME_TTL_MS && !g.hostWs) { clearTimeout(g.timer); games.delete(pin); }
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nQuiz server running on port ${PORT}`);
  console.log(`  Teacher:  http://localhost:${PORT}/host`);
  console.log(`  Students: http://localhost:${PORT}/`);
  const nets = os.networkInterfaces();
  for (const n of Object.values(nets)) for (const i of n || []) if (i.family === 'IPv4' && !i.internal) console.log(`  On your Wi-Fi (same network): http://${i.address}:${PORT}/`);
  if (HOST_KEY) console.log('  Teacher key is required to create games.');
  console.log('');
});
