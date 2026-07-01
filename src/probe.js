import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  appendJsonLine,
  getAuthKey,
  joinUrl,
  loadDotEnv,
  loadProviderConfig,
  repoRoot,
  writeJsonAtomic
} from "./config.js";

const DEFAULT_HEADER_ALLOWLIST = [
  "server",
  "cf-ray",
  "x-request-id",
  "x-oneapi-request-id",
  "x-requesty-provider",
  "x-requesty-cache",
  "x-requesty-latency-ms",
  "x-openrouter-provider",
  "openrouter-processing-ms",
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests",
  "anthropic-ratelimit-requests-limit",
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-requests-reset"
];

function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--all") options.all = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--include-disabled") options.includeDisabled = true;
    else if (arg === "--provider") options.provider = argv[++i];
    else if (arg === "--model") options.model = argv[++i];
    else if (arg === "--runs") options.runs = Number(argv[++i]);
    else if (arg === "--concurrency") options.concurrency = Number(argv[++i]);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++i]);
    else if (arg === "--max-tokens") options.maxTokens = Number(argv[++i]);
    else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`AI Proxy Verifier

Usage:
  node src/probe.js --all
  node src/probe.js --provider openrouter --model claude-opus --runs 3 --concurrency 2
  node src/probe.js --dry-run --all

Options:
  --all                 Probe all enabled providers and configured models.
  --provider <id>       Probe one provider. Works even if provider.enabled is false.
  --model <text>        Filter model IDs by substring.
  --runs <n>            Total requests per provider/model. Default comes from config.
  --concurrency <n>     Max parallel requests per provider/model.
  --include-disabled    Include disabled providers when --all is used.
  --dry-run             Validate target selection without making network calls.
`);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function summarizeLatency(latencies) {
  if (!latencies.length) return { min: null, p50: null, p95: null, max: null, avg: null };
  const sum = latencies.reduce((acc, item) => acc + item, 0);
  return {
    min: Math.min(...latencies),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    max: Math.max(...latencies),
    avg: Math.round(sum / latencies.length)
  };
}

function normalizeModelId(value = "") {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function modelLooksSimilar(requested, returned, family) {
  if (!returned) return false;
  const req = normalizeModelId(requested);
  const got = normalizeModelId(returned);
  if (!req || !got) return false;
  if (req === got || got.includes(req) || req.includes(got)) return true;
  if (family === "claude") return got.includes("claude") && (req.includes("opus") === got.includes("opus") || req.includes("fable") === got.includes("fable"));
  if (family === "openai") return got.includes("gpt") || got.includes("openai");
  if (family === "gemini") return got.includes("gemini");
  return false;
}

function pickHeaders(headers) {
  const selected = {};
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (DEFAULT_HEADER_ALLOWLIST.includes(lower) || lower.startsWith("x-ratelimit-")) {
      selected[lower] = value;
    }
  }
  return selected;
}

function buildHeaders(provider, apiKey) {
  const headers = {
    "content-type": "application/json",
    ...(provider.headers || {})
  };
  if (provider.auth?.type === "bearer" && apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  if (provider.auth?.type === "x-api-key" && apiKey) {
    headers["x-api-key"] = apiKey;
  }
  if (provider.apiFormat === "anthropic-messages") {
    headers["anthropic-version"] = provider.anthropicVersion || "2023-06-01";
  }
  return headers;
}

function buildRequest(provider, model, nonce, options, apiKey) {
  const maxTokens = Number(options.maxTokens || model.maxTokens || provider.maxTokens || 12);
  const prompt = `Return exactly this ASCII string and no other text: PROBE:${nonce}`;
  const headers = buildHeaders(provider, apiKey);

  if (provider.apiFormat === "anthropic-messages") {
    return {
      url: joinUrl(provider.baseUrl, provider.messagesPath || "/messages"),
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: model.id,
          max_tokens: maxTokens,
          temperature: 0,
          messages: [{ role: "user", content: prompt }]
        })
      }
    };
  }

  return {
    url: joinUrl(provider.baseUrl, provider.chatPath || "/chat/completions"),
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: model.id,
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
        messages: [
          { role: "system", content: "You are running a model availability smoke test. Follow the user instruction exactly." },
          { role: "user", content: prompt }
        ]
      })
    }
  };
}

function parseCompletion(provider, json) {
  if (provider.apiFormat === "anthropic-messages") {
    const text = Array.isArray(json.content)
      ? json.content.map((part) => part.text || "").join("")
      : "";
    return { text, responseModel: json.model, usage: json.usage || null };
  }

  const choice = json.choices?.[0] || {};
  const text = choice.message?.content ?? choice.text ?? "";
  return {
    text: typeof text === "string" ? text : JSON.stringify(text),
    responseModel: json.model || choice.model || null,
    usage: json.usage || null,
    finishReason: choice.finish_reason || null
  };
}

