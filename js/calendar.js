import { addDays, atMinute, dateISO, parts, weekday } from "./dates.js";
export function normalizeEvent(event, calendarId) {
  if (
    !event?.id ||
    event.status === "cancelled" ||
    event.attendees?.some((a) => a.self && a.responseStatus === "declined")
  )
    return null;
  const allDay = !!event.start?.date;
  let start, end;
  try {
    start = allDay
      ? atMinute(event.start.date, 0)
      : Date.parse(event.start?.dateTime) / 60000;
    end = allDay
      ? atMinute(event.end?.date || addDays(event.start.date, 1), 0)
      : Date.parse(event.end?.dateTime) / 60000;
  } catch {
    return null;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return null;
  return {
    id: `google:${calendarId}:${event.id}`,
    eventId: event.id,
    calendarId,
    seriesId: event.recurringEventId || null,
    title: event.summary || "Untitled commitment",
    location: event.location || "",
    start,
    end,
    allDay,
    blocks: event.transparency !== "transparent" && !allDay,
    source: "google",
    htmlLink: event.htmlLink || "https://calendar.google.com/calendar/u/0/r",
    originalStart: event.originalStartTime || null,
  };
}
export async function fetchCalendar({
  calendarId,
  from,
  until,
  token,
  fetcher = fetch,
}) {
  const events = [];
  let page;
  do {
    const params = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "2500",
      timeZone: "America/Chicago",
      timeMin: new Date(atMinute(from, 0) * 60000).toISOString(),
      timeMax: new Date(atMinute(until, 0) * 60000).toISOString(),
      showDeleted: "true",
    });
    if (page) params.set("pageToken", page);
    const response = await fetcher(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok)
      throw Error(
        response.status === 401
          ? "Reconnect Google to refresh Calendar. Cached events are preserved."
          : `Calendar could not refresh (HTTP ${response.status}). Cached events are preserved.`,
      );
    const data = await response.json();
    for (const raw of data.items || []) {
      const normalized = normalizeEvent(raw, calendarId);
      if (normalized) events.push(normalized);
    }
    page = data.nextPageToken;
  } while (page);
  return {
    from,
    until,
    events: [...new Map(events.map((e) => [e.id, e])).values()],
    updatedAt: Date.now(),
    error: "",
  };
}
export function mechanicsOverrides(events, existing = {}) {
  const result = { ...existing };
  for (const e of events) {
    const p = parts(e.start * 60000),
      date = dateISO(e.start * 60000);
    if (
      /honors.*mechanics/i.test(e.title) &&
      /arranged|^arr$/i.test(e.location) &&
      weekday(date) === 2 &&
      p.hour === 18 &&
      p.minute === 30 &&
      Math.round(e.end - e.start) === 50
    ) {
      const key = e.seriesId ? `series:${e.calendarId}:${e.seriesId}` : e.id;
      if (!(key in result)) result[key] = "kersten";
    }
  }
  return result;
}
export function eventsForDate(cache, date, overrides = {}) {
  const start = atMinute(date, 0),
    end = atMinute(addDays(date, 1), 0);
  const freshCoverage = Object.values(cache).some(
    (c) => !c.legacy && c.from <= date && c.until > date,
  );
  return [
    ...new Map(
      Object.values(cache)
        .flatMap((c) => (c.legacy && freshCoverage ? [] : c.events || []))
        .filter((e) => e.start < end && e.end > start)
        .map((e) => [
          e.id,
          {
            ...e,
            location:
              overrides[e.id] ||
              (e.seriesId &&
                overrides[`series:${e.calendarId}:${e.seriesId}`]) ||
              e.location,
          },
        ]),
    ).values(),
  ].sort((a, b) => a.start - b.start);
}
