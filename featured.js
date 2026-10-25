// Featured pictures: reads featured.json, turns each image into a puzzle on the server (cached on disk),
// picks the Picture of the day, and lets the admin page add, edit, reorder and remove pictures.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const PBN = require('./public/pbn.js');

const GENERATOR_VERSION = 2;
const IMAGE_EXT = /\.(png|jpe?g|webp|svg|gif)$/i;

function createFeatured({ dir, cacheDir }) {
  const manifestFile = path.join(dir, 'featured.json');
  fs.mkdirSync(cacheDir, { recursive: true });
  let pictures = [];
  let loadedMtime = 0;
  const puzzles = new Map(); // id -> Promise<puzzle>

  const cleanLink = (l) => (l && typeof l.url === 'string' && /^https:\/\/[^\s"<>]+$/i.test(l.url)
    ? { label: String(l.label || 'Link').slice(0, 30), url: l.url } : null);

  // a manifest entry as the rest of the app uses it, or null if it's unusable
  function normalize(p) {
    const id = String(p.id || '').toLowerCase();
    const file = path.resolve(dir, String(p.image || ''));
    if (!/^[a-z0-9-]{1,40}$/.test(id)) return null;
    if (!file.startsWith(dir + path.sep) || !IMAGE_EXT.test(file) || !fs.existsSync(file)) return null;
    const a = p.artist || {};
    return {
      id,
      title: String(p.title || id).slice(0, 60),
      file,
      image: '/featured/' + path.relative(dir, file).split(path.sep).map(encodeURIComponent).join('/'),
      colors: Math.max(4, Math.min(30, p.colors | 0 || 16)),
      detail: PBN.DETAIL[p.detail] ? p.detail : 'medium',
      date: /^\d{4}-\d{2}-\d{2}$/.test(p.date || '') ? p.date : null,
      artist: {
        name: String(a.name || 'Unknown artist').slice(0, 60),
        bio: String(a.bio || '').slice(0, 400),
        links: (Array.isArray(a.links) ? a.links : []).map(cleanLink).filter(Boolean).slice(0, 6),
      },
    };
  }

  function readManifest() {
    try { return JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { return { pictures: [] }; }
  }

  function reload() {
    let stat;
    try { stat = fs.statSync(manifestFile); } catch { pictures = []; return; }
    if (stat.mtimeMs === loadedMtime) return;
    loadedMtime = stat.mtimeMs;
    let data;
    try { data = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (e) {
      console.error('featured.json is not valid JSON:', e.message);
      return;
    }
    const seen = new Set();
    pictures = (data.pictures || []).map((p) => {
      const n = normalize(p);
      if (!n || seen.has(n.id)) return console.error('featured: skipping bad entry', p.id, p.image);
      seen.add(n.id);
      return n;
    }).filter(Boolean);
    puzzles.clear();
    console.log(`Loaded ${pictures.length} featured pictures`);
  }

  function writeManifest(data) {
    const tmp = manifestFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, manifestFile);
    loadedMtime = 0;
    reload();
  }

  function list() { reload(); return pictures; }
  function get(id) { return list().find((p) => p.id === id) || null; }

  // UTC date; an entry pinned to today wins, otherwise rotate by day number
  function pictureOfDay(now = new Date()) {
    const all = list();
    if (!all.length) return null;
    const today = now.toISOString().slice(0, 10);
    const pinned = all.find((p) => p.date === today);
    if (pinned) return { date: today, picture: pinned };
    const unpinned = all.filter((p) => !p.date);
    const pool = unpinned.length ? unpinned : all;
    const day = Math.floor(now.getTime() / 86400000);
    return { date: today, picture: pool[day % pool.length] };
  }

  async function build(p) {
    const bytes = fs.readFileSync(p.file);
    const key = crypto.createHash('sha1').update(bytes)
      .update(JSON.stringify([GENERATOR_VERSION, p.colors, p.detail])).digest('hex').slice(0, 16);
    const ref = `${p.id}-${key}.json`;
    const cacheFile = path.join(cacheDir, ref);
    try { return { ref, puzzle: loadRef(ref) }; } catch { /* not cached yet */ }

    const meta = await sharp(bytes, { density: 144 }).metadata();
    const fit = PBN.fitSize(meta.width, meta.height);
    const { data, info } = await sharp(bytes, { density: 144 })
      .resize(fit.w, fit.h, { fit: 'fill' })
      .flatten({ background: '#ffffff' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const g = PBN.generate({ data, width: info.width, height: info.height },
      PBN.optionsFor(p.detail, info.width, info.height, p.colors));
    const jpeg = await sharp(bytes, { density: 144 }).resize(960, 960, { fit: 'inside' })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 78 }).toBuffer();
    const puzzle = {
      w: g.w, h: g.h, palette: g.palette,
      regions: g.regions.map((r) => ({ c: r.c, x: r.x, y: r.y, r: r.r })),
      rle: PBN.encodeRLE(g.regionMap),
      preview: 'data:image/jpeg;base64,' + jpeg.toString('base64'),
    };
    fs.writeFileSync(cacheFile, JSON.stringify(puzzle));
    loaded.set(ref, puzzle);
    return { ref, puzzle };
  }

  // Rooms of featured pictures point at the cached puzzle instead of storing their own copy.
  // Don't delete featured-cache files while rooms still use them.
  const loaded = new Map();
  function loadRef(ref) {
    if (!/^[a-z0-9-]+-[0-9a-f]{16}\.json$/.test(ref)) throw new Error('bad puzzle ref');
    if (!loaded.has(ref)) loaded.set(ref, JSON.parse(fs.readFileSync(path.join(cacheDir, ref), 'utf8')));
    return loaded.get(ref);
  }

  function puzzleFor(p) {
    if (!puzzles.has(p.id)) {
      const job = build(p);
      job.catch((e) => { console.error('featured: could not build', p.id, e.message); puzzles.delete(p.id); });
      puzzles.set(p.id, job);
    }
    return puzzles.get(p.id);
  }

  // small JPEG for the home page gallery (the puzzle's preview), so big originals never go to players
  async function thumbnail(p) {
    const { puzzle } = await puzzleFor(p);
    return Buffer.from(String(puzzle.preview || '').split(',')[1] || '', 'base64');
  }

  // ----- admin editing -----
  const FORMAT_EXT = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif', svg: 'svg' };
  const removeArtFile = (rel) => {
    const f = path.resolve(dir, rel || '');
    if (f.startsWith(path.join(dir, 'art') + path.sep)) fs.rm(f, { force: true }, () => {});
  };

  // Create (no input.id) or update a featured picture. image is the uploaded file's bytes, or null to keep it.
  async function save(input, image) {
    const data = readManifest();
    data.pictures = data.pictures || [];
    const existing = input.id ? data.pictures.find((p) => p.id === input.id) : null;
    if (input.id && !existing) throw new Error('That featured picture no longer exists.');
    if (!existing && !image) throw new Error('Choose an image.');
    const title = String(input.title || '').trim().slice(0, 60);
    if (!title) throw new Error('Give the picture a title.');
    const a = input.artist || {};
    const artistName = String(a.name || '').trim().slice(0, 60);
    if (!artistName) throw new Error("Add the artist's name.");
    const links = (Array.isArray(a.links) ? a.links : []).filter((l) => l && (l.url || l.label));
    for (const l of links) {
      if (!cleanLink(l)) throw new Error(`Links must start with https:// (check "${String(l.label || l.url).slice(0, 40)}").`);
    }
    const date = input.date ? String(input.date) : null;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Pick a valid date.');

    let id = existing && existing.id;
    if (!id) {
      const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'picture';
      id = base;
      while (data.pictures.some((p) => p.id === id)) id = `${base}-${crypto.randomBytes(2).toString('hex')}`;
    }

    let imageRel = existing && existing.image;
    let written = null;
    if (image) {
      let meta;
      try { meta = await sharp(image, { density: 144 }).metadata(); } catch { throw new Error("That file isn't an image the server can read."); }
      const ext = FORMAT_EXT[meta.format];
      if (!ext) throw new Error('Use a PNG, JPEG, WebP, GIF or SVG image.');
      fs.mkdirSync(path.join(dir, 'art'), { recursive: true });
      imageRel = `art/${id}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
      written = path.join(dir, imageRel);
      fs.writeFileSync(written, image);
    }

    const entry = {
      id, title, image: imageRel,
      colors: Math.max(4, Math.min(30, Number(input.colors) || 16)),
      detail: PBN.DETAIL[input.detail] ? input.detail : 'medium',
      ...(date ? { date } : {}),
      artist: { name: artistName, bio: String(a.bio || '').trim().slice(0, 400), links: links.map(cleanLink).slice(0, 6) },
    };
    // make sure the picture actually converts before publishing it
    try { await build(normalize(entry)); } catch (e) {
      if (written) fs.rm(written, { force: true }, () => {});
      throw new Error('Could not turn that image into a puzzle: ' + e.message);
    }
    if (date) for (const p of data.pictures) if (p.date === date && p.id !== id) delete p.date; // one picture per day
    if (existing) Object.keys(existing).forEach((k) => delete existing[k]);
    if (existing) Object.assign(existing, entry); else data.pictures.push(entry);
    writeManifest(data);
    if (written && existing && imageRel !== input.previousImage) removeArtFile(input.previousImage);
    return id;
  }

  function remove(id) {
    const data = readManifest();
    const p = (data.pictures || []).find((x) => x.id === id);
    if (!p) throw new Error('That featured picture no longer exists.');
    data.pictures = data.pictures.filter((x) => x !== p);
    writeManifest(data);
    removeArtFile(p.image);
  }

  function move(id, delta) {
    const data = readManifest();
    const list = data.pictures || [];
    const i = list.findIndex((x) => x.id === id), j = i + (delta < 0 ? -1 : 1);
    if (i < 0) throw new Error('That featured picture no longer exists.');
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    writeManifest(data);
  }

  // warm the cache so the first player doesn't wait
  async function warm() {
    for (const p of list()) await puzzleFor(p).catch(() => {});
  }

  return { list, get, pictureOfDay, puzzleFor, loadRef, warm, thumbnail, save, remove, move, readManifest, dir };
}

module.exports = { createFeatured };
