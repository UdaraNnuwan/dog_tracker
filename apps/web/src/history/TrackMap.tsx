import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import type { GpsRow } from "../api.js";

const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

interface Props {
  points: GpsRow[];
  /** Index into `points` to highlight (e.g. the hovered table row). */
  focus: number | null;
}

/** A stored track: line, start (green) and end (red) markers, fitted to view (ADR 0005). */
export function TrackMap({ points, focus }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const focusMarker = useRef<L.CircleMarker | null>(null);

  useEffect(() => {
    if (!container.current) return;
    const m = L.map(container.current).setView([6.9271, 79.8612], 13);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    const group = layer.current;
    if (!m || !group) return;
    group.clearLayers();
    focusMarker.current = null;
    const latlngs = points.map((p) => [p.latitude, p.longitude] as L.LatLngTuple);
    const first = latlngs[0];
    const last = latlngs.at(-1);
    if (!first || !last) return;
    L.polyline(latlngs, { color: "#2563eb", weight: 3, opacity: 0.8 }).addTo(group);
    L.circleMarker(first, { radius: 7, color: "#fff", fillColor: "#15803d", fillOpacity: 1 })
      .bindTooltip("start")
      .addTo(group);
    L.circleMarker(last, { radius: 7, color: "#fff", fillColor: "#b91c1c", fillOpacity: 1 })
      .bindTooltip("end")
      .addTo(group);
    // No animation: a zoom animation started while React re-renders can be left half-applied.
    m.fitBounds(L.latLngBounds(latlngs), { padding: [24, 24], maxZoom: 17, animate: false });
  }, [points]);

  useEffect(() => {
    const m = map.current;
    const p = focus === null ? undefined : points[focus];
    focusMarker.current?.remove();
    focusMarker.current = null;
    if (!m || !p) return;
    focusMarker.current = L.circleMarker([p.latitude, p.longitude], {
      radius: 9,
      color: "#f59e0b",
      weight: 3,
      fillOpacity: 0,
    }).addTo(m);
  }, [focus, points]);

  return <div ref={container} className="map" />;
}
