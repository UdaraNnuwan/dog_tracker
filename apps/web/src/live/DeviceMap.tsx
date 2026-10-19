import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import { connectivity, type DeviceView } from "./model.js";

/** OpenStreetMap raster tiles (free, attribution required; fine for development volumes). */
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

/** An extra point, e.g. a `response/location` fix or where a geofence event happened. */
export interface MapPin {
  latitude: number;
  longitude: number;
  label: string;
}

interface Props {
  devices: DeviceView[];
  selectedId: string | null;
  onSelect: (deviceId: string) => void;
  pins?: MapPin[];
}

interface DeviceMarker {
  marker: L.Marker;
  el: HTMLButtonElement;
}

/** Trail points are stored [lon, lat] (GeoJSON order); Leaflet wants [lat, lon]. */
const toLatLng = ([lon, lat]: [number, number]): L.LatLngTuple => [lat, lon];

/**
 * All devices as markers; the selected one also shows its trail and is kept in view.
 * Leaflet (DOM/SVG, no WebGL) so it renders on any browser (ADR 0005).
 */
export function DeviceMap({ devices, selectedId, onSelect, pins }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const trail = useRef<L.Polyline | null>(null);
  const pinLayer = useRef<L.LayerGroup | null>(null);
  const markers = useRef(new Map<string, DeviceMarker>());
  const followed = useRef<string | null>(null);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useEffect(() => {
    if (!container.current) return;
    const m = L.map(container.current).setView([6.9271, 79.8612], 14);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(m);
    trail.current = L.polyline([], { color: "#2563eb", weight: 3, opacity: 0.7 }).addTo(m);
    pinLayer.current = L.layerGroup().addTo(m);
    map.current = m;
    const owned = markers.current;
    return () => {
      owned.clear();
      m.remove();
      map.current = null;
      trail.current = null;
      pinLayer.current = null;
    };
  }, []);

  // Markers: create, move and restyle per device.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set<string>();
    for (const d of devices) {
      const point = d.trail.at(-1);
      if (!point) continue;
      seen.add(d.deviceId);
      let entry = markers.current.get(d.deviceId);
      if (!entry) {
        const el = document.createElement("button");
        el.className = "marker";
        el.type = "button";
        el.textContent = d.deviceId;
        el.addEventListener("click", () => onSelectRef.current(d.deviceId));
        const icon = L.divIcon({ html: el, className: "marker-icon" });
        entry = { marker: L.marker(toLatLng(point), { icon }).addTo(m), el };
        markers.current.set(d.deviceId, entry);
      }
      entry.marker.setLatLng(toLatLng(point));
      entry.el.dataset.state = connectivity(d);
      entry.el.classList.toggle("selected", d.deviceId === selectedId);
      entry.marker.setZIndexOffset(d.deviceId === selectedId ? 1000 : 0);
    }
    for (const [id, entry] of markers.current) {
      if (!seen.has(id)) {
        entry.marker.remove();
        markers.current.delete(id);
      }
    }
  }, [devices, selectedId]);

  // Trail + camera for the selected device.
  useEffect(() => {
    const m = map.current;
    const selected = devices.find((d) => d.deviceId === selectedId);
    if (!m || !selected) return;
    trail.current?.setLatLngs(selected.trail.map(toLatLng));

    const point = selected.trail.at(-1);
    if (!point) return;
    if (followed.current !== selectedId) {
      followed.current = selectedId;
      m.flyTo(toLatLng(point), 16, { duration: 0.8 });
    } else if (!m.getBounds().contains(toLatLng(point))) {
      m.panTo(toLatLng(point));
    }
  }, [devices, selectedId]);

  // Extra pins, newest first: the newest is bigger and brought into view.
  useEffect(() => {
    const layer = pinLayer.current;
    const m = map.current;
    if (!layer || !m) return;
    layer.clearLayers();
    (pins ?? []).forEach((p, i) => {
      L.circleMarker([p.latitude, p.longitude], {
        radius: i === 0 ? 8 : 5,
        color: "#b45309",
        weight: 2,
        fillOpacity: i === 0 ? 0.8 : 0.4,
      })
        .bindTooltip(p.label)
        .addTo(layer);
    });
    const newest = pins?.[0];
    if (newest && !m.getBounds().contains([newest.latitude, newest.longitude])) {
      m.panTo([newest.latitude, newest.longitude]);
    }
  }, [pins]);

  return <div ref={container} className="map" />;
}
