/* Hello Beaches — beach ratings.
   A visitor's own rating is always kept on this device. When the site is connected to Supabase
   (config.js), ratings are shared too and everyone sees the average. Database side: supabase/setup.sql. */
(function () {
  'use strict';

  const backend = window.HelloBeachesBackend || { enabled: false };
  const SHARED = !!backend.enabled;
  const MINE_KEY = 'beaches:myratings';
  const VOTER_KEY = 'beaches:voter';
  const ID_RE = /^(node|way|relation)\/\d{1,15}$/;
  const summaryCache = new Map();   // beach id -> { avg, votes } or null (no ratings yet)

  function readMine() {
    try { const o = JSON.parse(localStorage.getItem(MINE_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; }
    catch (e) { return {}; }
  }
  function writeMine(o) { try { localStorage.setItem(MINE_KEY, JSON.stringify(o)); } catch (e) { /* storage off */ } }

  function randomUuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  // An anonymous id for this browser, so changing your mind replaces your rating instead of adding one.
  function voterId() {
    let id = null;
    try { id = localStorage.getItem(VOTER_KEY); } catch (e) { /* storage off */ }
    if (id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id;
    id = randomUuid();
    try { localStorage.setItem(VOTER_KEY, id); } catch (e) { /* storage off */ }
    return id;
  }

  const toSummary = (row) => (row && Number(row.votes) > 0 ? { avg: Number(row.avg_stars), votes: Number(row.votes) } : null);

  function mine(id) {
    const r = readMine()[id];
    return r && r.stars >= 1 && r.stars <= 5 ? r.stars : null;
  }

  // Averages for many beaches at once. Resolves to a Map of id -> { avg, votes } for rated beaches.
  async function summaries(ids) {
    const out = new Map();
    if (!SHARED) return out;
    const want = Array.from(new Set(ids.filter((id) => ID_RE.test(id))));
    const missing = want.filter((id) => !summaryCache.has(id));
    for (let i = 0; i < missing.length; i += 200) {
      const chunk = missing.slice(i, i + 200);
      const rows = await backend.rpc('beach_rating_summary', { p_beaches: chunk });
      for (const id of chunk) summaryCache.set(id, null);
      for (const row of Array.isArray(rows) ? rows : []) summaryCache.set(row.beach_id, toSummary(row));
    }
    for (const id of want) { const s = summaryCache.get(id); if (s) out.set(id, s); }
    return out;
  }

  // Saves locally first, then shares. Resolves to { shared, summary }; rejects only if sharing failed.
  async function rate(id, stars) {
    if (!ID_RE.test(id) || !(stars >= 1 && stars <= 5)) throw new Error('Invalid rating');
    const all = readMine();
    all[id] = { stars, at: Date.now() };
    writeMine(all);
    if (!SHARED) return { shared: false, summary: null };
    const rows = await backend.rpc('rate_beach', { p_beach: id, p_voter: voterId(), p_stars: stars });
    const summary = toSummary(Array.isArray(rows) ? rows[0] : rows);
    summaryCache.set(id, summary);
    return { shared: true, summary };
  }

  window.HelloBeachesRatings = {
    shared: SHARED,
    mine,
    rate,
    summaries,
    cached: (id) => summaryCache.get(id) || null,
  };
})();
