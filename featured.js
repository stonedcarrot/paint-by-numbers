// Featured pictures: reads featured/featured.json, turns each image into a puzzle on the server
// (cached on disk), and picks the Picture of the day.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const PBN = require('./public/pbn.js');

const GENERATOR_VERSION = 1;
const IMAGE_EXT = /\.(png|jpe?g|webp|svg|gif)$/i;

function createFeatured({ dir, cacheDir }) {
  const manifestFile = path.join(dir, 'featured.json');
  fs.mkdirSync(cacheDir, { recursive: true });
  let pictures = [];
  let loadedMtime = 0;
  const puzzles = new Map(); // id -> Promise<puzzle>

  const cleanLink = (l) => (l && typeof l.url === 'string' && /^https:\/\/[^\s"<>]+$/i.test(l.url)
    ? { label: String(l.label || 'Link').slice(0, 30), url: l.url } : null);

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
      const id = String(p.id || '').toLowerCase();
      const file = path.resolve(dir, String(p.image || ''));
      if (!/^[a-z0-9-]{1,40}$/.test(id) || seen.has(id)) return console.error('featured: bad or duplicate id', p.id);
      if (!file.startsWith(dir + path.sep) || !IMAGE_EXT.test(file) || !fs.existsSync(file)) {
        return console.error('featured: image not found for', id, p.image);
      }
      seen.add(id);
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
    }).filter(Boolean);
    puzzles.clear();
    console.log(`Loaded ${pictures.length} featured pictures`);
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
    const cacheFile = path.join(cacheDir, `${p.id}-${key}.json`);
    try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* not cached yet */ }

    const d = PBN.DETAIL[p.detail];
    const { data, info } = await sharp(bytes, { density: 144 })
      .resize(d.side, d.side, { fit: 'inside' })
      .flatten({ background: '#ffffff' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const g = PBN.generate({ data, width: info.width, height: info.height }, {
      colors: p.colors, smoothing: d.smoothing,
      minRegion: Math.max(4, Math.round(info.width * info.height / d.minDiv)),
    });
    const jpeg = await sharp(bytes, { density: 144 }).resize(480, 480, { fit: 'inside' })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 78 }).toBuffer();
    const puzzle = {
      w: g.w, h: g.h, palette: g.palette,
      regions: g.regions.map((r) => ({ c: r.c, x: r.x, y: r.y, r: r.r })),
      rle: PBN.encodeRLE(g.regionMap),
      preview: 'data:image/jpeg;base64,' + jpeg.toString('base64'),
    };
    fs.writeFileSync(cacheFile, JSON.stringify(puzzle));
    return puzzle;
  }

  function puzzleFor(p) {
    if (!puzzles.has(p.id)) {
      const job = build(p);
      job.catch((e) => { console.error('featured: could not build', p.id, e.message); puzzles.delete(p.id); });
      puzzles.set(p.id, job);
    }
    return puzzles.get(p.id);
  }

  // warm the cache so the first player doesn't wait
  async function warm() {
    for (const p of list()) await puzzleFor(p).catch(() => {});
  }

  return { list, get, pictureOfDay, puzzleFor, warm, dir };
}

module.exports = { createFeatured };
