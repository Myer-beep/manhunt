'use strict';
// Checks the Leaflet code path (real OpenStreetMap map) with a recording stand-in for Leaflet, since the sandbox is offline.
process.env.MANHUNT_DEV = '1';
const { chromium } = require(process.env.PW_PATH || '/home/claude/.npm-global/lib/node_modules/playwright');
const { server } = require('../server.js');
const STUB = `
window.__calls=[];const rec=(n,a)=>window.__calls.push([n,a]);
const chain=o=>Object.assign(o,{addTo(){return o},remove(){},clearLayers(){rec('clearLayers')},getBounds(){return{}},setView(){rec('setView');return o},fitBounds(b,opt){rec('fitBounds',opt);return o}});
window.L={map:(el,o)=>{rec('map',el.id);return chain({})},tileLayer:(u,o)=>{rec('tileLayer',[u,o.attribution]);return chain({})},layerGroup:()=>chain({}),
 circle:(c,o)=>{rec('circle',[c,o.radius]);return chain({})},marker:(c,o)=>{rec('marker',[c,o.icon.html]);return chain({})},divIcon:o=>o};`;
(async () => {
  await new Promise(r => server.listen(0, r)); const base = 'http://127.0.0.1:' + server.address().port;
  const b = await chromium.launch({ headless: true }); const ctx = await b.newContext({ permissions: ['geolocation'], geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 } });
  await ctx.route('**/unpkg.com/**', r => r.request().url().endsWith('.js') ? r.fulfill({ contentType: 'text/javascript', body: STUB }) : r.fulfill({ contentType: 'text/css', body: '' }));
  const p = await ctx.newPage(); p.on('pageerror', e => { console.log('PAGE ERROR', e.message); process.exitCode = 1; });
  await p.goto(base + '/?dev=1'); await p.fill('#name', 'Lea'); await p.click('#hostBtn'); await p.click('#mb0'); await p.waitForSelector('#gcode');
  const other = await b.newContext({ permissions: ['geolocation'], geolocation: { latitude: 37.7749, longitude: -122.4193, accuracy: 5 } }); await other.route('**/unpkg.com/**', r => r.abort());
  const q = await other.newPage(); await q.goto(base + '/?dev=1'); await q.fill('#name', 'Max'); await q.click('#joinBtn'); await q.fill('#code', (await p.innerText('#gcode')).trim()); await q.click('#joinGo'); await q.click('#mb0'); await q.waitForSelector('#readyBtn'); await q.click('#readyBtn');
  await p.selectOption('select[data-rule=head]', '0'); await p.click('[data-pick=hunter]'); await new Promise(r => setTimeout(r, 600)); await q.click('[data-pick=runner]'); await new Promise(r => setTimeout(r, 400)); await q.click('#readyBtn'); await new Promise(r => setTimeout(r, 2500));
  await p.click('#startBtn'); await p.waitForSelector('#mapwrap', { timeout: 10000 }); await new Promise(r => setTimeout(r, 5000));
  const calls = await p.evaluate(() => window.__calls), by = n => calls.filter(c => c[0] === n);
  let fail = 0; const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fail++; };
  ok(by('map').length >= 1 && by('map')[0][1] === 'map', 'Leaflet map created in #map');
  ok(by('tileLayer').length === 1 && /tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png/.test(by('tileLayer')[0][1][0]) && /OpenStreetMap/.test(by('tileLayer')[0][1][1]), 'OpenStreetMap tiles with attribution');
  ok(by('circle').some(c => c[1][1] > 100 && Math.abs(c[1][0][0] - 37.7749) < 1e-3), 'zone circle drawn at the host\u2019s GPS position with its radius');
  ok(by('marker').length >= 1 && by('marker').some(m => /mk hunter/.test(m[1][1]) && /me/.test(m[1][1])), 'your own marker drawn from your real GPS position');
  ok(by('fitBounds').length >= 1, 'map zooms to the zone'); ok(by('clearLayers').length >= 1, 'markers are redrawn as things change');
  await b.close(); server.close(); setTimeout(() => process.exit(fail ? 1 : 0), 100);
})().catch(e => { console.error('CRASH', e); process.exit(1); });
