'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const E = require('../engine.js');
const T0 = 1_000_000;
const C = { lat: 37.7749, lng: -122.4194 };
const off = (m, dir = 'n') => ({ lat: C.lat + (dir === 'n' ? m / 111320 : 0), lng: C.lng + (dir === 'e' ? m / (111320 * Math.cos(C.lat * Math.PI / 180)) : 0) });
function mk(rules = {}, n = 4, dev = true) {
  const s = new E.Store({ dev }); const r = s.create('tok0', 'Host', rules, C, T0); assert.ok(r.game, r.error);
  const g = r.game, toks = ['tok0']; for (let i = 1; i < n; i++) { toks.push('tok' + i); const j = E.join(g, 'tok' + i, 'P' + i, T0); assert.ok(j.playerId, j.error); }
  return { s, g, ids: toks.map(E.playerIdFromToken), toks };
}
function begin(rules, picks, n = picks.length) {
  const x = mk(rules, n); x.ids.forEach((id, i) => { E.setPick(x.g, id, picks[i]); E.setReady(x.g, id, true); });
  const r = E.start(x.g, x.ids[0], T0); assert.ok(r.ok, r.error); return x;
}
const at = (g, id, pos, t, acc = 5) => E.submitLocation(g, id, { lat: pos.lat, lng: pos.lng, acc }, t);
function active(x, t = T0 + 130000) { E.tick(x.g, t); assert.equal(x.g.state, 'active'); return t; }

