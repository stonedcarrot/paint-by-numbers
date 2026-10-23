// Paint Together: multiplayer paint-by-numbers server.
// Serves the static client and a WebSocket API for rooms, painting, chat and friends.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const PBN = require('./public/pbn.js');
const { createFeatured } = require('./featured.js');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const FEATURED_DIR = path.resolve(process.env.FEATURED_DIR || path.join(__dirname, 'featured'));
const MAX_PLAYERS = 10;
const PLAYER_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#9a6324', '#469990', '#808000'];

fs.mkdirSync(path.join(DATA_DIR, 'rooms'), { recursive: true });
const featured = createFeatured({ dir: FEATURED_DIR, cacheDir: path.join(DATA_DIR, 'featured-cache') });

// ---------- persistence helpers ----------
const saveTimers = new Map();
function saveLater(file, getData) {
  if (saveTimers.has(file)) return;
  saveTimers.set(file, setTimeout(() => {
    saveTimers.delete(file);
    const tmp = file + '.tmp';
    fs.writeFile(tmp, JSON.stringify(getData()), (err) => {
      if (err) return console.error('save failed', file, err);
      fs.rename(tmp, file, (e) => e && console.error('rename failed', file, e));
    });
  }, 1000));
}

// ---------- users & friends ----------
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const users = new Map();
try {
  for (const u of JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))) users.set(u.id, u);
} catch { /* first run */ }
const saveUsers = () => saveLater(USERS_FILE, () => [...users.values()]);
const usersByCode = () => new Map([...users.values()].map((u) => [u.code, u]));

const randomId = (bytes = 12) => crypto.randomBytes(bytes).toString('base64url');
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode(len) {
  let s = '';
  const b = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 24) || 'Painter';

function createUser(name) {
  const codes = usersByCode();
  let code;
  do code = randomCode(6); while (codes.has(code));
  const u = { id: randomId(), token: randomId(24), name: cleanName(name), code,
    friends: [], incoming: [], outgoing: [], recent: [] };
  users.set(u.id, u);
  saveUsers();
  return u;
}

function tokenMatches(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// userId -> Set of sockets
const sockets = new Map();
function sendUser(userId, msg) {
  for (const ws of sockets.get(userId) || []) send(ws, msg);
}

function presence(userId) {
  const set = sockets.get(userId);
  if (!set || !set.size) return { online: false };
  for (const ws of set) {
    if (ws.room) {
      return { online: true, roomId: ws.room.id, roomTitle: ws.room.title,
        roomPlayers: ws.room.players.size, roomFull: ws.room.players.size >= MAX_PLAYERS };
    }
  }
  return { online: true };
}

function friendsPayload(u) {
  const brief = (id) => { const f = users.get(id); return f ? { id, name: f.name } : null; };
  return {
    type: 'friends',
    code: u.code,
    friends: u.friends.map((id) => brief(id) && { ...brief(id), ...presence(id) }).filter(Boolean),
    incoming: u.incoming.map(brief).filter(Boolean),
    outgoing: u.outgoing.map(brief).filter(Boolean),
  };
}
const sendFriends = (userId) => { const u = users.get(userId); if (u) sendUser(userId, friendsPayload(u)); };
function notifyFriendsOf(userId) {
  const u = users.get(userId);
  if (u) for (const f of u.friends) sendFriends(f);
}

// a room's player count is part of every member's presence, so tell all their friends
function notifyRoomFriends(room) {
  const seen = new Set();
  for (const p of room.players.values()) {
    if (seen.has(p.userId)) continue;
    seen.add(p.userId);
    notifyFriendsOf(p.userId);
  }
}

const pull = (arr, v) => { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); };

// ---------- rooms ----------
const rooms = new Map();
const roomFile = (id) => path.join(DATA_DIR, 'rooms', id + '.json');
const ROOM_ID_RE = /^[A-Z2-9]{6}$/;

