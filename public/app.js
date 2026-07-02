const state = {
  providers: [],
  latest: null,
  running: false,
  staticMode: false
};

const providerSelect = document.querySelector("#providerSelect");
const modelInput = document.querySelector("#modelInput");
const runsInput = document.querySelector("#runsInput");
const concurrencyInput = document.querySelector("#concurrencyInput");
const includeDisabledInput = document.querySelector("#includeDisabledInput");
const runButton = document.querySelector("#runButton");
const refreshButton = document.querySelector("#refreshButton");
const metrics = document.querySelector("#metrics");
const resultsBody = document.querySelector("#resultsBody");
const providerGrid = document.querySelector("#providerGrid");
const runMeta = document.querySelector("#runMeta");

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function fetchJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
}

function badgeClass(value) {
  if (value === "yes" || value === "likely-real") return "good";
  if (value === "plausible" || value === "reachable") return "warn";
  if (value === "skipped" || value === "missing-key") return "skip";
  return "bad";
}

function renderProviders() {
  providerSelect.innerHTML = [
    `<option value="">全部启用站点</option>`,
    ...state.providers.map((provider) => `<option value="${provider.id}">${provider.name}</option>`)
  ].join("");

  providerGrid.innerHTML = state.providers
    .map((provider) => {
      const keyPresent = provider.auth?.keyPresent;
      const enabled = provider.enabled ? "启用" : "禁用";
      const keyText = keyPresent ? "已配置密钥" : `缺少 ${provider.auth?.env || "密钥"}`;
      const cls = keyPresent ? "good" : "skip";
      return `<article class="providerCard">
        <h3>${provider.name}</h3>
        <p>${enabled} · <span class="badge ${cls}">${keyText}</span></p>
        <p class="mono">${provider.baseUrl}</p>
      </article>`;
    })
    .join("");
}

function renderMetrics() {
  const summary = state.latest?.summary || {};
  const cards = [
    ["total", "总测试项"],
    ["yes", "支持"],
    ["likelyReal", "高可信"],
    ["skipped", "跳过"]
  ];
  metrics.innerHTML = cards
    .map(([key, label]) => `<div class="metric"><strong>${summary[key] ?? 0}</strong><span>${label}</span></div>`)
    .join("");
}

function renderResults() {
  const latest = state.latest;
  runMeta.textContent = latest?.runId ? `${latest.completedAt || latest.startedAt} · ${latest.runId}` : "还没有运行结果";
  const results = latest?.results || [];
  if (!results.length) {
    resultsBody.innerHTML = `<tr><td colspan="9">暂无结果。配置 .env 后点击“开始测试”。</td></tr>`;
    return;
  }
  resultsBody.innerHTML = results
    .map((item) => {
      const auth = item.authenticity || {};
      const p95 = item.latencyMs?.p95 == null ? "-" : `${item.latencyMs.p95} ms`;
      const errors = (item.errors || []).map((error) => error.error).join("; ");
      return `<tr>
        <td>${item.providerName || item.providerId}</td>
        <td class="mono">${item.modelId}</td>
        <td><span class="badge ${badgeClass(item.support)}">${item.support}</span></td>
        <td><span class="badge ${badgeClass(auth.label)}">${auth.label || "-"}</span><br><span class="mono">${auth.score ?? 0}/100</span></td>
        <td>${item.concurrency || "-"}</td>
        <td>${item.ok ?? 0}/${item.runs ?? 0}</td>
        <td>${p95}</td>
        <td class="mono">${(item.responseModels || []).join(", ") || "-"}</td>
        <td>${errors || "-"}</td>
      </tr>`;
    })
    .join("");
}

function render() {
  runButton.disabled = state.staticMode || state.running;
  runButton.textContent = state.staticMode ? "静态看板" : state.running ? "测试中" : "开始测试";
  renderMetrics();
  renderResults();
}

async function loadAll() {
  let providers;
  let latest;
  try {
    [providers, latest] = await Promise.all([api("/api/providers"), api("/api/results")]);
    state.staticMode = false;
  } catch {
    [providers, latest] = await Promise.all([fetchJson("data/providers.json"), fetchJson("data/latest.json")]);
    state.staticMode = true;
  }
  state.providers = providers.providers;
  state.latest = latest;
  renderProviders();
  render();
}

async function runProbe() {
  if (state.staticMode) {
    alert("GitHub Pages 是静态看板。请在仓库 Actions 里手动运行 workflow，或在本地 npm start 后从本地页面发起测试。");
    return;
  }
  state.running = true;
  runButton.disabled = true;
  runButton.textContent = "测试中";
  try {
    state.latest = await api("/api/run", {
      method: "POST",
      body: JSON.stringify({
        provider: providerSelect.value || undefined,
        model: modelInput.value.trim() || undefined,
        runs: Number(runsInput.value || 1),
        concurrency: Number(concurrencyInput.value || 1),
        includeDisabled: includeDisabledInput.checked
      })
    });
    render();
  } finally {
    state.running = false;
    render();
  }
}

function subscribeEvents() {
  if (state.staticMode) return;
  const events = new EventSource("/api/events");
  events.addEventListener("run-completed", (event) => {
    state.latest = JSON.parse(event.data);
    render();
  });
}

runButton.addEventListener("click", () => runProbe().catch((error) => alert(error.message)));
refreshButton.addEventListener("click", () => loadAll().catch((error) => alert(error.message)));

loadAll().then(subscribeEvents).catch((error) => {
  resultsBody.innerHTML = `<tr><td colspan="9">${error.message}</td></tr>`;
});
