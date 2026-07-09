import "leaflet/dist/leaflet.css";
import "./style.css";
import * as L from "leaflet";
import { getSunPosition, getSunTimes } from "./sunPosition.ts";

const mapEl = document.querySelector<HTMLDivElement>("#map")!;
const sunIcon = document.querySelector<HTMLDivElement>("#sun-icon")!;
const angleNeedle = document.querySelector<SVGLineElement>("#angle-needle")!;
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const datePicker = document.querySelector<HTMLInputElement>("#date-picker")!;
const hourPicker = document.querySelector<HTMLInputElement>("#hour-picker")!;
const hourValue = document.querySelector<HTMLSpanElement>("#hour-value")!;
const locateBtn = document.querySelector<HTMLButtonElement>("#locate-btn")!;
const solarNoonMarker = document.querySelector<HTMLDivElement>("#solar-noon-marker")!;
const sunriseMarker = document.querySelector<HTMLButtonElement>("#sunrise-marker")!;
const sunsetMarker = document.querySelector<HTMLButtonElement>("#sunset-marker")!;

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

function centerFromStorage(): L.LatLngTuple | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { lat, lng } = JSON.parse(raw);
    return isValidLatLng(lat, lng) ? [lat, lng] : null;
  } catch {
    return null;
  }
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

/** Keeps the URL query params and localStorage in sync with the map center. */
function persistCenter(lat: number, lng: number): void {
  const url = new URL(window.location.href);
  url.searchParams.set("lat", lat.toFixed(5));
  url.searchParams.set("lng", lng.toFixed(5));
  window.history.replaceState(null, "", url);
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ lat, lng }));
}

const MAX_ZOOM = 19;
/** One level below max: close enough to see the house, without maxing out. */
const LOCATE_ZOOM = MAX_ZOOM - 1;

const queryCenter = centerFromQuery();
const storageCenter = queryCenter ? null : centerFromStorage();

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

function selectedDate(): Date {
  const [year, month, day] = datePicker.value.split("-").map(Number);
  const minutes = Number(hourPicker.value);
  return new Date(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
}

/** Max distance (px) the sun icon travels from center as it nears the horizon. */
function maxRadius(): number {
  return Math.min(mapEl.clientWidth, mapEl.clientHeight) / 2 - 40;
}

/** Needle length (svg units) from the gauge's pivot at (50, 50). */
const NEEDLE_LENGTH = 18;

/** Point the gauge needle from horizon (0°) to zenith (90°) to mirror the sun's altitude. */
function setAngleNeedle(altitudeDeg: number): void {
  const rad = (Math.max(0, Math.min(90, altitudeDeg)) * Math.PI) / 180;
  angleNeedle.setAttribute("x2", String(50 + NEEDLE_LENGTH * Math.cos(rad)));
  angleNeedle.setAttribute("y2", String(50 - NEEDLE_LENGTH * Math.sin(rad)));
}

/** Position a marker below the time slider at the point matching the given instant. */
function placeTimeMarker(el: HTMLElement, time: Date | null): void {
  if (!time || Number.isNaN(time.getTime())) {
    el.style.display = "none";
    return;
  }
  const minutes = time.getHours() * 60 + time.getMinutes();
  const percent = (minutes / Number(hourPicker.max)) * 100;
  el.style.display = "block";
  el.style.left = `${percent}%`;
}

/** Slide the sunrise/solar-noon/sunset markers below the time slider to match today's sun times. */
function setTimeMarkers(date: Date, lat: number, lng: number): void {
  const { sunrise, solarNoon, sunset } = getSunTimes(date, lat, lng);
  placeTimeMarker(solarNoonMarker, solarNoon);
  placeTimeMarker(sunriseMarker, sunrise);
  placeTimeMarker(sunsetMarker, sunset);
}

/** Jump the time slider to the given instant and re-render. */
function jumpToTime(time: Date | null): void {
  if (!time || Number.isNaN(time.getTime())) return;
  const minutes = time.getHours() * 60 + time.getMinutes();
  hourPicker.value = String(minutes);
  hourValue.textContent = minutesToLabel(minutes);
  render();
}

function render(): void {
  const center = map.getCenter();
  const date = selectedDate();
  const { azimuthDeg, altitudeDeg } = getSunPosition(date, center.lat, center.lng);
  setTimeMarkers(date, center.lat, center.lng);

  const belowHorizon = altitudeDeg <= 0;
  const radius = maxRadius() * (1 - Math.max(altitudeDeg, 0) / 90);
  const azimuthRad = (azimuthDeg * Math.PI) / 180;
  const x = radius * Math.sin(azimuthRad);
  const y = -radius * Math.cos(azimuthRad);

  sunIcon.classList.toggle("below-horizon", belowHorizon);
  sunIcon.style.transform = `translate(${x}px, ${y}px)`;
  setAngleNeedle(altitudeDeg);
  statusEl.textContent = belowHorizon
    ? `Sun below horizon at ${center.lat.toFixed(2)}, ${center.lng.toFixed(2)} (altitude ${altitudeDeg.toFixed(1)}°)`
    : `${center.lat.toFixed(2)}, ${center.lng.toFixed(2)} — altitude ${altitudeDeg.toFixed(0)}°`;
}

const now = new Date();
datePicker.value = now.toISOString().slice(0, 10);
const initialMinutes = now.getHours() * 60 + now.getMinutes();
hourPicker.value = String(initialMinutes);
hourValue.textContent = minutesToLabel(initialMinutes);

datePicker.addEventListener("input", render);
hourPicker.addEventListener("input", () => {
  hourValue.textContent = minutesToLabel(Number(hourPicker.value));
  render();
});
solarNoonMarker.addEventListener("click", () => {
  const center = map.getCenter();
  jumpToTime(getSunTimes(selectedDate(), center.lat, center.lng).solarNoon);
});
sunriseMarker.addEventListener("click", () => {
  const center = map.getCenter();
  jumpToTime(getSunTimes(selectedDate(), center.lat, center.lng).sunrise);
});
sunsetMarker.addEventListener("click", () => {
  const center = map.getCenter();
  jumpToTime(getSunTimes(selectedDate(), center.lat, center.lng).sunset);
});
map.on("move", render);
map.on("moveend", () => {
  const center = map.getCenter();
  persistCenter(center.lat, center.lng);
});
map.on("resize", render);
window.addEventListener("resize", render);

locateBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    statusEl.textContent = "Geolocation is not supported by this browser";
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      map.setView([position.coords.latitude, position.coords.longitude], LOCATE_ZOOM);
    },
    () => {
      statusEl.textContent = "Unable to retrieve your location";
    },
  );
});

const initialCenter = map.getCenter();
persistCenter(initialCenter.lat, initialCenter.lng);
render();
