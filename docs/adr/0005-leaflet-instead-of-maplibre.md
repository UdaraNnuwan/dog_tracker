# ADR 0005: Leaflet instead of MapLibre GL

- Status: Accepted
- Date: 2026-10-19

## Context

CLAUDE.md chose MapLibre GL with OSM tiles. MapLibre v6 requires **WebGL2**. On the owner's
machine (Linux, Chrome on Wayland) WebGL2 isn't available, and the map failed with "WebGL2 is
required to display this map". Dog owners will open the app on all kinds of phones and laptops,
so the map must not depend on GPU features.

## Decision

Use **Leaflet 1.9** (DOM/SVG rendering, no WebGL) with the same OSM raster tiles.

## Consequences

- The map works on any browser, including ones with hardware acceleration off.
- The web bundle shrinks from about 362 KiB to about 116 KiB gzip, and the MapLibre worker
  bundling workaround is gone.
- We lose vector tiles, smooth rotation/3D and GPU rendering of very large point sets. None of
  these are needed for tracking a handful of collars. If they are needed later, MapLibre can be
  added behind a WebGL2 feature check with Leaflet as the fallback.
- OSM's public tiles are for light use only (OSM tile usage policy). Before production, switch to
  a tile provider that suits the traffic.
