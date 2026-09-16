import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = new URL("../", import.meta.url);
const hash = (data) => createHash("sha256").update(data).digest("hex");

export async function checkDeployment(base) {
  const origin = new URL(base.endsWith("/") ? base : base + "/");
  const worker = await readFile(new URL("sw.js", root), "utf8");
  const assets = [
    ...worker.match(/const FILES = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g),
  ].map((m) => (m[1] === "./" ? "index.html" : m[1]));
  const results = await Promise.all(
    [...new Set([...assets, "sw.js"])].map(async (file) => {
      try {
        const local = await readFile(new URL(file, root));
        const url = new URL(file, origin);
        url.searchParams.set("release_check", hash(local).slice(0, 16));
        const response = await fetch(url, {
          cache: "no-store",
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok)
          return { file, match: false, reason: `HTTP ${response.status}` };
        const match =
          hash(Buffer.from(await response.arrayBuffer())) === hash(local);
        return {
          file,
          match,
          ...(match
            ? {}
            : { reason: "Published contents differ from this release" }),
        };
      } catch (error) {
        return { file, match: false, reason: error.message };
      }
    }),
  );
  return {
    url: origin.href,
    matches: results.every((r) => r.match),
    files: results,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await checkDeployment(
    process.argv[2] || "https://jonathandesta.github.io/Planner/",
  );
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.matches ? 0 : 1;
}
