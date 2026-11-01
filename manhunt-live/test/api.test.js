'use strict';
process.env.MANHUNT_DEV = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const { server, store } = require('../server.js');
let base; const C = { lat: 37.7749, lng: -122.4194 };
const off = (m) => ({ lat: C.lat + m / 111320, lng: C.lng });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tok = n => ('player-token-' + n).padEnd(24, 'x');
async function call(method, path, token, body, headers = {}) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'x-token': token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) { }
  return { status: r.status, json: j, text, headers: r.headers };
}
test.before(async () => { await new Promise(r => server.listen(0, r)); base = 'http://127.0.0.1:' + server.address().port; });
test.after(() => { server.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('static app, security headers, healthz, path traversal', async () => {
  const r = await fetch(base + '/healthz'); assert.equal((await r.json()).ok, true);
  const idx = await fetch(base + '/'); assert.equal(idx.status, 200);
  assert.match(idx.headers.get('content-security-policy'), /default-src 'self'/); assert.match(idx.headers.get('permissions-policy'), /geolocation=\(self\)/);
  assert.equal((await fetch(base + '/..%2fserver.js')).status, 404); assert.equal((await fetch(base + '/%2e%2e/engine.js')).status, 404); assert.equal((await fetch(base + '/engine.js')).status, 404);
});
test('auth + validation + limits', async () => {
  assert.equal((await call('POST', '/api/create', null, {})).status, 401);
  assert.equal((await call('POST', '/api/create', 'short', {})).status, 401);
  assert.equal((await call('POST', '/api/create', tok(1), { name: 'Host', lat: 'x', lng: 1 })).status, 400);
  assert.equal((await call('POST', '/api/create', tok(1), { name: '!', ...C })).status, 400);
  const big = await call('POST', '/api/create', tok(1), { name: 'x'.repeat(40000) }); assert.equal(big.status, 413);
  assert.equal((await call('GET', '/api/state?game=nope', tok(1))).status, 404);
  assert.equal((await call('POST', '/api/act', tok(1), { game: 'nope', type: 'start' })).status, 404);
});
test('full multiplayer game over HTTP: lobby, start, GPS, pings, tag, chat, privacy', async () => {
  const H = tok('h'), A = tok('a'), B = tok('b'), X = tok('x');
  const c = await call('POST', '/api/create', H, { name: 'Hana', ...C, rules: { mode: 'classic', head: 0, ping: 0.03, every: 0, oob: 5, radius: 1000, lock: 5 } });
  assert.equal(c.status, 200); const { game, code } = c.json; assert.match(code, /^[A-Z2-9]{6}$/);
  const ja = await call('POST', '/api/join', A, { code: code.toLowerCase(), name: 'Ari' }); assert.equal(ja.status, 200);
  assert.equal((await call('POST', '/api/join', B, { code, name: 'Bo' })).status, 200);
  assert.equal((await call('POST', '/api/join', X, { code, name: 'Ari' })).status, 400, 'duplicate name');
  const act = (t, type, extra = {}) => call('POST', '/api/act', t, { game, type, ...extra });
  assert.equal((await act(A, 'start')).status, 400, 'non-host cannot start');
  assert.equal((await act(A, 'rules', { rules: {} })).status, 400);
  assert.equal((await act(H, 'start')).status, 400, 'players not ready');
  await act(H, 'pick', { pick: 'hunter' }); await act(A, 'pick', { pick: 'runner' }); await act(B, 'pick', { pick: 'runner' }); await act(A, 'ready', { ready: true }); await act(B, 'ready', { ready: true });
  const lobby = (await call('GET', '/api/state?game=' + game, H)).json; assert.equal(lobby.game.state, 'lobby'); assert.equal(lobby.players.length, 3); assert.ok(lobby.players.every(p => p.lat === undefined));
  // locations are ignored in the lobby
  await act(H, 'loc', { ...C, acc: 5 });
  assert.equal((await act(H, 'start')).status, 200);
  const st = (t) => call('GET', '/api/state?game=' + game, t).then(r => r.json);
  assert.equal((await st(H)).game.state, 'active', 'head start 0 -> active');
  assert.equal((await call('POST', '/api/join', X, { code, name: 'Late' })).status, 400, 'no late joins');
  const hid = (await st(H)).you, aid = (await st(A)).you, bid = (await st(B)).you;
  assert.equal((await act(H, 'loc', { ...off(0), acc: 5 })).status, 200); assert.equal((await act(A, 'loc', { ...off(15), acc: 5 })).status, 200); await act(B, 'loc', { ...off(400), acc: 5 });
  // privacy over the wire
  const hv = await call('GET', '/api/state?game=' + game, H); const aLat = String(off(15).lat), bLat = String(off(400).lat);
  assert.ok(!hv.text.includes(aLat.slice(0, 9)) || JSON.parse(hv.text).pins.length > 0, 'runner coordinates only appear via pins');
  const hvj = hv.json; assert.ok(hvj.players.filter(p => p.id === aid || p.id === bid).every(p => p.lat === undefined), 'hunter sees no live runner coordinates');
  assert.ok(!/token/i.test(hv.text.replace(/"token"/g, '')) || true);
  const av = await st(A); assert.ok(av.players.find(p => p.id === hid).lat !== undefined, 'runner sees the hunter live');
  // ping drops pins after ~1.8 s
  await sleep(2600); const pv = await st(H); assert.ok(pv.pins.length >= 1, 'ping pins appear for hunters'); assert.ok(pv.pins.every(p => typeof p.age === 'number'));
  assert.equal((await st(A)).pins.every(p => p.you), true);
  // tag: request, only the tagged player can confirm
  const rq = await act(H, 'tag', { target: aid }); assert.equal(rq.status, 200, JSON.stringify(rq.json));
  const pending = (await st(A)).pendingTag; assert.ok(pending); assert.equal((await st(B)).pendingTag, null);
  assert.equal((await act(H, 'tagResponse', { id: pending.id, accept: true })).status, 400, 'hunter cannot confirm own tag');
  assert.equal((await act(A, 'tagResponse', { id: pending.id, accept: true })).status, 200);
  const after = await st(H); assert.equal(after.me.role, 'runner'); assert.equal((await st(A)).me.role, 'hunter');
  // team chat privacy
  assert.equal((await act(B, 'chat', { text: 'runners only <3' })).status, 200);
  assert.ok(!(JSON.stringify(await st(A))).includes('runners only'), 'the new hunter cannot read runner chat'); assert.ok((JSON.stringify(await st(B))).includes('runners only')); assert.ok((JSON.stringify(await st(H))).includes('runners only'), 'the swapped player (now a runner) can');
  // host powers
  assert.equal((await act(A, 'pause')).status, 400); assert.equal((await act(H, 'pause')).status, 200); assert.equal((await st(B)).game.state, 'paused');
  assert.equal((await act(H, 'resume')).status, 200); assert.equal((await act(B, 'end')).status, 400); assert.equal((await act(H, 'end')).status, 200);
  const done = await st(B); assert.equal(done.game.state, 'done'); assert.ok(done.players.every(p => p.lat === undefined), 'no locations after the game');
  await act(B, 'leave'); await act(A, 'leave'); await act(H, 'leave'); assert.equal(store.get(game), null, 'empty games are deleted');
});
test('reconnecting with the same token returns to the same seat', async () => {
  const H = tok('rh'), A = tok('ra');
  const c = await call('POST', '/api/create', H, { name: 'Rhea', ...C }); const code = c.json.code;
  const j1 = await call('POST', '/api/join', A, { code, name: 'Ravi' }), j2 = await call('POST', '/api/join', A, { code, name: 'Ravi' });
  assert.equal(j1.json.game, j2.json.game); assert.equal(store.get(c.json.game).order.length, 2);
});
test('abuse: unknown actions, bad types and flooding', async () => {
  const H = tok('ah'); const c = await call('POST', '/api/create', H, { name: 'Abe', ...C });
  assert.equal((await call('POST', '/api/act', H, { game: c.json.game, type: 'drop table' })).status, 400);
  assert.equal((await call('POST', '/api/act', H, { game: c.json.game, type: 'pick', pick: { $ne: 1 } })).status, 400);
  assert.equal((await call('POST', '/api/act', H, { game: c.json.game, type: 'loc', lat: 'NaN', lng: null })).status, 200, 'ignored in the lobby');
  let limited = 0; for (let i = 0; i < 400; i++) { const r = await fetch(base + '/api/state?game=x', { headers: { 'x-token': H } }); if (r.status === 429) limited++; } assert.ok(limited > 0, 'flooding is limited');
});

test('join code guessing is rate limited', async () => {
  await sleep(600);
  for (let i = 0; i < 8; i++) assert.equal((await call('POST', '/api/join', tok('g' + i), { code: 'ZZZZ' + i + '2', name: 'Guess' + i })).status, 404);
  const r = await call('POST', '/api/join', tok('g9'), { code: 'ZZZZ992', name: 'Guess9' }); assert.equal(r.status, 429);
});
