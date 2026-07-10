import "leaflet/dist/leaflet.css";
import "./style.css";
import * as L from "leaflet";
import { getSunPosition, getSunTimes } from "./sunPosition.ts";
import { resolveTimeZone, wallTimeToUtc, utcToZonedMinutesOfDay, formatUtcOffsetLabel, formatZonedDateInput } from "./timezone.ts";
import { createPlayback } from "./playback.ts";
import { scheduleBuildingFetch, getCachedBuildings, findObstruction, type Building } from "./buildingShadows.ts";
import { pickLanguage, getStrings } from "./i18n.ts";

// Language comes from the browser's preference list; English is the fallback.
const lang = pickLanguage(navigator.languages ?? [navigator.language]);
const t = getStrings(lang);
document.documentElement.lang = lang;

const mapEl = document.querySelector<HTMLDivElement>("#map")!;
const sunBeamsSvg = document.querySelector<SVGSVGElement>("#sun-beams")!;
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const datePicker = document.querySelector<HTMLInputElement>("#date-picker")!;
const hourPicker = document.querySelector<HTMLInputElement>("#hour-picker")!;
const hourValue = document.querySelector<HTMLSpanElement>("#hour-value")!;
const tzLabel = document.querySelector<HTMLSpanElement>("#tz-label")!;
const locateBtn = document.querySelector<HTMLButtonElement>("#locate-btn")!;
const playBtn = document.querySelector<HTMLButtonElement>("#play-btn")!;
const buildingsSpinner = document.querySelector<HTMLDivElement>("#buildings-spinner")!;
const copyLinkBtn = document.querySelector<HTMLButtonElement>("#copy-link-btn")!;
const shadowsCheckbox = document.querySelector<HTMLInputElement>("#shadows-checkbox")!;
const solarNoonMarker = document.querySelector<HTMLDivElement>("#solar-noon-marker")!;
const sunriseMarker = document.querySelector<HTMLButtonElement>("#sunrise-marker")!;
const sunsetMarker = document.querySelector<HTMLButtonElement>("#sunset-marker")!;
const BEAM_COUNT = 4;
const beamLines = Array.from({ length: BEAM_COUNT }, (_, i) =>
  document.querySelector<SVGLineElement>(`#beam-${i}`)!,
);

// Static UI text ships in English in index.html; swap it to the picked language.
document.querySelector<HTMLSpanElement>("#date-label")!.textContent = t.dateLabel;
document.querySelector<HTMLSpanElement>("#time-label")!.textContent = t.timeLabel;
document.querySelector<HTMLSpanElement>("#shadows-label")!.textContent = t.shadowsLabel;
document.querySelector<HTMLElement>("#location-pin")!.title = t.pinTitle;
document.querySelector<HTMLElement>("#shadows-toggle")!.title = t.shadowsTitle;
locateBtn.title = t.locateTitle;
playBtn.title = t.playTitle;
buildingsSpinner.title = t.fetchingBuildings;
copyLinkBtn.title = t.copyLinkTitle;
solarNoonMarker.title = t.solarNoonTitle;
sunriseMarker.title = t.sunriseTitle;
sunsetMarker.title = t.sunsetTitle;

const DEFAULT_CENTER: L.LatLngTuple = [48.3794, 31.1656];
const STORAGE_KEY = "sunlight-tracker:last-location";

function isValidLatLng(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function centerFromQuery(): L.LatLngTuple | null {
  const params = new URLSearchParams(window.location.search);
  const latParam = params.get("lat");
  const lngParam = params.get("lng");
  if (latParam === null || lngParam === null) return null;
  const lat = Number(latParam);
  const lng = Number(lngParam);
  return isValidLatLng(lat, lng) ? [lat, lng] : null;
}

interface StoredView {
  lat: number;
  lng: number;
  date?: string;
  minutes?: number;
  shadows?: boolean;
}

function readStoredView(): StoredView | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { lat, lng, date, minutes, shadows } = JSON.parse(raw);
    if (!isValidLatLng(lat, lng)) return null;
    return {
      lat,
      lng,
      date: typeof date === "string" ? date : undefined,
      minutes: Number.isInteger(minutes) && minutes >= 0 && minutes <= 1439 ? minutes : undefined,
      shadows: typeof shadows === "boolean" ? shadows : undefined,
    };
  } catch {
    return null;
  }
}

