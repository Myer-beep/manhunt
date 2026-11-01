'use strict';
// Manhunt server: no dependencies. `node server.js` serves the web app and the game API.
const http = require('http'), fs = require('fs'), path = require('path');
const E = require('./engine.js');

const PORT = Number(process.env.PORT) || 3000;
const DEV = process.env.MANHUNT_DEV === '1';          // dev mode allows very short timers for testing
const DATA_DIR = process.env.DATA_DIR || '';
const PUB = path.join(__dirname, 'public');
const store = new E.Store({ dev: DEV });

// ---- persistence (optional): lobbies survive a restart; locations are never written to disk ----
const SNAP = DATA_DIR ? path.join(DATA_DIR, 'games.json') : '';
function save() {
  if (!SNAP) return;
  try {
    const out = [...store.games.values()].map(g => JSON.parse(JSON.stringify(g, (k, v) => (k === 'loc' ? null : k === 'snap' ? {} : v))));
    fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SNAP + '.tmp', JSON.stringify(out)); fs.renameSync(SNAP + '.tmp', SNAP);
  } catch (e) { console.error('save failed', e.message); }
}
function load() { try { if (SNAP && fs.existsSync(SNAP)) for (const g of JSON.parse(fs.readFileSync(SNAP, 'utf8'))) store.games.set(g.id, g); } catch (e) { console.error('load failed', e.message); } }
load();

// ---- abuse limits ----
const buckets = new Map(), guesses = new Map();
function allow(ip, now) {
  const b = buckets.get(ip) || { t: 120, at: now }; b.t = Math.min(120, b.t + (now - b.at) / 1000 * 40); b.at = now;
  if (b.t < 1) { buckets.set(ip, b); return false; } b.t -= 1; buckets.set(ip, b); return true;
}
function guessBlocked(ip, now) { const g = guesses.get(ip); return !!(g && g.until > now); }
function guessFail(ip, now) { const g = guesses.get(ip) || { n: 0, until: 0 }; g.n++; if (g.n >= 8) { g.until = now + 60000; g.n = 0; } guesses.set(ip, g); }

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0, big = false; const chunks = [];
    req.on('data', c => { n += c.length; if (n > 1048576) req.destroy(); else if (n > 16384) big = true; else chunks.push(c); });
    req.on('end', () => { if (big) return reject(new Error('too big')); try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
const tokenOf = req => { const t = String(req.headers['x-token'] || ''); return t.length >= 16 && t.length <= 128 ? t : null; };
const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

function actOn(g, pid, b, now) {
  const p = g.players[pid];
  if (!p) return { error: 'You\u2019re not in this game.' };
  switch (b.type) {
    case 'pick': return E.setPick(g, pid, String(b.pick));
    case 'ready': return E.setReady(g, pid, !!b.ready);
    case 'rules': return E.updateRules(g, pid, b.rules, DEV);
    case 'recenter': return E.recenter(g, pid, { lat: Number(b.lat), lng: Number(b.lng) });
    case 'start': return E.start(g, pid, now);
    case 'loc': return E.submitLocation(g, pid, { lat: Number(b.lat), lng: Number(b.lng), acc: Number(b.acc) }, now);
    case 'tag': return E.requestTag(g, pid, String(b.target), now);
    case 'tagResponse': return E.respondTag(g, pid, String(b.id), !!b.accept, now);
    case 'chat': return E.sendChat(g, pid, b.text, now);
    case 'pause': return E.pause(g, pid, now);
    case 'resume': return E.resume(g, pid, now);
    case 'end': return E.endGame(g, pid, now);
    case 'kick': return E.kick(g, pid, String(b.target), now);
    case 'leave': E.removeFromGame(g, pid, now); if (!g.order.some(id => g.players[id] && g.players[id].status !== 'left')) store.games.delete(g.id); return { ok: true, left: true };
    default: return { error: 'Unknown action.' };
  }
}

async function api(req, res, url, now) {
  const ip = ipOf(req);
  if (!allow(ip, now)) return send(res, 429, { error: 'Too many requests. Slow down a little.' });
  const tok = tokenOf(req);
  if (!tok) return send(res, 401, { error: 'Missing player token.' });
  const pid = E.playerIdFromToken(tok);
  try {
    if (req.method === 'GET' && url.pathname === '/api/state') {
      const g = store.get(url.searchParams.get('game'));
      if (!g || !g.players[pid]) return send(res, 404, { error: 'That game isn\u2019t available anymore.' });
      E.tick(g, now); g.lastTouch = now; g.players[pid].seen = now;
      return send(res, 200, E.view(g, pid, now));
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'Not allowed.' });
    const b = await readBody(req);
    if (url.pathname === '/api/create') {
      const r = store.create(tok, b.name, b.rules, { lat: Number(b.lat), lng: Number(b.lng) }, now);
      if (r.error) return send(res, 400, r);
      return send(res, 200, { game: r.game.id, code: r.game.code });
    }
    if (url.pathname === '/api/join') {
      if (guessBlocked(ip, now)) return send(res, 429, { error: 'Too many wrong codes. Wait a minute and try again.' });
      const g = store.byCode(b.code);
      if (!g) { guessFail(ip, now); return send(res, 404, { error: 'No game found with that code. Check it and try again.' }); }
      const r = E.join(g, tok, b.name, now);
      if (r.error) return send(res, 400, r);
      return send(res, 200, { game: g.id, code: g.code });
    }
    if (url.pathname === '/api/act') {
      const g = store.get(b.game);
      if (!g || !g.players[pid]) return send(res, 404, { error: 'That game isn\u2019t available anymore.' });
      E.tick(g, now); g.lastTouch = now;
      const r = actOn(g, pid, b, now);
      if (r && r.error) return send(res, 400, r);
      E.tick(g, now);
      return send(res, 200, r || { ok: true });
    }
    return send(res, 404, { error: 'Not found.' });
  } catch (e) {
    if (e.message === 'too big') return send(res, 413, { error: 'Request too large.' });
    if (e.message === 'bad json') return send(res, 400, { error: 'Bad request.' });
    console.error(e); return send(res, 500, { error: 'Something went wrong on the server.' });
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: https://tile.openstreetmap.org https://unpkg.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
function serveStatic(req, res, url) {
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUB, p));
  if (!file.startsWith(PUB + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'geolocation=(self)' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const now = Date.now(); let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  if (url.pathname === '/healthz') return send(res, 200, { ok: true, games: store.games.size });
  if (url.pathname.startsWith('/api/')) return api(req, res, url, now);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, url);
});

// keep every live game ticking even when nobody polls, and clean up old games
setInterval(() => {
  const now = Date.now();
  for (const g of store.games.values()) {
    E.tick(g, now);
    if ((g.state === 'done' && now - g.endedAt > 3600000) || now - g.lastTouch > 6 * 3600000) store.games.delete(g.id);
  }
  for (const [k, b] of buckets) if (now - b.at > 60000) buckets.delete(k);
  for (const [k, g] of guesses) if (g.until < now && g.n === 0) guesses.delete(k);
}, 2000).unref();
if (SNAP) setInterval(save, 20000).unref();
process.on('SIGTERM', () => { save(); process.exit(0); });

if (require.main === module) server.listen(PORT, () => console.log(`Manhunt listening on :${PORT}${DEV ? ' (dev mode: short timers allowed)' : ''}`));
module.exports = { server, store };
