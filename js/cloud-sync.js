// Immutable, app-created Drive revisions. No timestamp-based replacement.
// Kept byte-identical to Planner's module; each application owns its namespace.
export const canonical = (value) => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sort(value[k])]),
    );
  return value;
}
const clone = (v) => structuredClone(v);
const uid = () => crypto.randomUUID();
export function diffEntities(before, after) {
  const changes = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(key in after)) changes[key] = { deleted: true };
    else if (
      !(key in before) ||
      canonical(before[key]) !== canonical(after[key])
    )
      changes[key] = { value: clone(after[key]) };
  }
  return changes;
}
export function validateRevision(r, app) {
  if (
    !r ||
    r.schema !== 1 ||
    r.app !== app ||
    typeof r.id !== "string" ||
    !r.id ||
    typeof r.writer !== "string" ||
    !Array.isArray(r.parents) ||
    !r.parents.every((p) => typeof p === "string" && p !== r.id) ||
    !Number.isFinite(r.createdAt) ||
    !r.changes ||
    Array.isArray(r.changes) ||
    typeof r.changes !== "object" ||
    Object.keys(r.changes).some(
      (k) =>
        ["__proto__", "constructor", "prototype"].includes(k) ||
        !r.changes[k] ||
        (r.changes[k].deleted !== true && !("value" in r.changes[k])),
    )
  )
    throw Error(
      "An invalid cloud revision was retained without replacing local data.",
    );
  return r;
}
export function mergeRevisions(revisions, app) {
  const byId = new Map();
  for (const raw of revisions) {
    const r = validateRevision(raw, app);
    if (byId.has(r.id) && canonical(byId.get(r.id)) !== canonical(r))
      throw Error("Two different cloud revisions have the same identity.");
    byId.set(r.id, r);
  }
  const children = new Map([...byId.keys()].map((id) => [id, []]));
  const degree = new Map();
  for (const r of byId.values()) {
    degree.set(r.id, r.parents.length);
    for (const parent of r.parents) {
      if (!byId.has(parent))
        throw Error(
          "Cloud history is incomplete. Local changes are safe; retry sync.",
        );
      children.get(parent).push(r.id);
    }
  }
  const ready = [...byId.keys()].filter((id) => degree.get(id) === 0),
    order = [];
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i];
    order.push(id);
    for (const child of children.get(id)) {
      degree.set(child, degree.get(child) - 1);
      if (!degree.get(child)) ready.push(child);
    }
  }
  if (order.length !== byId.size)
    throw Error("Cloud revision history contains a cycle.");
  const rank = new Map(order.map((id, i) => [id, i]));
  const ancestry = new Map();
  function ancestor(a, b) {
    if (rank.get(a) >= rank.get(b)) return false;
    const key = `${a}:${b}`;
    if (ancestry.has(key)) return ancestry.get(key);
    const pending = [...byId.get(b).parents],
      seen = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (id === a) {
        ancestry.set(key, true);
        return true;
      }
      if (seen.has(id) || rank.get(id) <= rank.get(a)) continue;
      seen.add(id);
      pending.push(...byId.get(id).parents);
    }
    ancestry.set(key, false);
    return false;
  }
  const heads = order.filter((id) => !children.get(id).length).sort();
  const candidates = new Map();
  for (const id of order) {
    const r = byId.get(id);
    for (const [key, change] of Object.entries(r.changes)) {
      const live = (candidates.get(key) || []).filter(
        (v) => !ancestor(v.revision, r.id),
      );
      live.push({
        revision: r.id,
        writer: r.writer,
        at: r.createdAt,
        ...change,
      });
      candidates.set(key, live);
    }
  }
  const entities = {},
    conflicts = [];
  for (const [key, live] of candidates) {
    const distinct = [
      ...new Map(
        live.map((v) => [
          canonical(v.deleted ? { deleted: true } : { value: v.value }),
          v,
        ]),
      ).values(),
    ];
    if (distinct.length > 1) conflicts.push({ key, variants: distinct });
    else if (!distinct[0].deleted) entities[key] = clone(distinct[0].value);
  }
  return { entities, conflicts, heads };
}

