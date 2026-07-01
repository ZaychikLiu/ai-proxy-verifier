import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { loadDotEnv, loadProviderConfig, redactProvider, repoRoot } from "./config.js";
import { runProbeSuite } from "./probe.js";

loadDotEnv();

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const publicDir = path.join(repoRoot, "public");
const clients = new Set();

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const rawPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.normalize(path.join(publicDir, rawPath));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": contentType(filePath), "cache-control": "no-store" });
    res.end(data);
  });
}

function broadcast(event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(data);
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, now: new Date().toISOString() });
  }

  if (req.method === "GET" && url.pathname === "/api/providers") {
    const config = loadProviderConfig();
    return sendJson(res, 200, {
      defaults: config.defaults,
      providers: config.providers.map(redactProvider)
    });
  }

  if (req.method === "GET" && url.pathname === "/api/results") {
    const latestPath = path.join(repoRoot, "data", "latest.json");
    if (!fs.existsSync(latestPath)) return sendJson(res, 200, { runId: null, summary: {}, results: [] });
    return sendJson(res, 200, JSON.parse(fs.readFileSync(latestPath, "utf8")));
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    res.write(`event: ready\ndata: {"ok":true}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/run") {
    try {
      const body = await readBody(req);
      broadcast("run-started", { at: new Date().toISOString(), body });
      const run = await runProbeSuite({
        provider: body.provider || undefined,
        model: body.model || undefined,
        runs: Number(body.runs || 1),
        concurrency: Number(body.concurrency || 1),
        includeDisabled: Boolean(body.includeDisabled),
        all: true
      });
      broadcast("run-completed", run);
      return sendJson(res, 200, run);
    } catch (error) {
      broadcast("run-error", { error: error.message });
      return sendJson(res, 500, { error: error.message });
    }
  }

  return sendJson(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/")) {
    handleApi(req, res).catch((error) => sendJson(res, 500, { error: error.message }));
    return;
  }
  serveStatic(req, res);
});

server.listen(port, host, () => {
  console.log(`AI Proxy Verifier dashboard: http://${host}:${port}`);
});