test('create + join + validation', () => {
  const s = new E.Store(); assert.ok(s.create('t', 'A', {}, null, T0).error);
  assert.ok(s.create('t', 'x', {}, C, T0).error);
  const r = s.create('t', '<b>Sam</b>', {}, C, T0); assert.equal(r.game.players[r.playerId].name, 'bSam/b'); assert.match(r.game.code, /^[A-Z2-9]{6}$/);
  assert.ok(E.join(r.game, 't2', 'a', T0).error); assert.ok(E.join(r.game, 't2', 'bSam/b', T0).error);
  assert.ok(E.join(r.game, 't2', 'Ana', T0).playerId); assert.ok(E.join(r.game, 't2', 'Ana', T0).rejoined);
  for (let i = 0; i < 30; i++) E.join(r.game, 'x' + i, 'N' + i, T0); assert.equal(r.game.order.length, 20); assert.match(E.join(r.game, 'zz', 'Late', T0).error, /full/);
  assert.equal(s.byCode(r.game.code.toLowerCase()).id, r.game.id); assert.equal(s.byCode('NOPE00'), null);
});
test('rules are clamped', () => {
  const r = E.cleanRules({ radius: 1e9, every: -5, by: 'x', ping: 99, head: -1, oob: 0, lock: 1e6, mode: 'weird' }, false);
  assert.equal(r.radius, 5000); assert.ok(r.every >= 0.5); assert.equal(r.mode, 'classic'); assert.ok(r.ping <= 30); assert.ok(r.head >= 0.5); assert.ok(r.oob >= 0.5); assert.ok(r.lock <= 300);
  assert.equal(E.cleanRules({ every: 0, ping: 0 }, false).every, 0); assert.equal(E.cleanRules({ ping: 0 }, false).ping, 0);
});
test('only the host can start / change rules; need ready players and both teams', () => {
  const x = mk({}, 3); const [h, a, b] = x.ids;
  assert.match(E.start(x.g, a, T0).error, /Only the host/); assert.match(E.updateRules(x.g, a, {}, true).error, /Only the host/);
  assert.match(E.start(x.g, h, T0).error, /Waiting for/);
  E.setPick(x.g, h, 'hunter'); E.setPick(x.g, a, 'hunter'); E.setPick(x.g, b, 'hunter'); E.setReady(x.g, a, true); E.setReady(x.g, b, true);
  assert.match(E.start(x.g, h, T0).error, /at least one hunter and one runner|Too many hunters/);
  const one = mk({}, 1); assert.match(E.start(one.g, one.ids[0], T0).error, /at least 2/);
});
test('random roles are balanced and a head start runs first', () => {
  const x = begin({ head: 1 }, ['random', 'random', 'random', 'random', 'random', 'random']);
  const hs = Object.values(x.g.players).filter(p => p.role === 'hunter').length; assert.equal(hs, 2); assert.equal(x.g.state, 'head');
  E.tick(x.g, T0 + 30000); assert.equal(x.g.state, 'head'); E.tick(x.g, T0 + 61000); assert.equal(x.g.state, 'active');
});
test('locations: only during a live game, server clock, plausibility', () => {
  const x = mk({}, 2); assert.ok(E.submitLocation(x.g, x.ids[0], { lat: 1, lng: 1, acc: 5 }, T0).ignored); assert.equal(x.g.players[x.ids[0]].loc, null);
  const y = begin({}, ['hunter', 'runner']); const [h] = y.ids;
  assert.ok(at(y.g, h, C, T0 + 1000).ok); assert.equal(y.g.players[h].loc.t, T0 + 1000);
  assert.ok(E.submitLocation(y.g, h, { lat: 999, lng: 0 }, T0 + 5000).error);
  assert.ok(at(y.g, h, off(2000), T0 + 3000).error, 'teleport rejected'); assert.equal(y.g.players[h].strikes, 1);
  assert.ok(at(y.g, h, off(10), T0 + 8000).ok);
  assert.ok(at(y.g, h, off(11), T0 + 8100).ignored, 'too frequent');
});
test('visibility: runners see everyone, hunters see hunters, pins and out-of-zone runners only', () => {
  const x = begin({ ping: 0 }, ['hunter', 'hunter', 'runner', 'runner']); const [h1, h2, r1, r2] = x.ids; const t = active(x);
  [[h1, off(0)], [h2, off(20)], [r1, off(60)], [r2, off(90)]].forEach(([id, p], i) => at(x.g, id, p, t + 1000 * (i + 1)));
  const vh = E.view(x.g, h1, t + 6000), vr = E.view(x.g, r1, t + 6000);
  const get = (v, id) => v.players.find(p => p.id === id);
  assert.ok(get(vh, h2).lat !== undefined, 'hunter sees hunter'); assert.equal(get(vh, r1).lat, undefined); assert.equal(get(vh, r2).lat, undefined);
  assert.ok(vr.players.every(p => p.lat !== undefined), 'runner sees all');
  const json = JSON.stringify(vh); assert.ok(!json.includes(String(x.g.players[r1].loc.lat)), 'hidden coordinates never appear in the hunter view');
});
test('pings drop pins with age; pins only for hunters; tagged runner loses their pin', () => {
  const x = begin({ ping: 1, mode: 'infection' }, ['hunter', 'runner', 'runner']); const [h, r1, r2] = x.ids; const t = active(x);
  at(x.g, h, off(0), t + 1000); at(x.g, r1, off(30), t + 2000); at(x.g, r2, off(50), t + 3000);
  E.tick(x.g, t + 61000); assert.equal(Object.keys(x.g.ping.snap).length, 2);
  const v = E.view(x.g, h, t + 70000); assert.equal(v.pins.length, 2); assert.equal(v.pins[0].age, 9);
  assert.equal(E.view(x.g, r1, t + 70000).pins.length, 1, 'a runner only sees their own pin'); assert.ok(E.view(x.g, r1, t + 70000).pins[0].you);
  at(x.g, r1, off(30), t + 61500); at(x.g, h, off(31), t + 62500);
  assert.ok(E.requestTag(x.g, h, r1, t + 63000).ok); assert.ok(E.respondTag(x.g, r1, x.g.tags[0].id, true, t + 64000).ok);
  assert.equal(E.view(x.g, h, t + 65000).pins.length, 1, 'tagged runner loses their pin');
});
test('tags need a real confirmation, nearby fresh locations and an active hunter', () => {
  const x = begin({}, ['hunter', 'runner']); const [h, r] = x.ids; const t = active(x);
  assert.match(E.requestTag(x.g, h, r, t).error, /unavailable/);
  at(x.g, h, off(0), t + 1000); at(x.g, r, off(300), t + 2000);
  assert.match(E.requestTag(x.g, h, r, t + 3000).error, /too far/);
  at(x.g, r, off(20), t + 20000, 5); at(x.g, h, off(0), t + 21000);
  assert.match(E.requestTag(x.g, r, h, t + 22000).error, /Only active hunters/); assert.match(E.requestTag(x.g, h, h, t + 22000).error, /isn.t an active runner/);
  assert.ok(E.requestTag(x.g, h, r, t + 22000).ok); assert.match(E.requestTag(x.g, h, r, t + 22100).error, /already asked/);
  assert.equal(x.g.players[r].role, 'runner', 'a request alone changes nothing');
  assert.match(E.respondTag(x.g, h, x.g.tags[0].id, true, t + 23000).error, /no longer open/, 'only the tagged player can answer');
  assert.ok(E.view(x.g, r, t + 23000).pendingTag); assert.equal(E.view(x.g, h, t + 23000).pendingTag, null);
  assert.ok(E.respondTag(x.g, r, x.g.tags[0].id, false, t + 24000).ok); assert.equal(x.g.players[r].role, 'runner');
  at(x.g, h, off(0), t + 40000); at(x.g, r, off(20), t + 40500);
  assert.ok(E.requestTag(x.g, h, r, t + 41000).ok); assert.match(E.respondTag(x.g, r, x.g.tags[1].id, true, t + 41000 + 25000).error, /expired/);
});
test('classic: tagged runner swaps with the hunter, tag-back lock, game never auto-ends', () => {
  const x = begin({ lock: 15 }, ['hunter', 'runner', 'runner']); const [h, r1] = x.ids; const t = active(x);
  at(x.g, h, off(0), t + 1000); at(x.g, r1, off(10), t + 2000);
  E.requestTag(x.g, h, r1, t + 3000); E.respondTag(x.g, r1, x.g.tags[0].id, true, t + 4000);
  assert.equal(x.g.players[r1].role, 'hunter'); assert.equal(x.g.players[h].role, 'runner'); assert.equal(x.g.players[h].tags, 1); assert.equal(x.g.state, 'active');
  at(x.g, h, off(0), t + 5000); at(x.g, r1, off(10), t + 6000);
  assert.match(E.requestTag(x.g, r1, h, t + 7000).error, /No tag-backs/);
  at(x.g, h, off(0), t + 19000); at(x.g, r1, off(10), t + 20000);
  assert.ok(E.requestTag(x.g, r1, h, t + 20500).ok, 'allowed after the lock ends');
  E.tick(x.g, t + 3600000); assert.equal(x.g.state, 'active');
});
test('infection: tagged runners become hunters; the last runner wins', () => {
  const x = begin({ mode: 'infection' }, ['hunter', 'runner', 'runner']); const [h, a, b] = x.ids; const t = active(x);
  at(x.g, h, off(0), t + 1000); at(x.g, a, off(10), t + 2000); at(x.g, b, off(15), t + 3000);
  E.requestTag(x.g, h, a, t + 4000); E.respondTag(x.g, a, x.g.tags[0].id, true, t + 5000);
  assert.equal(x.g.players[a].role, 'hunter'); assert.equal(x.g.state, 'active');
  at(x.g, a, off(12), t + 6000);
  E.requestTag(x.g, a, b, t + 7000); E.respondTag(x.g, b, x.g.tags[1].id, true, t + 8000);
  assert.equal(x.g.state, 'done'); assert.equal(x.g.winner, x.g.players[b].name);
  assert.ok(Object.values(x.g.players).every(p => p.loc === null), 'locations are wiped when the game ends');
});
test('zone shrinks on the server clock, stops at the minimum, and pause freezes timers', () => {
  const x = begin({ radius: 500, every: 1, by: 100, minR: 250, ping: 0, head: 0 }, ['hunter', 'runner']); const t = T0 + 1;
  E.tick(x.g, t); assert.equal(x.g.state, 'active'); assert.equal(x.g.zone.r, 500);
  E.tick(x.g, t + 61000); assert.equal(x.g.zone.r, 400);
  const nx = x.g.zone.nextAt; E.pause(x.g, x.ids[0], t + 70000); E.tick(x.g, t + 10 * 60000); assert.equal(x.g.zone.r, 400);
  E.resume(x.g, x.ids[0], t + 70000 + 5 * 60000); assert.equal(x.g.zone.nextAt, nx + 5 * 60000);
  E.tick(x.g, t + 3600000 * 5); assert.equal(x.g.zone.r, 250); assert.equal(x.g.zone.nextAt, null);
  assert.match(E.pause(x.g, x.ids[1], t).error, /Only the host/);
});
test('out of zone: revealed to hunters, countdown, then the mode outcome; GPS uncertainty is forgiven', () => {
  const x = begin({ radius: 100, minR: 50, every: 0, ping: 0, head: 0, oob: 1 }, ['hunter', 'runner']); const [h, r] = x.ids; const t = T0 + 1; E.tick(x.g, t);
  at(x.g, h, off(10), t + 1000); at(x.g, r, off(130), t + 2000, 40);
  E.tick(x.g, t + 3000); assert.equal(x.g.players[r].oob, null, '130 m with 40 m uncertainty may still be inside');
  at(x.g, r, off(200), t + 4000, 10); E.tick(x.g, t + 5000); assert.ok(x.g.players[r].oob);
  const v = E.view(x.g, h, t + 5000); assert.ok(v.players.find(p => p.id === r).lat !== undefined, 'outside the zone: shown to hunters'); assert.ok(v.players.find(p => p.id === r).outUntil);
  at(x.g, r, off(40), t + 20000); E.tick(x.g, t + 21000); assert.equal(x.g.players[r].oob, null, 'back inside cancels it');
  at(x.g, r, off(220), t + 40000); E.tick(x.g, t + 41000); at(x.g, h, off(10), t + 95000); at(x.g, r, off(220), t + 96000); E.tick(x.g, t + 102000);
  assert.equal(x.g.players[r].role, 'hunter', 'classic: swaps with the nearest hunter');
});
test('team chat: only your team, recipients fixed at send time, rate limited and capped', () => {
  const x = begin({}, ['hunter', 'hunter', 'runner', 'runner']); const [h1, h2, r1, r2] = x.ids; const t = T0 + 10;
  assert.ok(E.sendChat(x.g, h1, 'hello <b>', t).ok); assert.match(E.sendChat(x.g, h1, 'again', t + 100).error, /Slow down/);
  assert.ok(E.sendChat(x.g, r1, 'x'.repeat(500), t + 2000).ok);
  assert.ok(E.view(x.g, h2, t + 3000).chat.some(m => m.text === 'hello <b>'), 'raw text stored; the client must escape it'); assert.ok(E.view(x.g, r1, t + 3000).chat.every(m => m.text !== 'hello <b>'));
  assert.equal(E.view(x.g, r2, t + 3000).chat[0].text.length, 140); assert.ok(E.view(x.g, h1, t + 3000).chat.every(m => m.text.length < 100));
  assert.match(E.sendChat(x.g, h1, '   ', t + 5000).error, /Type a message/);
});
test('leave, kick, host transfer and ending', () => {
  const x = begin({}, ['hunter', 'runner', 'runner']); const [h, a, b] = x.ids;
  E.kick(x.g, h, b, T0 + 5); assert.equal(x.g.players[b].status, 'left'); assert.match(E.kick(x.g, a, h, T0).error, /Only the host/);
  E.removeFromGame(x.g, h, T0 + 10); assert.equal(x.g.hostId, a); assert.equal(x.g.state, 'done', 'no hunters left: game ends');
  const y = begin({}, ['hunter', 'runner']); assert.ok(E.endGame(y.g, y.ids[0], T0 + 20).ok); assert.equal(y.g.winner, null); assert.match(E.endGame(y.g, y.ids[1], T0).error, /Only the host|isn.t running/);
});
test('lobby: ready resets when the host changes rules; late joins refused', () => {
  const x = mk({}, 2); E.setReady(x.g, x.ids[1], true); E.updateRules(x.g, x.ids[0], { radius: 800 }, true); assert.equal(x.g.players[x.ids[1]].ready, false); assert.equal(x.g.zone.r, 800);
  E.setReady(x.g, x.ids[1], true); E.start(x.g, x.ids[0], T0); assert.match(E.join(x.g, 'late', 'Late', T0).error, /already started/);
  assert.ok(E.join(x.g, 'tok1', 'P1', T0).rejoined, 'a returning player can rejoin after reconnecting');
});
