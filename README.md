
# pi-agent-config

Personal extensions for `@earendil-works/pi-coding-agent`, kept separately from
dotfiles because they are executable code assets.

## Active extensions

- `extensions/web-fetch/` — URL extraction and Markdown conversion (`pi-wf`).
- `extensions/web-search/` — general web search with fallback backends (`pi-ws`).
- `extensions/subagents/` — synchronous and visible-pane subagent delegation.
- `extensions/index.ts` — shared LSP extension.

Directory-based extensions own their runtime files, package manifest, and
tests; the shared LSP entry remains `extensions/index.ts`. Historical or
upstream comparison material lives under `old/` and is never loaded.

See [AGENTS.md](AGENTS.md) for conventions and [DEPLOY.md](DEPLOY.md) for a
fresh-machine setup.



pi-hypa

RTK
https://github.com/rtk-ai/rtk
