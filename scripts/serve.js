import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};
export function serve(port = 8780) {
  const server = http.createServer((request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(request.url, "http://localhost").pathname,
      );
    } catch {
      response.writeHead(400).end();
      return;
    }
    const oly = pathname.startsWith("/oly-tracker/"),
      base = oly ? path.resolve(root, "../oly-tracker") : root;
    if (pathname === "/") {
      response.writeHead(302, { Location: "/Planner/" }).end();
      return;
    }
    const relative = pathname.replace(
      oly ? /^\/oly-tracker\// : /^\/Planner\//,
      "",
    );
    const target = path.resolve(
      base,
      relative + (relative.endsWith("/") || !relative ? "index.html" : ""),
    );
    if (
      !target.startsWith(base + path.sep) ||
      /(^|\/)\.|node_modules|test-results|\/tmp\//.test(relative)
    ) {
      response.writeHead(403).end();
      return;
    }
    fs.readFile(target, (error, data) => {
      if (error) {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(200, {
        "Content-Type":
          types[path.extname(target)] || "application/octet-stream",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(data);
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = serve(Number(process.env.PORT) || 8780);
  server.on("listening", () =>
    console.log(`Planner: http://127.0.0.1:${server.address().port}/Planner/`),
  );
}
