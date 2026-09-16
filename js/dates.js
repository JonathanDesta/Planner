export const ZONE = "America/Chicago";
const partsFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
export function parts(at = Date.now()) {
  return Object.fromEntries(
    partsFormat
      .formatToParts(new Date(at))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)]),
  );
}
export function dateISO(at = Date.now()) {
  const p = parts(at);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
export function validDate(date) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    !Number.isNaN(Date.parse(date)) &&
    new Date(date + "T12:00:00Z").toISOString().slice(0, 10) === date
  );
}
export function addDays(date, n) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function weekday(date) {
  return new Date(date + "T12:00:00Z").getUTCDay();
}
export function dayDifference(a, b) {
  return Math.round(
    (Date.parse(a + "T12:00:00Z") - Date.parse(b + "T12:00:00Z")) / 86400000,
  );
}
export function monday(date) {
  return addDays(date, -((weekday(date) + 6) % 7));
}
export function clockMinutes(value) {
  if (!/^\d{2}:\d{2}$/.test(value || "")) return null;
  const [h, m] = value.split(":").map(Number);
  return h < 24 && m < 60 ? h * 60 + m : null;
}
export function atMinute(date, wallMinute) {
  if (!validDate(date) || !Number.isFinite(wallMinute))
    throw Error("Invalid date or time.");
  const [y, m, d] = date.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d, 0, wallMinute),
    normalized = new Date(target);
  let epoch = target;
  for (let i = 0; i < 4; i++) {
    const p = parts(epoch),
      represented = Date.UTC(
        p.year,
        p.month - 1,
        p.day,
        p.hour,
        p.minute,
        p.second,
      );
    const difference = target - represented;
    if (!difference) return epoch / 60000;
    epoch += difference;
  }
  const p = parts(epoch);
  if (
    p.hour !== normalized.getUTCHours() ||
    p.minute !== normalized.getUTCMinutes()
  )
    throw Error("That local time does not exist on this clock-change date.");
  return epoch / 60000;
}
export function sleepBounds(date, wake = "05:15") {
  const minute = clockMinutes(wake);
  if (minute === null) throw Error("Invalid wake time.");
  const start = atMinute(date, minute),
    nextWake = atMinute(addDays(date, 1), minute);
  return {
    wake: start,
    bed: nextWake - 420,
    nextWake,
    previousBed: start - 420,
  };
}
export function formatTime(minute) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(minute * 60000));
}
export function formatDate(date, options = {}) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "short",
    day: "numeric",
    ...options,
  }).format(new Date(date + "T12:00:00Z"));
}
export const minuteNow = () => Date.now() / 60000;
