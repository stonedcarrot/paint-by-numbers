// Paint-by-numbers generator: turns an image into numbered colour regions.
// Pipeline: blur -> k-means colour quantisation (in Lab space) -> mode-filter smoothing
// -> connected regions -> merge tiny regions -> pick a label spot inside each region.
// Works in the browser (window / worker) and in Node (module.exports).
(function (global) {
  'use strict';

  const LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  const labF = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

  function rgbToLab(r, g, b, out, o) {
    const R = LIN[r], G = LIN[g], B = LIN[b];
    const x = labF((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
    const y = labF(R * 0.2126 + G * 0.7152 + B * 0.0722);
    const z = labF((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
    out[o] = 116 * y - 16;
    out[o + 1] = 500 * (x - y);
    out[o + 2] = 200 * (y - z);
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // RGBA (any alpha) -> RGB composited on white
  function toRgb(rgba, n) {
    const rgb = new Uint8ClampedArray(n * 3);
    for (let i = 0; i < n; i++) {
      const a = rgba[i * 4 + 3] / 255;
      for (let c = 0; c < 3; c++) rgb[i * 3 + c] = rgba[i * 4 + c] * a + 255 * (1 - a);
    }
    return rgb;
  }

  function boxBlur(rgb, w, h, radius) {
    if (radius <= 0) return rgb;
    const tmp = new Float32Array(rgb.length);
    const out = new Uint8ClampedArray(rgb.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const i = (y * w + xx) * 3;
          r += rgb[i]; g += rgb[i + 1]; b += rgb[i + 2]; n++;
        }
        const o = (y * w + x) * 3;
        tmp[o] = r / n; tmp[o + 1] = g / n; tmp[o + 2] = b / n;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          const i = (yy * w + x) * 3;
          r += tmp[i]; g += tmp[i + 1]; b += tmp[i + 2]; n++;
        }
        const o = (y * w + x) * 3;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
      }
    }
    return out;
  }

  function kmeans(lab, n, k, rand) {
    const sampleN = Math.min(n, 20000);
    const sample = new Int32Array(sampleN);
    for (let i = 0; i < sampleN; i++) sample[i] = sampleN === n ? i : Math.floor(rand() * n);

    // k-means++ initialisation
    const centers = new Float32Array(k * 3);
    const d2 = new Float32Array(sampleN).fill(Infinity);
    let first = sample[Math.floor(rand() * sampleN)];
    centers.set(lab.subarray(first * 3, first * 3 + 3), 0);
    for (let c = 1; c < k; c++) {
      let sum = 0;
      for (let s = 0; s < sampleN; s++) {
        const p = sample[s] * 3, q = (c - 1) * 3;
        const dl = lab[p] - centers[q], da = lab[p + 1] - centers[q + 1], db = lab[p + 2] - centers[q + 2];
        const d = dl * dl + da * da + db * db;
        if (d < d2[s]) d2[s] = d;
        sum += d2[s];
      }
      let target = rand() * sum, pick = sampleN - 1;
      for (let s = 0; s < sampleN; s++) { target -= d2[s]; if (target <= 0) { pick = s; break; } }
      centers.set(lab.subarray(sample[pick] * 3, sample[pick] * 3 + 3), c * 3);
    }

    const nearest = (p) => {
      let best = 0, bestD = Infinity;
      for (let c = 0; c < k; c++) {
        const q = c * 3;
        const dl = lab[p] - centers[q], da = lab[p + 1] - centers[q + 1], db = lab[p + 2] - centers[q + 2];
        const d = dl * dl + da * da + db * db;
        if (d < bestD) { bestD = d; best = c; }
      }
      return best;
    };

    const sums = new Float64Array(k * 4);
    for (let iter = 0; iter < 25; iter++) {
      sums.fill(0);
      for (let s = 0; s < sampleN; s++) {
        const p = sample[s] * 3, c = nearest(p) * 4;
        sums[c] += lab[p]; sums[c + 1] += lab[p + 1]; sums[c + 2] += lab[p + 2]; sums[c + 3]++;
      }
      let moved = 0;
      for (let c = 0; c < k; c++) {
        const cnt = sums[c * 4 + 3];
        if (!cnt) continue;
        for (let j = 0; j < 3; j++) {
          const v = sums[c * 4 + j] / cnt;
          moved += Math.abs(v - centers[c * 3 + j]);
          centers[c * 3 + j] = v;
        }
      }
      if (moved < 0.05 * k) break;
    }

    const labels = new Uint8Array(n);
    for (let i = 0; i < n; i++) labels[i] = nearest(i * 3);
    return labels;
  }

  // Replace each pixel's colour with the most common colour around it.
  function modeFilter(labels, w, h, k, iterations) {
    let src = labels;
    const counts = new Int32Array(k);
    for (let it = 0; it < iterations; it++) {
      const dst = new Uint8Array(src.length);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const own = src[y * w + x];
          let best = own, bestN = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= w) continue;
              counts[src[yy * w + xx]]++;
            }
          }
          bestN = counts[own];
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= w) continue;
              const l = src[yy * w + xx];
              if (counts[l] > bestN) { bestN = counts[l]; best = l; }
            }
          }
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= w) continue;
              counts[src[yy * w + xx]] = 0;
            }
          }
          dst[y * w + x] = best;
        }
      }
      src = dst;
    }
    return src;
  }

  // 4-connected regions of equal colour.
  function components(labels, w, h) {
    const n = w * h;
    const map = new Int32Array(n).fill(-1);
    const sizes = [];
    const colors = [];
    const stack = new Int32Array(n);
    for (let start = 0; start < n; start++) {
      if (map[start] !== -1) continue;
      const id = sizes.length, col = labels[start];
      let sp = 0, size = 0;
      stack[sp++] = start; map[start] = id;
      while (sp) {
        const p = stack[--sp]; size++;
        const x = p % w;
        if (x > 0 && map[p - 1] === -1 && labels[p - 1] === col) { map[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && map[p + 1] === -1 && labels[p + 1] === col) { map[p + 1] = id; stack[sp++] = p + 1; }
        if (p >= w && map[p - w] === -1 && labels[p - w] === col) { map[p - w] = id; stack[sp++] = p - w; }
        if (p < n - w && map[p + w] === -1 && labels[p + w] === col) { map[p + w] = id; stack[sp++] = p + w; }
      }
      sizes.push(size); colors.push(col);
    }
    return { map, sizes, colors };
  }

  // Recolour the given regions to the colour each shares the longest border with. Returns true if any changed.
  function recolorRegions(labels, w, h, k, map, sizes, targets) {
    const n = w * h;
    const nb = new Int32Array(k);
    // bucket pixels by region
    const start = new Int32Array(sizes.length + 1);
    for (let r = 0; r < sizes.length; r++) start[r + 1] = start[r] + sizes[r];
    const fill = start.slice(0, sizes.length);
    const pix = new Int32Array(n);
    for (let p = 0; p < n; p++) pix[fill[map[p]]++] = p;
    let changed = false;
    for (const r of targets) {
      nb.fill(0);
      const own = labels[pix[start[r]]];
      for (let i = start[r]; i < start[r + 1]; i++) {
        const p = pix[i], x = p % w;
        if (x > 0 && map[p - 1] !== r) nb[labels[p - 1]]++;
        if (x < w - 1 && map[p + 1] !== r) nb[labels[p + 1]]++;
        if (p >= w && map[p - w] !== r) nb[labels[p - w]]++;
        if (p < n - w && map[p + w] !== r) nb[labels[p + w]]++;
      }
      let best = -1, bestN = 0;
      for (let c = 0; c < k; c++) if (c !== own && nb[c] > bestN) { bestN = nb[c]; best = c; }
      if (best < 0) continue;
      for (let i = start[r]; i < start[r + 1]; i++) labels[pix[i]] = best;
      changed = true;
    }
    return changed;
  }

  // Recolour regions smaller than minSize pixels.
  function mergeSmall(labels, w, h, k, minSize) {
    for (let pass = 0; pass < 30; pass++) {
      const { map, sizes } = components(labels, w, h);
      const small = [];
      for (let r = 0; r < sizes.length; r++) if (sizes[r] < minSize) small.push(r);
      if (!small.length || sizes.length === 1) return;
      small.sort((a, b) => sizes[a] - sizes[b]);
      if (!recolorRegions(labels, w, h, k, map, sizes, small)) return;
    }
  }

  // Recolour slivers: regions too narrow to hold a number (often the soft edge between two colours), which
  // would otherwise show up as doubled outlines in large pictures.
  function mergeThin(labels, w, h, k, minThickness) {
    for (let pass = 0; pass < 6; pass++) {
      const { map, sizes } = components(labels, w, h);
      if (sizes.length === 1) return;
      const spots = labelSpots(map, w, h, sizes.length);
      const thin = [];
      for (let r = 0; r < sizes.length; r++) if (spots[r].r < minThickness) thin.push(r);
      if (!thin.length) return;
      thin.sort((a, b) => sizes[a] - sizes[b]);
      if (!recolorRegions(labels, w, h, k, map, sizes, thin)) return;
    }
  }

  // For each region, the pixel farthest from its border (where the number goes).
  function labelSpots(map, w, h, count) {
    const n = w * h;
    const dist = new Float32Array(n);
    for (let p = 0; p < n; p++) {
      const x = p % w, y = (p / w) | 0, r = map[p];
      const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
        map[p - 1] !== r || map[p + 1] !== r || map[p - w] !== r || map[p + w] !== r;
      dist[p] = edge ? 1 : 1e9;
    }
    const D = Math.SQRT2;
    for (let y = 1; y < h; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x, r = map[p];
        let d = dist[p];
        if (map[p - 1] === r && dist[p - 1] + 1 < d) d = dist[p - 1] + 1;
        if (map[p - w] === r && dist[p - w] + 1 < d) d = dist[p - w] + 1;
        if (map[p - w - 1] === r && dist[p - w - 1] + D < d) d = dist[p - w - 1] + D;
        if (map[p - w + 1] === r && dist[p - w + 1] + D < d) d = dist[p - w + 1] + D;
        dist[p] = d;
      }
    }
    for (let y = h - 2; y >= 0; y--) {
      for (let x = w - 2; x >= 1; x--) {
        const p = y * w + x, r = map[p];
        let d = dist[p];
        if (map[p + 1] === r && dist[p + 1] + 1 < d) d = dist[p + 1] + 1;
        if (map[p + w] === r && dist[p + w] + 1 < d) d = dist[p + w] + 1;
        if (map[p + w + 1] === r && dist[p + w + 1] + D < d) d = dist[p + w + 1] + D;
        if (map[p + w - 1] === r && dist[p + w - 1] + D < d) d = dist[p + w - 1] + D;
        dist[p] = d;
      }
    }
    const best = new Float32Array(count).fill(-1);
    const at = new Int32Array(count);
    for (let p = 0; p < n; p++) {
      const r = map[p];
      if (dist[p] > best[r]) { best[r] = dist[p]; at[r] = p; }
    }
    const spots = [];
    for (let r = 0; r < count; r++) {
      spots.push({ x: (at[r] % w) + 0.5, y: ((at[r] / w) | 0) + 0.5, r: Math.round(best[r] * 10) / 10 });
    }
    return spots;
  }

  const hex = (v) => Math.round(v).toString(16).padStart(2, '0');

  /**
   * imageData: {data: RGBA array, width, height} (already resized to the puzzle size)
   * opts: {colors: 4..40, smoothing: 0..4, minRegion: pixels, maxRegions, seed}
   */
  function generate(imageData, opts) {
    const w = imageData.width, h = imageData.height, n = w * h;
    const k = Math.max(2, Math.min(40, opts.colors | 0 || 12));
    const rand = mulberry32(opts.seed || 12345);

    const rgb = boxBlur(toRgb(imageData.data, n), w, h, opts.blur == null ? 1 : opts.blur);
    const lab = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) rgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2], lab, i * 3);

    let labels = kmeans(lab, n, k, rand);
    labels = modeFilter(labels, w, h, k, opts.smoothing == null ? 2 : opts.smoothing);

    let minSize = Math.max(4, opts.minRegion || Math.round(n / 2500));
    const maxRegions = opts.maxRegions || 4000;
    mergeSmall(labels, w, h, k, minSize);
    if (opts.minThickness) {
      mergeThin(labels, w, h, k, opts.minThickness);
      mergeSmall(labels, w, h, k, minSize);
    }
    let comp = components(labels, w, h);
    while (comp.sizes.length > maxRegions && minSize < n) {
      minSize = Math.ceil(minSize * 1.5);
      mergeSmall(labels, w, h, k, minSize);
      comp = components(labels, w, h);
    }

    // palette: average original colour of each cluster, numbered by how much area it covers
    const acc = new Float64Array(k * 4);
    const orig = toRgb(imageData.data, n);
    for (let i = 0; i < n; i++) {
      const c = labels[i] * 4;
      acc[c] += orig[i * 3]; acc[c + 1] += orig[i * 3 + 1]; acc[c + 2] += orig[i * 3 + 2]; acc[c + 3]++;
    }
    const used = [];
    for (let c = 0; c < k; c++) if (acc[c * 4 + 3] > 0) used.push(c);
    used.sort((a, b) => acc[b * 4 + 3] - acc[a * 4 + 3]);
    const remap = new Int32Array(k).fill(-1);
    const palette = used.map((c, i) => {
      remap[c] = i;
      const cnt = acc[c * 4 + 3];
      return '#' + hex(acc[c * 4] / cnt) + hex(acc[c * 4 + 1] / cnt) + hex(acc[c * 4 + 2] / cnt);
    });

    const spots = labelSpots(comp.map, w, h, comp.sizes.length);
    const regions = comp.sizes.map((size, r) => ({
      c: remap[comp.colors[r]], x: spots[r].x, y: spots[r].y, r: spots[r].r, size,
    }));
    return { w, h, palette, regions, regionMap: comp.map };
  }

  // Run-length encoding for the region map: [value, count, value, count, ...]
  function encodeRLE(arr) {
    const out = [];
    let i = 0;
    while (i < arr.length) {
      const v = arr[i];
      let j = i + 1;
      while (j < arr.length && arr[j] === v) j++;
      out.push(v, j - i);
      i = j;
    }
    return out;
  }

  function decodeRLE(rle, n) {
    const out = new Int32Array(n);
    let p = 0;
    for (let i = 0; i + 1 < rle.length; i += 2) {
      const v = rle[i], c = rle[i + 1];
      if (!Number.isInteger(c) || c <= 0 || p + c > n) throw new Error('bad RLE');
      out.fill(v, p, p + c);
      p += c;
    }
    if (p !== n) throw new Error('bad RLE length');
    return out;
  }

  // Pictures are painted at their native size, shrunk only to fit Full HD (1920x1080, either orientation).
  const MAX_LONG = 1920, MAX_SHORT = 1080;
  function fitSize(w, h) {
    const s = Math.min(1, MAX_LONG / Math.max(w, h), MAX_SHORT / Math.min(w, h));
    return { w: Math.max(8, Math.round(w * s)), h: Math.max(8, Math.round(h * s)) };
  }

  // "detail" presets: the smallest region is pixels / minDiv, so the number of regions stays about the same
  // whatever the resolution; larger pictures just get smoother edges.
  const DETAIL = {
    low: { minDiv: 700, smoothing: 3 },
    medium: { minDiv: 1600, smoothing: 2 },
    high: { minDiv: 3500, smoothing: 2 },
    max: { minDiv: 8000, smoothing: 1 },
  };
  function optionsFor(detail, w, h, colors) {
    const d = DETAIL[detail] || DETAIL.medium;
    const scale = Math.max(w, h) / 400; // the presets were tuned at about 400px
    return {
      colors,
      blur: Math.max(1, Math.round(scale * 0.75)),
      smoothing: d.smoothing + (scale > 2.5 ? 1 : 0),
      minThickness: Math.max(1.5, scale * 0.7),
      minRegion: Math.max(4, Math.round(w * h / d.minDiv)),
    };
  }

  const api = { generate, encodeRLE, decodeRLE, components, DETAIL, fitSize, optionsFor, MAX_LONG, MAX_SHORT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.PBN = api;
})(typeof self !== 'undefined' ? self : this);
