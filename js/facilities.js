import { weekday, atMinute } from "./dates.js";
export const DINING_SOURCE = "https://dining.uchicago.edu/locations-and-hours";
export const RATNER_SOURCE =
  "https://athletics.uchicago.edu/sports/2023/6/12/facilities.aspx";
export function facilityHours(place, date, overrides = []) {
  const override = overrides
    .filter(
      (o) =>
        o.place === place &&
        o.from <= date &&
        o.until >= date &&
        (!o.weekdays || o.weekdays.includes(weekday(date))),
    )
    .at(-1);
  if (override)
    return {
      ...override,
      source: override.source || "Personal hours override",
      intervals: override.intervals.map(([a, b]) => [
        atMinute(date, a),
        atMinute(date, b),
      ]),
    };
  const day = weekday(date);
  if (place === "ratner") {
    const known = date <= "2026-09-27" && date >= "2026-06-06";
    const closed = [
      "2026-06-19",
      "2026-07-03",
      "2026-07-04",
      "2026-07-05",
      "2026-09-07",
    ].includes(date);
    return {
      place,
      intervals: closed
        ? []
        : [
            [
              atMinute(date, day === 0 || day === 6 ? 480 : 420),
              atMinute(date, day === 0 || day === 6 ? 1140 : 1260),
            ],
          ],
      verified: known,
      provisional: !known,
      source: RATNER_SOURCE,
      note: known
        ? "Published summer hours"
        : "Conservative summer-hours fallback; autumn hours need confirmation",
    };
  }
  if (["cathey", "woodlawn", "baker", "bartlett"].includes(place)) {
    const special = (intervals, note, source) => ({
      place,
      intervals: intervals.map(([a, b]) => [
        atMinute(date, a),
        atMinute(date, b),
      ]),
      verified: true,
      note,
      source,
    });
    const summer =
      "https://dining.uchicago.edu/-/media/project/uchicago-tenant/dining/documents/august-update-summer-hours-2026.pdf";
    const orientation =
      "https://dining.uchicago.edu/-/media/project/uchicago-tenant/dining/documents/o-week-2026.pdf";
    if (date >= "2026-08-02" && date <= "2026-09-20")
      return special(
        place === "baker"
          ? [
              [420, 570],
              [660, 840],
              [1050, 1170],
            ]
          : [],
        "Summer service · Baker only",
        summer,
      );
    if (date === "2026-09-21")
      return special(
        place === "baker"
          ? [
              [420, 570],
              [660, 840],
              [1050, 1170],
            ]
          : [],
        "Orientation Monday · Baker only",
        orientation,
      );
    if (["2026-09-22", "2026-09-23"].includes(date))
      return special(
        [
          [420, 600],
          [660, 870],
          [1050, 1170],
        ],
        "Orientation meal services",
        orientation,
      );
    if (date === "2026-09-24")
      return special(
        [
          [420, 600],
          [660, 870],
          [930, 1170],
        ],
        "Orientation meal services",
        orientation,
      );
    if (date === "2026-09-25")
      return special(
        [
          [420, 600],
          [660, 1170],
        ],
        "Orientation Friday hours",
        orientation,
      );
    if (date === "2026-09-26")
      return special(
        [[480, place === "bartlett" ? 1230 : 870]],
        "Orientation Saturday · dinner at Bartlett only",
        orientation,
      );
    if (date === "2026-09-27")
      return special([[480, 1230]], "Orientation Sunday hours", orientation);
    const open = day === 0 || day === 6 ? 480 : 420,
      close =
        day === 5
          ? 1170
          : ["cathey", "baker"].includes(place) && day === 6
            ? 870
            : 1230;
    return {
      place,
      intervals:
        date >= "2026-09-28"
          ? [[atMinute(date, open), atMinute(date, close)]]
          : [],
      verified: date >= "2026-09-28",
      source: DINING_SOURCE,
      note:
        date >= "2026-09-28"
          ? "Regular dining hours; date exceptions take precedence"
          : "Summer / orientation hours required",
    };
  }
  return {
    place,
    intervals: [[atMinute(date, 0), atMinute(date, 1440)]],
    verified: true,
  };
}
export function insideHours(start, end, hours) {
  return hours.intervals.some(([a, b]) => start >= a && end <= b);
}
