export type Lang = "en" | "uk";

/** Every user-facing string, shared by the website and the LUN.ua extension. */
export interface Strings {
  dateLabel: string;
  timeLabel: string;
  locateTitle: string;
  playTitle: string;
  solarNoonTitle: string;
  sunriseTitle: string;
  sunsetTitle: string;
  copyLinkTitle: string;
  copyLink: string;
  copied: string;
  copyFailed: string;
  shadowsLabel: string;
  shadowsShortLabel: string;
  shadowsTitle: string;
  fetchingBuildings: string;
  pinTitle: string;
  sunDown: string;
  geoUnsupported: string;
  geoFailed: string;
  altitude: (deg: string) => string;
  blockedByBuilding: (distanceM: number) => string;
}

const en: Strings = {
  dateLabel: "Date",
  timeLabel: "Time:",
  locateTitle: "Locate me",
  playTitle: "Play through the day",
  solarNoonTitle: "Solar noon (sun's highest point)",
  sunriseTitle: "Sunrise",
  sunsetTitle: "Sunset",
  copyLinkTitle: "Copy a link to this exact view",
  copyLink: "Copy link",
  copied: "Copied!",
  copyFailed: "Couldn't copy link",
  shadowsLabel: "Building shadows",
  shadowsShortLabel: "Shadows",
  shadowsTitle: "Highlight when a neighboring building blocks the sun (experimental)",
  fetchingBuildings: "Fetching building heights",
  pinTitle: "Observer location (map center)",
  sunDown: "Sun is down",
  geoUnsupported: "Geolocation is not supported by this browser",
  geoFailed: "Unable to retrieve your location",
  altitude: (deg) => `sun altitude ${deg}°`,
  blockedByBuilding: (distanceM) => `sun blocked by a building (~${distanceM}m away)`,
};

const uk: Strings = {
  dateLabel: "Дата",
  timeLabel: "Час:",
  locateTitle: "Моє місцезнаходження",
  playTitle: "Програти день",
  solarNoonTitle: "Сонячний полудень (найвища точка сонця)",
  sunriseTitle: "Схід сонця",
  sunsetTitle: "Захід сонця",
  copyLinkTitle: "Скопіювати посилання на цей вигляд",
  copyLink: "Копіювати посилання",
  copied: "Скопійовано!",
  copyFailed: "Не вдалося скопіювати",
  shadowsLabel: "Тіні будинків",
  shadowsShortLabel: "Тіні",
  shadowsTitle: "Показувати, коли сусідній будинок затуляє сонце (експериментально)",
  fetchingBuildings: "Отримуємо висоти будинків",
  pinTitle: "Точка спостереження (центр мапи)",
  sunDown: "Сонце зайшло",
  geoUnsupported: "Браузер не підтримує геолокацію",
  geoFailed: "Не вдалося визначити місцезнаходження",
  altitude: (deg) => `висота сонця ${deg}°`,
  blockedByBuilding: (distanceM) => `затінено будинком (~${distanceM} м)`,
};

const STRINGS: Record<Lang, Strings> = { en, uk };

/**
 * First supported language found in `candidates` (BCP 47 tags or bare codes,
 * e.g. "uk-UA", "en", "ru"), checked in order. Russian deliberately resolves
 * to Ukrainian rather than the English fallback; English is the fallback when
 * nothing matches.
 */
export function pickLanguage(candidates: readonly (string | null | undefined)[]): Lang {
  for (const candidate of candidates) {
    const code = candidate?.trim().toLowerCase().split(/[-_]/)[0];
    if (code === "uk" || code === "ru") return "uk";
    if (code === "en") return "en";
  }
  return "en";
}

export function getStrings(lang: Lang): Strings {
  return STRINGS[lang];
}
