// Admin page: edit featured pictures, review storage requests, set players' limits and remove their pictures.
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v != null) n.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  };
  const mb = (b) => (b < 1e6 ? Math.round(b / 1e3) + ' KB' : (b / 1e6).toFixed(1) + ' MB');
  let token = '';
  try { token = sessionStorage.getItem('pt.admin') || ''; } catch { /* storage blocked */ }

  function toast(text) {
    const t = el('div', { class: 'toast' }, text);
    $('#toasts').append(t);
    setTimeout(() => t.remove(), 3500);
  }

  async function api(path, body) {
    const res = await fetch('/api/admin/' + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status });
    return data;
  }

  function limitControl(u, suggested) {
    const input = el('input', { type: 'number', min: '0', step: '10', value: String(suggested), class: 'mb-input' });
    return el('span', { class: 'row' }, input, el('span', {}, 'MB'),
      el('button', { class: 'btn small primary', onclick: async () => {
        try { await api('quota', { userId: u.id, limitMB: Number(input.value) }); toast(`${u.name}: limit set to ${input.value} MB`); load(); } catch (e) { toast(e.message); }
      } }, 'Set limit'));
  }

  function render(data) {
    const reqs = data.users.filter((u) => u.request);
    const rt = $('#requests');
    rt.textContent = '';
    if (!reqs.length) rt.append(el('tr', {}, el('td', { class: 'stats' }, 'No requests waiting.')));
    else rt.append(el('tr', {}, ...['Player', 'Using', 'Asked for', 'Message', ''].map((h) => el('th', {}, h))));
    for (const u of reqs) {
      rt.append(el('tr', {},
        el('td', {}, el('b', {}, u.name), el('div', { class: 'stats' }, `code ${u.code} · ${new Date(u.request.at).toLocaleString()}`)),
        el('td', {}, `${mb(u.used)} of ${mb(u.limit)}`),
        el('td', {}, u.request.mb + ' MB'),
        el('td', {}, u.request.message || '—'),
        el('td', {}, el('div', { class: 'row' }, limitControl(u, u.request.mb),
          el('button', { class: 'btn small', onclick: async () => {
            try { await api('deny', { userId: u.id }); toast(`Declined ${u.name}'s request`); load(); } catch (e) { toast(e.message); }
          } }, 'Decline')))));
    }
    const ut = $('#users');
    ut.textContent = '';
    ut.append(el('tr', {}, ...['Player', 'Pictures', 'Using', 'Limit'].map((h) => el('th', {}, h))));
    for (const u of data.users) {
      ut.append(el('tr', {},
        el('td', {}, el('b', {}, u.name), el('div', { class: 'stats' }, 'code ' + u.code)),
        el('td', {}, String(u.pictures)),
        el('td', {}, mb(u.used)),
        el('td', {}, limitControl(u, Math.round(u.limit / 1e6)))));
    }
  }

  // ----- featured pictures -----
  const ff = {
    form: $('#featForm'), file: $('#featFile'), preview: $('#featPreview'), info: $('#featFileInfo'),
    title: $('#featTitle'), artist: $('#featArtist'), bio: $('#featBio'), links: $('#featLinks'),
    colors: $('#featColors'), detail: $('#featDetail'), date: $('#featDate'),
    save: $('#featSave'), cancel: $('#featCancel'), busy: $('#featBusy'), heading: $('#featFormTitle'),
  };
  let editing = null; // id being edited
  let imageData = null; // data URL of a newly chosen image
  let featuredData = { pictures: [] };

  function addLinkRow(l = {}) {
    if (ff.links.children.length >= 6) return;
    const row = el('div', { class: 'row link-row' },
      el('input', { placeholder: 'Label, e.g. Instagram', maxlength: '30', value: l.label || '' }),
      el('input', { placeholder: 'https://…', type: 'url', value: l.url || '' }),
      el('button', { type: 'button', class: 'btn small', title: 'Remove link', onclick: () => row.remove() }, '✕'));
    ff.links.append(row);
  }

  function resetForm() {
    editing = null;
    imageData = null;
    ff.form.reset();
    ff.links.textContent = '';
    addLinkRow();
    ff.preview.classList.add('hidden');
    ff.preview.removeAttribute('src');
    ff.info.textContent = 'PNG, JPEG, WebP, GIF or SVG, up to 20 MB. Bigger than Full HD is scaled down.';
    ff.heading.textContent = 'Add a featured picture';
    ff.save.textContent = 'Add picture';
    ff.cancel.classList.add('hidden');
    ff.busy.textContent = '';
    renderFeatured();
  }

  function editPicture(p) {
    resetForm();
    editing = p.id;
    ff.title.value = p.title || '';
    ff.artist.value = p.artist?.name || '';
    ff.bio.value = p.artist?.bio || '';
    ff.links.textContent = '';
    (p.artist?.links || []).forEach(addLinkRow);
    if (!ff.links.children.length) addLinkRow();
    ff.colors.value = p.colors || 16;
    ff.detail.value = p.detail || 'medium';
    ff.date.value = p.date || '';
    if (p.thumb) { ff.preview.src = p.thumb; ff.preview.classList.remove('hidden'); }
    ff.info.textContent = 'Choose a new image only if you want to replace it.';
    ff.heading.textContent = `Editing "${p.title}"`;
    ff.save.textContent = 'Save changes';
    ff.cancel.classList.remove('hidden');
    renderFeatured();
    ff.form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  ff.file.addEventListener('change', () => {
    const f = ff.file.files[0];
    if (!f) return;
    if (f.size > 20e6) { toast('That image is over 20 MB.'); ff.file.value = ''; return; }
    const reader = new FileReader();
    reader.onload = () => {
      imageData = reader.result;
      ff.preview.src = imageData;
      ff.preview.classList.remove('hidden');
      ff.info.textContent = `${f.name} (${mb(f.size)})`;
      if (!ff.title.value) ff.title.value = f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').slice(0, 60);
    };
    reader.readAsDataURL(f);
  });
  $('#featAddLink').addEventListener('click', () => addLinkRow());
  ff.cancel.addEventListener('click', resetForm);
  ff.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!editing && !imageData) return toast('Choose an image first.');
    const links = [...ff.links.children].map((r) => {
      const [label, url] = r.querySelectorAll('input');
      return { label: label.value.trim(), url: url.value.trim() };
    }).filter((l) => l.label || l.url);
    const body = {
      id: editing || undefined, title: ff.title.value.trim(), colors: Number(ff.colors.value), detail: ff.detail.value,
      date: ff.date.value || null, image: imageData || undefined,
      artist: { name: ff.artist.value.trim(), bio: ff.bio.value.trim(), links },
    };
    ff.save.disabled = true;
    ff.busy.textContent = imageData ? 'Uploading and making the puzzle…' : 'Saving…';
    try {
      await api('featured/save', body);
      toast(editing ? 'Saved' : `Added "${body.title}"`);
      resetForm();
      load();
    } catch (err) {
      ff.busy.textContent = '';
      toast(err.message);
    } finally { ff.save.disabled = false; }
  });

  function renderFeatured() {
    const t = $('#featured');
    t.textContent = '';
    const list = featuredData.pictures;
    if (!list.length) return t.append(el('tr', {}, el('td', { class: 'stats' }, 'No featured pictures yet. Add one below.')));
    t.append(el('tr', {}, ...['', 'Picture', 'Artist', 'Shown', ''].map((h) => el('th', {}, h))));
    list.forEach((p, i) => {
      const act = (path, extra, done) => async () => {
        try { await api(path, { id: p.id, ...extra }); if (done) toast(done); load(); } catch (e) { toast(e.message); }
      };
      t.append(el('tr', { class: editing === p.id ? 'editing' : '' },
        el('td', {}, p.thumb ? el('img', { class: 'thumb', src: p.thumb, alt: '' }) : el('span', { class: 'tag bad' }, 'Image missing')),
        el('td', {}, el('b', {}, p.title || p.id), el('div', { class: 'stats' }, `${p.colors || 16} colours · ${p.detail || 'medium'} detail`)),
        el('td', {}, p.artist?.name || '—', el('div', { class: 'stats' }, `${(p.artist?.links || []).length} link${(p.artist?.links || []).length === 1 ? '' : 's'}`)),
        el('td', {}, featuredData.today === p.id ? el('span', { class: 'tag' }, 'Today') : null,
          p.date ? el('div', { class: 'stats' }, 'Pinned to ' + p.date) : el('div', { class: 'stats' }, 'In rotation')),
        el('td', {}, el('div', { class: 'actions' },
          el('button', { class: 'btn small', title: 'Move up', disabled: i === 0 ? '' : null, onclick: act('featured/move', { delta: -1 }) }, '↑'),
          el('button', { class: 'btn small', title: 'Move down', disabled: i === list.length - 1 ? '' : null, onclick: act('featured/move', { delta: 1 }) }, '↓'),
          el('button', { class: 'btn small', onclick: () => editPicture(p) }, 'Edit'),
          el('button', { class: 'btn small', onclick: () => {
            if (confirm(`Remove "${p.title}" from the featured pictures? People painting it now can finish.`)) act('featured/delete', {}, `Removed "${p.title}"`)();
          } }, 'Delete')))));
    });
  }

  // ----- players' pictures -----
  const previews = new Map(); // room id -> blob URL (the preview needs the admin token, so no plain <img src>)
  function previewImg(id) {
    const img = el('img', { class: 'thumb', alt: '' });
    if (previews.has(id)) img.src = previews.get(id);
    else {
      fetch('/api/admin/pictures/preview/' + id, { headers: { Authorization: 'Bearer ' + token } })
        .then((r) => (r.ok ? r.blob() : null)).then((b) => {
          if (!b) return;
          previews.set(id, URL.createObjectURL(b));
          img.src = previews.get(id);
        }).catch(() => {});
    }
    return img;
  }

  function renderPictures(list) {
    const t = $('#pictures');
    t.textContent = '';
    if (!list.length) return t.append(el('tr', {}, el('td', { class: 'stats' }, 'Nobody has uploaded a picture yet.')));
    t.append(el('tr', {}, ...['', 'Picture', 'By', 'Size', 'Progress', ''].map((h) => el('th', {}, h))));
    for (const p of list) {
      t.append(el('tr', {},
        el('td', {}, previewImg(p.id)),
        el('td', {}, el('b', {}, p.title), el('div', { class: 'stats' }, `${new Date(p.createdAt).toLocaleString()} · code ${p.id}`)),
        el('td', {}, p.owner, el('div', { class: 'stats' }, 'code ' + p.ownerCode)),
        el('td', {}, mb(p.bytes)),
        el('td', {}, Math.round(p.progress * 100) + '%', p.players ? el('div', { class: 'stats' }, `${p.players} painting now`) : null),
        el('td', {}, el('div', { class: 'actions' }, el('button', { class: 'btn small', onclick: async () => {
          if (!confirm(`Delete "${p.title}" by ${p.owner}? This can't be undone.`)) return;
          try { await api('pictures/delete', { roomId: p.id }); toast(`Deleted "${p.title}"`); load(); } catch (e) { toast(e.message); }
        } }, 'Delete')))));
    }
  }

  async function load() {
    try {
      const [users, feat, pics] = await Promise.all([api('users'), api('featured'), api('pictures')]);
      render(users);
      featuredData = feat;
      renderFeatured();
      renderPictures(pics.pictures);
      $('#login').classList.add('hidden');
      $('#panel').classList.remove('hidden');
      $('#signOut').classList.remove('hidden');
      $('#msg').textContent = '';
    } catch (e) {
      $('#panel').classList.add('hidden');
      $('#login').classList.toggle('hidden', e.status === 503);
      $('#msg').textContent = token || e.status === 503 ? e.message : '';
    }
  }

  $('#login').addEventListener('submit', (e) => {
    e.preventDefault();
    token = $('#token').value.trim();
    try { sessionStorage.setItem('pt.admin', token); } catch { /* storage blocked */ }
    load();
  });
  $('#signOut').addEventListener('click', () => {
    token = '';
    try { sessionStorage.removeItem('pt.admin'); } catch { /* storage blocked */ }
    $('#signOut').classList.add('hidden');
    load();
  });
  resetForm();
  load();
  setInterval(() => { if (token && !document.hidden) load(); }, 30000);
})();