/** `date=YYYY-MM-DD` from the URL, if present and well-formed. */
function dateFromQuery(): string | null {
  const date = new URLSearchParams(window.location.search).get("date");
  return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

/**
 * Coarse, permission-free location guess from the visitor's IP address.
 * Good enough to drop them in the right city on a first visit; no browser
 * geolocation prompt involved.
 */
async function geolocateByIp(): Promise<L.LatLngTuple | null> {
  try {
    const response = await fetch("https://ipwho.is/");
    if (!response.ok) return null;
    const data = await response.json();
    if (!data.success) return null;
    const lat = Number(data.latitude);
    const lng = Number(data.longitude);
    return isValidLatLng(lat, lng) ? [lat, lng] : null;
  } catch {
    return null;
  }
}

/** City-level zoom appropriate for the coarse accuracy of IP-based geolocation. */
const IP_GEOLOCATION_ZOOM = 10;

/**
 * Keeps the URL query params and localStorage in sync with the map center and selected date.
 * Time of day is intentionally left out of the URL (so a shared link doesn't lock in a specific
 * moment) but is still remembered in localStorage for this device.
 */
function persistViewState(): void {
  const center = map.getCenter();
  const url = new URL(window.location.href);
  url.searchParams.set("lat", center.lat.toFixed(5));
  url.searchParams.set("lng", center.lng.toFixed(5));
  url.searchParams.set("date", datePicker.value);
  url.searchParams.delete("t");
  window.history.replaceState(null, "", url);
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      lat: center.lat,
      lng: center.lng,
      date: datePicker.value,
      minutes: Number(hourPicker.value),
      shadows: shadowsCheckbox.checked,
    }),
  );
}

const MAX_ZOOM = 19;
/** One level below max: close enough to see the house, without maxing out. */
const LOCATE_ZOOM = MAX_ZOOM - 1;

const queryCenter = centerFromQuery();
const storedView = queryCenter ? null : readStoredView();
const storageCenter: L.LatLngTuple | null = storedView ? [storedView.lat, storedView.lng] : null;
const queryDate = dateFromQuery();

const map = L.map(mapEl, { zoomControl: true, doubleClickZoom: "center", touchZoom: "center" }).setView(
  queryCenter ?? storageCenter ?? DEFAULT_CENTER,
  queryCenter ? 17 : 6,
);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: MAX_ZOOM,
}).addTo(map);

// First visit, no stored location: try a quick IP-based guess instead of the world-view default.
if (!queryCenter && !storageCenter) {
  const centerBeforeLookup = map.getCenter();
  geolocateByIp().then((ipCenter) => {
    if (!ipCenter) return;
    const current = map.getCenter();
    const userAlreadyMoved =
      Math.abs(current.lat - centerBeforeLookup.lat) > 1e-6 || Math.abs(current.lng - centerBeforeLookup.lng) > 1e-6;
    if (!userAlreadyMoved) {
      map.setView(ipCenter, IP_GEOLOCATION_ZOOM);
    }
  });
}

