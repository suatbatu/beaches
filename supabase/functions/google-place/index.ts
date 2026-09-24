// Hello Beaches: Google Maps proxy (Supabase Edge Function named "google-place").
//
// The Google key is a secret of this function and never reaches the browser. Every metered Google
// call is booked in the database first (claim_google in supabase/setup.sql), which refuses once the
// month's free allowance is nearly used. That makes a Google bill impossible, whatever visitors do.
//
// Secrets this function reads: GOOGLE_MAPS_API_KEY (you add it), SUPABASE_URL and the project's
// secret key (Supabase provides both). Optional: ALLOWED_ORIGINS, comma separated.

const PLACES = 'https://places.googleapis.com/v1';
const BEACH_ID_RE = /^(node|way|relation)\/[0-9]{1,15}$/;
const PLACE_ID_RE = /^[A-Za-z0-9_-]{10,300}$/;
const PHOTO_NAME_RE = /^places\/[A-Za-z0-9_-]{10,300}\/photos\/[A-Za-z0-9_-]{10,1000}$/;
const NO_MATCH_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;   // look again for beaches Google didn't know
const MAX_PHOTOS = 3;
const DEFAULT_ORIGINS = 'https://suatbatu.github.io,http://localhost:8765,http://127.0.0.1:8765';

type Env = Record<string, string | undefined>;
type Beach = { id: string; name: string; lat: number; lon: number };

export function pickSecretKey(env: Env): string {
  try {
    const keys = JSON.parse(env.SUPABASE_SECRET_KEYS || '{}');
    if (keys && typeof keys.default === 'string') return keys.default;
    const first = Object.values(keys || {}).find((v) => typeof v === 'string');
    if (typeof first === 'string') return first;
  } catch (_e) { /* fall through to the single-key forms */ }
  return env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
}

