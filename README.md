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

## When it feels slow

The page loads in well under a second. What can take long is the Overpass service that answers beach queries: it is a shared public service and sometimes replies "busy" or hangs. Hello Beaches asks several mirrors, re-asks a busy one after two seconds, skips one that timed out, and keeps a 24-hour cache of searches, so repeat visits are instant.

## Run locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765. Location sharing needs HTTPS or localhost.

## Credits

Beach data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL. Map tiles by OpenStreetMap. Missing a beach? Add it on OSM and it shows up here.
