# Hello Beaches

Nearest sand, sorted by distance.

A single-page beach finder: share your location, search a place, or tap the map, and Hello Beaches lists every beach within your chosen radius, closest first, with the direction it lies in and a one-tap link for directions.

## How it works

- **Beach data** comes live from OpenStreetMap (`natural=beach`) through the Overpass API. Several public mirrors are tried in parallel so one slow server does not stall the search.
- **Place search** uses Nominatim geocoding.
- **Photos**: selecting a beach shows, in this order, photos the mapper linked on the beach's OpenStreetMap entry, Wikipedia articles about the beach (English plus your browser language), and geo-tagged Wikimedia Commons files within 1 km ranked so beach-looking titles and categories come before the town behind them. With a Flickr API key in `config.js`, Flickr replaces the Commons part. Each photo links to its page for author and licence. Named beaches also get Wikipedia and Instagram links where available; Instagram has no public API for place photos, so that link is the closest ToS-compliant option.
- **Map** is Leaflet with OpenStreetMap tiles. Dark mode follows your system setting.
- No build step, no backend. Open `index.html` from any static host. The only optional key is Flickr's.

## Flickr photos

1. Create a key at https://www.flickr.com/services/apps/create/ (non-commercial).
2. Put it in `config.js` as `flickrApiKey`, commit, push. Pages redeploys in under a minute.

The key sits in a public page, which is how Flickr's client-side apps work; do not reuse a secret.

## Google photos as a fallback (optional)

When the free sources have nothing that looks like the beach, Hello Beaches can ask Google Maps for the beach's photos. It only does so if `googleMapsApiKey` is set in `config.js`. Three things keep this free:

1. **Only photo image loads are metered.** The search that finds the beach and the details call that lists its photos are sent with "IDs only" field masks, which Google prices as unlimited free. Each photo image is one "Place Details Photos" event: 1,000 free per month, then $7 per 1,000.
2. **The app rations itself.** At most `googlePhotoLimit` photos per beach (default 2), `googleDailyBudget` photo loads per browser per day (default 20), and every lookup is cached for 30 days.
3. **A quota cap in Google Cloud makes overspend impossible.** A browser-side limit cannot stop someone who copies the key, so set the cap:
   - Cloud Console → APIs & Services → Places API (New) → Quotas & System Limits.
   - Find the "Requests per day" row for photos (named like "Place Photos requests per day"). If your console only shows one overall "Requests per day", cap that one instead.
   - Edit it to **30**. 30 × 31 days = 930, under the 1,000 free photo loads. Google warns that enforcement lags a little, so do not set it to 32.
   - Once the cap is reached, Google returns an error and the app quietly shows the free sources only. Nothing is billed.

Set up the key like this: create a Cloud project with billing enabled (required even at zero cost), enable **Places API (New)**, create an API key, restrict it to **Websites** with `https://suatbatu.github.io/*`, and restrict it to the Places API (New) only. Then put it in `config.js`, commit, push.

Google's display rules are handled: the Google logo appears next to any Google photo, and each photo shows its author.

## When it feels slow

The page loads in well under a second. What can take long is the Overpass service that answers beach queries: it is a shared public service and sometimes replies "busy" or hangs. Hello Beaches asks several mirrors, re-asks a busy one after two seconds, skips one that timed out, and keeps a 24-hour cache of searches, so repeat visits are instant.

## Run locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765. Location sharing needs HTTPS or localhost.

## Credits

Beach data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL. Map tiles by OpenStreetMap. Missing a beach? Add it on OSM and it shows up here.
