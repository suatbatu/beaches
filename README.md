# Hello Beaches

Find your beach. Every beach around you, closest first, with photos, ratings and directions.

Share your location, search a place, or tap the map. Hello Beaches lists every beach within the radius you pick, closest first, with the direction it lies in. Open a beach to see its photos, its ratings, rate it yourself, and get directions.

Live: https://suatbatu.github.io/beaches/

## How it works

- **Beach data** comes live from OpenStreetMap (`natural=beach`) through the Overpass API. Several public mirrors are tried in parallel, and searches are cached for a day.
- **Place search** uses Nominatim geocoding.
- **Map** is Leaflet drawing OpenFreeMap's vector styles through MapLibre: Positron in light mode, Dark in dark mode. OpenFreeMap is free with no key and no view limits. Browsers without WebGL get plain OpenStreetMap tiles.
- **Photos**, in this order: photos linked on the beach's OpenStreetMap entry, Wikipedia articles about the beach, then geo-tagged Wikimedia Commons files within 1 km, ranked so beach photos come before the town behind them. Google Maps photos are a last resort, only when the site is connected to Google (below).
- **Ratings**: every visitor can rate a beach from 1 to 5 stars. Without Supabase, a rating stays on the visitor's own device. With Supabase connected, ratings are shared and everyone sees the average. When Google is connected, each beach also shows its Google Maps rating.
- **Design** follows Apple's web style: system San Francisco font (Inter elsewhere), frosted navigation bar, grouped lists, pill buttons, light and dark themes.
- No build step. The site is static files; the optional backend is one Supabase project.

## Connect Supabase for shared ratings (free, about 10 minutes)

1. Sign in at https://supabase.com with GitHub and create a new project on the free plan. No card is needed.
2. Open **SQL Editor**, paste all of [`supabase/setup.sql`](supabase/setup.sql) and press **Run**. It is safe to run again later.
3. Open **Project Settings > API Keys**. Copy the project URL and the **publishable** key (it starts with `sb_publishable_`). This key is meant to be public.
4. Put both in [`config.js`](config.js) as `supabaseUrl` and `supabaseKey`, commit, push.

What the database does: visitors can only call two functions, one to rate a beach and one to read averages. The ratings table itself is closed to the public API. One browser has one vote per beach, and one connection can send at most 60 ratings an hour. Only a hash of the address is stored for that limit.

Free Supabase projects pause after a week with no visits. The site keeps working while paused; ratings fall back to each visitor's device until you resume the project in the dashboard.

## Connect Google Maps for ratings and photos (optional, stays free)

Google's rating and review count need a Google Maps Platform key. Google requires a billing account for that key, so the site never talks to Google directly. A small Supabase Edge Function holds the key and counts every Google call in the database. Once a month's count reaches 900 it refuses, which keeps usage under Google's free 1,000 per month and the bill at zero.

| Google call | Google's free allowance | What the function allows |
|---|---|---|
| Find the beach on Google (Text Search, IDs only) | Unlimited | Unlimited, and each result is kept, as Google permits |
| Rating, review count, photo list (Place Details Enterprise) | 1,000 a month | 900 a month, 40 a day per connection |
| Each photo image (Place Details Photos) | 1,000 a month | 900 a month, 40 a day per connection |

Months follow Google's billing clock, US Pacific time. Past those limits, Google charges $20 per 1,000 rating lookups and $7 per 1,000 photos. The function stops well before that point.

Setup:

1. In Google Cloud Console, create a project, attach billing, enable **Places API (New)**, and create an API key. Under **API restrictions**, allow only Places API (New). Leave application restrictions off, because the calls come from Supabase's servers.
2. In Supabase, open **Edge Functions > Deploy a new function > Via Editor**. Name it `google-place`, paste all of [`supabase/functions/google-place/index.ts`](supabase/functions/google-place/index.ts), and deploy.
3. In the function's settings, turn **off** JWT verification ("Verify JWT"). The site sends the publishable key, which is not a JWT. The function checks the calling site instead, and the database limits above apply whoever calls.
4. Under **Edge Functions > Secrets**, add `GOOGLE_MAPS_API_KEY` with your key. Supabase supplies the project URL and service key to the function itself.
5. In [`config.js`](config.js), set `useGoogle: true`, commit, push.

Google's display rules are handled: the "Powered by Google" logo appears next to Google ratings and photos, each photo credits its author, and nothing Google returns is stored except place IDs. If you use the site from another address, add it to the function's optional `ALLOWED_ORIGINS` secret, comma separated.

## Flickr photos (optional)

Flickr only issues API keys to Flickr Pro accounts. With one, put the key in `config.js` as `flickrApiKey` and Flickr replaces the Wikimedia Commons part of the photos.

## When it feels slow

The page loads in well under a second. What can take long is the Overpass service that answers beach queries, a shared public service that sometimes replies "busy" or hangs. Hello Beaches asks several mirrors, re-asks a busy one after two seconds, skips one that timed out, and keeps a 24-hour cache, so repeat visits are instant.

## Run locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765. Location sharing needs HTTPS or localhost.

## Credits

Beach data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL. Map © [OpenMapTiles](https://www.openmaptiles.org/) via [OpenFreeMap](https://openfreemap.org). Photos from Wikimedia Commons and Wikipedia, credited on each file page. Missing a beach? Add it on OpenStreetMap and it shows up here.
