import path from "node:path";
import { loadDotEnv, loadProviderConfig, redactProvider, repoRoot, writeJsonAtomic } from "./config.js";

loadDotEnv();

const config = loadProviderConfig();
const payload = {
  defaults: config.defaults,
  providers: config.providers.map(redactProvider)
};

writeJsonAtomic(path.join(repoRoot, "public", "data", "providers.json"), payload);
writeJsonAtomic(path.join(repoRoot, "docs", "data", "providers.json"), payload);
