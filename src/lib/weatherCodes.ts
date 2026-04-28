// WMO weather codes (returned by Open-Meteo's `current.weather_code`)
// collapsed into the handful of scene categories the wave visualisation
// actually renders. Reference: https://open-meteo.com/en/docs

export type WeatherScene =
  | "clear"
  | "clouds"
  | "rain"
  | "storm"
  | "snow"
  | "fog";

export function sceneForCode(code: number | null | undefined): WeatherScene {
  if (code == null) return "clear";
  if (code === 0) return "clear";
  if (code <= 3) return "clouds";
  if (code === 45 || code === 48) return "fog";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 95 && code <= 99) return "storm";
  if (code >= 51 && code <= 67) return "rain";
  if (code >= 80 && code <= 86) return "rain";
  return "clear";
}
