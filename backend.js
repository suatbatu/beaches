/* Hello Beaches — connection to the site's Supabase project, if config.js names one.
   Used for shared ratings (database functions) and Google data (the google-place Edge Function). */
(function () {
  'use strict';

  const C = window.HELLO_BEACHES_CONFIG || {};
  const BASE = String(C.supabaseUrl || '').trim().replace(/\/+$/, '');
  const KEY = String(C.supabaseKey || '').trim();
  const enabled = /^https:\/\/[^\s/]+$/.test(BASE) && KEY.length > 20;

  async function post(path, body, timeoutMs) {
    const headers = { 'Content-Type': 'application/json', apikey: KEY };
    if (KEY.startsWith('eyJ')) headers.Authorization = 'Bearer ' + KEY;   // legacy anon keys are JWTs
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
      if (!res.ok) {
        const err = new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
        err.status = res.status;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  window.HelloBeachesBackend = {
    enabled,
    rpc: (name, body) => post('/rest/v1/rpc/' + encodeURIComponent(name), body, 8000),
    fn: (name, body) => post('/functions/v1/' + encodeURIComponent(name), body, 20000),
  };
})();
