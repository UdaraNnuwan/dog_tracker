const EARTH_RADIUS_M = 6_371_000;
const rad = (deg: number) => (deg * Math.PI) / 180;

export interface LatLon {
  latitude: number;
  longitude: number;
}

/** Great-circle distance in metres (haversine). */
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Move `distance` metres from `from` on compass `bearingDeg` (flat-earth, fine for metres). */
export function offset(from: LatLon, distance: number, bearingDeg: number): LatLon {
  const dNorth = distance * Math.cos(rad(bearingDeg));
  const dEast = distance * Math.sin(rad(bearingDeg));
  return {
    latitude: from.latitude + (dNorth / EARTH_RADIUS_M) * (180 / Math.PI),
    longitude:
      from.longitude + (dEast / (EARTH_RADIUS_M * Math.cos(rad(from.latitude)))) * (180 / Math.PI),
  };
}

/** Compass bearing from `a` to `b` in degrees, 0..360. */
export function bearing(a: LatLon, b: LatLon): number {
  const y = Math.sin(rad(b.longitude - a.longitude)) * Math.cos(rad(b.latitude));
  const x =
    Math.cos(rad(a.latitude)) * Math.sin(rad(b.latitude)) -
    Math.sin(rad(a.latitude)) *
      Math.cos(rad(b.latitude)) *
      Math.cos(rad(b.longitude - a.longitude));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export const round = (n: number, digits: number) => Number(n.toFixed(digits));
