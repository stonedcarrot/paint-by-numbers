// Paint Together client.
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem('pt.' + k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('pt.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  const state = {
    user: store.get('user'),
    friends: { friends: [], incoming: [], outgoing: [], code: '' },
    room: null,
    board: null,
    selected: 0,
    me: null,
    players: [],
    scores: [],
    pendingRoute: null,
  };

  // ---------- toasts ----------
  function toast(msg, action, ms = 3500) {
    const t = el('div', { class: 'toast' }, el('span', {}, msg));
    if (action) t.append(el('button', { class: 'btn primary', onclick: () => { action.fn(); t.remove(); } }, action.label));
    $('#toasts').append(t);
    setTimeout(() => t.remove(), action ? 12000 : ms);
  }

  // ---------- connection ----------
  let ws = null, wsReady = false, retry = 0;
  const outbox = [];
  function send(msg) {
    if (wsReady) ws.send(JSON.stringify(msg));
    else if (msg.type !== 'cursor') outbox.push(msg);
  }
  function connect() {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    ws.onopen = () => {
      retry = 0;
      const u = state.user || {};
      ws.send(JSON.stringify({ type: 'hello', userId: u.id, token: u.token, name: store.get('name') || u.name }));
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const h = on[m.type];
      if (h) h(m);
    };
    ws.onclose = () => {
      wsReady = false;
      setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
    };
  }

  const on = {
    welcome(m) {
      state.user = m.user;
      store.set('user', m.user);
      store.set('name', m.user.name);
      $('#nameInput').value = m.user.name;
      wsReady = true;
      renderRecent(m.recent);
      // rejoin after reconnect, or follow the URL on first load
      if (state.room) send({ type: 'join', roomId: state.room.id });
      else if (state.pendingRoute) { send({ type: 'join', roomId: state.pendingRoute }); state.pendingRoute = null; }
      while (outbox.length) ws.send(JSON.stringify(outbox.shift()));
    },
    recent(m) { renderRecent(m.recent); },
    storage(m) { state.storage = m; renderStorage(); updateCreateStats(); },
    roomDeleted(m) {
      if (state.room && state.room.id === m.roomId) {
        toast(`“${m.title}” was deleted by its creator.`, null, 5000);
        go('/');
      }
    },
    nameSet(m) { store.set('name', m.name); toast('Name saved'); },
    friends(m) { state.friends = m; renderFriends(); },
    notice(m) { toast(m.message); },
    error(m) {
      toast(m.message, null, 5000);
      if (m.code === 'notfound' || m.code === 'full') {
        // stay where we were: in the current picture, or back home
        if (state.room) { history.replaceState({}, '', '/r/' + state.room.id); show('game'); } else go('/', true);
      }
      if (m.code === 'badpuzzle' || m.code === 'quota') $('#createRoomBtn').disabled = false;
      if (m.code === 'quota') {
        // over the limit: back home with the request form open
        createImage = null;
        showStorageForm = true;
        go('/');
        renderStorage();
      }
    },
    roomCreated(m) { go('/r/' + m.roomId); },
    joined(m) { enterRoom(m.room, m.you); },
    players(m) {
      state.players = m.players;
      state.scores = m.scores;
      renderPlayers();
      const live = new Set(m.players.map((p) => p.pid));
      for (const [pid, c] of cursors) if (!live.has(pid)) { c.remove(); cursors.delete(pid); }
    },
    paint(m) {
      if (!state.board) return;
      state.board.paint(m.region);
      afterPaintChange();
    },
    wrong(m) {
      if (!state.board) return;
      state.board.unpaint(m.region);
      afterPaintChange();
    },
    complete() { if (state.board) showDone(); },
    cursor(m) { moveCursor(m.pid, m.x, m.y); },
    cursorGone(m) { const c = cursors.get(m.pid); if (c) { c.remove(); cursors.delete(m.pid); } },
    chat(m) { addChat(m); },
    invite(m) {
      toast(`${m.from.name} invited you to paint “${m.title}”`, { label: 'Join', fn: () => go('/r/' + m.roomId) });
    },
  };

  // ---------- routing ----------
  function show(id) {
    for (const s of $$('.screen')) s.classList.toggle('hidden', s.id !== id);
  }
  function go(path, replace) {
    if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState']({}, '', path);
    route();
  }
  function route() {
    const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{6})/);
    if (m) {
      const id = m[1].toUpperCase();
      if (state.room && state.room.id === id) return show('game');
      if (wsReady) send({ type: 'join', roomId: id });
      else state.pendingRoute = id;
      return;
    }
    if (state.room) leaveRoom();
    if (location.pathname !== '/') history.replaceState({}, '', '/');
    show(createImage ? 'create' : 'home');
    if (wsReady) send({ type: 'recent' });
    loadFeatured();
  }
  window.addEventListener('popstate', () => { createImage = null; route(); });

  // ---------- home ----------
  $('#nameInput').value = store.get('name') || '';
  $('#nameInput').addEventListener('change', (e) => send({ type: 'setName', name: e.target.value }));
  $('#joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('#joinInput').value.trim();
    const m = v.match(/([A-Za-z0-9]{6})\/?$/);
    if (!m) return toast('Paste an invite link or a 6-letter code.');
    $('#joinInput').value = '';
    go('/r/' + m[1].toUpperCase());
  });

  function renderRecent(list) {
    const ul = $('#recentList');
    ul.textContent = '';
    if (!list || !list.length) {
      ul.append(el('li', { class: 'empty' }, 'Pictures you create or join will show up here.'));
      return;
    }
    for (const r of list) {
      ul.append(el('li', {},
        el('div', { class: 'grow' }, el('div', {}, r.title),
          el('div', { class: 'sub' }, r.complete ? 'Finished' : `${Math.floor(r.progress * 100)}% painted` +
            (r.players ? ` · ${r.players} painting now` : ''))),
        el('div', { class: 'mini-progress' }, el('div', { style: `width:${r.progress * 100}%` })),
        el('button', { class: 'btn small', onclick: () => go('/r/' + r.id) }, 'Open'),
        r.mine ? el('button', { class: 'btn small ghost', title: 'Delete this picture', onclick: () => {
          if (confirm(`Delete “${r.title}”? Everyone loses it and its painting progress. This can't be undone.`)) {
            send({ type: 'deleteRoom', roomId: r.id });
          }
        } }, '🗑') : null));
    }
  }

  // ---------- featured pictures ----------
  function artistBlock(artist, withHeading) {
    if (!artist) return null;
    const box = el('div', { class: 'artist' },
      withHeading ? el('div', { class: 'sub' }, 'Artwork by') : null,
      el('div', { class: 'name' }, artist.name),
      artist.bio ? el('p', { class: 'bio' }, artist.bio) : null);
    if (artist.links && artist.links.length) {
      const links = el('div', { class: 'links' });
      for (const l of artist.links) {
        if (/^https:\/\//i.test(l.url)) links.append(el('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.label));
      }
      box.append(links);
    }
    return box;
  }

  const playButtons = (pic, big) => [
    el('button', { class: 'btn' + (big ? ' big' : ' small'), 'data-play': 'solo', onclick: () => playFeatured(pic.id, 'solo') }, 'Paint solo'),
    el('button', { class: 'btn primary' + (big ? ' big' : ' small'), 'data-play': 'together', onclick: () => playFeatured(pic.id, 'together') },
      'Paint with others'),
  ];

  function playFeatured(id, mode) { send({ type: 'playFeatured', id, mode }); }

  async function loadFeatured() {
    let data;
    try { data = await (await fetch('/api/featured')).json(); } catch { return; }
    const potd = $('#potd'), gallery = $('#gallery');
    potd.textContent = '';
    gallery.textContent = '';
    const today = data.pictures.find((p) => p.id === data.today);
    if (today) {
      const date = new Date(data.date + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'long', day: 'numeric', timeZone: 'UTC' });
      potd.append(
        el('img', { src: today.image, alt: today.title }),
        el('div', {},
          el('div', { class: 'kicker' }, `Picture of the day · ${date}`),
          el('h1', {}, today.title),
          artistBlock(today.artist, true),
          today.playing ? el('div', { class: 'playing' }, `● ${today.playing} painting right now`) : null,
          el('div', { class: 'actions' }, ...playButtons(today, true))));
    }
    $('.section-title').classList.toggle('hidden', data.pictures.length < 2);
    for (const p of data.pictures) {
      if (p.id === data.today) continue;
      gallery.append(el('div', { class: 'pic', 'data-id': p.id },
        el('img', { src: p.image, alt: p.title, loading: 'lazy' }),
        el('div', { class: 'body' },
          el('div', {}, el('div', { class: 'title' }, p.title), el('div', { class: 'by' }, 'by ' + p.artist.name)),
          p.playing ? el('div', { class: 'playing' }, `● ${p.playing} painting now`) : null,
          el('div', { class: 'actions' }, ...playButtons(p, false)))));
    }
  }

  // ---------- picture storage ----------
  const fmtMB = (b) => (b < 1e6 ? Math.round(b / 1e3) + ' KB' : (b / 1e6).toFixed(b < 10e6 ? 1 : 0) + ' MB');
  let showStorageForm = false;
  function renderStorage() {
    const st = state.storage, box = $('#storageBox');
    box.textContent = '';
    if (!st) return;
    const pct = Math.min(100, st.used / st.limit * 100);
    box.append(
      el('div', { class: 'sub' }, `Picture storage: ${fmtMB(st.used)} of ${fmtMB(st.limit)} used`),
      el('div', { class: 'bar' + (pct > 90 ? ' full' : '') }, el('div', { style: `width:${pct}%` })));
    if (st.request) {
      box.append(el('div', { class: 'row' },
        el('span', { class: 'sub grow' }, `You asked for ${st.request.mb} MB. Waiting for the admin to approve it.`),
        el('button', { class: 'btn small ghost', onclick: () => send({ type: 'cancelStorageRequest' }) }, 'Cancel request')));
      return;
    }
    if (!showStorageForm) {
      box.append(el('button', { class: 'btn small', id: 'moreSpaceBtn', onclick: () => { showStorageForm = true; renderStorage(); } }, 'Request more space'));
      return;
    }
    const suggested = Math.round(st.limit / 1e6) + 100;
    const form = el('form', { onsubmit: (e) => {
      e.preventDefault();
      send({ type: 'requestStorage', mb: Number(form.querySelector('input').value), message: form.querySelector('textarea').value });
      showStorageForm = false;
      toast('Request sent. You will get a message here once it is approved.');
    } },
    el('label', { class: 'row' }, 'New limit', el('input', { type: 'number', min: String(suggested - 99), step: '1', value: String(suggested), style: 'width:110px' }), 'MB'),
    el('textarea', { rows: '2', maxlength: '300', placeholder: 'Anything the admin should know (optional)' }),
    el('div', { class: 'row' },
      el('button', { class: 'btn small primary' }, 'Send request'),
      el('button', { class: 'btn small ghost', type: 'button', onclick: () => { showStorageForm = false; renderStorage(); } }, 'Cancel')));
    box.append(form);
    if (!$('#home').classList.contains('hidden')) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ---------- friends ----------
  function renderFriends() {
    const f = state.friends;
    const inRoom = state.room && state.room.id;
    let pending = f.incoming.length;
    for (const panel of $$('[data-friends]')) {
      const ingame = panel.hasAttribute('data-ingame');
      panel.textContent = '';
      panel.append(
        el('h4', {}, 'Your friend code'),
        el('div', { class: 'my-code' }, el('code', {}, f.code || '…'),
          el('button', { class: 'btn small', onclick: () => copy(f.code, 'Friend code copied') }, 'Copy')),
        el('form', { class: 'row', style: 'margin-top:10px', onsubmit: (e) => {
          e.preventDefault();
          const i = e.target.querySelector('input');
          if (i.value.trim()) send({ type: 'friendRequest', code: i.value });
          i.value = '';
        } }, el('input', { placeholder: "Friend's code", maxlength: 6, autocomplete: 'off' }),
        el('button', { class: 'btn' }, 'Add')),
      );
      if (f.incoming.length) {
        panel.append(el('h4', {}, 'Friend requests'));
        const ul = el('ul', { class: 'list' });
        for (const r of f.incoming) {
          ul.append(el('li', {}, el('div', { class: 'grow' }, r.name),
            el('button', { class: 'btn small primary', onclick: () => send({ type: 'friendRespond', userId: r.id, accept: true }) }, 'Accept'),
            el('button', { class: 'btn small', onclick: () => send({ type: 'friendRespond', userId: r.id, accept: false }) }, 'Decline')));
        }
        panel.append(ul);
      }
      panel.append(el('h4', {}, 'Friends'));
      const ul = el('ul', { class: 'list' });
      if (!f.friends.length) {
        ul.append(el('li', { class: 'empty' }, 'Share your code with friends, or add theirs, to see when they are painting and join them.'));
      }
      const sorted = [...f.friends].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
      for (const fr of sorted) {
        let status = 'Offline', action = null;
        if (fr.online && fr.roomId) {
          status = `Painting “${fr.roomTitle}” (${fr.roomPlayers}/10)`;
          if (fr.roomId === inRoom) status = 'Painting with you';
          else if (!fr.roomFull) action = el('button', { class: 'btn small primary', onclick: () => go('/r/' + fr.roomId) }, 'Join');
        } else if (fr.online) status = 'Online';
        if (ingame && inRoom && fr.online && fr.roomId !== inRoom) {
          action = el('button', { class: 'btn small', onclick: () => send({ type: 'invite', userId: fr.id }) }, 'Invite');
        }
        ul.append(el('li', {}, el('span', { class: 'dot' + (fr.online ? ' on' : '') }),
          el('div', { class: 'grow' }, el('div', {}, fr.name), el('div', { class: 'sub' }, status)),
          action,
          el('button', { class: 'btn small ghost', title: 'Remove friend', onclick: () => {
            if (confirm(`Remove ${fr.name} from your friends?`)) send({ type: 'removeFriend', userId: fr.id });
          } }, '✕')));
      }
      panel.append(ul);
      if (f.outgoing.length) {
        panel.append(el('h4', {}, 'Waiting for them to accept'));
        const out = el('ul', { class: 'list' });
        for (const r of f.outgoing) {
          out.append(el('li', {}, el('div', { class: 'grow' }, r.name),
            el('button', { class: 'btn small', onclick: () => send({ type: 'cancelRequest', userId: r.id }) }, 'Cancel')));
        }
        panel.append(out);
      }
    }
    const badge = $('#friendsBadge');
    badge.textContent = pending;
    badge.classList.toggle('hidden', !pending);
  }

  async function copy(text, msg) {
    try { await navigator.clipboard.writeText(text); toast(msg); } catch { prompt('Copy this:', text); }
  }

  // ---------- create ----------
  let createImage = null, genPuzzle = null, genSeq = 0, previewView = 'numbers', previewUrl = null;
  const worker = new Worker('/pbn-worker.js');

  function loadFile(file) {
    if (!file || !file.type.startsWith('image/')) return toast('Please choose an image file.');
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      createImage = img;
      $('#titleInput').value = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 60);
      // small jpeg of the original for the "peek" button
      const s = Math.min(1, 960 / Math.max(img.width, img.height));
      const c = el('canvas', { width: Math.round(img.width * s), height: Math.round(img.height * s) });
      const cx = c.getContext('2d');
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height);
      cx.drawImage(img, 0, 0, c.width, c.height);
      previewUrl = c.toDataURL('image/jpeg', 0.8);
      show('create');
      generate();
    };
    img.onerror = () => toast('That image could not be opened.');
    img.src = url;
  }
  $('#fileInput').addEventListener('change', (e) => { loadFile(e.target.files[0]); e.target.value = ''; });
  const dz = $('#dropZone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); loadFile(e.dataTransfer.files[0]); });
  $('#createBack').addEventListener('click', () => { createImage = null; show('home'); });
  $('#colorsInput').addEventListener('input', (e) => { $('#colorsVal').textContent = e.target.value; });
  $('#colorsInput').addEventListener('change', generate);
  $('#detailInput').addEventListener('change', generate);
  for (const b of $$('[data-view]')) {
    b.addEventListener('click', () => {
      previewView = b.dataset.view;
      for (const o of $$('[data-view]')) o.classList.toggle('active', o === b);
      drawPreview();
    });
  }

  function generate() {
    if (!createImage) return;
    const img = createImage;
    const { w, h } = PBN.fitSize(img.naturalWidth || img.width, img.naturalHeight || img.height);
    const c = el('canvas', { width: w, height: h });
    const cx = c.getContext('2d');
    cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(img, 0, 0, w, h);
    const id = cx.getImageData(0, 0, w, h);
    const seq = ++genSeq;
    $('#previewBusy').classList.remove('hidden');
    $('#createRoomBtn').disabled = true;
    worker.postMessage({ id: seq, imageData: { data: id.data, width: w, height: h },
      opts: PBN.optionsFor($('#detailInput').value, w, h, +$('#colorsInput').value) });
  }
  worker.onmessage = (e) => {
    if (e.data.id !== genSeq) return;
    $('#previewBusy').classList.add('hidden');
    if (!e.data.ok) return toast('Could not process that image: ' + e.data.error);
    genPuzzle = e.data.puzzle;
    const p = genPuzzle;
    genPayload = { w: p.w, h: p.h, palette: p.palette, preview: previewUrl,
      regions: p.regions.map((r) => ({ c: r.c, x: r.x, y: r.y, r: r.r })), rle: PBN.encodeRLE(p.regionMap) };
    genBytes = new Blob([JSON.stringify(genPayload)]).size;
    updateCreateStats();
    drawPreview();
  };

  let genPayload = null, genBytes = 0;
  function updateCreateStats() {
    if (!genPuzzle || !genPayload) return;
    const st = state.storage;
    const left = st ? st.limit - st.used : Infinity;
    const fits = genBytes <= left;
    $('#genStats').textContent = `${genPuzzle.regions.length} regions · ${genPuzzle.palette.length} colours · ` +
      `${genPuzzle.w}×${genPuzzle.h} · ${fmtMB(genBytes)}` + (st ? ` (${fmtMB(Math.max(0, left))} of your storage left)` : '');
    $('#createRoomBtn').disabled = !fits;
    $('#createRoomBtn').title = fits ? '' : 'Not enough storage left';
    if (!fits) $('#genStats').textContent += '. Not enough space: delete an old picture or request more on the home page.';
  }

  function drawPreview() {
    if (!genPuzzle) return;
    const canvas = $('#previewCanvas');
    if (previewView === 'original') {
      const img = new Image();
      img.onload = () => {
        canvas.width = img.width; canvas.height = img.height;
        canvas.getContext('2d').drawImage(img, 0, 0);
      };
      img.src = previewUrl;
      return;
    }
    const b = new Board({ ...genPuzzle, map: genPuzzle.regionMap }, canvas, 1400);
    if (previewView === 'painted') b.paintAll();
    b.render();
  }

  $('#createRoomBtn').addEventListener('click', () => {
    if (!genPayload) return;
    $('#createRoomBtn').disabled = true;
    send({ type: 'createRoom', title: $('#titleInput').value, puzzle: genPayload });
    createImage = null;
    setTimeout(updateCreateStats, 3000);
  });

  // ---------- board rendering ----------
  const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const inkFor = (hex) => { const [r, g, b] = rgbOf(hex); return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#222' : '#fff'; };
  const WHITE = [255, 255, 255], HIGHLIGHT = [214, 214, 222], FLASH = [255, 120, 120];

  // Draws the puzzle at S canvas pixels per puzzle pixel. A paint only redraws the box around the regions
  // involved, so Full HD pictures stay smooth while many people paint.
  class Board {
    constructor(p, canvas, target = 2400) {
      this.p = p;
      this.w = p.w; this.h = p.h;
      this.map = p.map;
      this.n = p.regions.length;
      this.S = Math.max(2, Math.min(10, Math.floor(target / Math.max(p.w, p.h))));
      this.canvas = canvas;
      canvas.width = p.w * this.S;
      canvas.height = p.h * this.S;
      this.ctx = canvas.getContext('2d');
      this.painted = new Uint8Array(this.n);
      this.highlight = -1;
      this.flash = -1;
      this.colorLayer = document.createElement('canvas');
      this.colorLayer.width = p.w; this.colorLayer.height = p.h;
      this.cctx = this.colorLayer.getContext('2d');
      this.img = this.cctx.createImageData(p.w, p.h);
      this.rgb = p.palette.map(rgbOf);
      this.remaining = new Array(p.palette.length).fill(0);
      this.byColor = p.palette.map(() => []);
      p.regions.forEach((r, i) => { this.remaining[r.c]++; this.byColor[r.c].push(i); });
      const { w, h, map, n } = this;

      // pixels of each region (bucketed) and each region's bounding box
      const count = new Int32Array(n + 1);
      const box = new Int32Array(n * 4);
      for (let r = 0; r < n; r++) { box[r * 4] = w; box[r * 4 + 1] = h; box[r * 4 + 2] = -1; box[r * 4 + 3] = -1; }
      for (let i = 0; i < w * h; i++) {
        const r = map[i], x = i % w, y = (i / w) | 0, b = r * 4;
        count[r + 1]++;
        if (x < box[b]) box[b] = x;
        if (y < box[b + 1]) box[b + 1] = y;
        if (x > box[b + 2]) box[b + 2] = x;
        if (y > box[b + 3]) box[b + 3] = y;
      }
      for (let r = 0; r < n; r++) count[r + 1] += count[r];
      const fill = count.slice(0, n);
      this.pixStart = count;
      this.pix = new Int32Array(w * h);
      for (let i = 0; i < w * h; i++) this.pix[fill[map[i]]++] = i;
      this.box = box;

      // border segments between neighbouring regions, indexed by the row that produced them
      const segs = [];
      this.segRow = new Int32Array(h + 1);
      for (let y = 0; y < h; y++) {
        this.segRow[y] = segs.length / 5;
        for (let x = 0; x < w; x++) {
          const i = y * w + x, a = map[i];
          if (x < w - 1 && map[i + 1] !== a) segs.push(x + 1, y, 0, a, map[i + 1]);
          if (y < h - 1 && map[i + w] !== a) segs.push(x, y + 1, 1, a, map[i + w]);
        }
      }
      this.segRow[h] = segs.length / 5;
      this.segs = Int32Array.from(segs);
      this.numberCap = Math.max(64, Math.max(w, h) * this.S / 45);
      this.dirty = new Set();
      this.fullDirty = true;
    }
    touch(r) { if (r >= 0 && r < this.n) this.dirty.add(r); }
    paint(r) {
      if (r < 0 || r >= this.n || this.painted[r]) return false;
      this.painted[r] = 1;
      this.remaining[this.p.regions[r].c]--;
      this.touch(r);
      return true;
    }
    unpaint(r) {
      if (!this.painted[r]) return;
      this.painted[r] = 0;
      this.remaining[this.p.regions[r].c]++;
      this.touch(r);
    }
    paintAll() { for (let r = 0; r < this.n; r++) this.paint(r); this.fullDirty = true; }
    setHighlight(c) {
      if (c === this.highlight) return;
      this.highlight = c;
      this.fullDirty = true; // touches regions all over the picture, so a full redraw is quicker
    }
    setFlash(r) { this.touch(this.flash); this.flash = r; this.touch(r); }
    get paintedCount() { return this.painted.reduce((a, b) => a + b, 0); }
    regionAt(x, y) {
      x = Math.floor(x); y = Math.floor(y);
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
      return this.map[y * this.w + x];
    }
    colorOf(r) {
      if (r === this.flash) return FLASH;
      if (this.painted[r]) return this.rgb[this.p.regions[r].c];
      return this.p.regions[r].c === this.highlight ? HIGHLIGHT : WHITE;
    }
    setPixels(r) {
      const d = this.img.data, c = this.colorOf(r);
      for (let i = this.pixStart[r]; i < this.pixStart[r + 1]; i++) {
        const o = this.pix[i] * 4;
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
      }
    }
    // draw everything that changed since the last call
    render() {
      if (this.fullDirty || this.dirty.size > 12) {
        for (let r = 0; r < this.n; r++) this.setPixels(r);
        this.cctx.putImageData(this.img, 0, 0);
        this.drawArea(0, 0, this.w, this.h);
      } else {
        // one box per changed region (plus a margin for numbers that spill over), merged where they overlap
        let rects = [];
        for (const r of this.dirty) {
          this.setPixels(r);
          const b = r * 4, m = 3;
          rects.push([Math.max(0, this.box[b] - m), Math.max(0, this.box[b + 1] - m),
            Math.min(this.w, this.box[b + 2] + 1 + m), Math.min(this.h, this.box[b + 3] + 1 + m)]);
        }
        rects = mergeRects(rects);
        const area = rects.reduce((a, [x0, y0, x1, y1]) => a + (x1 - x0) * (y1 - y0), 0);
        if (area > this.w * this.h * 0.5) rects = [[0, 0, this.w, this.h]];
        for (const [x0, y0, x1, y1] of rects) {
          this.cctx.putImageData(this.img, 0, 0, x0, y0, x1 - x0, y1 - y0);
          this.drawArea(x0, y0, x1, y1);
        }
      }
      this.dirty.clear();
      this.fullDirty = false;
    }
    // redraw puzzle pixels [x0,x1) x [y0,y1)
    drawArea(x0, y0, x1, y1) {
      const { ctx, S, painted, p, segs } = this;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 * S, y0 * S, (x1 - x0) * S, (y1 - y0) * S);
      ctx.clip();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(this.colorLayer, x0, y0, x1 - x0, y1 - y0, x0 * S, y0 * S, (x1 - x0) * S, (y1 - y0) * S);

      // borders around anything not yet painted
      const lw = Math.max(1, Math.round(S / 5));
      ctx.beginPath();
      const from = this.segRow[Math.max(0, y0 - 1)], to = this.segRow[Math.min(this.h, y1 + 1)];
      for (let k = from; k < to; k++) {
        const i = k * 5, x = segs[i], y = segs[i + 1];
        if (x < x0 - 1 || x > x1 + 1 || y < y0 - 1 || y > y1 + 1) continue;
        if (painted[segs[i + 3]] && painted[segs[i + 4]]) continue;
        if (segs[i + 2] === 0) ctx.rect(x * S - lw / 2, y * S, lw, S);
        else ctx.rect(x * S, y * S - lw / 2, S, lw);
      }
      ctx.fillStyle = '#8d8a93';
      ctx.fill();

      // numbers
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let r = 0; r < this.n; r++) {
        if (painted[r]) continue;
        const reg = p.regions[r];
        const label = String(reg.c + 1);
        const size = Math.max(5, Math.min(reg.r * S * (label.length > 1 ? 1.05 : 1.4), this.numberCap));
        const half = size / S;
        if (reg.x + half < x0 || reg.x - half > x1 || reg.y + half < y0 || reg.y - half > y1) continue;
        const hl = reg.c === this.highlight;
        ctx.font = `${hl ? 700 : 500} ${size}px system-ui, sans-serif`;
        ctx.fillStyle = hl ? '#111' : '#6d6a73';
        ctx.fillText(label, reg.x * S, reg.y * S + size * 0.04);
      }
      ctx.restore();
    }
  }

  // merge overlapping [x0,y0,x1,y1] boxes so each area is drawn once
  function mergeRects(rects) {
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i], b = rects[j];
          if (a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]) {
            rects[i] = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
            rects.splice(j, 1);
            merged = true;
            break outer;
          }
        }
      }
    }
    return rects;
  }

  // ---------- game ----------
  const view = { scale: 1, tx: 0, ty: 0 };
  const canvas = $('#boardCanvas');
  const viewport = $('#viewport');
  let renderQueued = false;
  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; if (state.board) state.board.render(); });
  }

  function enterRoom(room, you) {
    const puzzle = room.puzzle;
    const map = PBN.decodeRLE(puzzle.rle, puzzle.w * puzzle.h);
    state.room = room;
    state.me = you;
    state.board = new Board({ ...puzzle, map }, canvas);
    room.paintedBy.forEach((by, r) => { if (by) state.board.paint(r); });
    if (location.pathname !== '/r/' + room.id) {
      // arriving from home (e.g. a featured picture) gets its own history entry so Back returns home
      history[/^\/r\//.test(location.pathname) ? 'replaceState' : 'pushState']({}, '', '/r/' + room.id);
    }
    $('#credit').classList.toggle('hidden', !room.artist);
    $('#modeChip').textContent = { solo: 'Solo', public: 'Open to all' }[room.mode] || 'Invite only';
    $('#creditName').textContent = room.artist ? room.artist.name : '';
    $('#artistPanel').textContent = '';
    if (room.artist) $('#artistPanel').append(artistBlock(room.artist));
    $('#artistDrawer').classList.add('hidden');
    $('#gameTitle').textContent = room.title;
    document.title = room.title + ' · Paint Together';
    $('#peekImg').src = puzzle.preview || '';
    $('#peekImg').classList.add('hidden');
    $('#chatLog').textContent = '';
    for (const c of room.chat) addChat(c, true);
    $('#chatBadge').classList.add('hidden');
    chatUnread = 0;
    show('game');
    state.selected = firstRemaining(0);
    buildPalette();
    fitView();
    afterPaintChange();
    renderFriends();
    if (room.completedAt) toast('This picture is finished. You can still look around or download it.');
    else if (room.mode === 'solo' && room.paintedBy.every((x) => x === null)) {
      toast('You are painting solo. Share the invite link any time to paint with friends.', null, 5000);
    }
  }

  function leaveRoom() {
    send({ type: 'leave' });
    state.room = null;
    state.board = null;
    for (const c of cursors.values()) c.remove();
    cursors.clear();
    $('#doneOverlay').classList.add('hidden');
    document.title = 'Paint Together';
    renderFriends();
  }

  function firstRemaining(from) {
    const rem = state.board.remaining;
    for (let i = 0; i < rem.length; i++) {
      const c = (from + i) % rem.length;
      if (rem[c] > 0) return c;
    }
    return from;
  }

  function buildPalette() {
    const pal = $('#palette');
    pal.textContent = '';
    state.board.p.palette.forEach((hex, i) => {
      pal.append(el('button', { class: 'swatch', 'data-c': i, style: `background:${hex};color:${inkFor(hex)}`,
        title: `Colour ${i + 1}`, onclick: () => selectColor(i) },
      el('span', { class: 'num' }, String(i + 1)), el('span', { class: 'left' }, '')));
    });
  }
  function selectColor(i) {
    state.selected = i;
    state.board.setHighlight(i);
    updatePalette();
    queueRender();
    const sw = $(`.swatch[data-c="${i}"]`);
    if (sw) sw.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
  function updatePalette() {
    const rem = state.board.remaining;
    for (const sw of $$('.swatch')) {
      const c = +sw.dataset.c;
      sw.classList.toggle('selected', c === state.selected);
      sw.classList.toggle('done', rem[c] === 0);
      sw.querySelector('.left').textContent = rem[c] === 0 ? 'done' : rem[c] + ' left';
    }
  }
  function afterPaintChange() {
    const b = state.board;
    if (b.remaining[state.selected] === 0) state.selected = firstRemaining(state.selected);
    b.setHighlight(state.selected);
    const pct = b.paintedCount / b.n;
    $('#progressFill').style.width = pct * 100 + '%';
    $('#progressFill').parentElement.title = Math.floor(pct * 100) + '% painted';
    updatePalette();
    queueRender();
  }

  function renderPlayers() {
    const list = $('#playersList');
    list.textContent = '';
    const score = Object.fromEntries(state.scores.map((s) => [s.userId, s.n]));
    for (const p of state.players) {
      list.append(el('div', { class: 'avatar', style: `background:${p.color}`,
        title: `${p.name}${p.pid === state.me?.pid ? ' (you)' : ''} · ${score[p.userId] || 0} painted` },
      (p.name.trim()[0] || '?').toUpperCase()));
    }
  }

  function showDone() {
    const b = state.board;
    const done = $('#doneCanvas');
    const k = Math.min(3, 1600 / Math.max(b.w, b.h)); // keeps the canvas small enough for phones
    done.width = Math.round(b.w * k); done.height = Math.round(b.h * k);
    const ctx = done.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    b.setHighlight(-1);
    b.render();
    ctx.drawImage(b.canvas, 0, 0, done.width, done.height);
    const ol = $('#scoreList');
    ol.textContent = '';
    for (const s of state.scores) ol.append(el('li', {}, `${s.name}: ${s.n} region${s.n === 1 ? '' : 's'}`));
    $('#doneArtist').textContent = '';
    if (state.room.artist) $('#doneArtist').append(artistBlock(state.room.artist, true));
    $('#doneOverlay').classList.remove('hidden');
  }
  $('#doneClose').addEventListener('click', () => $('#doneOverlay').classList.add('hidden'));
  $('#downloadBtn').addEventListener('click', () => {
    const a = el('a', { download: (state.room?.title || 'picture') + '.png', href: state.board.canvas.toDataURL('image/png') });
    a.click();
  });

  // ---------- view: pan & zoom ----------
  function applyView() {
    canvas.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
    for (const [pid, c] of cursors) positionCursor(c);
  }
  function fitView() {
    const r = viewport.getBoundingClientRect();
    const s = Math.min(r.width / canvas.width, r.height / canvas.height) * 0.94;
    view.scale = s;
    view.tx = (r.width - canvas.width * s) / 2;
    view.ty = (r.height - canvas.height * s) / 2;
    view.fitted = true;
    applyView();
  }
  function zoomAt(factor, cx, cy) {
    const min = Math.min(viewport.clientWidth / canvas.width, viewport.clientHeight / canvas.height) * 0.5;
    const ns = Math.min(4, Math.max(min, view.scale * factor));
    factor = ns / view.scale;
    view.tx = cx - (cx - view.tx) * factor;
    view.ty = cy - (cy - view.ty) * factor;
    view.scale = ns;
    view.fitted = false;
    applyView();
  }
  const centerZoom = (f) => zoomAt(f, viewport.clientWidth / 2, viewport.clientHeight / 2);
  $('#zoomIn').addEventListener('click', () => centerZoom(1.4));
  $('#zoomOut').addEventListener('click', () => centerZoom(1 / 1.4));
  $('#zoomFit').addEventListener('click', fitView);
  window.addEventListener('resize', () => { if (state.board) (view.fitted ? fitView() : applyView()); });

  // screen point (relative to viewport) -> puzzle pixel coords
  function toPuzzle(px, py) {
    const S = state.board.S;
    return { x: (px - view.tx) / view.scale / S, y: (py - view.ty) / view.scale / S };
  }
  const localPoint = (e) => { const r = viewport.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  viewport.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = localPoint(e);
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
  }, { passive: false });

  const pointers = new Map();
  let gesture = null;
  viewport.addEventListener('pointerdown', (e) => {
    if (!state.board || e.target.closest('.zoom')) return;
    viewport.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, localPoint(e));
    if (pointers.size === 1) {
      const p = localPoint(e);
      gesture = { start: p, last: p, moved: e.button !== 0, pinch: null };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture.moved = true;
      gesture.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    }
  });
  viewport.addEventListener('pointermove', (e) => {
    if (!state.board) return;
    const p = localPoint(e);
    if (e.pointerType === 'mouse') sendCursor(p);
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, p);
    if (gesture.pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      view.tx += mid.x - gesture.pinch.mid.x;
      view.ty += mid.y - gesture.pinch.mid.y;
      zoomAt(dist / gesture.pinch.dist, mid.x, mid.y);
      gesture.pinch = { dist, mid };
      return;
    }
    if (!gesture.moved && Math.hypot(p.x - gesture.start.x, p.y - gesture.start.y) > 6) gesture.moved = true;
    if (gesture.moved) {
      viewport.classList.add('panning');
      view.tx += p.x - gesture.last.x;
      view.ty += p.y - gesture.last.y;
      view.fitted = false;
      applyView();
    }
    gesture.last = p;
  });
  const endPointer = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size === 0 && gesture) {
      viewport.classList.remove('panning');
      if (!gesture.moved && e.type === 'pointerup') tapAt(localPoint(e));
      gesture = null;
    } else if (pointers.size === 1 && gesture) {
      gesture.pinch = null;
      gesture.last = [...pointers.values()][0];
    }
  };
  viewport.addEventListener('pointerup', endPointer);
  viewport.addEventListener('pointercancel', endPointer);
  viewport.addEventListener('contextmenu', (e) => e.preventDefault());

  let flashTimer = null;
  function tapAt(p) {
    const b = state.board;
    const q = toPuzzle(p.x, p.y);
    const r = b.regionAt(q.x, q.y);
    if (r < 0 || b.painted[r]) return;
    const want = b.p.regions[r].c;
    if (want !== state.selected) {
      b.setFlash(r);
      queueRender();
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { b.setFlash(-1); queueRender(); }, 350);
      const sw = $(`.swatch[data-c="${want}"]`);
      if (sw) { sw.classList.remove('shake'); void sw.offsetWidth; sw.classList.add('shake'); }
      return;
    }
    b.paint(r);
    send({ type: 'paint', region: r, color: want });
    afterPaintChange();
  }

  // keyboard: number keys pick colours, +/- zoom, 0 fit
  window.addEventListener('keydown', (e) => {
    if (!state.board || e.target.matches('input, textarea')) return;
    if (e.key === '+' || e.key === '=') centerZoom(1.3);
    else if (e.key === '-') centerZoom(1 / 1.3);
    else if (e.key === '0') fitView();
    else if (e.key === 'ArrowRight' || e.key === ']') selectColor((state.selected + 1) % state.board.p.palette.length);
    else if (e.key === 'ArrowLeft' || e.key === '[') selectColor((state.selected - 1 + state.board.p.palette.length) % state.board.p.palette.length);
  });

  // ---------- live cursors ----------
  const cursors = new Map();
  let lastCursorSent = 0, cursorTimer = null, pendingCursor = null;
  function sendCursor(p) {
    pendingCursor = toPuzzle(p.x, p.y);
    const now = Date.now();
    const flush = () => { lastCursorSent = Date.now(); cursorTimer = null; send({ type: 'cursor', ...pendingCursor }); };
    if (now - lastCursorSent > 50) flush();
    else if (!cursorTimer) cursorTimer = setTimeout(flush, 50 - (now - lastCursorSent));
  }
  function moveCursor(pid, x, y) {
    const player = state.players.find((p) => p.pid === pid);
    if (!player) return;
    let c = cursors.get(pid);
    if (!c) {
      c = el('div', { class: 'cursor' });
      c.innerHTML = `<svg width="18" height="22" viewBox="0 0 18 22"><path d="M1 1l15 11-7 1-4 7z" fill="${player.color}" stroke="#fff" stroke-width="1.5"/></svg>`;
      c.append(el('span', { style: `background:${player.color}` }, player.name));
      cursors.set(pid, c);
      $('#cursors').append(c);
    }
    c.px = x; c.py = y;
    positionCursor(c);
  }
  function positionCursor(c) {
    if (!state.board) return;
    const S = state.board.S;
    c.style.transform = `translate(${view.tx + c.px * S * view.scale}px, ${view.ty + c.py * S * view.scale}px)`;
  }

  // ---------- chat, peek, drawers ----------
  let chatUnread = 0;
  function addChat(m, quiet) {
    const li = el('li', {}, el('b', { style: `color:${m.color}` }, m.name + ':'), m.text);
    const log = $('#chatLog');
    log.append(li);
    log.scrollTop = log.scrollHeight;
    if (!quiet && $('#chatDrawer').classList.contains('hidden')) {
      chatUnread++;
      $('#chatBadge').textContent = chatUnread;
      $('#chatBadge').classList.remove('hidden');
      toast(`${m.name}: ${m.text}`);
    }
  }
  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const i = $('#chatInput');
    if (i.value.trim()) send({ type: 'chat', text: i.value });
    i.value = '';
  });
  function toggleDrawer(id) {
    for (const d of ['#chatDrawer', '#friendsDrawer', '#artistDrawer']) {
      if (d !== id) $(d).classList.add('hidden');
    }
    $(id).classList.toggle('hidden');
    if (id === '#chatDrawer' && !$(id).classList.contains('hidden')) {
      chatUnread = 0;
      $('#chatBadge').classList.add('hidden');
      $('#chatInput').focus();
    }
    if (state.board) {
      // keep the picture where it was after the viewport resizes
      requestAnimationFrame(() => (view.fitted ? fitView() : applyView()));
    }
  }
  $('#chatBtn').addEventListener('click', () => toggleDrawer('#chatDrawer'));
  $('#creditName').addEventListener('click', () => toggleDrawer('#artistDrawer'));
  $('#friendsBtn').addEventListener('click', () => toggleDrawer('#friendsDrawer'));
  $('#peekBtn').addEventListener('click', () => {
    if (!$('#peekImg').getAttribute('src')) return toast('No original image saved for this picture.');
    $('#peekImg').classList.toggle('hidden');
  });
  $('#copyLinkBtn').addEventListener('click', () => copy(location.origin + '/r/' + state.room.id, 'Invite link copied. Send it to up to 9 friends!'));
  $('#gameBack').addEventListener('click', () => go('/'));

  // ---------- start ----------
  const initial = location.pathname.match(/^\/r\/([A-Za-z0-9]{6})/);
  if (initial) state.pendingRoute = initial[1].toUpperCase();
  else show('home');
  loadFeatured();
  connect();

  // exposed for automated tests
  window.__pt = { state, view, toPuzzle, tapAt, selectColor };
})();
