export const PLACES = {
  grossman: {
    label: "Grossman dorm",
    address: "6031 S Ellis Ave, Chicago, IL 60637",
    lat: 41.78486,
    lon: -87.60049,
    aliases: ["grossman", "renee", "dorm", "home", "6031 s ellis"],
  },
  cathey: {
    label: "Cathey Dining Commons",
    address: "6025 S Ellis Ave, Chicago, IL 60637",
    lat: 41.78532,
    lon: -87.60012,
    aliases: ["cathey", "6025 s ellis"],
  },
  woodlawn: {
    label: "Woodlawn Dining Commons",
    address: "1156 E 61st St, Chicago, IL 60637",
    lat: 41.7843,
    lon: -87.59638,
    aliases: ["woodlawn dining", "1156 e 61"],
  },
  baker: {
    label: "Baker Dining Commons",
    address: "5500 S University Ave, Chicago, IL 60637",
    lat: 41.79471,
    lon: -87.59877,
    aliases: ["baker dining", "baker commons"],
  },
  bartlett: {
    label: "Bartlett Dining Commons",
    address: "5640 S University Ave, Chicago, IL 60637",
    lat: 41.7927,
    lon: -87.59795,
    aliases: ["bartlett"],
  },
  ratner: {
    label: "Gerald Ratner Athletics Center",
    address: "5530 S Ellis Ave, Chicago, IL 60637",
    lat: 41.79425,
    lon: -87.60219,
    aliases: ["ratner", "5530 s ellis", "gym"],
  },
  kersten: {
    label: "Kersten Physics Teaching Center",
    address: "5720 S Ellis Ave, Chicago, IL 60637",
    lat: 41.79075,
    lon: -87.60128,
    aliases: ["kersten", "kptc", "5720 s ellis"],
  },
  ryerson: {
    label: "Ryerson Physical Laboratory",
    address: "1100 E 58th St, Chicago, IL 60637",
    lat: 41.78963,
    lon: -87.5988,
    aliases: ["ryerson", "1100 e 58"],
  },
  bslc: {
    label: "Biological Sciences Learning Center",
    address: "924 E 57th St, Chicago, IL 60637",
    lat: 41.79173,
    lon: -87.60318,
    aliases: [
      "bslc",
      "biological sciences learning",
      "bio sci learning",
      "biosci learning",
      "924 e 57",
    ],
  },
  cobb: {
    label: "Cobb Lecture Hall",
    address: "5811 S Ellis Ave, Chicago, IL 60637",
    lat: 41.78923,
    lon: -87.60037,
    aliases: ["cobb", "5811 s ellis", "581127 s ellis"],
  },
};
const normalize = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[.,–—-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const resolvedBuiltins = Object.fromEntries(
  Object.entries(PLACES).map(([id, p]) => [id, { ...p, id }]),
);
export function resolvePlace(value, custom = {}) {
  if (value && typeof value === "object") return value;
  if (resolvedBuiltins[value] && !custom[value]) return resolvedBuiltins[value];
  if (custom[value]) return { ...custom[value], id: value };
  const text = normalize(value);
  if (/https?:|zoom|google meet|online|virtual|microsoft teams/.test(text))
    return { id: "virtual", label: value, virtual: true };
  for (const [id, place] of Object.entries({ ...PLACES, ...custom }))
    if (id === text || place.aliases?.some((a) => text.includes(a)))
      return { ...place, id, display: value || place.label };
  return {
    id: `unknown:${text}`,
    label: value || "Location not provided",
    unknown: true,
  };
}
export const routeKey = (a, b) => [a, b].sort().join("|");
const CAMPUS_MINUTES = {
  "cathey|grossman": 5,
  "grossman|ratner": 20,
  "cathey|ratner": 19,
  "cathey|cobb": 10,
  "cathey|kersten": 13,
  "cathey|ryerson": 12,
  "bslc|cathey": 16,
  "cobb|kersten": 8,
  "bslc|ryerson": 10,
  "kersten|ratner": 9,
  "cobb|ratner": 13,
  "ratner|ryerson": 13,
  "bslc|ratner": 10,
  "grossman|woodlawn": 8,
  "cathey|woodlawn": 8,
};
export function travelBetween(origin, destination, settings = {}) {
  const a = resolvePlace(origin, settings.places),
    b = resolvePlace(destination, settings.places);
  if (b.virtual || a.virtual || (a.id === b.id && !a.unknown))
    return {
      minutes: 0,
      basis: "same location",
      origin: a,
      destination: b,
      includesTransitions: true,
    };
  const key = routeKey(a.id, b.id),
    override = settings.routes?.[key];
  if (override && Number.isFinite(override.minutes) && override.minutes > 0)
    return {
      ...override,
      basis: override.basis === "routed" ? "routed" : "personal override",
      origin: a,
      destination: b,
      includesTransitions: true,
    };
  if (CAMPUS_MINUTES[key])
    return {
      minutes: CAMPUS_MINUTES[key],
      basis: "campus estimate",
      origin: a,
      destination: b,
      includesTransitions: true,
    };
  if ([a.lat, a.lon, b.lat, b.lon].every(Number.isFinite)) {
    const rad = (v) => (v * Math.PI) / 180;
    const h =
      Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
      Math.cos(rad(a.lat)) *
        Math.cos(rad(b.lat)) *
        Math.sin(rad(b.lon - a.lon) / 2) ** 2;
    const km = 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    return {
      minutes: Math.max(4, Math.ceil(((km * 1.3) / 4.5) * 60) + 4),
      basis: "distance estimate",
      origin: a,
      destination: b,
      includesTransitions: true,
    };
  }
  return {
    minutes: Math.max(1, settings.defaultTravelMin || 15),
    basis: "unknown location allowance",
    unknown: true,
    origin: a,
    destination: b,
    includesTransitions: true,
  };
}
