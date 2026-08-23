/**
 * Sunlight Tracker overlay for LUN.ua and DOM.RIA building pages.
 *
 * Reuses the app's sun/timezone/playback/shadow modules, but instead of owning
 * a Leaflet map it drapes an SVG beam overlay + control bar over the Mapbox GL
 * map these sites render into their own map container. The observer is the
 * residential complex itself (coordinates parsed out of the page's own data),
 * not the map center.
 */
import { getSunPosition, getSunTimes } from "../../src/sunPosition.ts";
import {
  resolveTimeZone,
  wallTimeToUtc,
  utcToZonedMinutesOfDay,
  formatUtcOffsetLabel,
  formatZonedDateInput,
} from "../../src/timezone.ts";
import { createPlayback } from "../../src/playback.ts";
import { scheduleBuildingFetch, getCachedBuildings, findObstruction } from "../../src/buildingShadows.ts";
import { pickLanguage, getStrings, type Strings } from "../../src/i18n.ts";
import { SLT_COMMIT } from "./commit.generated.ts";

const STORAGE_KEY = "sunlight-tracker:lun-view";
const BEAM_COUNT = 4;
/** Fraction of the map's shorter side spanned by the outermost beams. */
const BEAM_SPREAD_RATIO = 0.12;
const BEAM_HORIZON_COLOR: [number, number, number] = [255, 214, 64]; // yellow, near the horizon
const BEAM_ZENITH_COLOR: [number, number, number] = [200, 30, 24]; // deep red, overhead
const PLAYBACK_STEP_MINUTES = 15;
const PLAYBACK_INTERVAL_MS = 350;
const MAX_MINUTES = 1439;
/** How often the watch loop compares the map's marker/bearing/size against the last render. */
const WATCH_INTERVAL_MS = 200;
/** A DOM marker this close to the map center at acquisition time is taken to be the complex pin. */
const MARKER_ACQUIRE_RADIUS_PX = 60;
/**
 * Floor applied to the map container's size. LUN's own map can fail to
 * initialize (e.g. malformed building/marker data server-side) and leave the
 * container at its collapsed pre-load size, which would squeeze our overlay
 * down to nothing; this gives it room regardless of whether LUN's map ever
 * renders. A min, not a fixed size, so it never fights a container that's
 * already sized correctly.
 */
const MIN_CONTAINER_PX = 240;
/**
 * How long init() keeps retrying via MutationObserver when the complex's geo
 * or the map container isn't in the DOM yet. Some pages populate
 * `window.params` from a client-side data fetch that lands after our
 * document_idle run, so a single immediate check can miss it; bounded so
 * this doesn't run forever on the many lun.ua pages that are never a
 * complex page at all.
 */
const INIT_RETRY_TIMEOUT_MS = 15000;
/**
 * Nudge applied when jumping to sunrise (+) or sunset (−), so the sun sits just
 * above the horizon and the beams are actually visible on the map, instead of
 * landing exactly on the below-horizon rise/set instant.
 */
const SUN_EVENT_NUDGE_MINUTES = 15;

interface ComplexLocation {
  lat: number;
  lng: number;
  name: string;
}

/** Depth-first search of a parsed JSON-LD value for a node carrying GeoCoordinates. */
function findGeoNode(node: unknown): ComplexLocation | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findGeoNode(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  const record = node as Record<string, unknown>;
  // Aggregate listing pages (e.g. lun.ua/sale/…, lun.ua/rent/…) carry an
  // ItemList of individual apartment offers, each with its own geo — that's
  // not a single complex, and these pages have no map to attach to at all.
  const type = record["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.includes("ItemList")) return null;
  const geo = record.geo as Record<string, unknown> | undefined;
  if (geo && typeof geo === "object") {
    const lat = Number(geo.latitude);
    const lng = Number(geo.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng, name: typeof record.name === "string" ? record.name : "this complex" };
    }
  }
  for (const value of Object.values(record)) {
    const found = findGeoNode(value);
    if (found) return found;
  }
  return null;
}

/** A page title/heading to use as the complex name when structured data lacks one. */
function getPageName(): string {
  const heading = document.querySelector("h1")?.textContent?.trim();
  if (heading) return heading;
  const title = document.title.trim();
  return title || "this complex";
}

