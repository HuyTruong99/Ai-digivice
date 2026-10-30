// lib/pois.ts — known buildings Digi should recognize.
// To get coordinates: open Apple Maps or Google Maps, long-press on the building,
// copy the two numbers shown (lat, lng) and paste them below.

export type POI = {
  name: string;     // what Digi calls it
  role: string;     // how it relates to Huy: home, library, classes, lab, dining, gym...
  lat: number;
  lng: number;
  radiusM?: number; // how close you must be to count as "here" (default 60 m)
};

export const CAMPUS_POIS: POI[] = [
  // TODO: replace 0, 0 with real coordinates
  { name: 'Ivy Dorm',                 role: 'home',     lat: 0, lng: 0, radiusM: 60 },
  { name: 'Claire T. Carney Library', role: 'library',  lat: 0, lng: 0, radiusM: 70 },
  { name: 'Campus Center',            role: 'dining',   lat: 0, lng: 0, radiusM: 70 },
  { name: 'Dion Building',            role: 'classes',  lat: 0, lng: 0, radiusM: 70 },
  { name: 'Textile Building',         role: 'lab',      lat: 0, lng: 0, radiusM: 70 },
];

export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371e3;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat);
  const dφ = toRad(b.lat - a.lat), dλ = toRad(b.lng - a.lng);
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Returns the closest known building you're inside of, or null. */
export function nearestPOI(lat: number, lng: number): POI | null {
  let best: POI | null = null;
  let bestD = Infinity;
  for (const p of CAMPUS_POIS) {
    if (p.lat === 0 && p.lng === 0) continue; // skip unfilled entries
    const d = distanceMeters({ lat, lng }, p);
    if (d < (p.radiusM ?? 60) && d < bestD) { best = p; bestD = d; }
  }
  return best;
}