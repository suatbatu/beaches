# Beaches

Nearest sand, sorted by distance.

A single-page beach finder: share your location, search a place, or tap the map, and Beaches lists every beach within your chosen radius, closest first, with the direction it lies in and a one-tap link for directions.

## How it works

- **Beach data** comes live from OpenStreetMap (`natural=beach`) through the Overpass API. Several public mirrors are tried in parallel so one slow server does not stall the search.
- **Place search** uses Nominatim geocoding.
- **Photos**: selecting a beach loads geo-tagged photos taken within 600 m of it from Wikimedia Commons, with a link to each file page for author and licence. Named beaches also get an Instagram hashtag link; Instagram has no public API for place photos, so that link is the closest ToS-compliant option.
- **Map** is Leaflet with OpenStreetMap tiles. Dark mode follows your system setting.
- No build step, no API keys, no backend. Open `index.html` from any static host.

## Run locally

```bash
python3 -m http.server 8765
```

Then open http://localhost:8765. Location sharing needs HTTPS or localhost.

## Credits

Beach data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL. Map tiles by OpenStreetMap. Missing a beach? Add it on OSM and it shows up here.
