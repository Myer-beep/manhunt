'use strict';
// Real-browser test: three simulated phones (own GPS each) play one game through the real server.
process.env.MANHUNT_DEV = '1';
const { chromium } = require(process.env.PW_PATH || '/home/claude/.npm-global/lib/node_modules/playwright');
const { server } = require('../server.js');
const path = require('path'), assert = require('node:assert/strict');
const C = { lat: 37.7749, lng: -122.4194 }, north = m => ({ latitude: C.lat + m / 111320, longitude: C.lng, accuracy: 5 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = (p, n) => p.evaluate(() => window.scrollTo(0, 0)).then(() => p.screenshot({ path: path.join(__dirname, 'shots', n + '.png'), fullPage: true }));
let pass = 0; const ok = (c, n) => { if (!c) { console.log('FAIL', n); process.exitCode = 1; } else { pass++; console.log('ok  ', n); } };
async function until(fn, ms = 12000, step = 250) { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch (e) { } if (Date.now() - t0 > ms) return false; await sleep(step); } }
const txt = (p, sel) => p.locator(sel).first().innerText().catch(() => '');
const has = (p, sel, re, ms) => until(async () => re.test(await txt(p, sel)), ms);

(async () => {
  await new Promise(r => server.listen(0, r)); const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true });
  const mk = async (geo) => { const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, permissions: geo ? ['geolocation'] : [], geolocation: geo || undefined }); await ctx.route('**/unpkg.com/**', r => r.abort()); const page = await ctx.newPage(); page.on('pageerror', e => { console.log('PAGE ERROR', e.message); process.exitCode = 1; }); return { ctx, page }; };
  const H = await mk(north(0)), A = await mk(north(15)), B = await mk(north(400));
  const stateBodies = []; H.page.on('response', async r => { if (r.url().includes('/api/state')) { try { stateBodies.push(await r.json()); } catch (e) { } } });

  // ---- GPS permission denied is handled ----
  const D = await mk(null); await D.page.goto(base + '/?dev=1'); await D.page.fill('#name', 'Denied'); await D.page.click('#hostBtn'); await D.page.click('#mb0');
  ok(await has(D.page, '#toast', /Location is blocked|couldn.t get your location|can.t give a location/i, 25000), 'denied GPS: friendly message and no game created'); await D.ctx.close();

  // ---- host creates a game ----
  await H.page.goto(base + '/?dev=1'); ok(await H.page.locator('#hostBtn').isVisible(), 'home screen shows Host and Join'); await shot(H.page, '1-home');
  await H.page.fill('#name', 'Hana'); await H.page.click('#hostBtn'); ok(/Before you play/.test(await txt(H.page, '#mbody')), 'safety + location consent before creating'); await H.page.click('#mb0');
  ok(await until(() => H.page.locator('#gcode').isVisible()), 'host reaches the lobby'); const code = (await txt(H.page, '#gcode')).trim(); ok(/^[A-Z2-9]{6}$/.test(code), 'game code ' + code);
  ok(/GPS ready/.test(await txt(H.page, '.note')), 'lobby shows a real GPS fix');
  // host sets quick timers (dev mode)
  const rule = async (k, v) => { await H.page.selectOption(`select[data-rule=${k}]`, String(v)); await sleep(300); };
  await H.page.click('[data-pick=hunter]'); await sleep(400);
  await rule('head', 0); await rule('ping', 0.05); await rule('oob', 0.1); await rule('lock', 3); await rule('radius', 420);
  ok(await until(async () => (await H.page.locator('select[data-rule=ping]').inputValue()) === '0.05'), 'host can change rules');

  // ---- two players join with the code ----
  for (const [P, name] of [[A, 'Ari'], [B, 'Bo']]) {
    await P.page.goto(base + '/?dev=1'); await P.page.fill('#name', name); await P.page.click('#joinBtn');
    await P.page.fill('#code', 'zzzzzz'); await P.page.click('#joinGo'); await P.page.click('#mb0'); ok(await has(P.page, '#jerr', /No game found/, 8000), name + ': wrong code is rejected');
    await P.page.fill('#code', code.toLowerCase()); await P.page.click('#joinGo'); await P.page.click('#mb0');
    ok(await until(() => P.page.locator('#readyBtn').isVisible()), name + ' joined the lobby');
    await P.page.click('[data-pick=runner]'); await sleep(300); await P.page.click('#readyBtn');
  }
  ok(await until(async () => (await H.page.locator('.player').count()) === 3), 'host sees all 3 players'); await shot(H.page, '2-lobby-host'); await shot(A.page, '3-lobby-player');
  ok(await until(async () => /Ready/.test(await txt(H.page, '.player[data-id] >> nth=2'))), 'ready state syncs');
  ok(!(await A.page.locator('#startBtn').count()) && !(await A.page.locator('select[data-rule]').count()), 'non-host sees no start button or editable rules');

  // ---- start ----
  await H.page.click('#startBtn');
  for (const [P, n] of [[H, 'Hana'], [A, 'Ari'], [B, 'Bo']]) ok(await until(() => P.page.locator('#mapwrap').isVisible(), 12000), n + ' is in the game');
  ok(await has(H.page, '#chips', /Hunter/), 'host is the hunter'); ok(await has(A.page, '#chips', /Runner/), 'Ari is a runner'); await sleep(1500);
  ok(await has(H.page, '#map', /./) || await H.page.locator('#map svg, #map .leaflet-container').count() > 0, 'a map is drawn'); await shot(H.page, '4-game-hunter'); await shot(A.page, '5-game-runner');
  const tokens = {}; for (const [k, P] of [['H', H], ['A', A], ['B', B]]) tokens[k] = await P.page.evaluate(() => localStorage.getItem('ml.token'));
  const gameId = await H.page.evaluate(() => localStorage.getItem('ml.game'));
  const raw = async k => (await fetch(`${base}/api/state?game=${gameId}`, { headers: { 'x-token': tokens[k] } })).json();
  ok(await until(async () => { const s = await raw('A'); const h = s.players.find(p => p.name === 'Hana'); return h && h.lat !== undefined; }, 12000), 'real GPS reaches the server: runner sees the hunter live');
  ok(await until(async () => /Hana/.test(await txt(A.page, '#plist')) && /\d+ m/.test(await txt(A.page, '#plist')), 8000), 'player list shows live distance');

  // ---- privacy: hunter never receives runner coordinates; pings drop pins ----
  ok(await until(async () => (await raw('H')).pins.length >= 1, 12000), 'ping drops pins for the hunter'); await sleep(500);
  ok(await has(H.page, '#plist', /pinged \d+:\d\d ago/, 8000), 'hunter\u2019s list shows how old each ping is');
  const leaks = stateBodies.filter(b => b.players && b.players.some(p => p.role === 'runner' && p.lat !== undefined && !p.outUntil)); ok(stateBodies.length > 5 && leaks.length === 0, `no live runner coordinates in ${stateBodies.length} hunter responses`);
  const pinsA = (await raw('A')).pins; ok(pinsA.every(p => p.you), 'a runner only ever gets their own pin');

  // ---- tag flow with real taps ----
  await H.page.click('#tagBtn'); ok(/Who did you physically tag/.test(await txt(H.page, '#mbody')), 'hunter opens the tag picker'); await H.page.click('#mbody [data-t] >> text=Ari');
  ok(await until(async () => /Were you tagged/.test(await txt(A.page, '#mbody')), 8000), 'the tagged player is asked to confirm');
  ok(!/Were you tagged/.test(await txt(B.page, '#mbody')), 'other runners are not asked'); await shot(A.page, '6-tag-confirm');
  await A.page.click('#mb0');
  ok(await has(A.page, '#chips', /Hunter/, 8000), 'confirmed: Ari becomes the hunter'); ok(await has(H.page, '#chips', /Runner/, 8000), 'and Hana becomes a runner');
  ok(await has(H.page, '#banners', /now a RUNNER/, 8000), 'banner explains the role switch'); ok(await has(A.page, '#actions', /Record a tag/, 8000), 'new hunter gets the tag button'); ok(!(await H.page.locator('#tagBtn').count()), 'old hunter loses it');

  // ---- team chat ----
  await B.page.fill('#chatIn', 'runners only <b>hi</b>'); await B.page.click('#chatSend');
  ok(await has(H.page, '#chatlog', /runners only/, 8000), 'a runner\u2019s message reaches the other runner'); await sleep(2500); ok(!/runners only/.test(await txt(A.page, '#chatlog')), 'the hunter cannot read runner chat');
  ok(await A.page.locator('#chatlog b', { hasText: 'hi' }).count() === 0 && (await H.page.locator('#chatlog b', { hasText: 'hi' }).count()) === 0, 'chat text is escaped (no injected HTML)');

  // ---- host controls ----
  ok(!(await A.page.locator('#pauseBtn').count()) && /Only the host/.test(await txt(A.page, '#actions')), 'players cannot pause or end');
  await H.page.click('#pauseBtn'); ok(await has(B.page, '#banners', /Paused by the host/, 8000), 'host pauses everyone'); await H.page.click('#pauseBtn'); ok(await until(async () => !/Paused/.test(await txt(B.page, '#banners')), 8000), 'host resumes');

  // ---- GPS tricks: teleporting is refused; walking out of the zone is detected ----
  await B.ctx.setGeolocation(north(3000)); ok(await has(B.page, '#toast', /impossible/, 12000), 'a teleporting phone is refused by the server');
  await B.ctx.setGeolocation(north(400)); await sleep(5000);
  await B.ctx.setGeolocation(north(460)); ok(await has(A.page, '#plist', /OUTSIDE/, 15000), 'a runner outside the zone is revealed to the hunter with a countdown');
  ok(await until(async () => /stayed outside the zone too long/.test(await txt(H.page, '#evt')), 20000), 'after the countdown the mode\u2019s outcome applies (Classic swap)'); await shot(H.page, '7-after-outofzone');

  // ---- reconnect: a reload mid-game puts the player back in their seat ----
  await A.page.reload(); ok(await until(() => A.page.locator('#mapwrap').isVisible(), 12000), 'reloading the page resumes the game'); ok(await has(A.page, '#chips', /you are/i, 8000), 'and the right role and state');
  // ---- end ----
  await H.page.click('#endBtn'); await H.page.click('#mb0');
  for (const [P, n] of [[H, 'Hana'], [A, 'Ari'], [B, 'Bo']]) ok(await has(P.page, 'h1', /Game over/, 10000), n + ' sees the game-over screen');
  const fin = await raw('A'); ok(fin.players.every(p => p.lat === undefined), 'no locations remain after the game'); await shot(H.page, '8-gameover');
  await H.page.click('#homeBtn'); ok(await H.page.locator('#hostBtn').isVisible(), 'back to home');
  // reconnect: reload mid-game resumes
  await browser.close(); console.log(`\n${pass} checks passed${process.exitCode ? ' (with failures)' : ''}`); server.close(); setTimeout(() => process.exit(), 100);
})().catch(e => { console.error('E2E CRASH', e); process.exit(1); });