export function createHandler(env: Env, fetchImpl: typeof fetch = fetch) {
  const googleKey = String(env.GOOGLE_MAPS_API_KEY || '').trim();
  const base = String(env.SUPABASE_URL || '').replace(/\/+$/, '');
  const serviceKey = pickSecretKey(env);
  const origins = String(env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);

  function corsHeaders(origin: string): Record<string, string> {
    const h: Record<string, string> = {
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Vary': 'Origin',
    };
    if (origin && origins.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
    return h;
  }

  function reply(body: unknown, status: number, origin: string): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders(origin), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  async function rpc(name: string, args: Record<string, unknown>): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', apikey: serviceKey };
    if (serviceKey.startsWith('eyJ')) headers.Authorization = 'Bearer ' + serviceKey;   // legacy service_role JWT
    const res = await fetchImpl(base + '/rest/v1/rpc/' + name, { method: 'POST', headers, body: JSON.stringify(args) });
    const text = await res.text();
    if (!res.ok) throw new Error('Database call ' + name + ' failed: HTTP ' + res.status + ' ' + text.slice(0, 200));
    return text ? JSON.parse(text) : null;
  }

  async function ipHash(req: Request): Promise<string> {
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    if (!ip) return '';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Text Search with an IDs-only field mask is free and unlimited, and place IDs may be kept forever.
  async function findPlaceId(beach: Beach): Promise<string | null> {
    const rows = await rpc('google_place_get', { p_beach: beach.id });
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row && row.place_id) return row.place_id;
    if (row && Date.now() - Date.parse(row.looked_up_at) < NO_MATCH_RECHECK_MS) return null;

    const d = beach.name ? 0.01 : 0.003;   // about 1 km around a named beach, 300 m around an unnamed strip
    const clampLat = (v: number) => Math.max(-90, Math.min(90, v));
    const clampLon = (v: number) => Math.max(-180, Math.min(180, v));
    const res = await fetchImpl(PLACES + '/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': googleKey, 'X-Goog-FieldMask': 'places.id' },
      body: JSON.stringify({
        textQuery: beach.name || 'beach',
        includedType: 'beach',
        maxResultCount: 1,
        locationRestriction: { rectangle: {
          low: { latitude: clampLat(beach.lat - d), longitude: clampLon(beach.lon - d) },
          high: { latitude: clampLat(beach.lat + d), longitude: clampLon(beach.lon + d) },
        } },
      }),
    });
    if (!res.ok) throw new Error('Google Text Search failed: HTTP ' + res.status);
    const data = await res.json();
    const first = data && Array.isArray(data.places) ? data.places[0] : null;
    const id = first && typeof first.id === 'string' && PLACE_ID_RE.test(first.id) ? first.id : null;
    await rpc('google_place_put', { p_beach: beach.id, p_place: id || '' });
    return id;
  }

  // Place Details with rating fields is one "Place Details Enterprise" call: booked first.
  async function info(beach: Beach, req: Request) {
    const placeId = await findPlaceId(beach);
    if (!placeId) return { place: null };
    const granted = Number(await rpc('claim_google', { p_kind: 'details', p_amount: 1, p_ip_hash: await ipHash(req) })) || 0;
    if (granted < 1) return { place: null, limited: true };

    const res = await fetchImpl(PLACES + '/places/' + encodeURIComponent(placeId), {
      headers: { 'X-Goog-Api-Key': googleKey, 'X-Goog-FieldMask': 'id,rating,userRatingCount,googleMapsUri,photos' },
    });
    if (!res.ok) throw new Error('Google Place Details failed: HTTP ' + res.status);
    const p = await res.json();
    const photos = (Array.isArray(p.photos) ? p.photos : [])
      .filter((ph: any) => ph && typeof ph.name === 'string' && PHOTO_NAME_RE.test(ph.name))
      .slice(0, 10)
      .map((ph: any) => {
        const a = Array.isArray(ph.authorAttributions) && ph.authorAttributions[0] ? ph.authorAttributions[0] : {};
        return {
          name: ph.name,
          author: typeof a.displayName === 'string' ? a.displayName : '',
          authorUri: typeof a.uri === 'string' ? a.uri : '',
          mapsUri: typeof ph.googleMapsUri === 'string' ? ph.googleMapsUri : '',
        };
      });
    return {
      place: {
        id: placeId,
        rating: typeof p.rating === 'number' ? p.rating : null,
        ratingCount: Number.isFinite(p.userRatingCount) ? p.userRatingCount : 0,
        mapsUri: typeof p.googleMapsUri === 'string' ? p.googleMapsUri : '',
        photos,
      },
    };
  }

  // Each photo is one "Place Details Photos" call: booked first, then resolved to a keyless image URL.
  async function photos(names: string[], req: Request) {
    const wanted = Array.from(new Set(names.filter((n) => PHOTO_NAME_RE.test(n)))).slice(0, MAX_PHOTOS);
    if (!wanted.length) return { photos: [] };
    const granted = Number(await rpc('claim_google', { p_kind: 'photo', p_amount: wanted.length, p_ip_hash: await ipHash(req) })) || 0;
    const allowed = wanted.slice(0, Math.max(0, granted));
    const results = await Promise.all(allowed.map(async (name) => {
      const url = PLACES + '/' + name + '/media?maxWidthPx=480&maxHeightPx=480&skipHttpRedirect=true&key=' + encodeURIComponent(googleKey);
      const res = await fetchImpl(url);
      if (!res.ok) return null;
      const data = await res.json();
      return data && typeof data.photoUri === 'string' && data.photoUri.startsWith('https://') ? { name, uri: data.photoUri } : null;
    }));
    return { photos: results.filter(Boolean), limited: allowed.length < wanted.length };
  }

  return async function handle(req: Request): Promise<Response> {
    const origin = req.headers.get('origin') || '';
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
    if (req.method !== 'POST') return reply({ error: 'Use POST.' }, 405, origin);
    if (origin && !origins.includes(origin)) return reply({ error: 'This site is not allowed to use the function.' }, 403, origin);
    if (!googleKey || !base || !serviceKey) {
      return reply({ error: 'The function is missing its GOOGLE_MAPS_API_KEY secret or its Supabase keys.' }, 500, origin);
    }

    let body: any;
    try { body = await req.json(); } catch (_e) { return reply({ error: 'Send a JSON body.' }, 400, origin); }

    try {
      if (body && body.action === 'info') {
        const b = body.beach || {};
        const beach: Beach = {
          id: String(b.id || ''),
          name: typeof b.name === 'string' ? b.name.trim().slice(0, 120) : '',
          lat: Number(b.lat),
          lon: Number(b.lon),
        };
        if (!BEACH_ID_RE.test(beach.id) || !(Math.abs(beach.lat) <= 90) || !(Math.abs(beach.lon) <= 180)) {
          return reply({ error: 'Invalid beach.' }, 400, origin);
        }
        return reply(await info(beach, req), 200, origin);
      }
      if (body && body.action === 'photos') {
        if (!Array.isArray(body.names)) return reply({ error: 'names must be a list.' }, 400, origin);
        return reply(await photos(body.names.map(String), req), 200, origin);
      }
      return reply({ error: 'Unknown action.' }, 400, origin);
    } catch (err) {
      console.error(err);
      return reply({ error: 'Google lookup failed.' }, 502, origin);
    }
  };
}

// deno-lint-ignore no-explicit-any
const DenoRuntime = (globalThis as any).Deno;
if (DenoRuntime && typeof DenoRuntime.serve === 'function') {
  DenoRuntime.serve(createHandler(DenoRuntime.env.toObject()));
}
