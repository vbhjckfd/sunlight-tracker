import type * as L from "leaflet";

export interface Building {
  footprint: L.LatLngTuple[];
  heightM: number;
}

export interface ObstructionResult {
  building: Building;
  distanceM: number;
}

const FETCH_RADIUS_M = 300;
/** Only refetch once the map has moved close enough to the edge of the cached radius to matter. */
const REFETCH_MARGIN_M = 80;
const MOVE_DEBOUNCE_MS = 800;
const FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_BUILDING_HEIGHT_M = 6; // ~2 stories, used when OSM has no height/levels tag
const METERS_PER_LEVEL = 3;
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

let cachedBuildings: Building[] = [];
let cachedCenter: L.LatLngTuple | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let inFlightController: AbortController | null = null;

export function getCachedBuildings(): Building[] {
  return cachedBuildings;
}

/** Meters per degree of longitude at `lat` (meters per degree of latitude is ~constant). */
function metersPerDegreeLng(lat: number): number {
  return 111_320 * Math.cos((lat * Math.PI) / 180);
}

const METERS_PER_DEGREE_LAT = 111_320;

/** Bearing (degrees clockwise from north, matching SunCalc's azimuth convention) and distance in meters. */
function bearingDistanceTo(observerLat: number, observerLng: number, lat: number, lng: number): { bearingDeg: number; distanceM: number } {
  const dx = (lng - observerLng) * metersPerDegreeLng(observerLat);
  const dy = (lat - observerLat) * METERS_PER_DEGREE_LAT;
  const distanceM = Math.hypot(dx, dy);
  const bearingDeg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  return { bearingDeg, distanceM };
}

function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  return bearingDistanceTo(aLat, aLng, bLat, bLng).distanceM;
}

/** Ray-casting point-in-polygon test, used to exclude the building the observer's own pin sits inside. */
function isPointInPolygon(lat: number, lng: number, footprint: L.LatLngTuple[]): boolean {
  let inside = false;
  for (let i = 0, j = footprint.length - 1; i < footprint.length; j = i++) {
    const [latI, lngI] = footprint[i];
    const [latJ, lngJ] = footprint[j];
    const intersects = latI > lat !== latJ > lat && lng < ((lngJ - lngI) * (lat - latI)) / (latJ - latI) + lngI;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Parses OSM height tags: `tags.height` (meters, may have a trailing unit) → `building:levels` → a fallback default. */
function resolveHeightM(tags: Record<string, string> | undefined): number {
  const heightTag = tags?.height;
  if (heightTag) {
    const meters = Number.parseFloat(heightTag);
    if (Number.isFinite(meters) && meters > 0) return meters;
  }
  const levelsTag = tags?.["building:levels"];
  if (levelsTag) {
    const levels = Number.parseFloat(levelsTag);
    if (Number.isFinite(levels) && levels > 0) return levels * METERS_PER_LEVEL;
  }
  return DEFAULT_BUILDING_HEIGHT_M;
}

interface OverpassElement {
  type: string;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

async function fetchBuildingsFromOverpass(lat: number, lng: number, radiusM: number, signal: AbortSignal): Promise<Building[]> {
  const query = `[out:json][timeout:15];way["building"](around:${radiusM},${lat},${lng});out geom;`;
  const response = await fetch(OVERPASS_URL, {
    method: "POST",
    body: `data=${encodeURIComponent(query)}`,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal,
  });
  if (!response.ok) throw new Error(`Overpass request failed: ${response.status}`);
  const data: { elements: OverpassElement[] } = await response.json();
  return data.elements
    .filter((el) => el.type === "way" && el.geometry && el.geometry.length >= 3)
    .map((el) => ({
      footprint: el.geometry!.map((p): L.LatLngTuple => [p.lat, p.lon]),
      heightM: resolveHeightM(el.tags),
    }));
}

/**
 * Debounced, cache-aware building fetch triggered on map moveend. Reuses the cached buildings if
 * the map hasn't moved close to the edge of the previously-fetched radius. Fails completely
 * silently on any network error or timeout — this is a "nice to have" overlay, never allowed to
 * disrupt core rendering.
 */
export function scheduleBuildingFetch(center: L.LatLngTuple, onUpdate: () => void): void {
  if (cachedCenter && distanceMeters(center[0], center[1], cachedCenter[0], cachedCenter[1]) < FETCH_RADIUS_M - REFETCH_MARGIN_M) {
    return;
  }

  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    inFlightController?.abort();
    const controller = new AbortController();
    inFlightController = controller;
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    fetchBuildingsFromOverpass(center[0], center[1], FETCH_RADIUS_M, controller.signal)
      .then((buildings) => {
        cachedBuildings = buildings;
        cachedCenter = center;
        onUpdate();
      })
      .catch(() => {
        // Overpass is known to be flaky/rate-limited in practice; silently keep the old cache.
      })
      .finally(() => {
        clearTimeout(timeoutId);
        if (inFlightController === controller) inFlightController = null;
      });
  }, MOVE_DEBOUNCE_MS);
}

/** Unwraps bearings relative to the footprint's first vertex so a min/max span works across the 0/360 seam. */
function bearingSpan(observerLat: number, observerLng: number, footprint: L.LatLngTuple[]): { min: number; max: number; nearestDistanceM: number } {
  const first = bearingDistanceTo(observerLat, observerLng, footprint[0][0], footprint[0][1]);
  let min = first.bearingDeg;
  let max = first.bearingDeg;
  let nearestDistanceM = first.distanceM;

  for (let i = 1; i < footprint.length; i++) {
    const { bearingDeg, distanceM } = bearingDistanceTo(observerLat, observerLng, footprint[i][0], footprint[i][1]);
    const unwrapped = first.bearingDeg + (((bearingDeg - first.bearingDeg + 540) % 360) - 180);
    min = Math.min(min, unwrapped);
    max = Math.max(max, unwrapped);
    nearestDistanceM = Math.min(nearestDistanceM, distanceM);
  }

  return { min, max, nearestDistanceM };
}

/** Does a building block the sun at `azimuthDeg`/`altitudeDeg` as seen from the observer? Returns the nearest match. */
export function findObstruction(observerLat: number, observerLng: number, azimuthDeg: number, altitudeDeg: number, buildings: Building[]): ObstructionResult | null {
  let nearest: ObstructionResult | null = null;

  for (const building of buildings) {
    if (isPointInPolygon(observerLat, observerLng, building.footprint)) continue; // the observer's own building

    const { min, max, nearestDistanceM } = bearingSpan(observerLat, observerLng, building.footprint);
    if (nearestDistanceM <= 0) continue;

    // Bring azimuth into the same unwrapped window as [min, max] before comparing.
    const unwrappedAzimuth = min + (((azimuthDeg - min + 540) % 360) - 180);
    if (unwrappedAzimuth < min || unwrappedAzimuth > max) continue;

    const angularHeightDeg = (Math.atan2(building.heightM, nearestDistanceM) * 180) / Math.PI;
    if (altitudeDeg >= angularHeightDeg) continue;

    if (!nearest || nearestDistanceM < nearest.distanceM) {
      nearest = { building, distanceM: nearestDistanceM };
    }
  }

  return nearest;
}
