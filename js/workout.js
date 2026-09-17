import { validDate, dayDifference } from "./dates.js";
export const FEED_KEY = "oly_planner_feed_v1";
export function validateFeed(feed) {
  if (
    !feed ||
    feed.schema !== 1 ||
    feed.type !== "oly:planner-feed" ||
    !Number.isFinite(feed.generatedAt) ||
    !Number.isFinite(feed.sourceRevision) ||
    !feed.program ||
    !Array.isArray(feed.entries) ||
    feed.entries.some(
      (e) =>
        typeof e.id !== "string" ||
        typeof e.date !== "string" ||
        !Number.isFinite(e.forecastSeconds) ||
        e.forecastSeconds < 0 ||
        e.forecastSeconds > 86400 ||
        !Number.isFinite(e.postChangeSeconds) ||
        e.postChangeSeconds < 0 ||
        !["model", "reported", "measured"].includes(e.basis),
    )
  )
    throw Error(
      "The workout scheduling feed is not compatible. Open Oly to update it.",
    );
  const days = new Set(),
    dates = new Set();
  if (feed.repeatStart && !validDate(feed.repeatStart))
    throw Error("Invalid workout projection date.");
  for (const e of feed.entries) {
    if (
      !validDate(e.date) ||
      !["monday", "tuesday", "thursday", "friday"].includes(e.day) ||
      days.has(e.day) ||
      dates.has(e.date) ||
      typeof e.label !== "string" ||
      typeof e.signature !== "string" ||
      !Number.isFinite(e.guideSeconds) ||
      e.guideSeconds < 0 ||
      !Number.isInteger(e.visits) ||
      e.visits < 0 ||
      e.postChangeSeconds > 3600 ||
      typeof e.active !== "boolean" ||
      typeof e.complete !== "boolean" ||
      (e.active &&
        (!Number.isFinite(e.startedAt) ||
          !Number.isFinite(e.activeRemainingSeconds) ||
          e.activeRemainingSeconds < 0)) ||
      (e.endedAt !== null &&
        (!Number.isFinite(e.endedAt) || e.endedAt < e.startedAt))
    )
      throw Error(
        "The workout feed contains an invalid or duplicate session. Open Oly to review it.",
      );
    days.add(e.day);
    dates.add(e.date);
  }
  return structuredClone(feed);
}
export function workoutForDate(feed, date) {
  if (!feed || feed.program.completed) return null;
  const exact = feed.entries.find((e) => e.date === date);
  if (exact) return { ...exact, projected: false };
  if (!feed.repeatStart || date < feed.repeatStart) return null;
  const offset = dayDifference(date, feed.repeatStart),
    position = offset % 7;
  const day = ["monday", "tuesday", null, "thursday", "friday", null, null][
    position
  ];
  const template = feed.entries.find((e) => e.day === day);
  if (!template) return null;
  return {
    ...template,
    id: `${template.id}:projection:${date}`,
    date,
    projected: true,
    active: false,
    complete: false,
    startedAt: null,
    endedAt: null,
    activeRemainingSeconds: null,
    note: "Current Oly dose and rolling A–B–rest–C–D–rest–rest calendar projected; program weeks advance only in Oly.",
  };
}
