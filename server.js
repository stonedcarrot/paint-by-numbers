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
// Featured pictures live with the saved data so the admin page can edit them; the bundled set seeds a new install.
const BUNDLED_FEATURED = path.join(__dirname, 'featured');
const FEATURED_DIR = path.resolve(process.env.FEATURED_DIR || path.join(DATA_DIR, 'featured'));
const MAX_PLAYERS = 10;
const MB = 1000 * 1000;
// Storage each player gets for their own uploaded pictures; admins can raise it per player.
const DEFAULT_QUOTA = (Number(process.env.UPLOAD_QUOTA_MB) || 100) * MB;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const PLAYER_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#9a6324', '#469990', '#808000'];

fs.mkdirSync(path.join(DATA_DIR, 'rooms'), { recursive: true });
if (!fs.existsSync(path.join(FEATURED_DIR, 'featured.json')) && FEATURED_DIR !== BUNDLED_FEATURED) {
  fs.cpSync(BUNDLED_FEATURED, FEATURED_DIR, { recursive: true });
  console.log('Copied the starter featured pictures to', FEATURED_DIR);
}
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

// ---------- storage quota ----------
const quotaOf = (u) => u.quotaBytes ?? DEFAULT_QUOTA;
const usedBy = (u) => (u.uploads || []).reduce((n, x) => n + x.bytes, 0);
function storagePayload(u) {
  return { type: 'storage', used: usedBy(u), limit: quotaOf(u), request: u.storageRequest || null };
}
const sendStorage = (u) => sendUser(u.id, storagePayload(u));

function createUser(name) {
  const codes = usersByCode();
  let code;
  do code = randomCode(6); while (codes.has(code));
  const u = { id: randomId(), token: randomId(24), name: cleanName(name), code,
    friends: [], incoming: [], outgoing: [], recent: [], uploads: [] };
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
    completedAt: room.completedAt || null, paintedBy: room.paintedBy,
    ...(room.puzzleRef ? { puzzleRef: room.puzzleRef } : { puzzle: room.puzzle }),
    bytes: room.bytes || 0, settings: room.settings,
    brushRuns: room.brushed ? PBN.toRuns(room.brushed) : (room.brushRuns || []),
    names: room.names, chat: room.chat, mode: room.mode || 'private', featuredId: room.featuredId || null,
    artist: room.artist || null };
}
// Which tool the room uses. Only the host (whoever made the picture) can change it; open-to-all featured
// rooms have no host, so everyone picks their own tool there.
const DEFAULT_SETTINGS = { tool: 'fill', size: 4, locked: true };
function cleanSettings(s, fallback = DEFAULT_SETTINGS) {
  s = s || {};
  return {
    tool: s.tool === 'brush' || s.tool === 'fill' ? s.tool : fallback.tool,
    size: PBN.BRUSH_SIZES.includes(s.size) ? s.size : fallback.size,
    locked: typeof s.locked === 'boolean' ? s.locked : fallback.locked,
  };
}
const isHost = (room, user) => room.mode !== 'public' && room.createdBy === user.id;

