/* Hello Beaches — nearby beach finder.
   Data: OpenStreetMap via Overpass (natural=beach). Geocoding: Nominatim. Map: Leaflet, drawing OpenFreeMap vector styles through MapLibre.
   Photos: OpenStreetMap links, Wikipedia, Wikimedia Commons (or Flickr), and Google as a last resort.
   Ratings: ratings.js. Google data only ever comes through the site's own Supabase function. */
(function () {
  'use strict';

  const CONFIG = window.HELLO_BEACHES_CONFIG || {};
  const BACKEND = window.HelloBeachesBackend || { enabled: false };
  const RATINGS = window.HelloBeachesRatings || null;
  const FLICKR_API_KEY = String(CONFIG.flickrApiKey || '').trim();
  const clampInt = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
  const GOOGLE_ON = CONFIG.useGoogle === true && !!BACKEND.enabled;
  const GOOGLE_PHOTO_LIMIT = clampInt(CONFIG.googlePhotoLimit, 1, 3, 2);

  const OVERPASS_MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  const NOMINATIM = 'https://nominatim.openstreetmap.org';
  const RADII_KM = [5, 10, 25, 50, 100];
  const MAX_LIST = 100;
  const MAX_MARKERS = 250;
  const REQUEST_TIMEOUT_MS = 20000;       // per request
  const HEDGE_MS = 4000;                  // ask the next mirror too if the current one is this slow
  const SAME_MIRROR_RETRIES = 2;          // Overpass answers 5xx when momentarily full; it clears in seconds
  const SAME_MIRROR_RETRY_MS = 2000;
  const DEAD_MIRROR_MS = 10 * 60 * 1000;  // skip a mirror that timed out, for this long
  const RETRY_DELAYS_MS = [3000, 8000];   // extra rounds after every mirror failed
  const STORAGE_KEY = 'beaches:last';
  const MIRROR_KEY = 'beaches:mirror';
  const CACHE_KEY = 'beaches:cache:v2';
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const CACHE_MAX = 6;
  const COMMONS = 'https://commons.wikimedia.org/w/api.php';
  const FLICKR = 'https://api.flickr.com/services/rest/';
  const FLICKR_RADIUS_M = 600;
  const FLICKR_LIMIT = 8;
  const COMMONS_RADIUS_M = 1000;
  const COMMONS_LIMIT = 30;
  const WIKI_RADIUS_M = 1000;
  const PHOTO_MAX = 10;
  const OLD_STORAGE_KEYS = ['beaches:cache', 'beaches:google:v1', 'beaches:google:budget'];

  const els = {
    locateBtn: document.getElementById('locate-btn'),
    form: document.getElementById('search-form'),
    input: document.getElementById('place-input'),
    radiusGroup: document.getElementById('radius-group'),
    radiusInputs: Array.from(document.querySelectorAll('input[name="radius"]')),
    status: document.getElementById('status'),
    empty: document.getElementById('empty'),
    tryRow: document.getElementById('try-row'),
    results: document.getElementById('results'),
  };

  const state = {
    center: null,      // { lat, lon }
    placeName: null,   // label for the centre, or null for a dropped pin
    radiusKm: 25,
    beaches: [],
    raw: null,         // last Overpass answer: { lat, lon, radiusKm, elements }
    selectedId: null,
    searchSeq: 0,
    searchNote: '',    // extra words for the busy status, e.g. while retrying
    abort: null,
  };

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Map ---------- */

  const map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([38.5, 20], 4);
  // Basemap: OpenFreeMap vector styles (free, no key, no view limits) drawn by MapLibre inside Leaflet.
  // Without WebGL, or if MapLibre fails to load, plain OpenStreetMap raster tiles take over.
  const STYLES = {
    light: 'https://tiles.openfreemap.org/styles/positron',
    dark: 'https://tiles.openfreemap.org/styles/dark',
  };
  const VECTOR_ATTRIBUTION = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
    '&copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' +
    'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
  const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
  const isDark = () => { const t = document.documentElement.getAttribute('data-theme'); return t ? t === 'dark' : darkMq.matches; };

  function webglAvailable() {
    try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); }
    catch (e) { return false; }
  }

  let vectorBase = null;
  function addRasterBase() {
    document.getElementById('map').classList.add('raster-base');
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }).addTo(map);
  }
  if (window.maplibregl && typeof L.maplibreGL === 'function' && webglAvailable()) {
    try {
      vectorBase = L.maplibreGL({ style: isDark() ? STYLES.dark : STYLES.light, attributionControl: { customAttribution: VECTOR_ATTRIBUTION } }).addTo(map);
    } catch (err) {
      console.warn('Vector map unavailable, using raster tiles:', err && err.message);
      vectorBase = null;
      addRasterBase();
    }
  } else {
    addRasterBase();
  }

  const mapEl = document.getElementById('map');
  const syncZoomClass = () => mapEl.classList.toggle('zoomed-out', map.getZoom() < 12);
  map.on('zoomend', syncZoomClass);
  syncZoomClass();

  const markersLayer = L.layerGroup().addTo(map);
  const markersById = new Map();
  let userMarker = null;
  let radiusCircle = null;

  function accentColor() {
    return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0071e3';
  }

  const UMBRELLA_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 11.4a8.5 7.9 0 0 1 17 0Z" fill="#fff"/><path d="M12 11.4v6.1a1.9 1.9 0 0 1-3.8 0" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>';

  function beachIcon(selected) {
    return L.divIcon({
      className: 'beach-pin',
      html: '<div class="beach-marker' + (selected ? ' is-selected' : '') + '">' + UMBRELLA_SVG + '</div>',
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
  }

  function userIcon() {
    return L.divIcon({ className: 'user-pin', html: '<div class="user-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
  }

  /* ---------- Geometry ---------- */

  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;

  function haversineKm(a, b) {
    const R = 6371;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function bearingDeg(a, b) {
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat), dLon = toRad(b.lon - a.lon);
    const y = Math.sin(dLon) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const compassLabel = (deg) => COMPASS[Math.round(deg / 45) % 8];

  function formatDistance(km) {
    if (km < 0.995) return Math.max(10, Math.round(km * 100) * 10) + ' m';
    if (km < 10) return km.toFixed(1) + ' km';
    return Math.round(km) + ' km';
  }

  /* ---------- Helpers ---------- */

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function describeWhere() {
    return state.placeName || 'the pin';
  }

  function directionsUrl(b) {
    return 'https://www.google.com/maps/dir/?api=1&destination=' + b.lat.toFixed(6) + ',' + b.lon.toFixed(6);
  }

  // Instagram offers no public API for place photos, so the closest link is the hashtag page.
  function instagramTag(name) {
    const slug = String(name)
      .replace(/\u0131/g, 'i').replace(/\u00df/g, 'ss')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]/g, '');
    return slug.length >= 4 ? slug : null;
  }

  function htmlToText(html) {
    return (new DOMParser().parseFromString(String(html), 'text/html').body.textContent || '').trim();
  }

  function loadStored() {
    try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function saveStored() {
    if (!state.center) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        lat: state.center.lat, lon: state.center.lon, name: state.placeName, radius: state.radiusKm,
      }));
    } catch (e) { /* storage unavailable */ }
  }
  function getPreferredMirror() { try { return localStorage.getItem(MIRROR_KEY); } catch (e) { return null; } }
  function setPreferredMirror(url) { try { localStorage.setItem(MIRROR_KEY, url); } catch (e) { /* ignore */ } }

  function setStatus(text, opts) {
    const kind = (opts && opts.kind) || 'info';
    const action = opts && opts.action;
    els.status.className = 'status' + (kind === 'error' ? ' is-error' : '');
    els.status.textContent = '';
    if (kind === 'busy') {
      const sp = document.createElement('span');
      sp.className = 'spinner';
      sp.setAttribute('aria-hidden', 'true');
      els.status.appendChild(sp);
    }
    const span = document.createElement('span');
    span.textContent = text;
    els.status.appendChild(span);
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'button button-secondary button-small';
      b.textContent = action.label;
      b.addEventListener('click', action.onClick);
      els.status.appendChild(b);
    }
  }

  function fetchWithTimeout(url, options, ms, outerSignal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException('Timed out', 'TimeoutError')), ms);
    const onOuter = () => ctrl.abort(outerSignal.reason);
    if (outerSignal) {
      if (outerSignal.aborted) onOuter();
      else outerSignal.addEventListener('abort', onOuter, { once: true });
    }
    return fetch(url, Object.assign({}, options, { signal: ctrl.signal })).finally(() => {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', onOuter);
    });
  }

  /* ---------- Beach data (Overpass) ---------- */

  function buildQuery(center, radiusM) {
    return '[out:json][timeout:25];' +
      'nwr["natural"="beach"](around:' + radiusM + ',' + center.lat.toFixed(6) + ',' + center.lon.toFixed(6) + ');' +
      'out center;';
  }

  function orderedMirrors() {
    const preferred = getPreferredMirror();
    const all = preferred && OVERPASS_MIRRORS.includes(preferred)
      ? [preferred].concat(OVERPASS_MIRRORS.filter((m) => m !== preferred))
      : OVERPASS_MIRRORS.slice();
    const alive = all.filter((m) => !isDead(m));
    return alive.length ? alive : all;
  }

  async function fetchFromMirror(url, query, signal) {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
    }, REQUEST_TIMEOUT_MS, signal);
    if (!res.ok) {
      const err = new Error('HTTP ' + res.status + ' from ' + url);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    if (!json || !Array.isArray(json.elements)) throw new Error('Unexpected response from ' + url);
    return json.elements;
  }

  const deadMirrors = new Map();   // url -> when it last timed out
  const markDead = (url) => deadMirrors.set(url, Date.now());
  const isDead = (url) => deadMirrors.has(url) && Date.now() - deadMirrors.get(url) < DEAD_MIRROR_MS;

  // Ask the preferred mirror first; if it is silent for HEDGE_MS, ask the next one as well.
  // A mirror that answers 5xx is asked again after a short pause (Overpass says 504 while it is
  // momentarily full), a mirror that times out is skipped for a while. First good answer wins.
  function fetchBeaches(center, radiusKm, signal) {
    const query = buildQuery(center, Math.round(radiusKm * 1000));
    const mirrors = orderedMirrors();

    return new Promise((resolve, reject) => {
      const controllers = new Set();
      const timers = new Set();
      let nextMirror = 0;
      let pending = 0;
      let settled = false;
      let lastError = null;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        timers.forEach((t) => clearTimeout(t));
        signal.removeEventListener('abort', onAbort);
        controllers.forEach((c) => c.abort());
        fn(value);
      };
      const onAbort = () => finish(reject, signal.reason || new DOMException('Aborted', 'AbortError'));
      const maybeGiveUp = () => {
        if (!settled && pending === 0 && timers.size === 0 && nextMirror >= mirrors.length) {
          finish(reject, lastError || new Error('All Overpass mirrors failed'));
        }
      };
      const later = (fn, ms) => {
        const t = setTimeout(() => { timers.delete(t); fn(); maybeGiveUp(); }, ms);
        timers.add(t);
      };

      const ask = (url, tries) => {
        if (settled) return;
        const ctrl = new AbortController();
        controllers.add(ctrl);
        pending++;
        const t0 = Date.now();
        fetchFromMirror(url, query, ctrl.signal).then(
          (elements) => { setPreferredMirror(url); finish(resolve, elements); },
          (err) => {
            controllers.delete(ctrl);
            pending--;
            if (settled) return;
            lastError = err;
            const quick = Date.now() - t0 < REQUEST_TIMEOUT_MS - 500;
            console.warn('Overpass mirror failed:', url, err && err.message);
            if (quick && err && err.status >= 500 && tries < SAME_MIRROR_RETRIES) {
              later(() => ask(url, tries + 1), SAME_MIRROR_RETRY_MS);
            } else {
              if (!quick) markDead(url);
              startNext();
            }
            maybeGiveUp();
          }
        );
      };
      const startNext = () => {
        if (settled || nextMirror >= mirrors.length) return;
        ask(mirrors[nextMirror++], 0);
        if (nextMirror < mirrors.length) later(startNext, HEDGE_MS);
      };

      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
      startNext();
    });
  }

  // Keep only what the UI needs so cached answers stay small.
  const KEEP_TAGS = ['name', 'name:en', 'alt_name', 'surface', 'lifeguard', 'nudism', 'dog', 'wheelchair', 'fee', 'access',
    'image', 'wikimedia_commons', 'wikipedia', 'wikidata'];
  function slim(el) {
    const out = { type: el.type, id: el.id, tags: {} };
    if (el.type === 'node') { out.lat = el.lat; out.lon = el.lon; }
    else if (el.center) out.center = { lat: el.center.lat, lon: el.center.lon };
    const tags = el.tags || {};
    for (const k of KEEP_TAGS) if (tags[k] != null) out.tags[k] = tags[k];
    return out;
  }

  // Recent answers live in localStorage for a day, so repeat searches are instant and
  // a busy Overpass server does not take the app down with it.
  function cacheKey(center, radiusKm) { return center.lat.toFixed(3) + ',' + center.lon.toFixed(3) + ',' + radiusKm; }
  function readCache() {
    try { const raw = localStorage.getItem(CACHE_KEY); const arr = raw ? JSON.parse(raw) : []; return Array.isArray(arr) ? arr : []; }
    catch (e) { return []; }
  }
  // Any fresh entry whose circle fully covers the requested one will do; results are filtered by distance.
  function cacheGet(center, radiusKm) {
    const now = Date.now();
    const fresh = readCache().filter((e) => e && Array.isArray(e.elements) && now - e.at < CACHE_TTL_MS &&
      typeof e.lat === 'number' && typeof e.lon === 'number' && typeof e.radiusKm === 'number');
    const covering = fresh.filter((e) => haversineKm({ lat: e.lat, lon: e.lon }, center) + radiusKm <= e.radiusKm + 0.01);
    if (!covering.length) return null;
    covering.sort((a, b) => a.radiusKm - b.radiusKm);   // tightest match first
    return covering[0].elements;
  }
  function cachePut(center, radiusKm, elements) {
    const key = cacheKey(center, radiusKm);
    const now = Date.now();
    const entries = readCache().filter((e) => e && e.key !== key && now - e.at < CACHE_TTL_MS);
    entries.unshift({ key, lat: center.lat, lon: center.lon, radiusKm, at: now, elements });
    for (let n = Math.min(entries.length, CACHE_MAX); n > 0; n--) {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(entries.slice(0, n))); return; }
      catch (e) { /* over quota: keep fewer entries */ }
    }
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(t); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
      const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function fetchWithRetries(center, radiusKm, signal) {
    let attempt = 0;
    for (;;) {
      try {
        return await fetchBeaches(center, radiusKm, signal);
      } catch (err) {
        if (signal.aborted || attempt >= RETRY_DELAYS_MS.length) throw err;
        const delay = RETRY_DELAYS_MS[attempt++];
        console.warn('Every Overpass mirror failed; retrying in ' + delay + ' ms');
        state.searchNote = 'Every map data server failed once; trying again.';
        await sleep(delay, signal);
      }
    }
  }

  const SURFACE_LABELS = {
    sand: 'Sand', fine_sand: 'Fine sand', pebbles: 'Pebbles', pebblestone: 'Pebbles', gravel: 'Gravel',
    shingle: 'Shingle', rock: 'Rock', rocky: 'Rock', stone: 'Stone', shell: 'Shells', mud: 'Mud', grass: 'Grass',
  };
  const SURFACE_CLASS = {
    sand: 'chip-sand', fine_sand: 'chip-sand', shell: 'chip-sand',
    pebbles: 'chip-pebble', pebblestone: 'chip-pebble', gravel: 'chip-pebble', shingle: 'chip-pebble',
    rock: 'chip-rock', rocky: 'chip-rock', stone: 'chip-rock',
  };

  function normalize(el, center) {
    const lat = el.type === 'node' ? el.lat : el.center && el.center.lat;
    const lon = el.type === 'node' ? el.lon : el.center && el.center.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number') return null;
    const tags = el.tags || {};
    const name = tags.name || tags['name:en'] || tags.alt_name || null;
    const features = [];
    const surfaceKey = String(tags.surface || '').split(';')[0].trim().toLowerCase();
    if (surfaceKey) {
      features.push({ label: SURFACE_LABELS[surfaceKey] || cap(surfaceKey.replace(/_/g, ' ')), cls: SURFACE_CLASS[surfaceKey] || '' });
    }
    if (tags.lifeguard === 'yes') features.push({ label: 'Lifeguard', cls: '' });
    if (tags.nudism === 'yes' || tags.nudism === 'designated') features.push({ label: 'Naturist', cls: '' });
    if (tags.dog === 'no') features.push({ label: 'No dogs', cls: '' });
    else if (tags.dog === 'yes' || tags.dog === 'leashed') features.push({ label: 'Dogs ok', cls: '' });
    if (tags.wheelchair === 'yes') features.push({ label: 'Wheelchair', cls: '' });
    if (tags.fee === 'yes') features.push({ label: 'Fee', cls: '' });
    if (tags.access === 'private') features.push({ label: 'Private', cls: 'chip-warn' });
    const point = { lat, lon };
    return {
      id: el.type + '/' + el.id,
      osmType: el.type,
      osmId: el.id,
      name, lat, lon, features,
      image: tags.image || null,
      commonsFile: tags.wikimedia_commons || null,
      wikipedia: tags.wikipedia || null,
      wikidata: tags.wikidata || null,
      distanceKm: haversineKm(center, point),
      bearing: bearingDeg(center, point),
    };
  }

  /* ---------- Search flow ---------- */

  async function runSearch() {
    if (!state.center) return;
    if (state.abort) state.abort.abort();
    const ctrl = new AbortController();
    state.abort = ctrl;
    const seq = ++state.searchSeq;
    const center = state.center;
    const radiusKm = state.radiusKm;
    const where = describeWhere();
    const t0 = Date.now();
    state.searchNote = '';
    const tick = () => {
      const secs = Math.round((Date.now() - t0) / 1000);
      let text = 'Searching within ' + radiusKm + ' km of ' + where + '…';
      if (secs >= 4) text += ' ' + secs + ' s.';
      if (state.searchNote) text += ' ' + state.searchNote;
      else if (secs >= 8) text += ' The OpenStreetMap data servers are busy right now; the page itself is fine.';
      setStatus(text, { kind: 'busy' });
    };
    tick();
    const ticker = setInterval(tick, 1000);
    els.results.classList.add('is-loading');

    try {
      // A smaller radius around the same spot needs no new request: filter what we already have.
      const raw = state.raw;
      const reusable = raw && raw.lat === center.lat && raw.lon === center.lon && raw.radiusKm >= radiusKm;
      let elements;
      if (reusable) {
        elements = raw.elements;
      } else {
        const cached = cacheGet(center, radiusKm);
        if (cached) {
          elements = cached;
        } else {
          const fresh = await fetchWithRetries(center, radiusKm, ctrl.signal);
          if (seq !== state.searchSeq) return;
          elements = fresh.map(slim);
          cachePut(center, radiusKm, elements);
        }
        state.raw = { lat: center.lat, lon: center.lon, radiusKm, elements };
      }

      const seen = new Set();
      const beaches = [];
      for (const el of elements) {
        const b = normalize(el, center);
        if (!b || seen.has(b.id)) continue;
        if (b.distanceKm > radiusKm) continue;
        seen.add(b.id);
        beaches.push(b);
      }
      beaches.sort((a, b) => a.distanceKm - b.distanceKm);

      state.beaches = beaches;
      state.selectedId = null;
      renderResults();
      renderMarkers();
      fitToResults();
      loadListRatings(seq);

      const n = beaches.length;
      if (n === 0) {
        const next = RADII_KM.find((r) => r > radiusKm);
        setStatus('No beaches within ' + radiusKm + ' km of ' + where + '.',
          next ? { action: { label: 'Try ' + next + ' km', onClick: () => setRadius(next) } } : undefined);
      } else {
        setStatus(n + (n === 1 ? ' beach' : ' beaches') + ' within ' + radiusKm + ' km of ' + where +
          (n > MAX_LIST ? ', showing the ' + MAX_LIST + ' closest.' : '.'));
      }
    } catch (err) {
      if (seq !== state.searchSeq || ctrl.signal.aborted) return;
      console.error('Beach search failed:', err);
      setStatus('The beach data service didn’t answer. Check your connection and try again.',
        { kind: 'error', action: { label: 'Retry', onClick: runSearch } });
    } finally {
      clearInterval(ticker);
      if (seq === state.searchSeq) els.results.classList.remove('is-loading');
    }
  }

  function setCenter(lat, lon, label) {
    state.center = { lat, lon };
    state.placeName = label;
    state.raw = null;
    state.beaches = [];
    state.selectedId = null;
    els.empty.hidden = true;
    if (!userMarker) {
      userMarker = L.marker([lat, lon], { icon: userIcon(), zIndexOffset: 2000, interactive: false, keyboard: false }).addTo(map);
    } else {
      userMarker.setLatLng([lat, lon]);
    }
    updateCircle();
    renderResults();
    renderMarkers();
    saveStored();
    runSearch();
  }

  function updateCircle() {
    if (!state.center) return;
    const ll = [state.center.lat, state.center.lon];
    const r = state.radiusKm * 1000;
    if (!radiusCircle) {
      radiusCircle = L.circle(ll, { radius: r, color: accentColor(), weight: 1.5, dashArray: '2 6', fillOpacity: 0.06, interactive: false }).addTo(map);
    } else {
      radiusCircle.setLatLng(ll);
      radiusCircle.setRadius(r);
    }
  }

  function setRadiusControl(km) {
    for (const input of els.radiusInputs) input.checked = input.value === String(km);
  }

  function setRadius(km) {
    state.radiusKm = km;
    setRadiusControl(km);
    updateCircle();
    if (state.center) {
      saveStored();
      runSearch();
    }
  }

  /* ---------- Rendering ---------- */

  const CHEVRON_SVG = '<svg class="chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.2 1.8 8.4 6l-4.2 4.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function renderResults() {
    const frag = document.createDocumentFragment();
    state.beaches.slice(0, MAX_LIST).forEach((b, i) => {
      const li = document.createElement('li');
      li.className = 'result';
      li.dataset.id = b.id;
      const deg = Math.round(b.bearing);
      const detailId = 'beach-detail-' + i;
      li.innerHTML =
        '<button type="button" class="result-head" aria-expanded="false" aria-controls="' + detailId + '">' +
          '<span class="result-main">' +
            '<span class="result-name' + (b.name ? '' : ' is-unnamed') + '">' + (b.name ? esc(b.name) : 'Unnamed beach') + '</span>' +
            '<span class="result-sub">' +
              b.features.map((f) => '<span class="tag' + (f.cls === 'chip-warn' ? ' tag-warn' : '') + '">' + esc(f.label) + '</span>').join('') +
            '</span>' +
          '</span>' +
          '<span class="result-dist">' +
            '<span class="dist-value">' + formatDistance(b.distanceKm) + '</span>' +
            '<span class="bearing" title="Bearing ' + deg + '°">' +
              '<svg viewBox="0 0 16 16" aria-hidden="true" style="rotate:' + deg + 'deg"><path d="M8 1.5 12.5 12.5 8 10 3.5 12.5Z"/></svg>' +
              compassLabel(b.bearing) +
            '</span>' +
          '</span>' +
          CHEVRON_SVG +
        '</button>' +
        '<div class="result-detail" id="' + detailId + '" hidden></div>';
      frag.appendChild(li);
    });
    els.results.replaceChildren(frag);
  }

  /* ----- Ratings in the list ----- */

  const plural = (n, one, many) => n.toLocaleString('en') + ' ' + (n === 1 ? one : many);

  function rowRatingHtml(summary, mine) {
    const star = '<span class="star" aria-hidden="true">★</span>';
    if (summary) {
      return '<span class="rating-inline">' + star + '<span class="visually-hidden">Rated </span>' + summary.avg.toFixed(1) +
        '<span class="visually-hidden"> out of 5,</span> <span class="votes">(' + summary.votes.toLocaleString('en') + ')</span></span>';
    }
    if (mine) {
      return '<span class="rating-inline">' + star + '<span class="visually-hidden">You rated it </span>' + mine + ' <span class="votes" aria-hidden="true">(you)</span></span>';
    }
    return '';
  }

  function paintRowRating(li) {
    const sub = li && li.querySelector('.result-sub');
    if (!sub) return;
    const old = sub.querySelector('.rating-inline');
    if (old) old.remove();
    const id = li.dataset.id;
    const html = rowRatingHtml(RATINGS ? RATINGS.cached(id) : null, RATINGS ? RATINGS.mine(id) : null);
    if (html) sub.insertAdjacentHTML('afterbegin', html);
  }

  async function loadListRatings(seq) {
    if (!RATINGS) return;
    if (RATINGS.shared) {
      try { await RATINGS.summaries(state.beaches.slice(0, MAX_LIST).map((b) => b.id)); }
      catch (err) { console.warn('Ratings could not be loaded:', err && err.message); }
    }
    if (seq !== state.searchSeq) return;
    for (const li of els.results.children) paintRowRating(li);
  }

  /* ----- Map popup ----- */

  const popupPhotoById = new Map();   // beach id -> the photo shown in its popup

  function popupRatingLine(b) {
    const s = RATINGS ? RATINGS.cached(b.id) : null;
    if (s) return '<div class="popup-rating"><span class="star">★</span> ' + s.avg.toFixed(1) + ' · ' + plural(s.votes, 'rating', 'ratings') + '</div>';
    const g = googleInfoCache.get(b.id);
    if (g && typeof g.rating === 'number') return '<div class="popup-rating"><span class="star">★</span> ' + g.rating.toFixed(1) + ' on Google Maps</div>';
    return '';
  }

  function popupHtml(b, photo) {
    return '<div class="popup">' +
      (photo
        ? '<a class="popup-photo" href="' + esc(photo.page) + '" target="_blank" rel="noopener"><img src="' + esc(photo.thumb) + '" alt="' + esc(photo.title) + '"></a>' +
          (photo.kind === 'google'
            ? '<div class="popup-credit"><span>' + (photo.artist ? 'Photo: ' + esc(photo.artist) : 'Google Maps photo') + '</span>' + GOOGLE_ATTR_HTML + '</div>'
            : '')
        : '') +
      '<div class="popup-body">' +
        '<div class="popup-name">' + (b.name ? esc(b.name) : 'Unnamed beach') + '</div>' +
        '<div class="popup-dist">' + formatDistance(b.distanceKm) + ' ' + compassLabel(b.bearing) + ' of ' + esc(describeWhere()) + '</div>' +
        popupRatingLine(b) +
        '<a class="button button-primary button-small" href="' + directionsUrl(b) + '" target="_blank" rel="noopener">Directions</a>' +
      '</div>' +
    '</div>';
  }

  function refreshPopup(b) {
    const m = markersById.get(b.id);
    if (m) m.setPopupContent(popupHtml(b, popupPhotoById.get(b.id) || null));
  }

  function renderMarkers() {
    markersLayer.clearLayers();
    markersById.clear();
    for (const b of state.beaches.slice(0, MAX_MARKERS)) {
      const m = L.marker([b.lat, b.lon], { icon: beachIcon(false), title: b.name || 'Unnamed beach', riseOnHover: true, keyboard: false });
      m.bindPopup(popupHtml(b, popupPhotoById.get(b.id) || null), { closeButton: false, offset: [0, -12], minWidth: 220, maxWidth: 260 });
      m.on('click', () => select(b.id, 'map'));
      m.addTo(markersLayer);
      markersById.set(b.id, m);
    }
  }

  function fitToResults() {
    if (!state.center) return;
    if (state.beaches.length === 0) {
      if (radiusCircle) map.fitBounds(radiusCircle.getBounds(), { padding: [20, 20], animate: !reducedMotion });
      return;
    }
    const pts = [[state.center.lat, state.center.lon]];
    for (const b of state.beaches.slice(0, 30)) pts.push([b.lat, b.lon]);
    map.fitBounds(L.latLngBounds(pts), { padding: [40, 40], maxZoom: 14, animate: !reducedMotion });
  }

  /* ----- Selecting a beach ----- */

  function openDetail(b, li) {
    li.classList.add('is-selected');
    const head = li.querySelector('.result-head');
    const detail = li.querySelector('.result-detail');
    if (!head || !detail) return;
    head.setAttribute('aria-expanded', 'true');
    detail.innerHTML = detailHtml(b);
    detail.hidden = false;
    showPhotos(b, detail);
    showRatings(b, detail);
  }

  function closeDetail(li) {
    li.classList.remove('is-selected');
    const head = li.querySelector('.result-head');
    const detail = li.querySelector('.result-detail');
    if (head) head.setAttribute('aria-expanded', 'false');
    if (detail) { detail.hidden = true; detail.replaceChildren(); }
  }

  function deselect() {
    const id = state.selectedId;
    if (!id) return;
    state.selectedId = null;
    const m = markersById.get(id);
    if (m) { m.setIcon(beachIcon(false)); m.setZIndexOffset(0); m.closePopup(); }
    const li = els.results.querySelector('[data-id="' + CSS.escape(id) + '"]');
    if (li) closeDetail(li);
  }

  function select(id, source) {
    const b = state.beaches.find((x) => x.id === id);
    if (!b) return;
    if (source === 'list' && state.selectedId === id) { deselect(); return; }
    const prev = state.selectedId;
    state.selectedId = id;

    if (prev && prev !== id && markersById.has(prev)) {
      const pm = markersById.get(prev);
      pm.setIcon(beachIcon(false));
      pm.setZIndexOffset(0);
    }
    const m = markersById.get(id);
    if (m) {
      m.setIcon(beachIcon(true));
      m.setZIndexOffset(1000);
    }

    for (const li of els.results.children) {
      if (li.dataset.id === id) { if (!li.classList.contains('is-selected')) openDetail(b, li); }
      else if (li.classList.contains('is-selected')) closeDetail(li);
    }

    if (source === 'map') {
      const li = els.results.querySelector('[data-id="' + CSS.escape(id) + '"]');
      if (li) li.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
    } else {
      // Fly to the beach first, then open its popup so it lands inside the view. The listener is
      // registered after flyTo so a 'moveend' from an interrupted earlier animation cannot trigger it.
      const zoom = Math.max(map.getZoom(), 14);
      const openIt = () => { if (state.selectedId === id && markersById.get(id) === m && m) m.openPopup(); };
      if (reducedMotion) {
        map.setView([b.lat, b.lon], zoom);
        openIt();
      } else {
        map.flyTo([b.lat, b.lon], zoom, { duration: 0.6 });
        // Background tabs pause animation frames, so 'moveend' may never come; open anyway after a beat.
        let opened = false;
        const openOnce = () => { if (opened) return; opened = true; map.off('moveend', openOnce); openIt(); };
        map.once('moveend', openOnce);
        setTimeout(openOnce, 1500);
      }
    }
  }

  function detailHtml(b) {
    const wikiRef = parseWikipediaTag(b.wikipedia);
    const igTag = b.name ? instagramTag(b.name) : null;
    const labelId = 'rate-label-' + b.id.replace(/\W/g, '-');
    let starButtons = '';
    for (let n = 1; n <= 5; n++) {
      starButtons += '<button type="button" data-stars="' + n + '" aria-label="Rate ' + n + (n === 1 ? ' star' : ' stars') + '" aria-pressed="false">★</button>';
    }
    return '<div class="gallery" aria-label="Photos of this beach">' + '<div class="skeleton"></div>'.repeat(3) + '</div>' +
      '<p class="gallery-note" hidden></p>' +
      '<div class="ratings">' +
        '<div class="rating-summary" hidden></div>' +
        '<div class="rating-google" hidden></div>' +
        '<div class="rate">' +
          '<span class="rate-label" id="' + labelId + '">Rate this beach</span>' +
          '<div class="rate-stars" role="group" aria-labelledby="' + labelId + '">' + starButtons + '</div>' +
          '<p class="rate-note" aria-live="polite"></p>' +
        '</div>' +
      '</div>' +
      '<div class="actions">' +
        '<a class="button button-primary button-small" href="' + directionsUrl(b) + '" target="_blank" rel="noopener">Directions</a>' +
        '<a class="link-more" href="https://www.openstreetmap.org/' + b.osmType + '/' + b.osmId + '" target="_blank" rel="noopener">OpenStreetMap</a>' +
        (wikiRef ? '<a class="link-more" href="' + esc(wikipediaUrl(wikiRef)) + '" target="_blank" rel="noopener">Wikipedia</a>' : '') +
        (igTag ? '<a class="link-more" href="https://www.instagram.com/explore/tags/' + igTag + '/" target="_blank" rel="noopener">Instagram</a>' : '') +
      '</div>';
  }

  /* ----- Ratings in the detail card ----- */

  function starsHtml(value) {
    const pct = Math.max(0, Math.min(100, (value / 5) * 100)).toFixed(1);
    return '<span class="stars" style="--pct:' + pct + '%" aria-hidden="true">★★★★★</span>';
  }

  function paintSummary(el, s) {
    if (!el) return;
    el.innerHTML = s
      ? '<div class="rating-big">' + s.avg.toFixed(1) + '<span class="visually-hidden"> out of 5</span></div>' +
        '<div class="rating-meta">' + starsHtml(s.avg) + '<span class="rating-count">' + plural(s.votes, 'rating', 'ratings') + ' on Hello Beaches</span></div>'
      : '<p class="rating-empty">No ratings yet. Be the first.</p>';
    el.hidden = false;
  }

  function paintGoogle(el, info) {
    if (!el) return;
    const url = info.mapsUri || ('https://www.google.com/maps/place/?q=place_id:' + encodeURIComponent(info.id));
    el.innerHTML = '<strong>' + info.rating.toFixed(1) + '<span class="visually-hidden"> out of 5</span></strong>' + starsHtml(info.rating) +
      '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + plural(info.ratingCount || 0, 'review', 'reviews') + ' on Google Maps</a>' +
      GOOGLE_ATTR_HTML;
    el.hidden = false;
  }

  function paintMine(detail, stars) {
    for (const btn of detail.querySelectorAll('.rate-stars button')) {
      const n = Number(btn.dataset.stars);
      btn.classList.toggle('is-on', !!stars && n <= stars);
      btn.setAttribute('aria-pressed', String(!!stars && n === stars));
    }
  }

  function setRateNote(detail, text, isError) {
    const note = detail.querySelector('.rate-note');
    if (!note) return;
    note.textContent = text;
    note.classList.toggle('is-error', !!isError);
  }

  async function showRatings(b, detail) {
    const shared = !!(RATINGS && RATINGS.shared);
    const mine = RATINGS ? RATINGS.mine(b.id) : null;
    paintMine(detail, mine);
    setRateNote(detail, mine
      ? 'Your rating: ' + mine + ' of 5' + (shared ? '. Tap a star to change it.' : ', saved on this device.')
      : (shared ? 'Tap a star. Everyone sees the average.' : 'Your ratings are saved on this device.'));

    const alive = () => state.selectedId === b.id && detail.isConnected;
    const jobs = [];
    if (shared) {
      jobs.push(RATINGS.summaries([b.id])
        .then((m) => { if (alive()) paintSummary(detail.querySelector('.rating-summary'), m.get(b.id) || null); })
        .catch((err) => console.warn('Ratings could not be loaded:', err && err.message)));
    }
    if (GOOGLE_ON) {
      jobs.push(googleInfo(b).then((info) => {
        if (alive() && info && typeof info.rating === 'number') paintGoogle(detail.querySelector('.rating-google'), info);
      }));
    }
    await Promise.all(jobs);
    if (alive()) refreshPopup(b);
  }

  async function submitRating(li, stars) {
    if (!RATINGS || !li) return;
    const id = li.dataset.id;
    const detail = li.querySelector('.result-detail');
    if (!detail) return;
    paintMine(detail, stars);
    setRateNote(detail, RATINGS.shared ? 'Saving…' : 'Your rating: ' + stars + ' of 5, saved on this device.');
    try {
      const res = await RATINGS.rate(id, stars);
      if (res.shared && detail.isConnected) {
        setRateNote(detail, 'Thanks. Your ' + stars + '-star rating is shared.');
        paintSummary(detail.querySelector('.rating-summary'), res.summary);
      }
    } catch (err) {
      console.warn('Rating could not be shared:', err && err.message);
      const msg = String((err && err.message) || '');
      if (detail.isConnected) {
        setRateNote(detail, /Too many ratings/.test(msg) ? msg : 'Saved on this device. It couldn’t be shared right now; try again later.', true);
      }
    }
    paintRowRating(li);
    const b = state.beaches.find((x) => x.id === id);
    if (b) refreshPopup(b);
  }

  /* ---------- Photos ----------
     Order: photos the mapper linked on OpenStreetMap, then Wikipedia articles about the beach,
     then geo-tagged Wikimedia Commons files (or Flickr when a key is set), ranked by how much
     their title and categories look like a beach rather than the town behind it. */

  const photosById = new Map();   // beach id -> Promise<photo[]>

  function normText(s) {
    return String(s || '').replace(/ı/g, 'i').replace(/ß/g, 'ss')
      .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }
  const BEACH_WORDS = ['beach', 'plaj', 'kumsal', 'playa', 'praia', 'strand', 'plage', 'spiaggia', 'paralia', 'παραλια', 'пляж'];
  const SHORE_WORDS = ['sea', 'deniz', 'bay', 'koy', 'cove', 'shore', 'coast', 'kiyi', 'sahil', 'lagoon', 'lagun', 'sand', 'kum'];

  const hasWord = (text, words) => { const t = normText(text); return words.some((w) => t.includes(w)); };
  // The name without its "beach" word: "Bodrum Halk Plajı" -> "bodrum halk", "Bondi Beach" -> "bondi".
  function coreName(s) {
    return normText(s).split(/[^a-z0-9Ͱ-ϿЀ-ӿ]+/)
      .filter((t) => t && !BEACH_WORDS.some((w) => t.includes(w))).join(' ');
  }
  function nameTokens(name) { return coreName(name).split(' ').filter((t) => t.length >= 4); }

  // A beach word in the title counts most; the beach's own name least, because a beach named after
  // the town would otherwise pull in every photo of the town.
  function relevance(text, tokens) {
    const t = normText(text);
    let score = 0;
    if (BEACH_WORDS.some((w) => t.includes(w))) score += 3;
    else if (SHORE_WORDS.some((w) => t.includes(w))) score += 1;
    if (tokens.length) {
      const hits = tokens.filter((tok) => t.includes(tok)).length;
      if (hits === tokens.length) score += 2;
      else if (hits) score += 1;
    }
    return score;
  }
  // An article is about the beach if its title carries a beach word or is the beach's name.
  function wikiTitleFits(title, beachName) {
    if (hasWord(title, BEACH_WORDS)) return true;
    const core = coreName(beachName);
    return !!core && coreName(title) === core;
  }

  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
  function commonsFileName(v) { return String(v || '').replace(/^(File|Image):/i, '').replace(/_/g, ' ').trim(); }
  function commonsThumb(name) { return 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(name) + '?width=320'; }
  function commonsPage(name) { return 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(name.replace(/ /g, '_')); }

  const WIKI_LANG_RE = /^[a-z]{2,3}(-[a-z]+)?$/;
  function wikiApi(lang) { return 'https://' + lang + '.wikipedia.org/w/api.php'; }
  function wikiLangs() {
    const local = String(navigator.language || '').toLowerCase().split('-')[0];
    return local && local !== 'en' && WIKI_LANG_RE.test(local) ? ['en', local] : ['en'];
  }
  function parseWikipediaTag(v) {
    const m = /^([A-Za-z]{2,3}(?:-[A-Za-z]+)?):(.+)$/.exec(String(v || '').trim());
    if (!m || !WIKI_LANG_RE.test(m[1].toLowerCase())) return null;
    return { lang: m[1].toLowerCase(), title: m[2].trim() };
  }
  function wikipediaUrl(ref) { return 'https://' + ref.lang + '.wikipedia.org/wiki/' + encodeURIComponent(ref.title.replace(/ /g, '_')); }

  async function getJson(url) {
    const res = await fetchWithTimeout(url, {}, 15000, null);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' from ' + new URL(url).host);
    return res.json();
  }
  function pagesOf(json) { return json && json.query && json.query.pages ? Object.values(json.query.pages) : []; }

  function wikiPageToPhoto(pg) {
    if (!pg || pg.missing != null || !pg.thumbnail || !pg.thumbnail.source) return null;
    return { thumb: pg.thumbnail.source, page: pg.fullurl || '', title: 'Wikipedia: ' + pg.title, artist: '', license: '', kind: 'wikipedia' };
  }

  async function fetchWikipediaArticle(ref) {
    const params = new URLSearchParams({
      action: 'query', format: 'json', origin: '*', titles: ref.title, redirects: '1',
      prop: 'pageimages|info', piprop: 'thumbnail', pithumbsize: '320', inprop: 'url',
    });
    return wikiPageToPhoto(pagesOf(await getJson(wikiApi(ref.lang) + '?' + params.toString()))[0]);
  }

  async function fetchWikipediaNear(lang, b) {
    const params = new URLSearchParams({
      action: 'query', format: 'json', origin: '*',
      generator: 'geosearch', ggscoord: b.lat.toFixed(6) + '|' + b.lon.toFixed(6), ggsradius: String(WIKI_RADIUS_M), ggslimit: '10',
      prop: 'pageimages|info', piprop: 'thumbnail', pithumbsize: '320', inprop: 'url',
    });
    return pagesOf(await getJson(wikiApi(lang) + '?' + params.toString()))
      .filter((pg) => pg.title && wikiTitleFits(pg.title, b.name || ''))
      .sort((a, c) => (a.index || 0) - (c.index || 0))
      .map(wikiPageToPhoto).filter(Boolean);
  }

  async function fetchWikidataImage(qid) {
    const params = new URLSearchParams({ action: 'wbgetclaims', format: 'json', origin: '*', entity: qid, property: 'P18' });
    const json = await getJson('https://www.wikidata.org/w/api.php?' + params.toString());
    const claim = json && json.claims && json.claims.P18 && json.claims.P18[0];
    const name = claim && claim.mainsnak && claim.mainsnak.datavalue && claim.mainsnak.datavalue.value;
    if (!name) return null;
    return { thumb: commonsThumb(name), page: commonsPage(name), title: 'Photo linked via Wikidata', artist: '', license: '', kind: 'osm' };
  }

  // Photos the mapper attached to the beach itself.
  async function fetchTaggedPhotos(b) {
    const out = [];
    const linked = (thumb, page) => out.push({ thumb, page, title: 'Photo linked from OpenStreetMap', artist: '', license: '', kind: 'osm' });
    if (/^(File|Image):/i.test(String(b.commonsFile || ''))) {
      const name = commonsFileName(b.commonsFile);
      if (name) linked(commonsThumb(name), commonsPage(name));
    }
    const img = String(b.image || '').trim();
    if (/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/i.test(img)) {
      const name = commonsFileName(safeDecode(img.split('/wiki/')[1] || ''));
      if (name) linked(commonsThumb(name), img);
    } else if (/^https:\/\/\S+\.(jpe?g|png|webp|gif)(\?\S*)?$/i.test(img)) {
      linked(img, img);
    }
    const ref = parseWikipediaTag(b.wikipedia);
    if (ref) {
      const art = await fetchWikipediaArticle(ref).catch(() => null);
      if (art) out.push(art);
    } else if (/^Q\d+$/.test(String(b.wikidata || ''))) {
      const wd = await fetchWikidataImage(b.wikidata).catch(() => null);
      if (wd) out.push(wd);
    }
    return out;
  }

  const FLICKR_LICENSES = {
    '0': 'All rights reserved', '1': 'CC BY-NC-SA', '2': 'CC BY-NC', '3': 'CC BY-NC-ND', '4': 'CC BY',
    '5': 'CC BY-SA', '6': 'CC BY-ND', '7': 'No known copyright restrictions', '8': 'US Government work',
    '9': 'CC0', '10': 'Public domain',
  };

  async function fetchFlickrPhotos(b) {
    const params = new URLSearchParams({
      method: 'flickr.photos.search', api_key: FLICKR_API_KEY, format: 'json', nojsoncallback: '1',
      lat: b.lat.toFixed(6), lon: b.lon.toFixed(6), radius: String(FLICKR_RADIUS_M / 1000), radius_units: 'km',
      has_geo: '1', min_taken_date: '2000-01-01 00:00:00',   // Flickr insists on a limiting parameter next to geo
      content_type: '1', safe_search: '1', sort: 'interestingness-desc', per_page: String(FLICKR_LIMIT),
      extras: 'url_n,url_m,owner_name,license',
    });
    const json = await getJson(FLICKR + '?' + params.toString());
    if (!json || json.stat !== 'ok') throw new Error('Flickr: ' + (json && json.message ? json.message : 'unexpected response'));
    const list = json.photos && Array.isArray(json.photos.photo) ? json.photos.photo : [];
    return list.map((ph) => {
      const thumb = ph.url_n || ph.url_m;
      if (!thumb || !ph.id || !ph.owner) return null;
      return {
        thumb,
        page: 'https://www.flickr.com/photos/' + encodeURIComponent(ph.owner) + '/' + encodeURIComponent(ph.id),
        title: String(ph.title || 'Untitled'),
        artist: String(ph.ownername || ''),
        license: FLICKR_LICENSES[String(ph.license)] || '',
        kind: 'flickr',
      };
    }).filter(Boolean);
  }

  // Geo-tagged Commons files near the beach, beach-looking ones first, then by distance.
  async function fetchCommonsPhotos(b, tokens) {
    const params = new URLSearchParams({
      action: 'query', format: 'json', origin: '*',
      generator: 'geosearch', ggscoord: b.lat.toFixed(6) + '|' + b.lon.toFixed(6),
      ggsradius: String(COMMONS_RADIUS_M), ggslimit: String(COMMONS_LIMIT), ggsnamespace: '6',
      prop: 'imageinfo|categories', iiprop: 'url|mime|extmetadata', iiurlwidth: '320',
      iiextmetadatafilter: 'Artist|LicenseShortName', clshow: '!hidden', cllimit: '500',
    });
    return pagesOf(await getJson(COMMONS + '?' + params.toString()))
      .map((pg) => {
        const ii = pg.imageinfo && pg.imageinfo[0];
        if (!ii || !ii.thumburl || !/^image\/(jpeg|png|webp|gif)$/.test(ii.mime || '')) return null;
        const md = ii.extmetadata || {};
        const cats = (pg.categories || []).map((c) => c.title).join(' ');
        const name = commonsFileName(pg.title || '');
        return {
          thumb: ii.thumburl,
          page: ii.descriptionurl || commonsPage(name),
          title: name.replace(/\.[a-z0-9]+$/i, ''),
          artist: md.Artist ? htmlToText(md.Artist.value) : '',
          license: md.LicenseShortName ? htmlToText(md.LicenseShortName.value) : '',
          kind: 'commons',
          score: relevance(pg.title + ' ' + cats, tokens),
          index: pg.index || 0,
        };
      })
      .filter(Boolean)
      .sort((a, c) => c.score - a.score || a.index - c.index);
  }

  /* Google Maps, through the site's own Supabase Edge Function (supabase/functions/google-place).
     The browser never holds the Google key. The function books every metered Google call in the
     database first and refuses once the month's free allowance is nearly used, so Google cannot bill. */

  const googleInfoById = new Map();    // beach id -> Promise<info or null>
  const googleInfoCache = new Map();   // beach id -> info, once it has arrived (read by the popup)
  // Google requires its logo next to Places content shown away from a Google map.
  const GOOGLE_ATTR_HTML = '<picture class="google-attr">' +
    '<source media="(prefers-color-scheme: dark)" srcset="https://maps.gstatic.com/mapfiles/api-3/images/powered-by-google-on-non-white3_hdpi.png">' +
    '<img src="https://maps.gstatic.com/mapfiles/api-3/images/powered-by-google-on-white3_hdpi.png" alt="Powered by Google" width="120" height="14">' +
    '</picture>';

  function googleInfo(b) {
    if (!GOOGLE_ON) return Promise.resolve(null);
    if (googleInfoById.has(b.id)) return googleInfoById.get(b.id);
    const promise = BACKEND.fn('google-place', { action: 'info', beach: { id: b.id, name: b.name || '', lat: b.lat, lon: b.lon } })
      .then((r) => {
        const info = r && r.place && typeof r.place.id === 'string' ? r.place : null;
        if (info) googleInfoCache.set(b.id, info);
        return info;
      })
      .catch((err) => {
        googleInfoById.delete(b.id);
        console.warn('Google data unavailable:', err && err.message);
        return null;
      });
    googleInfoById.set(b.id, promise);
    return promise;
  }

  async function fetchGooglePhotos(b) {
    const info = await googleInfo(b);
    if (!info || !Array.isArray(info.photos) || !info.photos.length) return [];
    const picks = info.photos.slice(0, GOOGLE_PHOTO_LIMIT);
    const r = await BACKEND.fn('google-place', { action: 'photos', names: picks.map((ph) => ph.name) });
    const uris = new Map(((r && r.photos) || [])
      .filter((ph) => ph && typeof ph.uri === 'string' && /^https:\/\//.test(ph.uri))
      .map((ph) => [ph.name, ph.uri]));
    const placeLink = info.mapsUri || ('https://www.google.com/maps/place/?q=place_id:' + encodeURIComponent(info.id));
    return picks.filter((ph) => uris.has(ph.name)).map((ph) => ({
      thumb: uris.get(ph.name),
      page: ph.mapsUri || placeLink,
      title: 'Google Maps photo',
      artist: ph.author || '',
      authorUri: ph.authorUri || '',
      license: '',
      kind: 'google',
    }));
  }

  // "Looks like the beach": linked on OSM, a Wikipedia article, a Flickr geo hit, or a Commons file
  // whose title or categories carry a beach word.
  function looksLikeBeach(ph) {
    return ph.kind === 'osm' || ph.kind === 'wikipedia' || ph.kind === 'flickr' || (ph.kind === 'commons' && ph.score >= 3);
  }

  async function collectPhotos(b) {
    const tokens = nameTokens(b.name || '');
    const langs = wikiLangs();
    let geoError = null;
    const jobs = [fetchTaggedPhotos(b).catch(() => [])]
      .concat(langs.map((lang) => fetchWikipediaNear(lang, b).catch(() => [])))
      .concat([(FLICKR_API_KEY ? fetchFlickrPhotos(b) : fetchCommonsPhotos(b, tokens)).catch((err) => { geoError = err; return []; })]);
    const parts = await Promise.all(jobs);
    const seen = new Set();
    const out = [];
    for (const ph of parts.flat()) {
      if (!ph || !ph.thumb || seen.has(ph.thumb)) continue;
      seen.add(ph.thumb);
      out.push(ph);
      if (out.length >= PHOTO_MAX) break;
    }
    if (GOOGLE_ON && !out.some(looksLikeBeach)) {
      const google = await fetchGooglePhotos(b).catch((err) => { console.warn('Google photos failed:', err && err.message); return []; });
      if (google.length) {
        const merged = google.concat(out.filter((ph) => !google.some((g) => g.thumb === ph.thumb)));
        return merged.slice(0, PHOTO_MAX);
      }
    }
    if (!out.length && geoError) throw geoError;
    return out;
  }

  function fetchPhotos(b) {
    if (photosById.has(b.id)) return photosById.get(b.id);
    const promise = collectPhotos(b).catch((err) => { photosById.delete(b.id); throw err; });
    photosById.set(b.id, promise);
    return promise;
  }

  const SOURCE_NAMES = { osm: 'OpenStreetMap', wikipedia: 'Wikipedia', commons: 'Wikimedia Commons', flickr: 'Flickr', google: 'Google Maps' };

  async function showPhotos(b, detail) {
    const gallery = detail.querySelector('.gallery');
    const note = detail.querySelector('.gallery-note');
    if (!gallery || !note) return;
    const alive = () => state.selectedId === b.id && detail.isConnected;
    let photos;
    try {
      photos = await fetchPhotos(b);
    } catch (err) {
      if (!alive()) return;
      gallery.hidden = true;
      note.textContent = 'Photos couldn’t be loaded right now.';
      note.hidden = false;
      return;
    }
    if (!alive()) return;
    gallery.replaceChildren();
    if (photos.length === 0) {
      gallery.hidden = true;
      note.textContent = 'No photos of this beach yet.';
      note.hidden = false;
      return;
    }
    for (const ph of photos) {
      const a = document.createElement('a');
      a.className = 'photo';
      a.href = ph.page;
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = ph.title + (ph.artist ? ' — ' + ph.artist : '') + (ph.license ? ' (' + ph.license + ')' : '');
      const img = document.createElement('img');
      img.src = ph.thumb;
      img.alt = ph.title;
      img.loading = 'lazy';
      img.decoding = 'async';
      img.addEventListener('error', () => a.remove(), { once: true });
      a.appendChild(img);
      if (ph.kind === 'google' && ph.artist) {
        const by = document.createElement('span');
        by.className = 'photo-author';
        by.textContent = ph.artist;
        a.appendChild(by);
      }
      gallery.appendChild(a);
    }
    const sources = [];
    for (const ph of photos) { const n = SOURCE_NAMES[ph.kind]; if (n && !sources.includes(n)) sources.push(n); }
    note.textContent = sources.join(', ') + ' · within 1 km';
    if (photos.some((ph) => ph.kind === 'google')) note.insertAdjacentHTML('beforeend', GOOGLE_ATTR_HTML);
    note.hidden = false;
    popupPhotoById.set(b.id, photos[0]);
    refreshPopup(b);
  }

  /* ---------- Location & geocoding ---------- */

  function locate() {
    if (!('geolocation' in navigator)) {
      setStatus('This browser can’t share your location. Search a place or tap the map instead.', { kind: 'error' });
      return;
    }
    if (!window.isSecureContext) {
      setStatus('Location only works over HTTPS or on localhost. Search a place or tap the map instead.', { kind: 'error' });
      return;
    }
    els.locateBtn.disabled = true;
    setStatus('Finding your location…', { kind: 'busy' });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        els.locateBtn.disabled = false;
        els.input.value = '';
        setCenter(pos.coords.latitude, pos.coords.longitude, 'you');
      },
      (err) => {
        els.locateBtn.disabled = false;
        const denied = err && err.code === 1;
        setStatus(denied
          ? 'Location access was blocked. Allow it in your browser, or search a place or tap the map.'
          : 'Couldn’t get your location. Try again, or search a place or tap the map.', { kind: 'error' });
      },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60 * 1000 }
    );
  }

  async function searchPlace(query) {
    const q = String(query || '').trim();
    if (!q) { els.input.focus(); return; }
    setStatus('Looking up “' + q + '”…', { kind: 'busy' });
    try {
      const url = NOMINATIM + '/search?' + new URLSearchParams({ q, format: 'jsonv2', limit: '1', 'accept-language': 'en' });
      const res = await fetchWithTimeout(url, {}, 15000, null);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        setStatus('No place called “' + q + '” was found. Try a town or region name.', { kind: 'error' });
        return;
      }
      const r = rows[0];
      const label = r.name || String(r.display_name || q).split(',')[0];
      els.input.value = label;
      setCenter(parseFloat(r.lat), parseFloat(r.lon), label);
    } catch (err) {
      console.error('Place lookup failed:', err);
      setStatus('Place lookup failed. Check your connection and try again.',
        { kind: 'error', action: { label: 'Retry', onClick: () => searchPlace(q) } });
    }
  }

  /* ---------- Events ---------- */

  els.locateBtn.addEventListener('click', locate);

  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    searchPlace(els.input.value);
  });

  els.radiusGroup.addEventListener('change', (e) => {
    const t = e.target;
    if (t && t.name === 'radius' && t.checked) setRadius(parseInt(t.value, 10));
  });

  els.tryRow.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-place]');
    if (!btn) return;
    els.input.value = btn.dataset.place;
    searchPlace(btn.dataset.place);
  });

  els.results.addEventListener('click', (e) => {
    const star = e.target.closest('.rate-stars button[data-stars]');
    if (star) { submitRating(star.closest('.result'), Number(star.dataset.stars)); return; }
    const head = e.target.closest('.result-head');
    if (head) select(head.closest('.result').dataset.id, 'list');
  });

  // A click that merely dismisses a popup should not drop a new pin.
  let popupOpen = false;
  let popupWasOpen = false;
  map.on('popupopen', () => { popupOpen = true; });
  map.on('popupclose', () => { popupOpen = false; });
  map.on('preclick', () => { popupWasOpen = popupOpen; });
  map.on('click', (e) => {
    if (popupWasOpen) return;
    els.input.value = '';
    setCenter(e.latlng.lat, e.latlng.lng, null);
  });

  const onThemeChange = () => {
    if (vectorBase && vectorBase.getMaplibreMap()) vectorBase.getMaplibreMap().setStyle(isDark() ? STYLES.dark : STYLES.light);
    if (radiusCircle) radiusCircle.setStyle({ color: accentColor() });
  };
  if (darkMq.addEventListener) darkMq.addEventListener('change', onThemeChange);

  /* ---------- Boot ---------- */

  function init() {
    for (const k of OLD_STORAGE_KEYS) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
    const stored = loadStored();
    if (stored && typeof stored.lat === 'number' && typeof stored.lon === 'number' && isFinite(stored.lat) && isFinite(stored.lon)) {
      if (RADII_KM.includes(stored.radius)) {
        state.radiusKm = stored.radius;
        setRadiusControl(stored.radius);
      }
      let label = stored.name || null;
      if (label === 'you') label = 'your last location';
      else if (label) els.input.value = label;
      setCenter(stored.lat, stored.lon, label);
    } else {
      els.empty.hidden = false;
      setStatus('Pick a starting point to find beaches nearby.');
    }
  }

  init();
})();
