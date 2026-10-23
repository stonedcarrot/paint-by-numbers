// Runs the paint-by-numbers generator off the main thread.
importScripts('/pbn.js');
self.onmessage = (e) => {
  const { id, imageData, opts } = e.data;
  try {
    const t0 = Date.now();
    const p = self.PBN.generate(imageData, opts);
    self.postMessage({ id, ok: true, puzzle: p, ms: Date.now() - t0 }, [p.regionMap.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