function hydrateRoom(data) {
  if (data.puzzleRef && !data.puzzle) data.puzzle = featured.loadRef(data.puzzleRef);
  const settings = data.mode === 'public' ? { tool: 'fill', size: 4, locked: false } : cleanSettings(data.settings);
  return { ...data, settings, players: new Map(),
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

function deleteRoomData(room) {
  const file = roomFile(room.id);
  clearTimeout(saveTimers.get(file));
  saveTimers.delete(file);
  fs.rm(file, { force: true }, () => {});
  rooms.delete(room.id);
}

// Brushed pixels live in memory as a 0/1 array per pixel, created the first time a room is brushed.
function ensurePixels(room) {
  if (room.brushed) return;
  const { w, h, rle, regions } = room.puzzle;
  room.regionMap = Uint16Array.from(PBN.decodeRLE(rle, w * h));
  room.regionSize = new Int32Array(regions.length);
  room.brushCount = new Int32Array(regions.length);
  room.brushed = PBN.fromRuns(room.brushRuns, w * h);
  for (let i = 0; i < room.regionMap.length; i++) {
    const r = room.regionMap[i];
    room.regionSize[r]++;
    if (room.brushed[i]) room.brushCount[r]++;
  }
  delete room.brushRuns;
}

function markPainted(room, r, user) {
  room.paintedBy[r] = user.id;
  room.paintedCount++;
  broadcast(room, { type: 'paint', region: r, by: user.id });
}

function afterPaint(room) {
  if (room.paintedCount === room.paintedBy.length && !room.completedAt) {
    room.completedAt = Date.now();
    broadcast(room, { type: 'complete', completedAt: room.completedAt });
  }
  broadcast(room, playersPayload(room));
  saveRoom(room);
}

// a player's tool must be the room's when the host has locked it
function toolAllowed(room, ws, tool, size) {
  const s = room.settings;
  if (!s.locked || isHost(room, ws.user)) return tool === 'fill' || PBN.BRUSH_SIZES.includes(size);
  return s.tool === tool && (tool === 'fill' || size === s.size);
}

// Deletes a picture for good: players inside are sent home and its owner gets the storage back.
function removeRoom(room, notice) {
  const inside = new Set();
  for (const p of [...room.players.values()]) {
    inside.add(p.ws.user.id);
    send(p.ws, { type: 'roomDeleted', roomId: room.id, title: room.title, byAdmin: !!notice });
    leaveRoom(p.ws);
  }
  deleteRoomData(room);
  const owner = users.get(room.createdBy);
  if (!owner) return;
  owner.uploads = (owner.uploads || []).filter((x) => x.roomId !== room.id);
  pull(owner.recent, room.id);
  saveUsers();
  sendStorage(owner);
  sendUser(owner.id, { type: 'recent', recent: recentRooms(owner) });
  if (notice && !inside.has(owner.id)) sendUser(owner.id, { type: 'notice', message: notice });
}

function validatePuzzle(p) {
  if (!p || typeof p !== 'object') throw new Error('missing puzzle');
  const { w, h, palette, regions, rle } = p;
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 8 || h < 8 ||
    Math.max(w, h) > PBN.MAX_LONG || Math.min(w, h) > PBN.MAX_SHORT) throw new Error('bad size');
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
  if (typeof p.preview === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(p.preview) && p.preview.length < 1500000) {
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
    paintedBy: room.paintedBy, completedAt: room.completedAt || null, chat: room.chat.slice(-50),
    settings: room.settings, brushRuns: room.brushed ? PBN.toRuns(room.brushed) : (room.brushRuns || []) },
  you: { pid: ws.pid, color, host: isHost(room, ws.user) } });
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
      id: p.id, title: p.title, image: `/featured-thumb/${p.id}.jpg?v=${encodeURIComponent(path.basename(p.file))}`, artist: p.artist,
      playing: (featuredRooms[p.id] || []).reduce((n, id) => n + (rooms.get(id)?.players.size || 0), 0),
    })),
  };
}