export class DriveSync {
  constructor({
    app,
    storage,
    getSnapshot,
    applySnapshot,
    hasLocalData,
    getToken,
    onStatus = () => {},
    fetcher = fetch,
  }) {
    Object.assign(this, {
      app,
      storage,
      getSnapshot,
      applySnapshot,
      hasLocalData,
      getToken,
      onStatus,
      fetcher,
    });
    this.key = `${app}:sync:v1`;
    const raw = storage.getItem(this.key);
    this.meta = raw
      ? JSON.parse(raw)
      : {
          writer: uid(),
          revisions: [],
          uploaded: [],
          baseline: null,
          baseHeads: [],
        };
    if (
      !Array.isArray(this.meta.revisions) ||
      !Array.isArray(this.meta.uploaded)
    )
      throw Error("Cloud metadata needs recovery; local journal is intact.");
    mergeRevisions(this.meta.revisions, app);
    this.conflicts = [];
    this.busy = false;
    this.status = "Saved on this device";
    this.history =
      typeof indexedDB !== "undefined" ? new RevisionStorage(app) : null;
    this.ready = this.history
      ? this.history.read().then((saved) => {
          if (saved) {
            mergeRevisions(saved.revisions, app);
            this.meta = saved;
          }
        })
      : Promise.resolve();
    this.ready.catch((error) => this.report(error.message));
  }
  report(message) {
    this.status = message;
    this.onStatus(message, this.conflicts);
  }
  async save() {
    if (this.history) {
      this.meta = await this.history.write(this.meta);
      this.storage.removeItem(this.key);
    } else this.storage.setItem(this.key, JSON.stringify(this.meta));
  }
  append(changes, parents) {
    if (!Object.keys(changes).length) return;
    const revision = {
      schema: 1,
      app: this.app,
      id: uid(),
      writer: this.meta.writer,
      createdAt: Date.now(),
      parents,
      changes,
    };
    this.meta.revisions.push(revision);
    return revision.id;
  }
  async capture() {
    try {
      await this.ready;
      const current = this.getSnapshot();
      if (
        this.meta.baseline === null &&
        !this.hasLocalData() &&
        !this.meta.revisions.length
      )
        return;
      const before = this.meta.baseline || {};
      const id = this.append(
        diffEntities(before, current),
        this.meta.baseHeads || [],
      );
      if (id) this.meta.baseHeads = [id];
      this.meta.baseline = clone(current);
      await this.save();
      this.report(
        this.getToken()
          ? "Changes queued for sync"
          : "Saved on this device · connect to sync",
      );
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.sync(), 1200);
    } catch (error) {
      this.report(error.message);
    }
  }
  async request(url, options = {}) {
    const token = this.getToken();
    if (!token)
      throw Error(
        "Connect Google to sync. Your changes are saved on this device.",
      );
    const response = await this.fetcher(url, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
    });
    if (!response.ok)
      throw Error(
        response.status === 401
          ? "Reconnect Google to sync. Your changes are saved."
          : `Sync could not finish (HTTP ${response.status}). Your changes are saved.`,
      );
    return response.json();
  }
  async sync() {
    if (this.busy) {
      this.again = true;
      return;
    }
    if (!this.getToken()) {
      this.report("Saved on this device · connect to sync");
      return;
    }
    this.busy = true;
    clearTimeout(this.timer);
    try {
      await this.ready;
      // Capture before the first network await, including edits made while offline.
      const current = this.getSnapshot();
      if (this.meta.baseline !== null || this.hasLocalData()) {
        const id = this.append(
          diffEntities(this.meta.baseline || {}, current),
          this.meta.baseHeads || [],
        );
        if (id) this.meta.baseHeads = [id];
        this.meta.baseline = clone(current);
        await this.save();
      }
      this.report("Syncing…");
      const files = [];
      let page;
      do {
        const p = new URLSearchParams({
          q: `trashed=false and appProperties has { key='campusSyncApp' and value='${this.app}' }`,
          spaces: "drive",
          fields: "nextPageToken,files(id,appProperties)",
          pageSize: "1000",
        });
        if (page) p.set("pageToken", page);
        const data = await this.request(
          `https://www.googleapis.com/drive/v3/files?${p}`,
        );
        files.push(...(data.files || []));
        page = data.nextPageToken;
      } while (page);
      const known = new Set(this.meta.revisions.map((r) => r.id));
      const missing = files.filter(
        (f) => !known.has(f.appProperties?.revision),
      );
      // Download everything successfully before adopting any remote data.
      const fetched = [];
      for (let i = 0; i < missing.length; i += 8)
        fetched.push(
          ...(await Promise.all(
            missing
              .slice(i, i + 8)
              .map((f) =>
                this.request(
                  `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}?alt=media`,
                ),
              ),
          )),
        );
      fetched.forEach((r) => validateRevision(r, this.app));
      for (const r of fetched)
        if (!known.has(r.id)) {
          this.meta.revisions.push(r);
          known.add(r.id);
        }
      const remoteIds = new Set(files.map((f) => f.appProperties?.revision));
      this.meta.uploaded = [...new Set([...this.meta.uploaded, ...remoteIds])];
      await this.save();
      for (const revision of [...this.meta.revisions]) {
        if (this.meta.uploaded.includes(revision.id)) continue;
        const boundary = `campus_${uid()}`;
        const metadata = {
          name: `${this.app}-${revision.id}.json`,
          mimeType: "application/json",
          appProperties: { campusSyncApp: this.app, revision: revision.id },
        };
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(revision)}\r\n--${boundary}--`;
        await this.request(
          "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
          {
            method: "POST",
            headers: {
              "Content-Type": `multipart/related; boundary=${boundary}`,
            },
            body,
          },
        );
        this.meta.uploaded.push(revision.id);
        await this.save();
      }
      // A user may have edited while network requests were in flight. Capture that
      // delta against the previously adopted baseline before computing the merge.
      const latest = this.getSnapshot();
      if (this.meta.baseline !== null) {
        const changes = diffEntities(this.meta.baseline, latest);
        if (Object.keys(changes).length) {
          const id = this.append(changes, this.meta.baseHeads || []);
          this.meta.baseHeads = [id];
          this.meta.baseline = clone(latest);
          this.again = true;
        }
      }
      const merged = mergeRevisions(this.meta.revisions, this.app);
      this.conflicts = merged.conflicts;
      if (!merged.conflicts.length && Object.keys(merged.entities).length) {
        if (canonical(merged.entities) !== canonical(this.getSnapshot()))
          await this.applySnapshot(merged.entities);
        this.meta.baseline = clone(this.getSnapshot());
        this.meta.baseHeads = merged.heads;
      }
      await this.save();
      this.report(
        this.conflicts.length
          ? `${this.conflicts.length} sync conflict${this.conflicts.length === 1 ? "" : "s"} · both versions preserved`
          : "Synced with Google Drive",
      );
    } catch (e) {
      this.report(e.message);
    } finally {
      this.busy = false;
      if (this.again) {
        this.again = false;
        this.timer = setTimeout(() => this.sync(), 1500);
      }
    }
  }
  async resolve(key, revisionId) {
    const merged = mergeRevisions(this.meta.revisions, this.app);
    const conflict = merged.conflicts.find((c) => c.key === key);
    const choice = conflict?.variants.find((v) => v.revision === revisionId);
    if (!choice)
      throw Error("That conflict changed. Refresh the conflict list.");
    this.append(
      { [key]: choice.deleted ? { deleted: true } : { value: choice.value } },
      merged.heads,
    );
    await this.save();
    await this.sync();
  }
}

// Revision history can exceed localStorage's small quota after a few long workouts.
// Keep it in IndexedDB; only the current app journal and its backup use localStorage.
// Atomic union writes preserve revisions queued by another tab of the same app.
class RevisionStorage {
  constructor(app) {
    this.app = app;
    this.db = new Promise((resolve, reject) => {
      const request = indexedDB.open("campus-private-revisions-v1", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("history");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(
          Error(
            "Private revision storage could not open. The current journal is safe on this device.",
          ),
        );
    });
  }
  async read() {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("history", "readonly");
      const request = tx.objectStore("history").get(this.app);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }
  async write(meta) {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction("history", "readwrite"),
        store = tx.objectStore("history");
      const request = store.get(this.app);
      let merged;
      request.onsuccess = () => {
        const old = request.result;
        const byId = new Map((old?.revisions || []).map((r) => [r.id, r]));
        for (const r of meta.revisions) byId.set(r.id, r);
        merged = {
          ...clone(meta),
          revisions: [...byId.values()],
          uploaded: [...new Set([...(old?.uploaded || []), ...meta.uploaded])],
        };
        store.put(merged, this.app);
      };
      tx.oncomplete = () => resolve(merged);
      tx.onerror = () =>
        reject(
          tx.error ||
            Error(
              "Private revision history could not be saved. Your current journal remains on this device.",
            ),
        );
      tx.onabort = () =>
        reject(tx.error || Error("Revision save was interrupted; retry sync."));
    });
  }
}