/**
 * Fallback for page types (e.g. `/new/` residential-quarter listings) that omit
 * JSON-LD geo and instead expose coordinates through an inline
 * `window.params = { center: [lng, lat], … }` script. Content scripts run in an
 * isolated world and cannot read the page's real `window.params`, and the host
 * runs Cloudflare Rocket Loader (which mangles script `type` and defers
 * execution), so we parse the script's source text out of the DOM directly.
 */
function getLocationFromWindowParams(): ComplexLocation | null {
  for (const script of document.querySelectorAll<HTMLScriptElement>("script")) {
    const text = script.textContent;
    if (!text || !text.includes("window.params")) continue;
    const match = text.match(/center\s*:\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/);
    if (!match) continue;
    const lng = Number(match[1]);
    const lat = Number(match[2]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { lat, lng, name: getPageName() };
    }
  }
  return null;
}

/**
 * Slice out a balanced `[...]` array starting at `text[startIdx]` (which must
 * be the opening bracket), tracking nesting depth so an inner array (e.g.
 * `osmId`) doesn't end the slice early.
 */
function extractBalancedArray(text: string, startIdx: number): string | null {
  let depth = 0;
  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

/**
 * DOM.RIA newbuild-complex pages: geo lives in an inline `window.init=…` blob
 * (not JSON-LD) under `mapPage.mapData`, a single-element array on a genuine
 * complex detail page (an array with multiple entries means this is a
 * listing/search page with several pins, not one complex — skip it, same as
 * the JSON-LD ItemList exclusion above). Content scripts run in an isolated
 * world and can't read the page's real `window.init`, so this parses the
 * script's source text out of the DOM directly, same approach as the lun.ua
 * `window.params` fallback below.
 */
function getLocationFromWindowInit(): ComplexLocation | null {
  for (const script of document.querySelectorAll<HTMLScriptElement>("script")) {
    const text = script.textContent;
    if (!text || !text.includes("window.init=")) continue;
    const key = '"mapData":[';
    const keyIdx = text.indexOf(key);
    if (keyIdx === -1) continue;
    const arrayText = extractBalancedArray(text, keyIdx + key.length - 1);
    if (!arrayText) continue;
    try {
      const mapData = JSON.parse(arrayText);
      if (!Array.isArray(mapData) || mapData.length !== 1) continue;
      const [entry] = mapData;
      const lat = Number(entry?.latitude);
      const lng = Number(entry?.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
        return { lat, lng, name: typeof entry.name === "string" && entry.name ? entry.name : getPageName() };
      }
    } catch {
      // Malformed/unexpected shape; keep scanning other scripts.
    }
  }
  return null;
}

/** The complex's coordinates + name, from whichever data shape the host page uses. */
function getComplexLocation(): ComplexLocation | null {
  for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')) {
    try {
      const found = findGeoNode(JSON.parse(script.textContent ?? ""));
      if (found) return found;
    } catch {
      // Malformed JSON-LD block; keep scanning the rest.
    }
  }
  return getLocationFromWindowParams() ?? getLocationFromWindowInit();
}

function findMapContainer(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#map-canvas, .BuildingLocation-map-canvas, #map");
}

function minutesToLabel(minutes: number): string {
  const h = Math.floor(minutes / 60)
    .toString()
    .padStart(2, "0");
  const m = (minutes % 60).toString().padStart(2, "0");
  return `${h}:${m}`;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Yellow near the horizon, deepening to red overhead. */
function altitudeToBeamColor(altitudeDeg: number): string {
  const t = Math.min(altitudeDeg, 90) / 90;
  const [r, g, b] = BEAM_HORIZON_COLOR.map((horizon, i) => Math.round(lerp(horizon, BEAM_ZENITH_COLOR[i], t)));
  return `rgb(${r}, ${g}, ${b})`;
}

interface StoredView {
  date?: string;
  minutes?: number;
  shadows?: boolean;
}

function readStoredView(): StoredView {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const { date, minutes, shadows } = JSON.parse(raw);
    return {
      date: typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
      minutes: Number.isInteger(minutes) && minutes >= 0 && minutes <= MAX_MINUTES ? minutes : undefined,
      shadows: typeof shadows === "boolean" ? shadows : undefined,
    };
  } catch {
    return {};
  }
}

