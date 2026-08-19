/* The one physical enemy of a doorstep item in Britain is rain. Open-Meteo
   is free, needs no key, and an hour-by-hour chance of rain is all this app
   ever asks of it. Cached per rounded coordinate so a busy neighbourhood
   asks the sky once, not once per person. */

const cache = new Map(); /* key -> { at, hours } */
const CACHE_MS = 30 * 60 * 1000;

export async function rainOutlook(lat, lng) {
  const key = `${Math.round(lat * 50) / 50},${Math.round(lng * 50) / 50}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.hours;

  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&hourly=precipitation_probability&forecast_days=1&timezone=Europe%2FLondon`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const hours = data.hourly.time.map((t, i) => ({
      hour: Number(t.slice(11, 13)),
      prob: data.hourly.precipitation_probability[i],
    }));
    cache.set(key, { at: Date.now(), hours });
    return hours;
  } catch {
    return null; /* no forecast is never an error worth surfacing */
  }
}

/* "Rain likely from 15:00" — or nothing, which is the usual happy answer */
export function rainWarning(hours, windowHours) {
  if (!hours) return null;
  const nowH = new Date().getHours();
  const soon = hours.filter((h) => h.hour >= nowH && h.hour <= nowH + windowHours);
  const wet = soon.find((h) => h.prob >= 55);
  if (!wet) return null;
  return {
    from: `${String(wet.hour).padStart(2, "0")}:00`,
    prob: wet.prob,
  };
}
