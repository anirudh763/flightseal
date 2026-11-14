// Minimal static server for docs/ (what GitHub Pages serves), used by the browser test.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, normalize, extname, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DOCS = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2",
  ".mjs": "text/javascript", ".wasm": "application/wasm", ".txt": "text/plain", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

export function serve(port = 0, prefix = "") {
  if (prefix && !/^\/[a-z0-9-]+$/.test(prefix)) throw new Error("Invalid static path prefix");
  const server = createServer(async (req, res) => {
    let path;
    try { path = decodeURIComponent(new URL(req.url, "http://x").pathname); }
    catch { return res.writeHead(400).end("invalid URL"); }
    if (prefix) {
      if (!path.startsWith(prefix + "/")) return res.writeHead(404).end("not found");
      path = path.slice(prefix.length);
    }
    const file = normalize(join(DOCS, path.endsWith("/") ? path + "index.html" : path));
    if (file !== DOCS && !file.startsWith(DOCS + sep)) return res.writeHead(403).end();
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((ok, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => ok({ server, url: `http://127.0.0.1:${server.address().port}${prefix}/` }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const prefix = process.argv[3] || "";
  const { url } = await serve(Number(process.argv[2] || 8080), prefix);
  console.log(`serving docs/ at ${url}${prefix ? "console/" : ""}`);
}