async function withTimeout(promiseFactory, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await promiseFactory(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function probeOnce(provider, model, options, apiKey) {
  const nonce = crypto.randomBytes(6).toString("hex");
  const started = Date.now();
  const { url, init } = buildRequest(provider, model, nonce, options, apiKey);

  try {
    const response = await withTimeout(
      (signal) => fetch(url, { ...init, signal }),
      Number(options.timeoutMs || provider.timeoutMs || 45000)
    );
    const latencyMs = Date.now() - started;
    const headers = pickHeaders(response.headers);
    const raw = await response.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = null;
    }

    if (!response.ok) {
      return {
        ok: false,
        httpStatus: response.status,
        latencyMs,
        headers,
        error: json?.error?.message || json?.message || raw.slice(0, 500)
      };
    }

    const parsed = parseCompletion(provider, json || {});
    const expected = `PROBE:${nonce}`;
    const sentinelMatched = parsed.text.trim().includes(expected);
    return {
      ok: Boolean(parsed.text),
      httpStatus: response.status,
      latencyMs,
      headers,
      textHash: crypto.createHash("sha256").update(parsed.text).digest("hex").slice(0, 16),
      sample: parsed.text.slice(0, 120),
      sentinelMatched,
      responseModel: parsed.responseModel,
      usage: parsed.usage,
      finishReason: parsed.finishReason || null
    };
  } catch (error) {
    return {
      ok: false,
      httpStatus: null,
      latencyMs: Date.now() - started,
      headers: {},
      error: error.name === "AbortError" ? "timeout" : error.message
    };
  }
}

async function runPool(tasks, concurrency) {
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchCatalogue(provider, apiKey, options) {
  const url = provider.catalogueUrl || (provider.modelsEndpoint ? joinUrl(provider.baseUrl, provider.modelsEndpoint) : "");
  if (!url) return { available: false, ids: [], error: "no catalogue endpoint configured" };

  try {
    const response = await withTimeout(
      (signal) => fetch(url, { method: "GET", headers: buildHeaders(provider, apiKey), signal }),
      Number(options.timeoutMs || provider.timeoutMs || 45000)
    );
    const text = await response.text();
    if (!response.ok) return { available: false, ids: [], httpStatus: response.status, error: text.slice(0, 300) };
    const json = JSON.parse(text);
    const items = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
    const ids = items
      .map((item) => item.id || item.model_id || item.model || item.name)
      .filter(Boolean)
      .map(String);
    return { available: true, httpStatus: response.status, ids };
  } catch (error) {
    return { available: false, ids: [], error: error.name === "AbortError" ? "timeout" : error.message };
  }
}

function scoreAuthenticity({ attempts, model, catalogue }) {
  const successes = attempts.filter((item) => item.ok);
  const first = successes[0] || attempts[0] || {};
  const signals = [];
  let score = 0;

  if (successes.length > 0) {
    score += 30;
    signals.push("2xx_with_non_empty_text");
  }
  if (successes.some((item) => item.sentinelMatched)) {
    score += 20;
    signals.push("nonce_echo_matched");
  }
  if (successes.some((item) => item.usage && typeof item.usage === "object")) {
    score += 15;
    signals.push("usage_reported");
  }
  if (successes.some((item) => modelLooksSimilar(model.id, item.responseModel, model.family))) {
    score += 15;
    signals.push("response_model_similar");
  }
  const advertised = catalogue?.ids?.some((id) => normalizeModelId(id) === normalizeModelId(model.id));
  if (advertised) {
    score += 10;
    signals.push("model_catalogue_contains_id");
  }
  const knownRouterHeader = Object.keys(first.headers || {}).some((key) => key.includes("openrouter") || key.includes("requesty"));
  if (knownRouterHeader) {
    score += 5;
    signals.push("router_header_seen");
  }
  if (successes.length === attempts.length && attempts.length > 1) {
    score += 5;
    signals.push("all_concurrent_requests_succeeded");
  }

  let label = "failed";
  if (score >= 75) label = "likely-real";
  else if (score >= 55) label = "plausible";
  else if (score >= 30) label = "reachable";
  else if (attempts.some((item) => item.error)) label = "failed";

  return { score, label, signals, advertised };
}

async function probeTarget(provider, model, options, apiKey, catalogue) {
  const runs = Math.max(1, Number(options.runs || provider.runs || 1));
  const concurrency = Math.max(1, Math.min(Number(options.concurrency || provider.concurrency || 1), runs));
  const attempts = await runPool(
    Array.from({ length: runs }, () => () => probeOnce(provider, model, options, apiKey)),
    concurrency
  );
  const okCount = attempts.filter((item) => item.ok).length;
  const latencies = attempts.filter((item) => item.latencyMs !== null).map((item) => item.latencyMs);
  const authenticity = scoreAuthenticity({ attempts, model, catalogue });

  return {
    providerId: provider.id,
    providerName: provider.name,
    modelId: model.id,
    family: model.family || "unknown",
    price: model.price || null,
    support: okCount > 0 ? "yes" : "no",
    authenticity,
    concurrency,
    runs,
    ok: okCount,
    failed: runs - okCount,
    latencyMs: summarizeLatency(latencies),
    responseModels: [...new Set(attempts.map((item) => item.responseModel).filter(Boolean))],
    usageSamples: attempts.map((item) => item.usage).filter(Boolean).slice(0, 3),
    headerSamples: attempts.map((item) => item.headers).filter((item) => Object.keys(item).length).slice(0, 3),
    errors: attempts.filter((item) => !item.ok).map((item) => ({ httpStatus: item.httpStatus, error: item.error })).slice(0, 5),
    samples: attempts.filter((item) => item.sample).map((item) => item.sample).slice(0, 2)
  };
}

function selectTargets(config, options) {
  const providerFilter = options.provider ? String(options.provider).toLowerCase() : "";
  const modelFilter = options.model ? String(options.model).toLowerCase() : "";
  const includeDisabled = Boolean(options.includeDisabled || options.provider);

  const targets = [];
  for (const provider of config.providers || []) {
    if (providerFilter && provider.id.toLowerCase() !== providerFilter) continue;
    if (!includeDisabled && !provider.enabled) continue;
    for (const model of provider.models || []) {
      if (modelFilter && !model.id.toLowerCase().includes(modelFilter)) continue;
      targets.push({ provider, model });
    }
  }
  return targets;
}

function mergeDefaults(config, options) {
  return {
    ...(config.defaults || {}),
    ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined))
  };
}

