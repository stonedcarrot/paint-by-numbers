// Admin page: review storage requests and set players' storage limits.
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

  async function load() {
    try {
      render(await api('users'));
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
  load();
  setInterval(() => { if (token && !document.hidden) load(); }, 30000);
})();
