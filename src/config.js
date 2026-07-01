import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
export const repoRoot = path.resolve(path.dirname(__filename), "..");

export function loadDotEnv(filePath = path.join(repoRoot, ".env")) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function loadProviderConfig(filePath = path.join(repoRoot, "config", "providers.json")) {
  return readJson(filePath);
}

export function getAuthKey(provider) {
  const envName = provider.auth?.env;
  if (!envName) return "";
  return process.env[envName] || "";
}

export function redactProvider(provider) {
  const envName = provider.auth?.env || "";
  return {
    ...provider,
    auth: provider.auth ? { ...provider.auth, keyPresent: Boolean(envName && process.env[envName]) } : undefined
  };
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

export function appendJsonLine(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

export function joinUrl(baseUrl, suffix = "") {
  if (/^https?:\/\//i.test(suffix)) return suffix;
  return `${String(baseUrl).replace(/\/+$/, "")}/${String(suffix).replace(/^\/+/, "")}`;
}
