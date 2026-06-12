# Rainfall Tracker

Static browser app for tracking Met Eireann radar rain patches over a selected point.

## GitHub Pages

This app can be hosted directly from GitHub Pages. It does not require the Node server for production hosting.

1. Push this folder to a GitHub repository.
2. In the repository settings, open **Pages**.
3. Set the source to the repository root and the default branch.
4. Open the published Pages URL after deployment completes.

The app loads:

- Met Eireann radar metadata and tiles directly from `https://gdal.met.ie`.
- OpenStreetMap base tiles directly from `https://tile.openstreetmap.org`.
- Local Leaflet files from `vendor/`.

## Local Node Server

`server.js` is optional and only useful for local testing with proxy routes. GitHub Pages ignores it.

```bash
npm start
```
