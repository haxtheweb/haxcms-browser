// A static file server that behaves like GitHub Pages for a project site:
// the folder is served under /<name>/, anything else on the origin is a 404.
// With no name it is served at the root, like a site with its own domain.
// setApi(handler) answers /api/... with handler(req, res), standing in for
// the publish broker a Vercel deployment has (api/); setApi(null) removes it.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

export function startPagesServer(folder, name, port = 0) {
  const prefix = name ? "/" + name + "/" : "/";
  const rootDir = fs.realpathSync(folder);
  const requests = [];
  let api = null;
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
    requests.push(req.method + " " + pathname);
    if (api && pathname.startsWith("/api/")) {
      api(req, res);
      return;
    }
    const notFound = () => {
      res.statusCode = 404;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<h1>404</h1><p>There isn't a GitHub Pages site here.</p>");
    };
    if (name && pathname === "/" + name) {
      res.statusCode = 301;
      res.setHeader("location", prefix);
      res.end();
      return;
    }
    if (!pathname.startsWith(prefix) || pathname.includes("..")) {
      notFound();
      return;
    }
    let file = path.join(rootDir, pathname.slice(prefix.length));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      file = path.join(file, "index.html");
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      notFound();
      return;
    }
    res.setHeader(
      "content-type",
      TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
    );
    res.setHeader("cache-control", "max-age=600");
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}${prefix}`,
        requests,
        setApi: (handler) => {
          api = handler;
        },
        close: () => server.close(),
      });
    });
  });
}
