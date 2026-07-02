# AI Proxy Verifier

一个小型、可发布到 GitHub 的模型中转站验证器。它会用服务端密钥去真实调用各站点 API，记录模型是否可用、并发成功率、延迟、错误、usage、响应模型名和若干真实性信号。

> 重要边界：任何外部测试都不能百分百证明“背后一定是真模型”。这个项目给的是证据强弱：是否 2xx、是否返回随机 nonce、是否报告 usage、响应 `model` 是否相近、模型列表是否包含该 ID、是否有平台特征 header、并发下是否稳定。

## 快速开始

```bash
cp .env.example .env
# 编辑 .env，填入要测试的平台 key
npm start
```

打开 `http://localhost:8787`，点击“开始测试”。

也可以直接跑命令行：

```bash
node src/probe.js --all
node src/probe.js --provider openrouter --model claude --runs 3 --concurrency 2
node src/probe.js --dry-run --all
```

## 配置站点

站点和模型在 `config/providers.json`。默认启用了 OpenRouter、Requesty、AIHubMix、AI/ML API；国内中转站默认禁用，填好 key 和确认 `baseUrl` 后把 `enabled` 改成 `true`。

每个站点支持：

- `apiFormat`: 目前支持 `openai-chat` 和 `anthropic-messages`
- `baseUrl`: 例如 `https://openrouter.ai/api/v1`
- `modelsEndpoint` 或 `catalogueUrl`: 用来验证模型列表是否真的包含目标模型
- `auth.env`: `.env` 里的密钥变量名
- `models`: 要测试的模型 ID 和参考价格

## GitHub 定时测试

这个仓库内置 `.github/workflows/probe.yml`：

1. 在 GitHub 仓库 Settings -> Secrets and variables -> Actions 填入对应 API key。
2. 开启 GitHub Pages，发布 `main` 分支的 `/docs`。
3. Actions 会每小时跑一次，把脱敏后的最新结果写到 `public/data/latest.json`。

如果你不想自动提交结果，可以把 workflow 最后的 commit/push 步骤删掉，改成上传 artifact。

## 结果字段

- `support`: `yes`、`no`、`skipped`
- `authenticity.label`: `likely-real`、`plausible`、`reachable`、`failed`、`missing-key`
- `authenticity.score`: 0-100 的证据分
- `latencyMs.p95`: 并发请求的 P95 延迟
- `usageSamples`: 平台返回的 token/费用样本
- `headerSamples`: 脱敏后的关键响应头

## 安全默认值

默认每个模型只发 1 个小 token 请求。并发和请求数必须手动调高，避免无意烧额度。
