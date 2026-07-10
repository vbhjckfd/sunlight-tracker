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
const METERS_PER_LEVEL = 3;
/**
 * Buildings shorter than this can't meaningfully shade an observer (sheds,
 * garages, kiosks) and are ignored, as are buildings whose height OSM simply
 * doesn't know — guessing a height would produce confident-looking but made-up
 * "blocked" verdicts.
 */
const MIN_OBSTRUCTION_HEIGHT_M = 4;
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

/** Flat local projection (meters east, meters north) relative to the observer, good enough at building scale. */
function toLocalMeters(observerLat: number, observerLng: number, lat: number, lng: number): [number, number] {
  const dx = (lng - observerLng) * metersPerDegreeLng(observerLat);
  const dy = (lat - observerLat) * METERS_PER_DEGREE_LAT;
  return [dx, dy];
}

/** Bearing (degrees clockwise from north, matching SunCalc's azimuth convention) and distance in meters. */
function bearingDistanceTo(observerLat: number, observerLng: number, lat: number, lng: number): { bearingDeg: number; distanceM: number } {
  const [dx, dy] = toLocalMeters(observerLat, observerLng, lat, lng);
  const distanceM = Math.hypot(dx, dy);
  const bearingDeg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  return { bearingDeg, distanceM };
}

function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  return bearingDistanceTo(aLat, aLng, bLat, bLng).distanceM;
}

/** Distance from the origin to the segment (ax,ay)-(bx,by), all in local meters. */
function distanceToSegmentM(ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abLenSq = abx * abx + aby * aby;
  const t = abLenSq > 0 ? Math.max(0, Math.min(1, (-ax * abx + -ay * aby) / abLenSq)) : 0;
  const closestX = ax + t * abx;
  const closestY = ay + t * aby;
  return Math.hypot(closestX, closestY);
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

/** Parses OSM height tags: `tags.height` (meters, may have a trailing unit) → `building:levels` → null when unknown. */
function resolveHeightM(tags: Record<string, string> | undefined): number | null {
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
  return null;
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
  const buildings: Building[] = [];
  for (const el of data.elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 3) continue;
    const heightM = resolveHeightM(el.tags);
    if (heightM === null || heightM < MIN_OBSTRUCTION_HEIGHT_M) continue;
    buildings.push({
      footprint: el.geometry.map((p): L.LatLngTuple => [p.lat, p.lon]),
      heightM,
    });
  }
  return buildings;
}

/**
 * Debounced, cache-aware building fetch triggered on map moveend. Reuses the cached buildings if
 * the map hasn't moved close to the edge of the previously-fetched radius. Fails completely
 * silently on any network error or timeout — this is a "nice to have" overlay, never allowed to
 * disrupt core rendering. `onFetchStateChange` fires around the actual network request only (not
 * the debounce wait), so callers can show a "fetching" indicator.
 */
export function scheduleBuildingFetch(center: L.LatLngTuple, onUpdate: () => void, onFetchStateChange: (fetching: boolean) => void): void {
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

    onFetchStateChange(true);
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
        if (inFlightController === controller) {
          inFlightController = null;
          onFetchStateChange(false);
        }
      });
  }, MOVE_DEBOUNCE_MS);
}

interface EdgeSpan {
  min: number;
  max: number;
  nearestDistanceM: number;
}

/**
 * Angular span + nearest distance for a single polygon edge, as seen from the observer. Edges
 * (not whole polygons) are the right unit here: a large, close, non-convex building — e.g. a
 * courtyard apartment block the observer is standing right next to — can wrap most of the way
 * around the observer, so a single min/max bearing over *all* its vertices would (wrongly) claim
 * it blocks the sun from nearly every direction. A single wall segment never has that problem.
 */
function edgeSpans(observerLat: number, observerLng: number, footprint: L.LatLngTuple[]): EdgeSpan[] {
  const local = footprint.map(([lat, lng]) => toLocalMeters(observerLat, observerLng, lat, lng));
  const spans: EdgeSpan[] = [];

  for (let i = 0; i < local.length; i++) {
    const [ax, ay] = local[i];
    const [bx, by] = local[(i + 1) % local.length];
    const bearingA = ((Math.atan2(ax, ay) * 180) / Math.PI + 360) % 360;
    const bearingB = ((Math.atan2(bx, by) * 180) / Math.PI + 360) % 360;
    const unwrappedB = bearingA + (((bearingB - bearingA + 540) % 360) - 180);
    spans.push({
      min: Math.min(bearingA, unwrappedB),
      max: Math.max(bearingA, unwrappedB),
      nearestDistanceM: distanceToSegmentM(ax, ay, bx, by),
    });
  }

  return spans;
}

/** Does a building block the sun at `azimuthDeg`/`altitudeDeg` as seen from the observer? Returns the nearest match. */
export function findObstruction(observerLat: number, observerLng: number, azimuthDeg: number, altitudeDeg: number, buildings: Building[]): ObstructionResult | null {
  let nearest: ObstructionResult | null = null;

  for (const building of buildings) {
    if (isPointInPolygon(observerLat, observerLng, building.footprint)) continue; // the observer's own building

    for (const { min, max, nearestDistanceM } of edgeSpans(observerLat, observerLng, building.footprint)) {
      if (nearestDistanceM <= 0) continue;
      if (nearest && nearestDistanceM >= nearest.distanceM) continue; // already have a closer match

      // Bring azimuth into the same unwrapped window as [min, max] before comparing.
      const unwrappedAzimuth = min + (((azimuthDeg - min + 540) % 360) - 180);
      if (unwrappedAzimuth < min || unwrappedAzimuth > max) continue;

      const angularHeightDeg = (Math.atan2(building.heightM, nearestDistanceM) * 180) / Math.PI;
      if (altitudeDeg >= angularHeightDeg) continue;

      nearest = { building, distanceM: nearestDistanceM };
    }
  }

  return nearest;
}
