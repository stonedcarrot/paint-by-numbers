// End-to-end test: 11 browser clients, shared painting, room limit, friends, invites, chat, persistence.
// Run: npm run test:e2e   (starts its own server on a spare port with a temporary data folder)
'use strict';
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// E2E_URL tests an already-running server (e.g. the Docker container); E2E_RESTART is the shell command
// that restarts it for the persistence check (e.g. "docker restart paint-together").
const PORT = 3457;
const EXTERNAL = process.env.E2E_URL;
const BASE = EXTERNAL || `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-e2e-'));
const SHOTS = process.env.SHOTS || path.join(__dirname, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

async function waitHealthy() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not come up');
}

function startServer() {
  if (EXTERNAL) {
    return waitHealthy().then(() => ({
      kill() { if (process.env.E2E_RESTART) require('child_process').execSync(process.env.E2E_RESTART, { stdio: 'inherit' }); },
    }));
  }
  const p = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, DATA_DIR: DATA, UPLOAD_QUOTA_MB: '2', ADMIN_TOKEN }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => p.stdout.on('data', (d) => { if (/running/.test(d)) resolve(p); }));
}
const step = (s) => console.log('•', s);
// the spawned server gets a 2 MB storage limit and this admin token; for E2E_URL set them on the server yourself
const ADMIN_TOKEN = process.env.E2E_ADMIN_TOKEN || 'test-admin-token';

// a busy 2400x1600 picture (bigger than Full HD) as PNG bytes
async function makeBigImage(page) {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 2400; c.height = 1600;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 2400, 1600);
    g.addColorStop(0, '#fbd38d'); g.addColorStop(0.5, '#f56565'); g.addColorStop(1, '#553c9a');
    x.fillStyle = g; x.fillRect(0, 0, 2400, 1600);
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const cols = ['#2b6cb0', '#38a169', '#ecc94b', '#ffffff', '#1a202c', '#ed64a6', '#4fd1c5'];
    for (let i = 0; i < 260; i++) {
      x.fillStyle = cols[i % cols.length];
      x.beginPath();
      x.ellipse(rnd() * 2400, rnd() * 1600, 20 + rnd() * 160, 20 + rnd() * 120, rnd() * 3, 0, 7);
      x.fill();
    }
    return c.toDataURL('image/png').split(',')[1];
  });
  return Buffer.from(b64, 'base64');
}

// draw a little landscape and return it as PNG bytes
async function makeImage(page) {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 640; c.height = 480;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, 300);
    g.addColorStop(0, '#2b6cb0'); g.addColorStop(1, '#bee3f8');
    x.fillStyle = g; x.fillRect(0, 0, 640, 480);
    x.fillStyle = '#f6c90e'; x.beginPath(); x.arc(500, 100, 55, 0, 7); x.fill();
    x.fillStyle = '#38a169'; x.beginPath(); x.ellipse(160, 480, 360, 200, 0, 0, 7); x.fill();
    x.fillStyle = '#276749'; x.beginPath(); x.ellipse(520, 500, 300, 170, 0, 0, 7); x.fill();
    x.fillStyle = '#c53030'; x.fillRect(240, 260, 140, 110);
    x.fillStyle = '#742a2a'; x.beginPath(); x.moveTo(225, 262); x.lineTo(310, 190); x.lineTo(395, 262); x.fill();
    x.fillStyle = '#fefcbf'; x.fillRect(265, 290, 35, 35); x.fillRect(325, 290, 35, 35);
    x.fillStyle = '#ffffff'; x.beginPath(); x.ellipse(150, 90, 70, 28, 0, 0, 7); x.ellipse(200, 80, 50, 30, 0, 0, 7); x.fill();
    return c.toDataURL('image/png').split(',')[1];
  });
  return Buffer.from(b64, 'base64');
}

async function newPlayer(browser, name, url = BASE) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.error(`[${name}] page error:`, e); process.exitCode = 1; });
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) { console.error(`[${name}] CSP violation:`, m.text()); process.exitCode = 1; }
  });
  await page.goto(BASE);
  await page.waitForFunction(() => window.__pt && window.__pt.state.user);
  await page.fill('#nameInput', name);
  await page.press('#nameInput', 'Enter');
  await page.locator('#nameInput').blur();
  await page.waitForFunction((n) => JSON.parse(localStorage.getItem('pt.name')) === n, name);
  if (url !== BASE) await page.goto(url);
  return page;
}

// click the label spot of a region with the real mouse (after selecting its colour)
async function paintRegionByClick(page, r) {
  const pt = await page.evaluate((r) => {
    const { state, view } = window.__pt;
    const reg = state.board.p.regions[r];
    window.__pt.selectColor(reg.c);
    const vr = document.querySelector('#viewport').getBoundingClientRect();
    const S = state.board.S;
    return { x: vr.left + view.tx + reg.x * S * view.scale, y: vr.top + view.ty + reg.y * S * view.scale };
  }, r);
  await page.mouse.click(pt.x, pt.y);
}

const paintedCount = (page) => page.evaluate(() => window.__pt.state.board.paintedCount);
const brushedCount = (page) => page.evaluate(() => window.__pt.state.board.brushed.reduce((a, b) => a + b, 0));

// screen position of a puzzle pixel
const screenOf = (page, x, y) => page.evaluate(([x, y]) => {
  const { state, view } = window.__pt;
  const vr = document.querySelector('#viewport').getBoundingClientRect();
  const S = state.board.S;
  return { x: vr.left + view.tx + x * S * view.scale, y: vr.top + view.ty + y * S * view.scale };
}, [x, y]);

// drag the brush back and forth over a region's bounding box until it's covered
async function brushRegion(page, r, step) {
  const b = await page.evaluate((r) => {
    const { state } = window.__pt;
    window.__pt.selectColor(state.board.p.regions[r].c);
    return Array.from(state.board.box.slice(r * 4, r * 4 + 4));
  }, r);
  for (let y = b[1] + 0.5; y <= b[3] + step; y += step) {
    const a = await screenOf(page, b[0] - 1, Math.min(y, b[3] + 0.5));
    const z = await screenOf(page, b[2] + 2, Math.min(y, b[3] + 0.5));
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(z.x, z.y, { steps: 8 });
    await page.mouse.up();
  }
}

(async () => {
  let server = await startServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  try {
    step('Alice uploads an image and creates a picture');
    const alice = await newPlayer(browser, 'Alice');
    const png = await makeImage(alice);
    await alice.setInputFiles('#fileInput', { name: 'farm-house.png', mimeType: 'image/png', buffer: png });
    await alice.waitForSelector('#createRoomBtn:not([disabled])', { timeout: 30000 });
    assert.match(await alice.textContent('#genStats'), /\d+ regions/);
    assert.match(await alice.textContent('#genStats'), /640×480/, 'smaller pictures keep their native size');
    await alice.screenshot({ path: path.join(SHOTS, '1-create.png') });
    await alice.click('#createRoomBtn');
    await alice.waitForURL(/\/r\/[A-Z2-9]{6}$/);
    await alice.waitForSelector('#game:not(.hidden)');
    const link = alice.url();
    const roomId = link.split('/').pop();
    assert.equal(await alice.textContent('#gameTitle'), 'farm house');
    const nRegions = await alice.evaluate(() => window.__pt.state.board.n);
    step(`room ${roomId} created with ${nRegions} regions`);

    step('9 more players join through the shared link');
    const names = ['Bob', 'Cara', 'Dev', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jo'];
    const others = [];
    for (const n of names) others.push(await newPlayer(browser, n, link));
    await Promise.all(others.map((p) => p.waitForSelector('#game:not(.hidden)')));
    await alice.waitForFunction(() => window.__pt.state.players.length === 10);
    assert.equal(await alice.locator('#playersList .avatar').count(), 10);

    step('an 11th player is turned away because the picture is full');
    const kim = await newPlayer(browser, 'Kim', link);
    await kim.waitForSelector('.toast:has-text("already has 10 painters")');
    assert.equal(new URL(kim.url()).pathname, '/');
    assert.ok(await kim.isVisible('#home'));

    step('a real mouse click by Bob paints a region for everyone');
    const bob = others[0];
    await paintRegionByClick(bob, 0);
    await alice.waitForFunction(() => window.__pt.state.board.painted[0] === 1);
    await others[8].waitForFunction(() => window.__pt.state.board.painted[0] === 1);

    step('a click with the wrong colour does not paint');
    const wrong = await bob.evaluate(() => {
      const { state } = window.__pt;
      const r = state.board.p.regions.findIndex((g, i) => !state.board.painted[i]);
      window.__pt.selectColor((state.board.p.regions[r].c + 1) % state.board.p.palette.length);
      return r;
    });
    const before = await paintedCount(bob);
    await bob.evaluate((r) => {
      const { state, view } = window.__pt; const reg = state.board.p.regions[r]; const S = state.board.S;
      window.__pt.tapAt({ x: view.tx + reg.x * S * view.scale, y: view.ty + reg.y * S * view.scale });
    }, wrong);
    assert.equal(await paintedCount(bob), before);

    step('live cursors show up for other players');
    const vr = await bob.locator('#viewport').boundingBox();
    await bob.mouse.move(vr.x + 200, vr.y + 200);
    await bob.mouse.move(vr.x + 260, vr.y + 230, { steps: 5 });
    await alice.waitForSelector('.cursor span:has-text("Bob")');

    step('chat reaches everyone');
    await alice.click('#chatBtn');
    await alice.fill('#chatInput', 'Hi team, I will do the sky!');
    await alice.press('#chatInput', 'Enter');
    await bob.waitForSelector('#chatLog li:has-text("I will do the sky")', { state: 'attached' });

    step('friends: Bob adds Alice by code, Alice accepts');
    const aliceCode = await alice.evaluate(() => window.__pt.state.friends.code);
    await bob.click('#friendsBtn');
    await bob.fill('#friendsDrawer input', aliceCode);
    await bob.press('#friendsDrawer input', 'Enter');
    await alice.click('#friendsBtn');
    await alice.click('#friendsDrawer button:has-text("Accept")');
    await bob.waitForSelector('#friendsDrawer li:has-text("Alice") >> text=Painting with you');

    step('Kim friends Alice, a player leaves, Kim joins from the friends list');
    await kim.fill('[data-friends] input', aliceCode);
    await kim.press('[data-friends] input', 'Enter');
    await alice.click('#friendsDrawer button:has-text("Accept")');
    await kim.waitForSelector('#home li:has-text("Alice") >> text=/Painting .*10\\/10/');
    assert.equal(await kim.locator('#home li:has-text("Alice") button:has-text("Join")').count(), 0, 'no Join while full');
    await others[8].click('#gameBack');
    await kim.click('#home li:has-text("Alice") button:has-text("Join")');
    await kim.waitForSelector('#game:not(.hidden)');
    assert.equal(new URL(kim.url()).pathname, '/r/' + roomId);
    assert.equal(await kim.evaluate(() => window.__pt.state.board.painted[0]), 1, 'late joiner sees earlier paint');

    step('invites: Alice invites Jo (now at home) who joins from the toast');
    const jo = others[8];
    const joCode = await jo.evaluate(() => window.__pt.state.friends.code);
    await alice.fill('#friendsDrawer input', joCode);
    await alice.press('#friendsDrawer input', 'Enter');
    await jo.click('[data-friends] button:has-text("Accept")');
    // room is full again (Kim took the spot) so free one first
    await others[7].click('#gameBack');
    await alice.waitForSelector('#friendsDrawer li:has-text("Jo") button:has-text("Invite")');
    await alice.click('#friendsDrawer li:has-text("Jo") button:has-text("Invite")');
    await jo.click('.toast button:has-text("Join")');
    await jo.waitForSelector('#game:not(.hidden)');
    await alice.screenshot({ path: path.join(SHOTS, '2-game.png') });

    step('all players paint together until the picture is finished');
    const painters = [alice, bob, ...others.slice(1, 7), kim, jo];
    await Promise.all(painters.map((p, k) => p.evaluate(async ({ k, total }) => {
      const { state, view } = window.__pt;
      const b = state.board;
      for (let r = k; r < b.n; r += total) {
        if (b.painted[r]) continue;
        const reg = b.p.regions[r];
        window.__pt.selectColor(reg.c);
        // tap a pixel that belongs to the region
        const S = b.S;
        window.__pt.tapAt({ x: view.tx + reg.x * S * view.scale, y: view.ty + reg.y * S * view.scale });
        if (r % 20 === 0) await new Promise((res) => setTimeout(res, 5));
      }
    }, { k, total: painters.length })));
    await Promise.all(painters.map((p) => p.waitForSelector('#doneOverlay:not(.hidden)', { timeout: 20000 })));
    for (const p of painters) assert.equal(await paintedCount(p), nRegions);
    const scores = await alice.locator('#scoreList li').count();
    assert.ok(scores >= 9, 'scoreboard lists the painters');
    await alice.screenshot({ path: path.join(SHOTS, '3-done.png') });

    step('the picture survives a server restart');
    await new Promise((r) => setTimeout(r, 1500)); // let the debounced save land
    // free two spots so the reconnecting painters don't fill the picture before "Late" arrives
    await Promise.all([kim, jo].map((p) => p.context().close()));
    server.kill();
    server = await startServer();
    const late = await newPlayer(browser, 'Late', link);
    await late.waitForSelector('#game:not(.hidden)');
    assert.equal(await paintedCount(late), nRegions);
    await alice.waitForFunction(() => window.__pt.state.players.length >= 2, null, { timeout: 15000 });

    step('featured: picture of the day with artist credit and links');
    const f1 = await newPlayer(browser, 'Fran');
    await f1.waitForSelector('#potd h1');
    const potdTitle = await f1.textContent('#potd h1');
    assert.ok(await f1.locator('#potd .links a').count() >= 1, 'artist links shown');
    assert.ok(await f1.locator('#gallery .pic').count() >= 1, 'gallery shown');
    await f1.screenshot({ path: path.join(SHOTS, '5-home.png'), fullPage: true });

    step('featured: two players hop on "Paint with others" and land in the same picture');
    await f1.click('#potd [data-play=together]');
    await f1.waitForSelector('#game:not(.hidden)');
    const shared = new URL(f1.url()).pathname;
    assert.equal(await f1.textContent('#gameTitle'), potdTitle);
    assert.equal(await f1.textContent('#modeChip'), 'Open to all');
    assert.equal(await f1.isVisible('#settingsBtn'), false, 'open-to-all pictures have no host');
    assert.equal(await f1.isVisible('#toolLock'), false, 'everyone picks their own tool in open-to-all pictures');
    const f2 = await newPlayer(browser, 'Gwen');
    await f2.waitForSelector('#potd [data-play=together]');
    await f2.click('#potd [data-play=together]');
    await f2.waitForSelector('#game:not(.hidden)');
    assert.equal(new URL(f2.url()).pathname, shared);
    await f1.waitForFunction(() => window.__pt.state.players.length === 2);
    await paintRegionByClick(f2, 0);
    await f1.waitForFunction(() => window.__pt.state.board.painted[0] === 1);
    await f2.click('#creditName');
    await f2.waitForSelector('#artistDrawer:not(.hidden) .links a');

    step('featured: "Paint solo" gives a private copy, and Back returns home');
    const f3 = await newPlayer(browser, 'Hal');
    await f3.waitForSelector('#potd [data-play=solo]');
    await f3.click('#potd [data-play=solo]');
    await f3.waitForSelector('#game:not(.hidden)');
    assert.notEqual(new URL(f3.url()).pathname, shared);
    assert.equal(await f3.textContent('#modeChip'), 'Solo');
    assert.equal(await f3.evaluate(() => window.__pt.state.board.paintedCount), 0);
    await f3.screenshot({ path: path.join(SHOTS, '6-solo.png') });
    await f3.goBack();
    await f3.waitForSelector('#home:not(.hidden)');
    await Promise.all([f1, f2, f3].map((p) => p.context().close()));

    step('pixel brush: the host locks the picture to a 16 px brush');
    const host = await newPlayer(browser, 'Hope');
    await host.setInputFiles('#fileInput', { name: 'brush-house.png', mimeType: 'image/png', buffer: await makeImage(host) });
    await host.waitForSelector('#createRoomBtn:not([disabled])', { timeout: 30000 });
    await host.click('#createRoomBtn');
    await host.waitForSelector('#game:not(.hidden)');
    assert.ok(await host.isVisible('#settingsBtn'), 'the host gets the settings button');
    assert.ok(await host.isVisible('#toolLock'), 'new pictures start locked to the host\'s tool');
    await host.click('#settingsBtn');
    await host.check('#settingsForm input[value=brush]');
    await host.selectOption('#settingsForm [name=size]', '16');
    await host.click('#settingsForm button:has-text("Save")');
    await host.waitForFunction(() => window.__pt.state.settings.tool === 'brush');
    const guest = await newPlayer(browser, 'Ivy', host.url());
    await guest.waitForSelector('#game:not(.hidden)');
    assert.equal(await guest.isVisible('#settingsBtn'), false, 'guests have no settings');
    assert.ok(await guest.isDisabled('#tools [data-tool=fill]'), 'guests cannot switch tools while locked');
    assert.equal(await guest.inputValue('#brushSize'), '16');
    await guest.screenshot({ path: path.join(SHOTS, '12-brush-locked.png') });

    step('pixel brush: a click does not fill, a drag colours only matching pixels for everyone');
    // the largest region, so a drag through it can't finish it
    const largest = await guest.evaluate(() => {
      const b = window.__pt.state.board;
      let best = 0;
      for (let r = 1; r < b.n; r++) if (b.pixStart[r + 1] - b.pixStart[r] > b.pixStart[best + 1] - b.pixStart[best]) best = r;
      return { r: best, x: b.p.regions[best].x, y: b.p.regions[best].y, c: b.p.regions[best].c };
    });
    await paintRegionByClick(guest, largest.r);
    await guest.waitForTimeout(300);
    assert.equal(await paintedCount(guest), 0, 'a click with the brush does not fill a region');
    const dabbed = await brushedCount(guest);
    assert.ok(dabbed > 0, "the click dabbed a few pixels");
    const a = await screenOf(guest, largest.x - 30, largest.y), z = await screenOf(guest, largest.x + 30, largest.y);
    await guest.mouse.move(a.x, a.y);
    await guest.mouse.down();
    await guest.mouse.move(z.x, z.y, { steps: 10 });
    await guest.mouse.up();
    const brushed = await brushedCount(guest);
    assert.ok(brushed > dabbed, 'the drag coloured pixels');
    const wrongPixels = await guest.evaluate((c) => {
      const b = window.__pt.state.board;
      let n = 0;
      b.brushed.forEach((v, i) => { if (v && b.p.regions[b.map[i]].c !== c) n++; });
      return n;
    }, largest.c);
    assert.equal(wrongPixels, 0, 'only pixels with the selected number are coloured');
    await host.waitForFunction((n) => window.__pt.state.board.brushed.reduce((a, b) => a + b, 0) === n, brushed);

    step('pixel brush: covering a whole region completes it');
    const small = await guest.evaluate(() => {
      const b = window.__pt.state.board;
      let best = -1;
      for (let r = 0; r < b.n; r++) {
        const size = b.pixStart[r + 1] - b.pixStart[r];
        if (size > 300 && (best < 0 || size < b.pixStart[best + 1] - b.pixStart[best])) best = r;
      }
      return best;
    });
    await brushRegion(guest, small, 8);
    await host.waitForFunction((r) => window.__pt.state.board.painted[r] === 1, small);
    await guest.reload();
    await guest.waitForSelector('#game:not(.hidden)');
    assert.equal(await brushedCount(guest), await brushedCount(host), 'brushed pixels are kept');

    step('pixel brush: the host unlocks it and a guest picks the fill bucket');
    await host.click('#settingsBtn');
    await host.uncheck('#settingsForm [name=locked]');
    await host.click('#settingsForm button:has-text("Save")');
    await guest.waitForSelector('#tools [data-tool=fill]:not([disabled])');
    await guest.click('#tools [data-tool=fill]');
    const fillable = await guest.evaluate(() => {
      const b = window.__pt.state.board;
      for (let r = 0; r < b.n; r++) if (!b.painted[r] && b.p.regions[r].r > 6) return r;
      return -1;
    });
    await paintRegionByClick(guest, fillable);
    await host.waitForFunction((r) => window.__pt.state.board.painted[r] === 1, fillable);
    await guest.screenshot({ path: path.join(SHOTS, '13-brush-game.png') });
    await Promise.all([host, guest].map((p) => p.context().close()));

    step('Full HD: a 2400x1600 upload is reduced to fit 1920x1080');
    const q = await newPlayer(browser, 'Quinn');
    await q.waitForSelector('#storageBox .sub');
    assert.match(await q.textContent('#storageBox'), /0 KB of 2\.0 MB/);
    const big = await makeBigImage(q);
    await q.setInputFiles('#fileInput', { name: 'big.png', mimeType: 'image/png', buffer: big });
    await q.waitForFunction(() => /1620×1080/.test(document.querySelector('#genStats').textContent), null, { timeout: 60000 });
    await q.selectOption('#detailInput', 'max');
    await q.waitForFunction(() => /1620×1080/.test(document.querySelector('#genStats').textContent) &&
      document.querySelector('#previewBusy').classList.contains('hidden'), null, { timeout: 60000 });
    await q.screenshot({ path: path.join(SHOTS, '8-fhd-create.png') });
    const bigBytes = await q.evaluate(() => /· ([\d.]+ [KM]B)/.exec(document.querySelector('#genStats').textContent)[1]);
    step(`  Full HD picture needs ${bigBytes}`);

    step('storage: admin page is locked without the token');
    const adm = await (await browser.newContext()).newPage();
    await adm.goto(BASE + '/admin');
    await adm.fill('#token', 'wrong');
    await adm.press('#token', 'Enter');
    await adm.waitForSelector('#msg:has-text("Wrong admin token")', { timeout: 5000 });

    step('storage: with the limit set to 0 MB the Start button is disabled');
    await adm.fill('#token', ADMIN_TOKEN);
    await adm.press('#token', 'Enter');
    await adm.waitForSelector('#users tr:has-text("Quinn")');
    await adm.fill('#users tr:has-text("Quinn") input', '0');
    await adm.click('#users tr:has-text("Quinn") button:has-text("Set limit")');
    await q.waitForSelector('#createRoomBtn[disabled]');
    assert.match(await q.textContent('#genStats'), /Not enough space/);

    step('storage: player requests more, admin approves, player creates the Full HD picture');
    await q.click('#createBack');
    await q.click('#moreSpaceBtn');
    await q.fill('#storageBox input', '50');
    await q.fill('#storageBox textarea', 'I paint big pictures');
    await q.click('#storageBox button:has-text("Send request")');
    await q.waitForSelector('#storageBox:has-text("You asked for 50 MB")');
    await adm.reload();
    await adm.waitForSelector('#requests tr:has-text("I paint big pictures")');
    await adm.screenshot({ path: path.join(SHOTS, '9-admin.png'), fullPage: true });
    await adm.click('#requests tr:has-text("Quinn") button:has-text("Set limit")');
    await q.waitForSelector('.toast:has-text("storage is now 50 MB")');
    assert.match(await q.textContent('#storageBox'), /of 50 MB/);
    await q.setInputFiles('#fileInput', { name: 'big.png', mimeType: 'image/png', buffer: big });
    await q.waitForSelector('#createRoomBtn:not([disabled])', { timeout: 60000 });
    await q.click('#createRoomBtn');
    await q.waitForSelector('#game:not(.hidden)');
    const dims = await q.evaluate(() => [window.__pt.state.board.w, window.__pt.state.board.h]);
    assert.deepEqual(dims, [1620, 1080]);

    step('Full HD: painting updates stay fast');
    const timing = await q.evaluate(() => {
      const { state } = window.__pt;
      const b = state.board;
      const times = [];
      window.__pt.selectColor(0);
      b.render();
      const todo = b.p.regions.map((g, i) => i).filter((i) => b.p.regions[i].c === 0 && !b.painted[i]).slice(0, 40);
      for (const r of todo) {
        b.paint(r);
        const t = performance.now();
        b.render();
        times.push(performance.now() - t);
      }
      times.sort((x, y) => x - y);
      const t0 = performance.now();
      b.fullDirty = true; b.render();
      return { median: times[times.length >> 1], full: performance.now() - t0, regions: b.n };
    });
    step(`  ${timing.regions} regions; one paint redraws in ${timing.median.toFixed(1)} ms (full redraw ${timing.full.toFixed(0)} ms)`);
    assert.ok(timing.median < timing.full, 'a paint redraws less than the whole picture');
    await q.screenshot({ path: path.join(SHOTS, '10-fhd-game.png') });

    step('storage: deleting the picture frees the space');
    await q.click('#gameBack');
    await q.waitForSelector('#storageBox .sub:not(:has-text("0 KB of"))');
    q.once('dialog', (d) => d.accept());
    await q.click('#recentList li:has-text("big") button[title="Delete this picture"]');
    await q.waitForSelector('#storageBox .sub:has-text("0 KB of 50 MB")');

    step("admin: removing a player's picture sends painters home and frees the owner's space");
    adm.on('dialog', (d) => d.accept());
    await q.setInputFiles('#fileInput', { name: 'cottage.png', mimeType: 'image/png', buffer: await makeImage(q) });
    await q.waitForSelector('#createRoomBtn:not([disabled])', { timeout: 30000 });
    await q.click('#createRoomBtn');
    await q.waitForSelector('#game:not(.hidden)');
    await adm.reload();
    await adm.waitForSelector('#pictures tr:has-text("cottage") img.thumb[src^="blob:"]');
    await adm.click('#pictures tr:has-text("cottage") button:has-text("Delete")');
    await q.waitForSelector('#home:not(.hidden)');
    await q.waitForSelector('.toast:has-text("removed by the admin")');
    await q.waitForSelector('#storageBox .sub:has-text("0 KB of 50 MB")');
    await adm.waitForFunction(() => !document.querySelector('#pictures').textContent.includes('cottage'));

    step('admin: add a featured picture for today, edit it, then delete it');
    const today = new Date().toISOString().slice(0, 10);
    await adm.setInputFiles('#featFile', { name: 'harbour-dawn.png', mimeType: 'image/png', buffer: await makeImage(adm) });
    await adm.waitForSelector('#featPreview:not(.hidden)');
    assert.equal(await adm.inputValue('#featTitle'), 'harbour dawn');
    await adm.fill('#featTitle', 'Harbour Dawn');
    await adm.fill('#featArtist', 'Rosa Test');
    await adm.fill('#featBio', 'Paints harbours at sunrise.');
    await adm.fill('#featLinks .link-row input >> nth=0', 'Instagram');
    await adm.fill('#featLinks .link-row input >> nth=1', 'http://insecure.example');
    await adm.fill('#featDate', today);
    await adm.click('#featSave');
    await adm.waitForSelector('.toast:has-text("must start with https://")');
    await adm.fill('#featLinks .link-row input >> nth=1', 'https://instagram.com/rosa');
    await adm.click('#featSave');
    await adm.waitForSelector('#featured tr:has-text("Harbour Dawn") .tag:has-text("Today")', { timeout: 30000 });
    await adm.screenshot({ path: path.join(SHOTS, '11-admin-featured.png'), fullPage: true });
    const fan = await newPlayer(browser, 'Fan');
    await fan.waitForSelector('#potd h1:has-text("Harbour Dawn")');
    assert.match(await fan.textContent('#potd'), /Rosa Test/);
    assert.equal(await fan.getAttribute('#potd .links a', 'href'), 'https://instagram.com/rosa');
    const thumbSrc = await fan.getAttribute('#potd img', 'src');
    assert.match(thumbSrc, /^\/featured-thumb\//);
    await fan.click('#potd [data-play=solo]');
    await fan.waitForSelector('#game:not(.hidden)');
    assert.equal(await fan.textContent('#gameTitle'), 'Harbour Dawn');
    await adm.click('#featured tr:has-text("Harbour Dawn") button:has-text("Edit")');
    assert.equal(await adm.inputValue('#featArtist'), 'Rosa Test');
    await adm.fill('#featArtist', 'Rosa Renamed');
    await adm.click('#featSave');
    await adm.waitForSelector('#featured tr:has-text("Rosa Renamed")');
    await fan.goto(BASE);
    await fan.waitForSelector('#potd:has-text("Rosa Renamed")');
    await adm.click('#featured tr:has-text("Harbour Dawn") button:has-text("↑")');
    await adm.waitForFunction(() => {
      const rows = [...document.querySelectorAll('#featured tr')].map((r) => r.textContent);
      return rows.findIndex((t) => t.includes('Harbour Dawn')) === rows.length - 2;
    });
    await adm.click('#featured tr:has-text("Harbour Dawn") button:has-text("Delete")');
    await adm.waitForFunction(() => !document.querySelector('#featured').textContent.includes('Harbour Dawn'));
    await fan.reload();
    await fan.waitForSelector('#potd h1');
    assert.doesNotMatch(await fan.textContent('#featuredWrap'), /Harbour Dawn/);
    await Promise.all([q, adm, fan].map((p) => p.context().close()));

    step('mobile layout renders');
    await Promise.all([bob, ...others.slice(0, 8)].map((p) => p.context().close()));
    const mctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
    const mob = await mctx.newPage();
    await mob.goto(link);
    await mob.waitForSelector('#game:not(.hidden)');
    await mob.screenshot({ path: path.join(SHOTS, '4-mobile.png') });
    await mob.goto(BASE);
    await mob.waitForSelector('#potd h1');
    await mob.screenshot({ path: path.join(SHOTS, '7-mobile-home.png'), fullPage: true });

    console.log('\nALL E2E CHECKS PASSED');
  } catch (e) {
    console.error('\nE2E FAILED:', e);
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})();
