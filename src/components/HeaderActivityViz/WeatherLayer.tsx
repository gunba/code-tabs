import type { WeatherScene } from "../../lib/weatherCodes";

// Edge-implied weather: nothing renders as a full body. The sun bulges in
// from the upper-right corner, clouds drift across the top edge, rain
// falls as short slanted lines that exit the bottom of the visible
// rectangle, etc. Container is `pointer-events: none; overflow: hidden;`.
//
// Animation is pure CSS so this component can be a simple JSX tree —
// no rAF, no React state.

interface Props {
  scene: WeatherScene;
}

const RAIN_DROPS = 18;
const SNOW_FLAKES = 14;

export function WeatherLayer({ scene }: Props) {
  return (
    <div className={`viz-weather viz-weather-${scene}`} aria-hidden="true">
      {scene === "clear" && <div className="viz-sun" />}

      {scene === "clouds" && (
        <>
          <div className="viz-cloud viz-cloud-a" />
          <div className="viz-cloud viz-cloud-b" />
          <div className="viz-cloud viz-cloud-c" />
        </>
      )}

      {(scene === "rain" || scene === "storm") &&
        Array.from({ length: RAIN_DROPS }).map((_, i) => {
          const left = (i * 5.5 + ((i * 37) % 11)) % 100;
          const delay = ((i * 173) % 1200) / 1000;
          const dur = 0.7 + ((i * 41) % 60) / 100;
          return (
            <div
              key={i}
              className="viz-rain"
              style={{
                left: `${left}%`,
                animationDelay: `${delay}s`,
                animationDuration: `${dur}s`,
              }}
            />
          );
        })}

      {scene === "storm" && <div className="viz-flash" />}

      {scene === "snow" &&
        Array.from({ length: SNOW_FLAKES }).map((_, i) => {
          const left = (i * 7.3 + ((i * 53) % 13)) % 100;
          const delay = ((i * 311) % 2400) / 1000;
          const dur = 4 + ((i * 71) % 200) / 100;
          return (
            <div
              key={i}
              className="viz-snow"
              style={{
                left: `${left}%`,
                animationDelay: `${delay}s`,
                animationDuration: `${dur}s`,
              }}
            />
          );
        })}

      {scene === "fog" && <div className="viz-fog" />}
    </div>
  );
}