function serializeRoom(room) {
  return { id: room.id, title: room.title, createdAt: room.createdAt, createdBy: room.createdBy,
    completedAt: room.completedAt || null, puzzle: room.puzzle, paintedBy: room.paintedBy,
    names: room.names, chat: room.chat, mode: room.mode || 'private', featuredId: room.featuredId || null,
    artist: room.artist || null };
}
function hydrateRoom(data) {
  return { ...data, players: new Map(),
    paintedCount: data.paintedBy.filter((x) => x !== null).length };
}
function getRoom(id) {
  if (!ROOM_ID_RE.test(id || '')) return null;
  if (rooms.has(id)) return rooms.get(id);
  try {
    const room = hydrateRoom(JSON.parse(fs.readFileSync(roomFile(id), 'utf8')));
    rooms.set(id, room);
    return room;
  } catch { return null; }
}
const saveRoom = (room) => saveLater(roomFile(room.id), () => serializeRoom(room));

function validatePuzzle(p) {
  if (!p || typeof p !== 'object') throw new Error('missing puzzle');
  const { w, h, palette, regions, rle } = p;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 8 || h < 8 || w > 800 || h > 800) throw new Error('bad size');
  if (!Array.isArray(palette) || palette.length < 1 || palette.length > 60) throw new Error('bad palette');
  if (!palette.every((c) => /^#[0-9a-f]{6}$/i.test(c))) throw new Error('bad colour');
  if (!Array.isArray(regions) || regions.length < 1 || regions.length > 5000) throw new Error('bad regions');
  const clean = regions.map((r) => {
    if (!r || !Number.isInteger(r.c) || r.c < 0 || r.c >= palette.length) throw new Error('bad region');
    const num = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);
    return { c: r.c, x: num(r.x), y: num(r.y), r: num(r.r) };
  });
  if (!Array.isArray(rle)) throw new Error('bad map');
  const map = PBN.decodeRLE(rle, w * h);
  const seen = new Uint8Array(regions.length);
  for (let i = 0; i < map.length; i++) {
    const v = map[i];
    if (!Number.isInteger(v) || v < 0 || v >= regions.length) throw new Error('bad map value');
    seen[v] = 1;
  }
  if (seen.includes(0)) throw new Error('empty region');
  let preview = null;
  if (typeof p.preview === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(p.preview) && p.preview.length < 400000) {
    preview = p.preview;
  }
  return { w, h, palette, regions: clean, rle, preview };
}

function createRoom(user, title, puzzle, extra = {}) {
  let id;
  do id = randomCode(6); while (rooms.has(id) || fs.existsSync(roomFile(id)));
  const room = hydrateRoom({ id, title: String(title || '').trim().slice(0, 60) || 'Untitled picture',
    createdAt: Date.now(), createdBy: user.id, puzzle,
    paintedBy: new Array(puzzle.regions.length).fill(null), names: {}, chat: [], ...extra });
  rooms.set(id, room);
  saveRoom(room);
  return room;
}

function playersPayload(room) {
  const counts = {};
  for (const by of room.paintedBy) if (by) counts[by] = (counts[by] || 0) + 1;
  return {
    type: 'players',
    players: [...room.players.values()].map((p) => ({ pid: p.pid, userId: p.userId, name: p.name, color: p.color })),
    scores: Object.entries(counts).map(([userId, n]) => ({ userId, name: room.names[userId] || 'Painter', n }))
      .sort((a, b) => b.n - a.n),
  };
}

function broadcast(room, msg, except) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) if (p.ws !== except && p.ws.readyState === 1) p.ws.send(data);
}

function leaveRoom(ws) {
  const room = ws.room;
  if (!room) return;
  room.players.delete(ws.pid);
  ws.room = null;
  broadcast(room, playersPayload(room));
  broadcast(room, { type: 'cursorGone', pid: ws.pid });
  notifyFriendsOf(ws.user.id);
  notifyRoomFriends(room);
  if (!room.players.size) {
    // unload idle rooms from memory once saved
    setTimeout(() => { if (!room.players.size && !saveTimers.has(roomFile(room.id))) rooms.delete(room.id); }, 5000);
  }
}