const overlayHtml = (t: Strings): string => `
  <svg class="slt-sun-beams">
    ${Array.from({ length: BEAM_COUNT }, (_, i) => `<line class="slt-sun-beam" data-beam="${i}" />`).join("")}
  </svg>
  <div class="slt-compass" aria-hidden="true">
    <svg viewBox="0 0 48 48" width="40" height="40" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="24" cy="24" r="20" stroke-width="1.5" opacity="0.6" />
      <line x1="24" y1="6" x2="24" y2="12" stroke-width="2" />
      <line x1="24" y1="36" x2="24" y2="42" stroke-width="1.5" opacity="0.6" />
      <line x1="6" y1="24" x2="12" y2="24" stroke-width="1.5" opacity="0.6" />
      <line x1="36" y1="24" x2="42" y2="24" stroke-width="1.5" opacity="0.6" />
      <text x="24" y="17" text-anchor="middle" font-size="9" font-weight="700" stroke="none" fill="currentColor">N</text>
      <text x="24" y="35.5" text-anchor="middle" font-size="7" stroke="none" fill="currentColor" opacity="0.7">S</text>
      <text x="9.5" y="27" text-anchor="middle" font-size="7" stroke="none" fill="currentColor" opacity="0.7">W</text>
      <text x="38.5" y="27" text-anchor="middle" font-size="7" stroke="none" fill="currentColor" opacity="0.7">E</text>
    </svg>
  </div>
  <div class="slt-controls">
    <div class="slt-status-row">
      <span class="slt-status"></span>
      <span class="slt-spinner" title="${t.fetchingBuildings}"></span>
      <label class="slt-shadows-toggle" title="${t.shadowsTitle}">
        <input type="checkbox" class="slt-shadows" />
        🏢 ${t.shadowsShortLabel} <span class="slt-beta">BETA</span>
      </label>
    </div>
    <div class="slt-inputs-row">
      <input type="date" class="slt-date" title="${t.dateLabel}" />
      <button type="button" class="slt-play" title="${t.playTitle}">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <polygon class="slt-play-icon" points="6,4 20,12 6,20" />
          <rect class="slt-pause-icon" x="6" y="4" width="4" height="16" />
          <rect class="slt-pause-icon" x="14" y="4" width="4" height="16" />
        </svg>
      </button>
      <div class="slt-slider-wrap">
        <input type="range" class="slt-hour" min="0" max="${MAX_MINUTES}" step="15" />
        <div class="slt-noon-marker" title="${t.solarNoonTitle}"></div>
        <button type="button" class="slt-time-icon slt-sunrise-marker" title="${t.sunriseTitle}">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <line x1="2" y1="18" x2="22" y2="18" stroke="#f5a300" stroke-width="2" stroke-linecap="round" />
            <path d="M6 18a6 6 0 0 1 12 0" fill="#ffcc33" stroke="#f5a300" stroke-width="1.5" />
            <path d="M12 10V4M9 7l3-3 3 3" fill="none" stroke="#f5a300" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
        <button type="button" class="slt-time-icon slt-sunset-marker" title="${t.sunsetTitle}">
          <svg viewBox="0 0 24 24" width="16" height="16">
            <line x1="2" y1="18" x2="22" y2="18" stroke="#b45309" stroke-width="2" stroke-linecap="round" />
            <path d="M6 18a6 6 0 0 1 12 0" fill="#f97316" stroke="#b45309" stroke-width="1.5" />
            <path d="M12 4v6M9 7l3 3 3-3" fill="none" stroke="#b45309" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
      <span class="slt-hour-value">12:00</span>
      <span class="slt-tz"></span>
    </div>
  </div>
`;

