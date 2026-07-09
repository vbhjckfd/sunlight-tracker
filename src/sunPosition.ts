import * as SunCalc from "suncalc";

export interface SunPosition {
  /** Degrees clockwise from north, as seen from the observer. */
  azimuthDeg: number;
  /** Degrees above the horizon; negative means the sun is below it. */
  altitudeDeg: number;
}

/** Sun position as seen by an observer standing at (lat, lng) at the given instant. */
export function getSunPosition(date: Date, lat: number, lng: number): SunPosition {
  const { azimuth, altitude } = SunCalc.getPosition(date, lat, lng);
  return { azimuthDeg: azimuth, altitudeDeg: altitude };
}

export interface SunTimes {
  /** Null when the sun doesn't rise that day (polar night). */
  sunrise: Date | null;
  solarNoon: Date;
  /** Null when the sun doesn't set that day (polar day). */
  sunset: Date | null;
}

/** Sunrise, solar noon (highest point), and sunset for the observer's day. */
export function getSunTimes(date: Date, lat: number, lng: number): SunTimes {
  const { sunrise, solarNoon, sunset } = SunCalc.getTimes(date, lat, lng);
  return { sunrise, solarNoon, sunset };
}