function joinRoom(ws, roomId) {
  const room = getRoom(String(roomId || '').toUpperCase());
  if (!room) return send(ws, { type: 'error', code: 'notfound', message: 'That picture does not exist (check the link).' });
  if (ws.room === room) return;
  if (room.players.size >= MAX_PLAYERS) {
    return send(ws, { type: 'error', code: 'full', message: `This picture already has ${MAX_PLAYERS} painters. Try again later.` });
  }
  leaveRoom(ws);
  const used = new Set([...room.players.values()].map((p) => p.color));
  const color = PLAYER_COLORS.find((c) => !used.has(c)) || PLAYER_COLORS[0];
  ws.room = room;
  room.players.set(ws.pid, { pid: ws.pid, userId: ws.user.id, name: ws.user.name, color, ws });
  room.names[ws.user.id] = ws.user.name;
  const u = ws.user;
  pull(u.recent, room.id);
  u.recent.unshift(room.id);
  u.recent.length = Math.min(u.recent.length, 12);
  saveUsers();
  send(ws, { type: 'joined', room: { id: room.id, title: room.title, puzzle: room.puzzle,
    mode: room.mode || 'private', featuredId: room.featuredId || null, artist: room.artist || null,
    paintedBy: room.paintedBy, completedAt: room.completedAt || null, chat: room.chat.slice(-50) },
  you: { pid: ws.pid, color } });
  broadcast(room, playersPayload(room));
  notifyRoomFriends(room);
}

// ---------- featured pictures ----------
// featuredId -> ids of its open "paint with others" rooms
const FEATURED_ROOMS_FILE = path.join(DATA_DIR, 'featured-rooms.json');
let featuredRooms = {};
try { featuredRooms = JSON.parse(fs.readFileSync(FEATURED_ROOMS_FILE, 'utf8')); } catch { /* first run */ }
const saveFeaturedRooms = () => saveLater(FEATURED_ROOMS_FILE, () => featuredRooms);

// Busiest unfinished room with a free spot, so people who hop on end up painting together.
function openFeaturedRoom(featuredId) {
  const ids = (featuredRooms[featuredId] || []).filter((id) => {
    const r = getRoom(id);
    return r && !r.completedAt;
  });
  if (ids.length !== (featuredRooms[featuredId] || []).length) { featuredRooms[featuredId] = ids; saveFeaturedRooms(); }
  const open = ids.map(getRoom).filter((r) => r.players.size < MAX_PLAYERS);
  open.sort((a, b) => b.players.size - a.players.size);
  return open[0] || null;
}

function featuredPayload() {
  const pod = featured.pictureOfDay();
  return {
    date: pod && pod.date,
    today: pod && pod.picture.id,
    pictures: featured.list().map((p) => ({
      id: p.id, title: p.title, image: p.image, artist: p.artist,
      playing: (featuredRooms[p.id] || []).reduce((n, id) => n + (rooms.get(id)?.players.size || 0), 0),
    })),
  };
}

function recentRooms(u) {
  return u.recent.map((id) => {
    const r = getRoom(id);
    if (!r) return null;
    return { id, title: r.title, progress: r.paintedCount / r.paintedBy.length,
      players: r.players.size, complete: !!r.completedAt };
  }).filter(Boolean);
}

// ---------- message handling ----------
function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

