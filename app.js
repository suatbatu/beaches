/* Hello Beaches — nearby beach finder.
   Data: OpenStreetMap via Overpass (natural=beach). Geocoding: Nominatim. Map: Leaflet.
   Photos: Flickr when a key is set in config.js, otherwise Wikimedia Commons. */
(function () {
  'use strict';

  const CONFIG = window.HELLO_BEACHES_CONFIG || {};
  const FLICKR_API_KEY = String(CONFIG.flickrApiKey || '').trim();

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
  const CACHE_KEY = 'beaches:cache';
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const CACHE_MAX = 6;
  const COMMONS = 'https://commons.wikimedia.org/w/api.php';
  const FLICKR = 'https://api.flickr.com/services/rest/';
  const PHOTO_SOURCE_NAME = FLICKR_API_KEY ? 'Flickr' : 'Wikimedia Commons';
  const PHOTO_RADIUS_M = 600;
  const PHOTO_LIMIT = 8;

  const els = {
    locateBtn: document.getElementById('locate-btn'),
    form: document.getElementById('search-form'),
    input: document.getElementById('place-input'),
    radius: document.getElementById('radius-select'),
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
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  }).addTo(map);

  const markersLayer = L.layerGroup().addTo(map);
  const markersById = new Map();
  let userMarker = null;
  let radiusCircle = null;

  function accentColor() {
    return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0E8C86';
  }

  function beachIcon(selected) {
    return L.divIcon({
      className: 'beach-pin',
      html: '<div class="beach-marker' + (selected ? ' is-selected' : '') + '"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
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
      b.className = 'btn btn-small';
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
  const KEEP_TAGS = ['name', 'name:en', 'alt_name', 'surface', 'lifeguard', 'nudism', 'dog', 'wheelchair', 'fee', 'access'];
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
      radiusCircle = L.circle(ll, { radius: r, color: accentColor(), weight: 1.2, dashArray: '4 6', fillOpacity: 0.05, interactive: false }).addTo(map);
    } else {
      radiusCircle.setLatLng(ll);
      radiusCircle.setRadius(r);
    }
  }

  function setRadius(km) {
    state.radiusKm = km;
    els.radius.value = String(km);
    updateCircle();
    if (state.center) {
      saveStored();
      runSearch();
    }
  }

  /* ---------- Rendering ---------- */

  function renderResults() {
    const list = state.beaches.slice(0, MAX_LIST);
    const frag = document.createDocumentFragment();
    for (const b of list) {
      const li = document.createElement('li');
      li.className = 'result' + (b.id === state.selectedId ? ' is-selected' : '');
      li.dataset.id = b.id;
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.setAttribute('aria-label', (b.name || 'Unnamed beach') + ', ' + formatDistance(b.distanceKm) + ' ' + compassLabel(b.bearing));
      const deg = Math.round(b.bearing);
      const igTag = b.name ? instagramTag(b.name) : null;
      li.innerHTML =
        '<div class="result-main">' +
          '<h3 class="result-name' + (b.name ? '' : ' is-unnamed') + '">' + (b.name ? esc(b.name) : 'Unnamed beach') + '</h3>' +
          (b.features.length
            ? '<div class="result-tags">' + b.features.map((f) => '<span class="chip ' + f.cls + '">' + esc(f.label) + '</span>').join('') + '</div>'
            : '') +
        '</div>' +
        '<div class="result-dist">' +
          '<span class="dist-value">' + formatDistance(b.distanceKm) + '</span>' +
          '<span class="bearing" title="Bearing ' + deg + '°">' +
            '<svg viewBox="0 0 16 16" aria-hidden="true" style="rotate:' + deg + 'deg"><path d="M8 1.5 12.5 12.5 8 10 3.5 12.5Z"/></svg>' +
            compassLabel(b.bearing) +
          '</span>' +
        '</div>' +
        '<div class="result-actions">' +
          '<a class="link-dir" href="' + directionsUrl(b) + '" target="_blank" rel="noopener">Directions</a>' +
          '<a class="link-osm" href="https://www.openstreetmap.org/' + b.osmType + '/' + b.osmId + '" target="_blank" rel="noopener">View on OSM</a>' +
          (igTag ? '<a class="link-osm" href="https://www.instagram.com/explore/tags/' + igTag + '/" target="_blank" rel="noopener">Instagram</a>' : '') +
        '</div>';
      frag.appendChild(li);
    }
    els.results.replaceChildren(frag);
  }

  function popupHtml(b, photo) {
    return '<div class="popup">' +
      (photo
        ? '<a class="popup-photo" href="' + esc(photo.page) + '" target="_blank" rel="noopener">' +
            '<img src="' + esc(photo.thumb) + '" alt="' + esc(photo.title) + '"></a>'
        : '') +
      '<div class="popup-name">' + (b.name ? esc(b.name) : 'Unnamed beach') + '</div>' +
      '<div class="popup-dist">' + formatDistance(b.distanceKm) + ' ' + compassLabel(b.bearing) + ' of ' + esc(describeWhere()) + '</div>' +
      '<a class="link-dir" href="' + directionsUrl(b) + '" target="_blank" rel="noopener">Directions</a>' +
    '</div>';
  }

  function renderMarkers() {
    markersLayer.clearLayers();
    markersById.clear();
    for (const b of state.beaches.slice(0, MAX_MARKERS)) {
      const m = L.marker([b.lat, b.lon], { icon: beachIcon(false), title: b.name || 'Unnamed beach', riseOnHover: true, keyboard: false });
      m.bindPopup(popupHtml(b), { closeButton: false, offset: [0, -6], minWidth: 200, maxWidth: 260 });
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

  function select(id, source) {
    const b = state.beaches.find((x) => x.id === id);
    if (!b) return;
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

    let selectedLi = null;
    for (const li of els.results.children) {
      const on = li.dataset.id === id;
      li.classList.toggle('is-selected', on);
      if (on) selectedLi = li;
      else { const box = li.querySelector('.result-photos'); if (box) box.remove(); }
    }
    if (selectedLi) showPhotos(b, selectedLi);

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

  /* ---------- Photos (Wikimedia Commons, geo-tagged near the beach) ---------- */

  const photosById = new Map();   // beach id -> Promise<photo[]>

  function fetchPhotos(b) {
    if (photosById.has(b.id)) return photosById.get(b.id);
    const promise = (FLICKR_API_KEY ? fetchFlickrPhotos(b) : fetchCommonsPhotos(b))
      .catch((err) => { photosById.delete(b.id); throw err; });
    photosById.set(b.id, promise);
    return promise;
  }

  const FLICKR_LICENSES = {
    '0': 'All rights reserved', '1': 'CC BY-NC-SA', '2': 'CC BY-NC', '3': 'CC BY-NC-ND', '4': 'CC BY',
    '5': 'CC BY-SA', '6': 'CC BY-ND', '7': 'No known copyright restrictions', '8': 'US Government work',
    '9': 'CC0', '10': 'Public domain',
  };

  async function fetchFlickrPhotos(b) {
    const params = new URLSearchParams({
      method: 'flickr.photos.search', api_key: FLICKR_API_KEY, format: 'json', nojsoncallback: '1',
      lat: b.lat.toFixed(6), lon: b.lon.toFixed(6), radius: String(PHOTO_RADIUS_M / 1000), radius_units: 'km',
      has_geo: '1', min_taken_date: '2000-01-01 00:00:00',   // Flickr insists on a limiting parameter next to geo
      content_type: '1', safe_search: '1', sort: 'interestingness-desc', per_page: String(PHOTO_LIMIT),
      extras: 'url_n,url_m,owner_name,license',
    });
    const res = await fetchWithTimeout(FLICKR + '?' + params.toString(), {}, 15000, null);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
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
      };
    }).filter(Boolean);
  }

  function fetchCommonsPhotos(b) {
    const params = new URLSearchParams({
      action: 'query', format: 'json', origin: '*',
      generator: 'geosearch', ggscoord: b.lat.toFixed(6) + '|' + b.lon.toFixed(6),
      ggsradius: String(PHOTO_RADIUS_M), ggslimit: String(PHOTO_LIMIT), ggsnamespace: '6',
      prop: 'imageinfo', iiprop: 'url|mime|extmetadata', iiurlwidth: '320',
      iiextmetadatafilter: 'Artist|LicenseShortName',
    });
    return fetchWithTimeout(COMMONS + '?' + params.toString(), {}, 15000, null)
      .then((res) => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
      .then((json) => {
        const pages = json && json.query && json.query.pages ? Object.values(json.query.pages) : [];
        return pages.map((pg) => {
          const ii = pg.imageinfo && pg.imageinfo[0];
          if (!ii || !ii.thumburl || !/^image\/(jpeg|png|webp|gif)$/.test(ii.mime || '')) return null;
          const md = ii.extmetadata || {};
          return {
            thumb: ii.thumburl,
            page: ii.descriptionurl || ('https://commons.wikimedia.org/wiki/' + encodeURIComponent(pg.title || '')),
            title: String(pg.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''),
            artist: md.Artist ? htmlToText(md.Artist.value) : '',
            license: md.LicenseShortName ? htmlToText(md.LicenseShortName.value) : '',
          };
        }).filter(Boolean);
      });
  }

  async function showPhotos(b, li) {
    let box = li.querySelector('.result-photos');
    if (!box) {
      box = document.createElement('div');
      box.className = 'result-photos';
      li.appendChild(box);
    }
    box.textContent = 'Loading photos\u2026';
    let photos;
    try {
      photos = await fetchPhotos(b);
    } catch (err) {
      if (state.selectedId === b.id && li.isConnected) box.textContent = 'Photos couldn\u2019t be loaded right now.';
      return;
    }
    if (state.selectedId !== b.id || !li.isConnected) return;
    box.textContent = '';
    if (photos.length === 0) {
      box.textContent = 'No geo-tagged photos on ' + PHOTO_SOURCE_NAME + ' yet.';
      return;
    }
    for (const ph of photos) {
      const a = document.createElement('a');
      a.className = 'photo';
      a.href = ph.page;
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = ph.title + (ph.artist ? ' \u2014 ' + ph.artist : '') + (ph.license ? ' (' + ph.license + ')' : '');
      const img = document.createElement('img');
      img.src = ph.thumb;
      img.alt = ph.title;
      img.loading = 'lazy';
      img.decoding = 'async';
      a.appendChild(img);
      box.appendChild(a);
    }
    const credit = document.createElement('span');
    credit.className = 'photo-credit';
    credit.textContent = PHOTO_SOURCE_NAME + ', within ' + PHOTO_RADIUS_M + ' m';
    box.appendChild(credit);

    const m = markersById.get(b.id);
    if (m) m.setPopupContent(popupHtml(b, photos[0]));
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

  els.radius.addEventListener('change', () => setRadius(parseInt(els.radius.value, 10)));

  els.tryRow.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-place]');
    if (!btn) return;
    els.input.value = btn.dataset.place;
    searchPlace(btn.dataset.place);
  });

  els.results.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const li = e.target.closest('.result');
    if (li) select(li.dataset.id, 'list');
  });

  els.results.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (!e.target.classList || !e.target.classList.contains('result')) return;
    e.preventDefault();
    select(e.target.dataset.id, 'list');
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

  const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
  if (darkMq.addEventListener) {
    darkMq.addEventListener('change', () => { if (radiusCircle) radiusCircle.setStyle({ color: accentColor() }); });
  }

  /* ---------- Boot ---------- */

  function init() {
    const stored = loadStored();
    if (stored && typeof stored.lat === 'number' && typeof stored.lon === 'number' && isFinite(stored.lat) && isFinite(stored.lon)) {
      if (RADII_KM.includes(stored.radius)) {
        state.radiusKm = stored.radius;
        els.radius.value = String(stored.radius);
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
