# agent-team

把飞书变成 AI 编程 CLI（Claude Code / Codex）的指挥台。
一个话题 = 一个任务；bot 之间可互相 @ 协作；cron 定时巡检。

## 运行

pnpm dev（tsx watch）/ pnpm start / pnpm build

## 约定

- ESM only，Node 22+，pnpm
- 凭证只放 .env（已 gitignore），绝不硬编码、绝不提交
- bot 在 `config/bots.json` 注册（模板见 `config/bots.example.json`）：id、凭证环境变量名、`defaultCli`（该 bot 新话题的默认引擎）、`systemPrompt`
- `/claude <任务>` 与 `/codex <任务>` 可以为新话题显式选择引擎
- Claude Code 与 Codex 的模型服务使用各自的用户级配置，不把模型密钥写进项目 `.env`

## 错题本

> 踩坑后追加一行：现象 → 原因 → 正确做法。给未来的 AI 和人看。

- pnpm v11 默认拒绝依赖的构建脚本（esbuild 装完不可用）→ 在 `pnpm-workspace.yaml` 写 `allowBuilds: { esbuild: true }` 放行

<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Start with `openwiki/quickstart.md`, then follow its links to architecture, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