export async function runProbeSuite(options = {}) {
  loadDotEnv();
  const config = loadProviderConfig();
  const effectiveOptions = mergeDefaults(config, options);
  const targets = selectTargets(config, effectiveOptions);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const startedAt = new Date().toISOString();

  if (effectiveOptions.dryRun) {
    return {
      runId,
      startedAt,
      dryRun: true,
      targets: targets.map(({ provider, model }) => ({
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        enabled: Boolean(provider.enabled),
        keyEnv: provider.auth?.env || null,
        keyPresent: Boolean(getAuthKey(provider))
      }))
    };
  }

  const results = [];
  const catalogueCache = new Map();
  for (const { provider, model } of targets) {
    const apiKey = getAuthKey(provider);
    if (!apiKey) {
      results.push({
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        family: model.family || "unknown",
        support: "skipped",
        authenticity: { score: 0, label: "missing-key", signals: [] },
        errors: [{ error: `Missing ${provider.auth?.env || "API key"}` }]
      });
      continue;
    }

    let catalogue = catalogueCache.get(provider.id);
    if (!catalogue) {
      catalogue = await fetchCatalogue(provider, apiKey, effectiveOptions);
      catalogueCache.set(provider.id, catalogue);
    }
    results.push(await probeTarget(provider, model, effectiveOptions, apiKey, catalogue));
  }

  const completedAt = new Date().toISOString();
  const summary = {
    total: results.length,
    yes: results.filter((item) => item.support === "yes").length,
    no: results.filter((item) => item.support === "no").length,
    skipped: results.filter((item) => item.support === "skipped").length,
    likelyReal: results.filter((item) => item.authenticity?.label === "likely-real").length
  };
  const run = { runId, startedAt, completedAt, summary, results };

  const latestPath = path.join(repoRoot, "data", "latest.json");
  const publicLatestPath = path.join(repoRoot, "public", "data", "latest.json");
  const historyPath = path.join(repoRoot, "data", "results.jsonl");
  writeJsonAtomic(latestPath, run);
  writeJsonAtomic(publicLatestPath, run);
  appendJsonLine(historyPath, run);
  return run;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs();
    if (options.help) {
      printHelp();
      process.exit(0);
    }
    if (!options.all && !options.provider) {
      printHelp();
      process.exit(1);
    }
    const result = await runProbeSuite(options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.stack || error.message);
    process.exit(1);
  }
}