function recentRooms(u) {
  return u.recent.map((id) => {
    const r = getRoom(id);
    if (!r) return null;
    return { id, title: r.title, progress: r.paintedCount / r.paintedBy.length,
      players: r.players.size, complete: !!r.completedAt,
      mine: r.createdBy === u.id && r.mode !== 'public', bytes: r.bytes || 0 };
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
    send(ws, storagePayload(u));
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
    const u = ws.user;
    const bytes = Buffer.byteLength(JSON.stringify(puzzle));
    if (usedBy(u) + bytes > quotaOf(u)) {
      return send(ws, { type: 'error', code: 'quota', message:
        `This picture needs ${(bytes / MB).toFixed(1)} MB but you have ${((quotaOf(u) - usedBy(u)) / MB).toFixed(1)} MB left. ` +
        'Delete an old picture or request more space.' });
    }
    const room = createRoom(u, m.title, puzzle, { bytes, uploaded: true });
    (u.uploads = u.uploads || []).push({ roomId: room.id, bytes });
    saveUsers();
    sendStorage(u);
    send(ws, { type: 'roomCreated', roomId: room.id });
  },

  // creators can delete their own pictures (not the shared featured canvases) to free space
  deleteRoom(ws, m) {
    const u = ws.user;
    const room = getRoom(String(m.roomId || ''));
    if (!room || room.createdBy !== u.id || room.mode === 'public') {
      return send(ws, { type: 'error', code: 'delete', message: 'Only the person who created a picture can delete it.' });
    }
    removeRoom(room);
  },

  requestStorage(ws, m) {
    const u = ws.user;
    const mb = Math.round(Number(m.mb));
    if (!Number.isFinite(mb) || mb <= quotaOf(u) / MB || mb > 100000) {
      return send(ws, { type: 'error', code: 'request', message: 'Ask for more than your current limit.' });
    }
    u.storageRequest = { mb, message: String(m.message || '').replace(/[\u0000-\u0009\u000b-\u001f]/g, '').slice(0, 300),
      at: Date.now() };
    saveUsers();
    sendStorage(u);
    console.log(`Storage request: ${u.name} (${u.id}) asks for ${mb} MB`);
  },

  cancelStorageRequest(ws) {
    ws.user.storageRequest = null;
    saveUsers();
    sendStorage(ws.user);
  },

  join(ws, m) { joinRoom(ws, m.roomId); },

  async playFeatured(ws, m) {
    const pic = featured.get(String(m.id || ''));
    if (!pic) return send(ws, { type: 'error', code: 'nofeatured', message: 'That featured picture is no longer available.' });
    let puzzle, ref;
    try { ({ puzzle, ref } = await featured.puzzleFor(pic)); } catch {
      return send(ws, { type: 'error', code: 'nofeatured', message: 'That picture could not be prepared. Try another one.' });
    }
    const extra = { featuredId: pic.id, artist: pic.artist, puzzleRef: ref };
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
    if (room.puzzle.regions[r].c !== m.color || !toolAllowed(room, ws, 'fill')) return send(ws, { type: 'wrong', region: r });
    markPainted(room, r, ws.user);
    afterPaint(room);
  },

  // pixel brush: colours only the pixels under the stroke whose number matches the colour
  brush(ws, m) {
    const room = ws.room;
    if (!room || room.completedAt) return;
    const { w, h, palette, regions } = room.puzzle;
    const pts = m.pts, size = m.size, color = m.color;
    if (!Number.isInteger(color) || color < 0 || color >= palette.length) return;
    if (!Array.isArray(pts) || pts.length < 2 || pts.length % 2 || pts.length > PBN.MAX_STROKE_POINTS * 2) return;
    if (!pts.every((v, k) => Number.isFinite(v) && v >= -16 && v <= (k % 2 ? h : w) + 16)) return;
    if (!toolAllowed(room, ws, 'brush', size)) return send(ws, { type: 'settings', settings: room.settings });
    ensurePixels(room);
    const done = [];
    PBN.brushStroke(w, h, pts, size, (i) => {
      if (room.brushed[i]) return;
      const r = room.regionMap[i];
      if (regions[r].c !== color || room.paintedBy[r] !== null) return;
      room.brushed[i] = 1;
      if (++room.brushCount[r] === room.regionSize[r]) done.push(r);
    });
    broadcast(room, { type: 'brush', pid: ws.pid, color, size, pts }, ws);
    for (const r of done) markPainted(room, r, ws.user);
    if (done.length) afterPaint(room); else saveRoom(room);
  },

  roomSettings(ws, m) {
    const room = ws.room;
    if (!room || !isHost(room, ws.user)) return send(ws, { type: 'error', code: 'settings', message: 'Only the host can change the room settings.' });
    room.settings = cleanSettings(m.settings, room.settings);
    broadcast(room, { type: 'settings', settings: room.settings, by: ws.user.name });
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

// ---------- admin ----------
function adminUsers() {
  return [...users.values()].map((u) => ({
    id: u.id, name: u.name, code: u.code, used: usedBy(u), limit: quotaOf(u),
    pictures: (u.uploads || []).length, request: u.storageRequest || null,
  })).sort((a, b) => (!!b.request - !!a.request) || ((b.request?.at || 0) - (a.request?.at || 0)) || b.used - a.used);
}

function readJson(req, maxBytes = 10000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(Object.assign(new Error('too big'), { tooBig: true })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// players' own uploads, newest first
function adminPictures() {
  const out = [];
  for (const u of users.values()) {
    for (const up of u.uploads || []) {
      const r = getRoom(up.roomId);
      if (!r) continue;
      out.push({ id: r.id, title: r.title, owner: u.name, ownerCode: u.code, bytes: up.bytes, createdAt: r.createdAt,
        players: r.players.size, progress: r.paintedCount / r.paintedBy.length });
    }
  }
  return out.sort((x, y) => y.createdAt - x.createdAt);
}

function adminFeatured() {
  const pod = featured.pictureOfDay();
  const ok = new Set(featured.list().map((p) => p.id));
  return {
    today: pod && pod.picture.id,
    pictures: (featured.readManifest().pictures || []).map((p) => ({
      ...p, ok: ok.has(p.id),
      thumb: ok.has(p.id) ? `/featured-thumb/${p.id}.jpg?v=${encodeURIComponent(path.basename(String(p.image)))}` : null,
    })),
  };
}

const ADMIN_ROUTE = /^\/api\/admin\/(users|quota|deny|featured|featured\/save|featured\/delete|featured\/move|pictures|pictures\/delete|pictures\/preview\/[A-Z2-9]{6})$/;
const MAX_FEATURED_UPLOAD = 20 * MB;

async function handleAdmin(req, res, route) {
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (!ADMIN_TOKEN) return json(503, { error: 'Admin is turned off. Set the ADMIN_TOKEN environment variable and restart.' });
  const given = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!given || !tokenMatches(ADMIN_TOKEN, given)) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return json(401, { error: 'Wrong admin token.' });
  }
  if (req.method === 'GET') {
    if (route === 'users') return json(200, { defaultLimit: DEFAULT_QUOTA, users: adminUsers() });
    if (route === 'featured') return json(200, adminFeatured());
    if (route === 'pictures') return json(200, { pictures: adminPictures() });
    if (route.startsWith('pictures/preview/')) {
      const room = getRoom(route.split('/')[2]);
      const m = room && String(room.puzzle?.preview || '').match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
      if (!m) return json(404, { error: 'No preview' });
      res.writeHead(200, { 'Content-Type': m[1], 'Cache-Control': 'private, max-age=600' });
      return res.end(Buffer.from(m[2], 'base64'));
    }
    return json(405, { error: 'Method not allowed' });
  }
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  let body;
  try { body = await readJson(req, route === 'featured/save' ? MAX_FEATURED_UPLOAD * 1.4 : 10000); } catch (e) {
    return json(e.tooBig ? 413 : 400, { error: e.tooBig ? 'That image is too big (20 MB at most).' : 'Bad JSON' });
  }

  if (route.startsWith('featured/')) {
    try {
      if (route === 'featured/save') {
        let image = null;
        if (body.image) {
          const m = String(body.image).match(/^data:[^;,]*;base64,(.*)$/);
          if (!m) return json(400, { error: 'Bad image upload' });
          image = Buffer.from(m[1], 'base64');
        }
        const prev = body.id && (featured.readManifest().pictures || []).find((p) => p.id === body.id);
        const id = await featured.save({ ...body, previousImage: prev && prev.image }, image);
        return json(200, { ok: true, id });
      }
      if (route === 'featured/delete') featured.remove(String(body.id || ''));
      if (route === 'featured/move') featured.move(String(body.id || ''), Number(body.delta) || 1);
      return json(200, { ok: true });
    } catch (e) {
      return json(400, { error: e.message });
    }
  }
  if (route === 'pictures/delete') {
    const room = getRoom(String(body.roomId || ''));
    if (!room || room.featuredId) return json(404, { error: 'That picture no longer exists.' });
    removeRoom(room, `"${room.title}" was removed by the admin.`);
    return json(200, { ok: true });
  }

  const u = users.get(body.userId);
  if (!u) return json(404, { error: 'No such player' });
  if (route === 'quota') {
    const mb = Number(body.limitMB);
    if (!Number.isFinite(mb) || mb < 0 || mb > 1000000) return json(400, { error: 'Bad limit' });
    u.quotaBytes = Math.round(mb * MB);
    u.storageRequest = null;
    saveUsers();
    sendStorage(u);
    sendUser(u.id, { type: 'notice', message: `Your picture storage is now ${mb} MB.` });
    return json(200, { ok: true });
  }
  if (route === 'deny') {
    u.storageRequest = null;
    saveUsers();
    sendStorage(u);
    sendUser(u.id, { type: 'notice', message: 'Your request for more storage was not approved.' });
    return json(200, { ok: true });
  }
  return json(404, { error: 'Not found' });
}

// Browser protections for every page: only this site's own scripts run, nothing can frame the game.
function securityHeaders(req) {
  const host = String(req.headers.host || '').replace(/[^a-zA-Z0-9.:[\]-]/g, '');
  return {
    'Content-Security-Policy': [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
      `connect-src 'self' ws://${host} wss://${host}`, "worker-src 'self'", "object-src 'none'", "base-uri 'none'",
      "frame-ancestors 'none'", "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let file = url.pathname;
  if (file === '/' || /^\/r\/[A-Za-z0-9]+\/?$/.test(file)) file = '/index.html';
  if (file === '/admin' || file === '/admin/') file = '/admin.html';
  const admin = file.match(ADMIN_ROUTE);
  if (admin) {
    handleAdmin(req, res, admin[1]).catch((e) => { console.error('admin error', e); res.writeHead(500); res.end(); });
    return;
  }
  if (file === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (file === '/api/featured') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    return res.end(JSON.stringify(featuredPayload()));
  }
  const thumb = file.match(/^\/featured-thumb\/([a-z0-9-]{1,40})\.jpg$/);
  if (thumb) {
    const pic = featured.get(thumb[1]);
    if (!pic) { res.writeHead(404); return res.end(); }
    featured.thumbnail(pic).then((jpg) => {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
      res.end(jpg);
    }, () => { res.writeHead(500); res.end(); });
    return;
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache',
      ...securityHeaders(req) });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 * 1024 });
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
  console.log(ADMIN_TOKEN ? `Admin page: http://localhost:${PORT}/admin` : 'Admin page off (set ADMIN_TOKEN to turn it on)');
  featured.warm().then(() => console.log('Featured pictures ready'));
});