const handlers = {
  hello(ws, m) {
    let u = users.get(m.userId);
    if (!u || !tokenMatches(u.token, m.token)) u = createUser(m.name);
    else if (m.name) u.name = cleanName(m.name);
    ws.user = u;
    if (!sockets.has(u.id)) sockets.set(u.id, new Set());
    sockets.get(u.id).add(ws);
    send(ws, { type: 'welcome', user: { id: u.id, token: u.token, name: u.name, code: u.code }, recent: recentRooms(u) });
    send(ws, friendsPayload(u));
    notifyFriendsOf(u.id);
  },

  setName(ws, m) {
    const u = ws.user;
    u.name = cleanName(m.name);
    saveUsers();
    for (const s of sockets.get(u.id) || []) {
      if (s.room) {
        const p = s.room.players.get(s.pid);
        if (p) p.name = u.name;
        s.room.names[u.id] = u.name;
        broadcast(s.room, playersPayload(s.room));
      }
    }
    send(ws, { type: 'nameSet', name: u.name });
    notifyFriendsOf(u.id);
  },

  createRoom(ws, m) {
    let puzzle;
    try { puzzle = validatePuzzle(m.puzzle); } catch (e) {
      return send(ws, { type: 'error', code: 'badpuzzle', message: 'Could not create the picture: ' + e.message });
    }
    const room = createRoom(ws.user, m.title, puzzle);
    send(ws, { type: 'roomCreated', roomId: room.id });
  },

  join(ws, m) { joinRoom(ws, m.roomId); },

  async playFeatured(ws, m) {
    const pic = featured.get(String(m.id || ''));
    if (!pic) return send(ws, { type: 'error', code: 'nofeatured', message: 'That featured picture is no longer available.' });
    let puzzle;
    try { puzzle = await featured.puzzleFor(pic); } catch {
      return send(ws, { type: 'error', code: 'nofeatured', message: 'That picture could not be prepared. Try another one.' });
    }
    const extra = { featuredId: pic.id, artist: pic.artist };
    if (m.mode === 'together') {
      let room = openFeaturedRoom(pic.id);
      if (!room) {
        room = createRoom(ws.user, pic.title, puzzle, { ...extra, mode: 'public' });
        (featuredRooms[pic.id] = featuredRooms[pic.id] || []).push(room.id);
        saveFeaturedRooms();
      }
      joinRoom(ws, room.id);
    } else {
      joinRoom(ws, createRoom(ws.user, pic.title, puzzle, { ...extra, mode: 'solo' }).id);
    }
  },
  leave(ws) { leaveRoom(ws); },

  recent(ws) { send(ws, { type: 'recent', recent: recentRooms(ws.user) }); },

  paint(ws, m) {
    const room = ws.room;
    if (!room) return;
    const r = m.region;
    if (!Number.isInteger(r) || r < 0 || r >= room.paintedBy.length) return;
    if (room.paintedBy[r] !== null) return;
    if (room.puzzle.regions[r].c !== m.color) return send(ws, { type: 'wrong', region: r });
    room.paintedBy[r] = ws.user.id;
    room.paintedCount++;
    broadcast(room, { type: 'paint', region: r, by: ws.user.id, pid: ws.pid });
    if (room.paintedCount === room.paintedBy.length && !room.completedAt) {
      room.completedAt = Date.now();
      broadcast(room, { type: 'complete', completedAt: room.completedAt });
    }
    broadcast(room, playersPayload(room));
    saveRoom(room);
  },

  cursor(ws, m) {
    const room = ws.room;
    if (!room) return;
    const now = Date.now();
    if (now - (ws.lastCursor || 0) < 30) return;
    ws.lastCursor = now;
    const x = Number(m.x), y = Number(m.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    broadcast(room, { type: 'cursor', pid: ws.pid, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }, ws);
  },

  chat(ws, m) {
    const room = ws.room;
    if (!room) return;
    const text = String(m.text || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
    if (!text) return;
    const p = room.players.get(ws.pid);
    const entry = { name: ws.user.name, color: p ? p.color : '#666', text, ts: Date.now() };
    room.chat.push(entry);
    if (room.chat.length > 100) room.chat.splice(0, room.chat.length - 100);
    broadcast(room, { type: 'chat', ...entry });
    saveRoom(room);
  },

  friendRequest(ws, m) {
    const me = ws.user;
    const other = usersByCode().get(String(m.code || '').trim().toUpperCase());
    if (!other) return send(ws, { type: 'error', code: 'friend', message: 'No player has that friend code.' });
    if (other.id === me.id) return send(ws, { type: 'error', code: 'friend', message: "That's your own code." });
    if (me.friends.includes(other.id)) return send(ws, { type: 'error', code: 'friend', message: `${other.name} is already your friend.` });
    if (me.incoming.includes(other.id)) return handlers.friendRespond(ws, { userId: other.id, accept: true });
    if (!me.outgoing.includes(other.id)) me.outgoing.push(other.id);
    if (!other.incoming.includes(me.id)) other.incoming.push(me.id);
    saveUsers();
    sendFriends(me.id);
    sendFriends(other.id);
    send(ws, { type: 'notice', message: `Friend request sent to ${other.name}.` });
  },

  friendRespond(ws, m) {
    const me = ws.user, other = users.get(m.userId);
    if (!other || !me.incoming.includes(other.id)) return;
    pull(me.incoming, other.id);
    pull(other.outgoing, me.id);
    if (m.accept) {
      if (!me.friends.includes(other.id)) me.friends.push(other.id);
      if (!other.friends.includes(me.id)) other.friends.push(me.id);
    }
    saveUsers();
    sendFriends(me.id);
    sendFriends(other.id);
  },

  cancelRequest(ws, m) {
    const me = ws.user, other = users.get(m.userId);
    if (!other) return;
    pull(me.outgoing, other.id);
    pull(other.incoming, me.id);
    saveUsers();
    sendFriends(me.id);
    sendFriends(other.id);
  },

  removeFriend(ws, m) {
    const me = ws.user, other = users.get(m.userId);
    if (!other) return;
    pull(me.friends, other.id);
    pull(other.friends, me.id);
    saveUsers();
    sendFriends(me.id);
    sendFriends(other.id);
  },

  invite(ws, m) {
    const me = ws.user;
    if (!ws.room || !me.friends.includes(m.userId)) return;
    sendUser(m.userId, { type: 'invite', from: { id: me.id, name: me.name }, roomId: ws.room.id, title: ws.room.title });
    send(ws, { type: 'notice', message: `Invite sent to ${users.get(m.userId).name}.` });
  },
};

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = url.pathname;
  if (file === '/' || /^\/r\/[A-Za-z0-9]+\/?$/.test(file)) file = '/index.html';
  if (file === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (file === '/api/featured') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify(featuredPayload()));
  }
  if (file.startsWith('/featured/')) {
    let rel;
    try { rel = decodeURIComponent(file.slice('/featured/'.length)); } catch { res.writeHead(400); return res.end(); }
    const img = path.resolve(FEATURED_DIR, rel);
    const ext = path.extname(img).toLowerCase();
    if (!img.startsWith(FEATURED_DIR + path.sep) || !IMAGE_MIME[ext]) { res.writeHead(404); return res.end(); }
    return fs.readFile(img, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': IMAGE_MIME[ext], 'Cache-Control': 'public, max-age=3600',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
      res.end(data);
    });
  }
  const full = path.join(PUBLIC_DIR, path.normalize(file));
  if (!full.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 * 1024 });
let nextPid = 1;
wss.on('connection', (ws) => {
  ws.pid = nextPid++;
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.type !== 'string' || !Object.hasOwn(handlers, m.type)) return;
    if (m.type !== 'hello' && !ws.user) return;
    try {
      const r = handlers[m.type](ws, m);
      if (r && r.catch) r.catch((e) => console.error('handler error', m.type, e));
    } catch (e) { console.error('handler error', m.type, e); }
  });
  ws.on('close', () => {
    if (!ws.user) return;
    leaveRoom(ws);
    const set = sockets.get(ws.user.id);
    if (set) { set.delete(ws); if (!set.size) sockets.delete(ws.user.id); }
    notifyFriendsOf(ws.user.id);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 30000).unref();

server.listen(PORT, () => {
  console.log(`Paint Together running at http://localhost:${PORT}`);
  featured.warm().then(() => console.log('Featured pictures ready'));
});
