'use strict';
// Manhunt game engine. Pure logic, no network. The server is the only authority:
// clients send intents (location, tag requests, chat); this file decides everything.
const crypto = require('crypto');

const R_EARTH = 6371000;
const rad = d => d * Math.PI / 180;
function dist(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng), la = rad(a.lat), lb = rad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}
const FRESH_MS = 30000, TAG_RANGE = 75, TAG_TTL = 20000, MAX_PLAYERS = 20, MAX_SPEED = 20;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const DEFAULT_RULES = { mode: 'classic', zone: true, radius: 420, every: 5, by: 60, minR: 150, ping: 2, head: 2, oob: 2, lock: 15 };
function cleanName(n) { return String(n == null ? '' : n).replace(/[\u0000-\u001f<>&"'`]/g, '').trim().slice(0, 24); }
function num(v, lo, hi, d) { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; }
function cleanRules(r, dev) {
  r = r || {};
  const mn = dev ? 0.02 : 0.5;            // dev mode allows very short timers for testing
  const out = { mode: r.mode === 'infection' ? 'infection' : 'classic', zone: r.zone !== false };
  out.radius = num(r.radius, 50, 5000, DEFAULT_RULES.radius);
  out.every = r.every === 0 || r.every === '0' ? 0 : num(r.every, mn, 60, DEFAULT_RULES.every);
  out.by = num(r.by, 5, 2000, DEFAULT_RULES.by);
  out.minR = num(r.minR, 20, out.radius, Math.min(DEFAULT_RULES.minR, out.radius));
  out.ping = r.ping === 0 || r.ping === '0' ? 0 : num(r.ping, mn, 30, DEFAULT_RULES.ping);
  out.head = num(r.head, dev ? 0 : 0.5, 30, DEFAULT_RULES.head);
  out.oob = num(r.oob, mn, 10, DEFAULT_RULES.oob);
  out.lock = num(r.lock, dev ? 1 : 5, 300, DEFAULT_RULES.lock);
  return out;
}
const rid = n => crypto.randomBytes(n).toString('hex');
const playerIdFromToken = t => crypto.createHash('sha256').update('mh1:' + String(t)).digest('hex').slice(0, 12);

class Store {
  constructor(opts = {}) { this.games = new Map(); this.dev = !!opts.dev; }
  newCode() {
    for (;;) {
      let c = ''; const b = crypto.randomBytes(6);
      for (let i = 0; i < 6; i++) c += ALPHABET[b[i] % ALPHABET.length];
      if (![...this.games.values()].some(g => g.code === c)) return c;
    }
  }
  byCode(code) { code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); for (const g of this.games.values()) if (g.code === code) return g; return null; }
  get(id) { return this.games.get(String(id)) || null; }
  create(token, name, rules, loc, now) {
    name = cleanName(name);
    if (name.length < 2) return { error: 'Names need 2 to 24 characters.' };
    if (!validLoc(loc)) return { error: 'We need your location to set the play zone. Turn on location and try again.' };
    const id = rid(6), pid = playerIdFromToken(token), r = cleanRules(rules, this.dev);
    const g = {
      id, code: this.newCode(), hostId: pid, state: 'lobby', createdAt: now, activeAt: null, endedAt: null, winner: null, reason: null,
      rules: r, zone: { lat: loc.lat, lng: loc.lng, r: r.radius, nextAt: null }, headEnds: null, pausedAt: null,
      ping: { nextAt: null, snap: {}, flashUntil: 0 }, players: {}, order: [], tags: [], chat: [], events: [], lastTouch: now, dev: this.dev
    };
    addPlayer(g, pid, name, now);
    this.games.set(id, g);
    return { game: g, playerId: pid };
  }
}
function validLoc(l) { return l && Number.isFinite(l.lat) && Number.isFinite(l.lng) && Math.abs(l.lat) <= 90 && Math.abs(l.lng) <= 180; }
function addPlayer(g, pid, name, now) {
  g.players[pid] = { id: pid, name, pick: 'random', role: null, status: 'lobby', ready: false, loc: null, joinedAt: now, tags: 0, caught: 0, lock: null, oob: null, lastChat: 0, strikes: 0, seen: now };
  g.order.push(pid);
}
function ev(g, txt, now) { g.events.push({ at: now, txt }); if (g.events.length > 80) g.events.shift(); }
const live = g => g.state === 'head' || g.state === 'active' || g.state === 'paused';
const act = p => p.status === 'active';
const fresh = (p, now) => !!(p.loc && now - p.loc.t < FRESH_MS);

function join(g, token, name, now) {
  name = cleanName(name);
  if (name.length < 2) return { error: 'Names need 2 to 24 characters.' };
  const pid = playerIdFromToken(token);
  if (g.players[pid]) { g.players[pid].seen = now; return { playerId: pid, rejoined: true }; }
  if (g.state === 'done') return { error: 'That game has ended.' };
  if (g.state !== 'lobby') return { error: 'That game already started and isn\u2019t accepting late joins.' };
  if (g.order.length >= MAX_PLAYERS) return { error: 'That game is full.' };
  if (Object.values(g.players).some(p => p.name.toLowerCase() === name.toLowerCase())) return { error: 'Someone in that game already has that name. Pick another.' };
  addPlayer(g, pid, name, now); g.lastTouch = now;
  return { playerId: pid };
}

function removeFromGame(g, pid, now, why) {
  const p = g.players[pid]; if (!p) return;
  if (g.state === 'lobby') { delete g.players[pid]; g.order = g.order.filter(x => x !== pid); }
  else { p.status = 'left'; p.oob = null; delete g.ping.snap[pid]; ev(g, `${p.name} ${why || 'left the game'}`, now); }
  if (g.hostId === pid) {
    const next = g.order.find(x => x !== pid && g.players[x] && g.players[x].status !== 'left');
    if (next) { g.hostId = next; ev(g, `${g.players[next].name} is now the host`, now); }
  }
  if (live(g)) checkEnd(g, now);
}
function activeIds(g, role) { return g.order.filter(id => g.players[id] && act(g.players[id]) && (!role || g.players[id].role === role)); }

function checkEnd(g, now) {
  if (g.state !== 'active' && g.state !== 'head' && g.state !== 'paused') return;
  const hs = activeIds(g, 'hunter').length, rs = activeIds(g, 'runner').length;
  if (rs === 0 || hs === 0) finish(g, null, 'Not enough players left', now);
}
function finish(g, winner, reason, now) {
  g.state = 'done'; g.endedAt = now; g.winner = winner; g.reason = reason || null;
  for (const p of Object.values(g.players)) { p.loc = null; p.oob = null; } // privacy: no locations kept after the game
  g.ping.snap = {}; g.tags.forEach(t => { if (t.status === 'pending') t.status = 'expired'; });
  ev(g, winner ? `Game over: ${winner} wins` : (reason ? `Game over: ${reason}` : 'Game over'), now);
}

function setPick(g, pid, pick) {
  if (g.state !== 'lobby') return { error: 'The game already started.' };
  if (!['hunter', 'runner', 'random'].includes(pick)) return { error: 'Pick hunter, runner or random.' };
  g.players[pid].pick = pick; g.players[pid].ready = false; return { ok: true };
}
function setReady(g, pid, ready) { if (g.state !== 'lobby') return { error: 'The game already started.' }; g.players[pid].ready = !!ready; return { ok: true }; }
function recenter(g, pid, loc) {
  if (g.hostId !== pid) return { error: 'Only the host can do that.' };
  if (g.state !== 'lobby') return { error: 'The zone can only move in the lobby.' };
  if (!validLoc(loc)) return { error: 'Location unavailable.' };
  g.zone.lat = loc.lat; g.zone.lng = loc.lng; return { ok: true };
}
function updateRules(g, pid, rules, dev) {
  if (g.hostId !== pid) return { error: 'Only the host can change the rules.' };
  if (g.state !== 'lobby') return { error: 'Rules can only change in the lobby.' };
  g.rules = cleanRules(rules, dev); g.zone.r = g.rules.radius;
  Object.values(g.players).forEach(p => { if (p.id !== pid) p.ready = false; });
  return { ok: true };
}

function start(g, pid, now) {
  if (g.hostId !== pid) return { error: 'Only the host can start the game.' };
  if (g.state !== 'lobby') return { error: 'The game already started.' };
  const ids = g.order.slice(), n = ids.length;
  if (n < 2) return { error: 'You need at least 2 players.' };
  const notReady = ids.filter(id => id !== g.hostId && !g.players[id].ready).map(id => g.players[id].name);
  if (notReady.length) return { error: 'Waiting for: ' + notReady.join(', ') };
  let h = ids.filter(id => g.players[id].pick === 'hunter').length, r = ids.filter(id => g.players[id].pick === 'runner').length;
  const target = Math.max(1, Math.round(n / 3));
  const rand = ids.filter(id => g.players[id].pick === 'random').sort(() => crypto.randomInt(0, 2) - 0.5);
  const role = {};
  ids.forEach(id => { if (g.players[id].pick !== 'random') role[id] = g.players[id].pick; });
  for (const id of rand) { if (h < target) { role[id] = 'hunter'; h++; } else { role[id] = 'runner'; r++; } }
  if (!h || !r) return { error: 'You need at least one hunter and one runner.' };
  if (h > Math.floor(n / 2)) return { error: `Too many hunters for ${n} players. The most is ${Math.floor(n / 2)}.` };
  ids.forEach(id => { const p = g.players[id]; p.role = role[id]; p.status = 'active'; p.tags = 0; p.caught = 0; p.lock = null; p.oob = null; p.loc = null; });
  g.state = 'head'; g.headEnds = now + g.rules.head * 60000; g.zone.r = g.rules.radius; g.startedAt = now;
  ev(g, 'Head start began: runners, go!', now);
  tick(g, now);
  return { ok: true };
}

function submitLocation(g, pid, loc, now) {
  const p = g.players[pid];
  if (!live(g)) return { ok: true, ignored: true };   // locations are only accepted during a live game
  if (!p || !act(p)) return { ok: true, ignored: true };
  if (!validLoc(loc)) return { error: 'Bad location.' };
  const acc = num(loc.acc, 0, 5000, 50);
  const nl = { lat: loc.lat, lng: loc.lng, acc, t: now };  // timestamps are the server's, never the phone's
  if (p.loc) {
    const dt = (now - p.loc.t) / 1000;
    if (dt < 0.8) return { ok: true, ignored: true };
    const d = dist(p.loc, nl);
    if (dt < 60 && d / dt > MAX_SPEED && d > acc + p.loc.acc + 30) { p.strikes++; return { error: 'That movement looked impossible, so it was ignored.' }; }
  }
  p.loc = nl; p.seen = now; return { ok: true };
}

function shiftTimes(g, d) {
  if (g.headEnds) g.headEnds += d; if (g.zone.nextAt) g.zone.nextAt += d; if (g.ping.nextAt) g.ping.nextAt += d;
  Object.values(g.players).forEach(p => { if (p.oob) p.oob += d; if (p.lock) p.lock.until += d; });
  g.tags.forEach(t => { t.at += d; });
}
function pause(g, pid, now) {
  if (g.hostId !== pid) return { error: 'Only the host can pause the game.' };
  if (g.state !== 'head' && g.state !== 'active') return { error: 'The game isn\u2019t running.' };
  g.prevState = g.state; g.state = 'paused'; g.pausedAt = now; ev(g, 'Paused: all timers frozen', now); return { ok: true };
}
function resume(g, pid, now) {
  if (g.hostId !== pid) return { error: 'Only the host can resume the game.' };
  if (g.state !== 'paused') return { error: 'The game isn\u2019t paused.' };
  shiftTimes(g, now - g.pausedAt); g.state = g.prevState; g.pausedAt = null; ev(g, 'Resumed', now); return { ok: true };
}
function endGame(g, pid, now) {
  if (g.hostId !== pid) return { error: 'Only the host can end the game.' };
  if (!live(g)) return { error: 'The game isn\u2019t running.' };
  finish(g, null, 'Ended by the host', now); return { ok: true };
}
function kick(g, pid, target, now) {
  if (g.hostId !== pid) return { error: 'Only the host can remove players.' };
  if (!g.players[target] || target === pid) return { error: 'No such player.' };
  removeFromGame(g, target, now, 'was removed by the host'); g.kicked = (g.kicked || []).concat(target); return { ok: true };
}

function doPing(g, now) {
  g.ping.snap = {};
  for (const id of activeIds(g, 'runner')) { const p = g.players[id]; if (p.loc && now - p.loc.t < 60000) g.ping.snap[id] = { lat: p.loc.lat, lng: p.loc.lng, at: now, name: p.name }; }
  g.ping.flashUntil = now + 3000; ev(g, 'PING: runner locations updated for the hunters', now);
}
function outsideZone(g, p, now) { return fresh(p, now) && p.loc.acc <= 100 && dist(p.loc, g.zone) - p.loc.acc > g.zone.r; }
function swapRoles(g, runner, hunter, why, now) {
  runner.role = 'hunter'; hunter.role = 'runner'; runner.caught++; runner.oob = null; hunter.oob = null;
  delete g.ping.snap[runner.id]; runner.lock = { vs: hunter.id, until: now + g.rules.lock * 1000 };
  ev(g, `${why}: ${runner.name} is now a hunter and ${hunter.name} is now a runner`, now);
}
function convert(g, runner, why, now) {
  runner.role = 'hunter'; runner.caught++; runner.oob = null; delete g.ping.snap[runner.id];
  ev(g, `${runner.name} ${why} and is now a hunter`, now);
  if (!activeIds(g, 'runner').length) finish(g, runner.name, 'Last runner standing', now);
}
function nearest(g, p, role, now) {
  let best = null, bd = Infinity;
  for (const id of activeIds(g, role)) { const q = g.players[id]; if (!q.loc) continue; const d = p.loc ? dist(p.loc, q.loc) : 1e9; if (d < bd) { bd = d; best = q; } }
  return best;
}

function tick(g, now) {
  if (g.state === 'head' && now >= g.headEnds) {
    g.state = 'active'; g.activeAt = g.headEnds;
    if (g.rules.zone && g.rules.every > 0) g.zone.nextAt = now + g.rules.every * 60000;
    if (g.rules.ping > 0) g.ping.nextAt = now + g.rules.ping * 60000;
    ev(g, 'Game on! Hunters are released', now);
  }
  if (g.state !== 'active') return;
  let guard = 0;
  while (g.zone.nextAt && now >= g.zone.nextAt && guard++ < 100) {
    g.zone.r = Math.max(g.rules.minR, g.zone.r - g.rules.by);
    ev(g, `Zone shrank to ${Math.round(g.zone.r)} m`, g.zone.nextAt);
    g.zone.nextAt = g.zone.r <= g.rules.minR ? null : g.zone.nextAt + g.rules.every * 60000;
  }
  if (g.ping.nextAt && now >= g.ping.nextAt) { doPing(g, now); g.ping.nextAt = now + g.rules.ping * 60000; }
  g.tags.forEach(t => { if (t.status === 'pending' && now - t.at > TAG_TTL) t.status = 'expired'; });
  if (g.rules.zone) for (const id of activeIds(g)) {
    const p = g.players[id]; if (g.state !== 'active') break;
    if (outsideZone(g, p, now)) {
      if (!p.oob) p.oob = now + g.rules.oob * 60000;
      else if (now >= p.oob) {
        p.oob = null;
        if (p.role === 'runner') {
          if (g.rules.mode === 'infection') convert(g, p, 'stayed outside the zone too long', now);
          else { const h = nearest(g, p, 'hunter', now); if (h) swapRoles(g, p, h, `${p.name} stayed outside the zone too long`, now); }
        } else if (g.rules.mode === 'classic') {
          const r = nearest(g, p, 'runner', now); if (r) swapRoles(g, r, p, `${p.name} stayed outside the zone too long`, now);
          else { p.status = 'out'; ev(g, `${p.name} stayed outside the zone and is out`, now); }
        } else { p.status = 'out'; ev(g, `${p.name} stayed outside the zone and is out`, now); }
      }
    } else p.oob = null;
  }
  if (g.state === 'active') checkEnd(g, now);
}

function requestTag(g, hid, rid_, now) {
  if (g.state !== 'active') return { error: 'The game isn\u2019t active.' };
  const h = g.players[hid], r = g.players[rid_];
  if (!h || !act(h) || h.role !== 'hunter') return { error: 'Only active hunters can tag.' };
  if (!r || !act(r) || r.role !== 'runner') return { error: 'That player isn\u2019t an active runner.' };
  if (h.lock && h.lock.vs === rid_ && h.lock.until > now) return { error: `No tag-backs yet: wait ${Math.ceil((h.lock.until - now) / 1000)}s.` };
  if (g.tags.some(t => t.status === 'pending' && t.h === hid && t.r === rid_)) return { error: 'You already asked them. Waiting for their answer.' };
  if (!fresh(h, now) || !fresh(r, now)) return { error: 'Your location or theirs is unavailable right now.' };
  if (dist(h.loc, r.loc) - h.loc.acc - r.loc.acc > TAG_RANGE) return { error: 'You\u2019re too far apart for a tag.' };
  g.tags.push({ id: rid(4), h: hid, r: rid_, at: now, status: 'pending' }); if (g.tags.length > 200) g.tags.shift();
  return { ok: true };
}
function respondTag(g, pid, tagId, accept, now) {
  const t = g.tags.find(x => x.id === tagId);
  if (!t || t.status !== 'pending' || t.r !== pid) return { error: 'That tag request is no longer open.' };
  if (now - t.at > TAG_TTL) { t.status = 'expired'; return { error: 'That tag request expired.' }; }
  if (!accept) { t.status = 'rejected'; return { ok: true }; }
  if (g.state !== 'active') return { error: 'The game isn\u2019t active.' };
  const h = g.players[t.h], r = g.players[t.r];
  if (!h || !act(h) || h.role !== 'hunter' || !act(r) || r.role !== 'runner') { t.status = 'expired'; return { error: 'That tag is no longer valid.' }; }
  t.status = 'confirmed'; h.tags++;
  if (g.rules.mode === 'infection') convert(g, r, `was tagged by ${h.name}`, now);
  else swapRoles(g, r, h, `${r.name} was tagged by ${h.name}`, now);
  return { ok: true };
}

function sendChat(g, pid, text, now) {
  if (!live(g)) return { error: 'Team chat opens when the game starts.' };
  const p = g.players[pid]; if (!p || p.status === 'left') return { error: 'You\u2019re not in this game.' };
  text = String(text == null ? '' : text).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 140);
  if (!text) return { error: 'Type a message first.' };
  if (now - p.lastChat < 800) return { error: 'Slow down a little.' };
  p.lastChat = now;
  const to = g.order.filter(id => g.players[id].role === p.role && g.players[id].status !== 'left');
  g.chat.push({ id: rid(4), team: p.role, from: pid, name: p.name, text, at: now, to }); if (g.chat.length > 80) g.chat.shift();
  return { ok: true };
}

// What a given player is allowed to know. Hidden coordinates are never put in the response.
function view(g, pid, now) {
  const me = g.players[pid]; if (!me) return null;
  const isHunter = me.role === 'hunter';
  const players = g.order.map(id => g.players[id]).filter(Boolean).map(p => {
    const o = { id: p.id, name: p.name, role: live(g) || g.state === 'done' ? p.role : null, pick: p.pick, status: p.status, ready: p.ready, host: p.id === g.hostId, you: p.id === pid, tags: p.tags, caught: p.caught };
    if (live(g) && act(p)) {
      o.outUntil = p.oob || null;
      let show = false;
      if (p.id === pid) show = true;
      else if (!isHunter) show = true;                                  // runners see everyone live
      else show = p.role === 'hunter' || !!p.oob;                        // hunters see hunters, and runners who are outside the zone
      if (show && p.loc) { o.lat = p.loc.lat; o.lng = p.loc.lng; o.acc = Math.round(p.loc.acc); o.age = Math.round((now - p.loc.t) / 1000); }
    }
    return o;
  });
  const pins = [];
  if (live(g)) for (const [id, s] of Object.entries(g.ping.snap)) {
    const r = g.players[id]; if (!r || !act(r) || r.role !== 'runner') continue;
    if (isHunter || id === pid) pins.push({ id, name: s.name, lat: s.lat, lng: s.lng, age: Math.round((now - s.at) / 1000), you: id === pid });
  }
  const pend = g.tags.find(t => t.status === 'pending' && t.r === pid && now - t.at <= TAG_TTL);
  const lock = me.lock && me.lock.until > now ? { until: me.lock.until, vs: me.lock.vs } : null;
  const out = {
    now, you: pid,
    game: { id: g.id, code: g.code, state: g.state, mode: g.rules.mode, rules: g.rules, host: g.hostId === pid, hostId: g.hostId,
      zone: g.rules.zone ? { lat: g.zone.lat, lng: g.zone.lng, r: g.zone.r, minR: g.rules.minR, by: g.rules.by, nextAt: g.zone.nextAt } : { lat: g.zone.lat, lng: g.zone.lng, r: 0, off: true },
      headEnds: g.state === 'head' || (g.state === 'paused' && g.prevState === 'head') ? g.headEnds : null, nextPing: g.ping.nextAt, pingFlashUntil: g.ping.flashUntil,
      paused: g.state === 'paused', pausedAt: g.pausedAt, winner: g.winner, reason: g.reason, startedAt: g.startedAt || null, endedAt: g.endedAt },
    me: { role: me.role, status: me.status, pick: me.pick, ready: me.ready, oobUntil: me.oob || null, lock },
    players, pins, pendingTag: pend ? { id: pend.id, hunter: g.players[pend.h].name, expires: pend.at + TAG_TTL } : null,
    events: g.events.slice(-30), chat: g.chat.filter(m => m.to.includes(pid) && m.team === me.role).slice(-40).map(m => ({ id: m.id, name: m.name, text: m.text, at: m.at, you: m.from === pid }))
  };
  return out;
}

module.exports = { Store, join, setPick, setReady, recenter, updateRules, start, submitLocation, pause, resume, endGame, kick, removeFromGame,
  tick, requestTag, respondTag, sendChat, view, dist, cleanName, cleanRules, playerIdFromToken, DEFAULT_RULES, live, validLoc, FRESH_MS, TAG_RANGE };
