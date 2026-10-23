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
    env: { ...process.env, PORT, DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => p.stdout.on('data', (d) => { if (/running/.test(d)) resolve(p); }));
}
const step = (s) => console.log('•', s);

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