function init(): void {
  const complex = getComplexLocation();
  const container = complex ? findMapContainer() : null;
  if (complex && container) {
    attach(complex, container);
    return;
  }

  // Either piece can still be missing because it hasn't landed in the DOM
  // yet, not because this isn't a complex page — keep watching for both.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => {
    const c = getComplexLocation();
    if (!c) return;
    if (timeoutId !== undefined) {
      // Confirmed complex page: stop racing the clock. The map container can
      // still be legitimately missing for much longer than the timeout — e.g.
      // DOM.RIA only mounts its map once the section is scrolled into view —
      // so from here on just wait for it, however long that takes.
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    const el = findMapContainer();
    if (!el) return;
    observer.disconnect();
    attach(c, el);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  timeoutId = setTimeout(() => observer.disconnect(), INIT_RETRY_TIMEOUT_MS);
}

function attach(complex: ComplexLocation, container: HTMLElement): void {
  if (container.querySelector(".slt-root")) return; // already attached

  // Language follows the host page's metadata (lun.ua sets <html lang="uk">);
  // anything unsupported (e.g. "ru") falls back to English.
  const t = getStrings(
    pickLanguage([
      document.documentElement.lang,
      document.querySelector<HTMLMetaElement>('meta[property="og:locale"]')?.content,
    ]),
  );

  if (getComputedStyle(container).position === "static") {
    container.style.position = "relative";
  }
  // LUN's own map can be full-sized at attach time and only collapse later —
  // e.g. its init throws asynchronously (malformed building/marker data) and
  // its error path shrinks the container back to a placeholder size. A
  // one-time check of the *current* size would miss that. Set the floor
  // unconditionally (min-*, so it's a no-op wherever the real map is already
  // bigger) on the container and a few ancestors, since the element that
  // actually clips visually is often a wrapper whose own size doesn't derive
  // from the child. min-width/min-height also clamps any smaller size LUN's
  // JS sets on these same elements afterward, per normal CSS precedence.
  let sizeTarget: HTMLElement | null = container;
  for (let depth = 0; sizeTarget && depth < 4; depth++) {
    sizeTarget.style.minWidth = `${MIN_CONTAINER_PX}px`;
    sizeTarget.style.minHeight = `${MIN_CONTAINER_PX}px`;
    sizeTarget = sizeTarget.parentElement;
  }

  const root = document.createElement("div");
  root.className = "slt-root";
  root.innerHTML = overlayHtml(t);
  container.appendChild(root);

  const sunBeamsSvg = root.querySelector<SVGSVGElement>(".slt-sun-beams")!;
  const beamLines = Array.from(root.querySelectorAll<SVGLineElement>(".slt-sun-beam"));
  const compassEl = root.querySelector<HTMLDivElement>(".slt-compass")!;
  const statusEl = root.querySelector<HTMLSpanElement>(".slt-status")!;
  const spinnerEl = root.querySelector<HTMLSpanElement>(".slt-spinner")!;
  const datePicker = root.querySelector<HTMLInputElement>(".slt-date")!;
  const hourPicker = root.querySelector<HTMLInputElement>(".slt-hour")!;
  const hourValue = root.querySelector<HTMLSpanElement>(".slt-hour-value")!;
  const tzLabel = root.querySelector<HTMLSpanElement>(".slt-tz")!;
  const playBtn = root.querySelector<HTMLButtonElement>(".slt-play")!;
  const noonMarker = root.querySelector<HTMLDivElement>(".slt-noon-marker")!;
  const sunriseMarker = root.querySelector<HTMLButtonElement>(".slt-sunrise-marker")!;
  const sunsetMarker = root.querySelector<HTMLButtonElement>(".slt-sunset-marker")!;
  const shadowsCheckbox = root.querySelector<HTMLInputElement>(".slt-shadows")!;

  const timeZone = resolveTimeZone(complex.lat, complex.lng);

  /**
   * The Mapbox GL DOM marker that represents the complex, once acquired: at load
   * LUN centers the map on the complex, so a marker sitting near the container
   * center is taken to be its pin. Tracking its on-screen position keeps the
   * beams anchored to the complex through pans and zooms; until (or unless) a
   * marker shows up, the beams converge on the container center instead.
   */
  let trackedMarker: HTMLElement | null = null;

  function tryAcquireMarker(): void {
    const containerRect = container.getBoundingClientRect();
    const cx = containerRect.left + containerRect.width / 2;
    const cy = containerRect.top + containerRect.height / 2;
    let best: { el: HTMLElement; distance: number } | null = null;
    for (const el of container.querySelectorAll<HTMLElement>(".mapboxgl-marker, .maplibregl-marker")) {
      const rect = el.getBoundingClientRect();
      const distance = Math.hypot(rect.left + rect.width / 2 - cx, rect.top + rect.height / 2 - cy);
      if (distance <= MARKER_ACQUIRE_RADIUS_PX && (!best || distance < best.distance)) {
        best = { el, distance };
      }
    }
    if (best) trackedMarker = best.el;
  }

  /** Where the beams converge, in overlay-local pixels. */
  function beamAnchor(): { x: number; y: number } {
    const containerRect = container.getBoundingClientRect();
    if (trackedMarker?.isConnected) {
      const rect = trackedMarker.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2 - containerRect.left,
        y: rect.top + rect.height / 2 - containerRect.top,
      };
    }
    return { x: containerRect.width / 2, y: containerRect.height / 2 };
  }

  /**
   * Map rotation, read off the Mapbox GL compass control's icon: mapbox-gl keeps
   * that icon rotated by `-bearing` degrees. Returns 0 when there's no compass
   * (map not initialized yet, or the control is absent) — i.e. assume north-up.
   */
  function readBearingDeg(): number {
    const icon = container.querySelector<HTMLElement>(
      ".mapboxgl-ctrl-compass .mapboxgl-ctrl-icon, .maplibregl-ctrl-compass .maplibregl-ctrl-icon",
    );
    if (!icon) return 0;
    const transform = getComputedStyle(icon).transform;
    if (!transform || transform === "none") return 0;
    const matrix = new DOMMatrix(transform);
    const iconAngleDeg = (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
    return -iconAngleDeg;
  }

  /** The date/time picked, interpreted as local wall-clock time at the complex. */
  function selectedDate(): Date {
    const [year, month, day] = datePicker.value.split("-").map(Number);
    const minutes = Number(hourPicker.value);
    return wallTimeToUtc(year, month, day, Math.floor(minutes / 60), minutes % 60, timeZone);
  }

  /** Draw 4 parallel beams from off the map edge, in the sun's direction, converging on the complex. */
  function renderSunBeams(screenAzimuthDeg: number, altitudeDeg: number): void {
    const width = container.clientWidth;
    const height = container.clientHeight;
    sunBeamsSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);

    const { x: cx, y: cy } = beamAnchor();
    const azimuthRad = (screenAzimuthDeg * Math.PI) / 180;
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

  /** Position a marker below the time slider at the point matching the given instant. */
  function placeTimeMarker(el: HTMLElement, time: Date | null): void {
    if (!time || Number.isNaN(time.getTime())) {
      el.style.display = "none";
      return;
    }
    const minutes = utcToZonedMinutesOfDay(time, timeZone);
    el.style.display = "block";
    el.style.left = `${(minutes / MAX_MINUTES) * 100}%`;
  }

  function persistView(): void {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ date: datePicker.value, minutes: Number(hourPicker.value), shadows: shadowsCheckbox.checked }),
    );
  }

  function render(): void {
    const date = selectedDate();
    const { azimuthDeg, altitudeDeg } = getSunPosition(date, complex.lat, complex.lng);
    const { sunrise, solarNoon, sunset } = getSunTimes(date, complex.lat, complex.lng);
    placeTimeMarker(noonMarker, solarNoon);
    placeTimeMarker(sunriseMarker, sunrise);
    placeTimeMarker(sunsetMarker, sunset);
    tzLabel.textContent = formatUtcOffsetLabel(date, timeZone);

    const bearingDeg = readBearingDeg();
    compassEl.style.transform = `rotate(${-bearingDeg}deg)`;

    const belowHorizon = altitudeDeg <= 0;
    sunBeamsSvg.style.display = belowHorizon ? "none" : "block";
    statusEl.classList.toggle("slt-sun-down", belowHorizon);

    if (belowHorizon) {
      statusEl.textContent = t.sunDown;
      return;
    }

    renderSunBeams(azimuthDeg - bearingDeg, altitudeDeg);

    const obstruction = shadowsCheckbox.checked
      ? findObstruction(complex.lat, complex.lng, azimuthDeg, altitudeDeg, getCachedBuildings())
      : null;
    beamLines.forEach((line) => line.classList.toggle("slt-blocked", obstruction !== null));

    statusEl.textContent = obstruction
      ? `☀️ ${complex.name} — ${t.blockedByBuilding(Math.round(obstruction.distanceM))}`
      : `☀️ ${complex.name} — ${t.altitude(altitudeDeg.toFixed(0))}`;
  }

  function applyMinutes(minutes: number): void {
    hourPicker.value = String(minutes);
    hourValue.textContent = minutesToLabel(minutes);
    persistView();
    render();
  }

  function jumpToTime(time: Date | null, nudgeMinutes = 0): void {
    if (!time || Number.isNaN(time.getTime())) return;
    const minutes = utcToZonedMinutesOfDay(time, timeZone) + nudgeMinutes;
    applyMinutes(Math.max(0, Math.min(MAX_MINUTES, minutes)));
  }

  const playback = createPlayback({
    getMinutes: () => Number(hourPicker.value),
    setMinutes: applyMinutes,
    stepMinutes: PLAYBACK_STEP_MINUTES,
    maxMinutes: MAX_MINUTES,
    intervalMs: PLAYBACK_INTERVAL_MS,
    onStop: () => playBtn.classList.remove("slt-playing"),
  });

  const stored = readStoredView();
  const now = new Date();
  datePicker.value = stored.date ?? formatZonedDateInput(now, timeZone);
  const initialMinutes = stored.minutes ?? utcToZonedMinutesOfDay(now, timeZone);
  hourPicker.value = String(initialMinutes);
  hourValue.textContent = minutesToLabel(initialMinutes);
  // Building shadows are experimental (BETA): off unless the user opted in before.
  shadowsCheckbox.checked = stored.shadows ?? false;

  datePicker.addEventListener("input", () => {
    playback.stop();
    persistView();
    render();
  });
  hourPicker.addEventListener("pointerdown", () => playback.stop());
  hourPicker.addEventListener("input", () => applyMinutes(Number(hourPicker.value)));
  playBtn.addEventListener("click", () => {
    playback.toggle();
    playBtn.classList.toggle("slt-playing", playback.isPlaying());
  });
  noonMarker.addEventListener("click", () => {
    playback.stop();
    jumpToTime(getSunTimes(selectedDate(), complex.lat, complex.lng).solarNoon);
  });
  sunriseMarker.addEventListener("click", () => {
    playback.stop();
    jumpToTime(getSunTimes(selectedDate(), complex.lat, complex.lng).sunrise, SUN_EVENT_NUDGE_MINUTES);
  });
  sunsetMarker.addEventListener("click", () => {
    playback.stop();
    jumpToTime(getSunTimes(selectedDate(), complex.lat, complex.lng).sunset, -SUN_EVENT_NUDGE_MINUTES);
  });

  // Neighbor-building heights for the "is the sun blocked" check (opt-in BETA).
  // One fetch is enough: the observer is pinned to the complex, it never moves.
  function scheduleShadowsFetchIfEnabled(): void {
    if (!shadowsCheckbox.checked) return;
    scheduleBuildingFetch([complex.lat, complex.lng], render, (fetching) => {
      spinnerEl.classList.toggle("slt-visible", fetching);
    });
  }

  shadowsCheckbox.addEventListener("change", () => {
    persistView();
    scheduleShadowsFetchIfEnabled();
    render();
  });

  scheduleShadowsFetchIfEnabled();

  new ResizeObserver(render).observe(container);

  // Re-render when anything the render depends on but has no event for changes:
  // the tracked marker's screen position (map pans/zooms), map rotation, or the
  // GL map initializing late (markers appearing after our overlay attached).
  let lastSignature = "";
  const watchTimer = setInterval(() => {
    if (!root.isConnected) {
      // The site re-rendered the map section (e.g. style switch); re-attach.
      clearInterval(watchTimer);
      playback.stop();
      init();
      return;
    }
    if (!trackedMarker?.isConnected) {
      trackedMarker = null;
      tryAcquireMarker();
    }
    const { x, y } = beamAnchor();
    const signature = `${Math.round(x)},${Math.round(y)},${readBearingDeg().toFixed(1)}`;
    if (signature !== lastSignature) {
      lastSignature = signature;
      render();
    }
  }, WATCH_INTERVAL_MS);

  render();
}

console.log(`[Sunlight Tracker] content.js @ ${SLT_COMMIT}`);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => init());
} else {
  init();
}