function minutesToLabel(minutes: number): string {
  const h = Math.floor(minutes / 60)
    .toString()
    .padStart(2, "0");
  const m = (minutes % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

/** The date/time picked, interpreted as local wall-clock time at `timeZone` (the map pin's zone). */
function selectedDate(timeZone: string): Date {
  const [year, month, day] = datePicker.value.split("-").map(Number);
  const minutes = Number(hourPicker.value);
  return wallTimeToUtc(year, month, day, Math.floor(minutes / 60), minutes % 60, timeZone);
}

const BEAM_HORIZON_COLOR: [number, number, number] = [255, 214, 64]; // yellow, near the horizon
const BEAM_ZENITH_COLOR: [number, number, number] = [200, 30, 24]; // deep red, overhead
/** Fraction of the map's shorter side spanned by the outermost beams. */
const BEAM_SPREAD_RATIO = 0.12;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Yellow near the horizon, deepening to red overhead. */
function altitudeToBeamColor(altitudeDeg: number): string {
  const t = Math.min(altitudeDeg, 90) / 90;
  const [r, g, b] = BEAM_HORIZON_COLOR.map((horizon, i) => Math.round(lerp(horizon, BEAM_ZENITH_COLOR[i], t)));
  return `rgb(${r}, ${g}, ${b})`;
}

/** Draw 4 parallel beams from off the map edge, in the sun's direction, converging on the house. */
function renderSunBeams(azimuthDeg: number, altitudeDeg: number): void {
  const width = mapEl.clientWidth;
  const height = mapEl.clientHeight;
  sunBeamsSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const cx = width / 2;
  const cy = height / 2;
  const azimuthRad = (azimuthDeg * Math.PI) / 180;
  const dirX = Math.sin(azimuthRad);
  const dirY = -Math.cos(azimuthRad);
  const perpX = -dirY;
  const perpY = dirX;

  const farDistance = Math.hypot(width, height);
  const maxOffset = Math.min(width, height) * BEAM_SPREAD_RATIO;
  const color = altitudeToBeamColor(altitudeDeg);

  beamLines.forEach((line, i) => {
    const t = (i / (BEAM_COUNT - 1)) * 2 - 1; // -1..1, evenly spaced
    const offset = t * maxOffset;
    line.setAttribute("x1", String(cx + dirX * farDistance + perpX * offset));
    line.setAttribute("y1", String(cy + dirY * farDistance + perpY * offset));
    line.setAttribute("x2", String(cx + perpX * offset));
    line.setAttribute("y2", String(cy + perpY * offset));
    line.setAttribute("stroke", color);
  });
}

let obstructionLayer: L.Polygon | null = null;

/** Outline the building that's currently blocking the sun. */
function showObstructionHighlight(building: Building): void {
  if (obstructionLayer) {
    obstructionLayer.setLatLngs(building.footprint);
  } else {
    obstructionLayer = L.polygon(building.footprint, {
      color: "#ef4444",
      weight: 2,
      fillOpacity: 0.15,
      interactive: false,
    }).addTo(map);
  }
}

function clearObstructionHighlight(): void {
  if (!obstructionLayer) return;
  obstructionLayer.remove();
  obstructionLayer = null;
}

/** Position a marker below the time slider at the point matching the given instant, in `timeZone`. */
function placeTimeMarker(el: HTMLElement, time: Date | null, timeZone: string): void {
  if (!time || Number.isNaN(time.getTime())) {
    el.style.display = "none";
    return;
  }
  const minutes = utcToZonedMinutesOfDay(time, timeZone);
  const percent = (minutes / Number(hourPicker.max)) * 100;
  el.style.display = "block";
  el.style.left = `${percent}%`;
}

/** Slide the sunrise/solar-noon/sunset markers below the time slider to match today's sun times. */
function setTimeMarkers(date: Date, lat: number, lng: number, timeZone: string): void {
  const { sunrise, solarNoon, sunset } = getSunTimes(date, lat, lng);
  placeTimeMarker(solarNoonMarker, solarNoon, timeZone);
  placeTimeMarker(sunriseMarker, sunrise, timeZone);
  placeTimeMarker(sunsetMarker, sunset, timeZone);
}

/** Apply a new minutes-of-day selection, persist it, and re-render. */
function applyMinutes(minutes: number): void {
  hourPicker.value = String(minutes);
  hourValue.textContent = minutesToLabel(minutes);
  persistViewState();
  render();
}

/**
 * Nudge applied when jumping to sunrise (+) or sunset (−), so the sun sits just
 * above the horizon and the beams are actually visible on the map, instead of
 * landing exactly on the below-horizon rise/set instant.
 */
const SUN_EVENT_NUDGE_MINUTES = 15;

/** Jump the time slider to the given instant (in `timeZone`), optionally nudged, and re-render. */
function jumpToTime(time: Date | null, timeZone: string, nudgeMinutes = 0): void {
  if (!time || Number.isNaN(time.getTime())) return;
  const minutes = utcToZonedMinutesOfDay(time, timeZone) + nudgeMinutes;
  applyMinutes(Math.max(0, Math.min(Number(hourPicker.max), minutes)));
}

function render(): void {
  const center = map.getCenter();
  const timeZone = resolveTimeZone(center.lat, center.lng);
  const date = selectedDate(timeZone);
  const { azimuthDeg, altitudeDeg } = getSunPosition(date, center.lat, center.lng);
  setTimeMarkers(date, center.lat, center.lng, timeZone);
  tzLabel.textContent = formatUtcOffsetLabel(date, timeZone);

  const belowHorizon = altitudeDeg <= 0;
  sunBeamsSvg.style.display = belowHorizon ? "none" : "block";
  statusEl.classList.toggle("sun-down", belowHorizon);

  if (belowHorizon) {
    statusEl.textContent = t.sunDown;
    clearObstructionHighlight();
    return;
  }

  renderSunBeams(azimuthDeg, altitudeDeg);

  const obstruction = shadowsCheckbox.checked
    ? findObstruction(center.lat, center.lng, azimuthDeg, altitudeDeg, getCachedBuildings())
    : null;
  beamLines.forEach((line) => line.classList.toggle("blocked", obstruction !== null));

  if (obstruction) {
    statusEl.textContent = `${center.lat.toFixed(2)}, ${center.lng.toFixed(2)} — ${t.blockedByBuilding(Math.round(obstruction.distanceM))}`;
    showObstructionHighlight(obstruction.building);
  } else {
    statusEl.textContent = `${center.lat.toFixed(2)}, ${center.lng.toFixed(2)} — ${t.altitude(altitudeDeg.toFixed(0))}`;
    clearObstructionHighlight();
  }
}

const PLAYBACK_STEP_MINUTES = 15;
const PLAYBACK_INTERVAL_MS = 350;
const playback = createPlayback({
  getMinutes: () => Number(hourPicker.value),
  setMinutes: applyMinutes,
  stepMinutes: PLAYBACK_STEP_MINUTES,
  maxMinutes: Number(hourPicker.max),
  intervalMs: PLAYBACK_INTERVAL_MS,
  onStop: () => playBtn.classList.remove("playing"),
});

const initialTimeZone = resolveTimeZone(map.getCenter().lat, map.getCenter().lng);
const now = new Date();
datePicker.value = queryDate ?? storedView?.date ?? formatZonedDateInput(now, initialTimeZone);
const initialMinutes = storedView?.minutes ?? utcToZonedMinutesOfDay(now, initialTimeZone);
hourPicker.value = String(initialMinutes);
hourValue.textContent = minutesToLabel(initialMinutes);
// Building shadows are experimental (BETA): off unless the user opted in before.
shadowsCheckbox.checked = storedView?.shadows ?? false;

datePicker.addEventListener("input", () => {
  playback.stop();
  persistViewState();
  render();
});
hourPicker.addEventListener("pointerdown", () => playback.stop());
hourPicker.addEventListener("input", () => {
  applyMinutes(Number(hourPicker.value));
});
playBtn.addEventListener("click", () => {
  playback.toggle();
  playBtn.classList.toggle("playing", playback.isPlaying());
});
solarNoonMarker.addEventListener("click", () => {
  playback.stop();
  const center = map.getCenter();
  const timeZone = resolveTimeZone(center.lat, center.lng);
  jumpToTime(getSunTimes(selectedDate(timeZone), center.lat, center.lng).solarNoon, timeZone);
});
sunriseMarker.addEventListener("click", () => {
  playback.stop();
  const center = map.getCenter();
  const timeZone = resolveTimeZone(center.lat, center.lng);
  jumpToTime(getSunTimes(selectedDate(timeZone), center.lat, center.lng).sunrise, timeZone, SUN_EVENT_NUDGE_MINUTES);
});
sunsetMarker.addEventListener("click", () => {
  playback.stop();
  const center = map.getCenter();
  const timeZone = resolveTimeZone(center.lat, center.lng);
  jumpToTime(getSunTimes(selectedDate(timeZone), center.lat, center.lng).sunset, timeZone, -SUN_EVENT_NUDGE_MINUTES);
});
function setBuildingsFetching(fetching: boolean): void {
  buildingsSpinner.classList.toggle("visible", fetching);
}

shadowsCheckbox.addEventListener("change", () => {
  persistViewState();
  scheduleShadowsFetchIfEnabled();
  render();
});

/** Fetch neighbor-building data for the current center, if the BETA shadows feature is on. */
function scheduleShadowsFetchIfEnabled(): void {
  if (!shadowsCheckbox.checked) return;
  const center = map.getCenter();
  scheduleBuildingFetch([center.lat, center.lng], render, setBuildingsFetching);
}

map.on("move", render);
map.on("moveend", () => {
  persistViewState();
  scheduleShadowsFetchIfEnabled();
});
map.on("resize", render);
window.addEventListener("resize", render);

locateBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    statusEl.classList.remove("sun-down");
    statusEl.textContent = t.geoUnsupported;
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      map.setView([position.coords.latitude, position.coords.longitude], LOCATE_ZOOM);
    },
    () => {
      statusEl.classList.remove("sun-down");
      statusEl.textContent = t.geoFailed;
    },
  );
});

const COPY_FEEDBACK_MS = 1500;
const copyLinkLabel = copyLinkBtn.querySelector<HTMLSpanElement>(".copy-link-label")!;
copyLinkLabel.textContent = t.copyLink;
copyLinkBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(window.location.href);
    copyLinkBtn.classList.add("copied");
    copyLinkLabel.textContent = t.copied;
    setTimeout(() => {
      copyLinkBtn.classList.remove("copied");
      copyLinkLabel.textContent = t.copyLink;
    }, COPY_FEEDBACK_MS);
  } catch {
    const previousText = statusEl.textContent;
    const previousSunDown = statusEl.classList.contains("sun-down");
    statusEl.classList.remove("sun-down");
    statusEl.textContent = t.copyFailed;
    setTimeout(() => {
      statusEl.classList.toggle("sun-down", previousSunDown);
      statusEl.textContent = previousText;
    }, COPY_FEEDBACK_MS);
  }
});

persistViewState();
scheduleShadowsFetchIfEnabled();
render();
