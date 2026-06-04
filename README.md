# Headroom plugin for Cline

A [Cline](https://github.com/cline/cline) plugin that gives the agent
[Headroom](https://github.com/chopratejas/headroom) — the local context
compression layer — so it can shrink large context (tool outputs, logs, RAG
chunks, transcripts) **before** it reaches the model. Same answers, 60–95% fewer
tokens, and fully reversible (originals are retrievable via Headroom CCR).

> Plugins currently apply to the Cline **SDK, CLI, and Kanban** — not the VS Code
> or JetBrains extensions.

## What it adds

The plugin registers four tools and lifecycle hooks:

| Tool | Purpose |
| --- | --- |
| `headroom_compress` | Compress a `messages` array or raw `text` blob. Returns the compressed content in the same shape plus token savings. |
| `headroom_simulate` | Dry-run compression — reports estimated savings, transforms, waste signals, and cache-alignment score without modifying anything. |
| `headroom_retrieve` | Retrieve the original, uncompressed content behind a CCR hash (from `headroom_compress`'s `ccrHashes`). Supports an optional search `query`. |
| `headroom_stats` | Cumulative session savings: number of compressions, tokens before/after, tokens saved, and aggregate percentage. |

Hooks:

- `beforeRun` / `afterRun` emit optional debug logs (enable with `verbose`).
- `beforeModel` optionally **auto-compacts** oversized context before each model
  call (opt-in via `autoCompact`). It only acts above a token threshold and fails
  open — a compression error never blocks the model call.

## Requirements

Headroom must be reachable, either via a local proxy or Headroom Cloud:

```bash
pip install "headroom-ai[all]"   # or: npm install -g headroom-ai
headroom proxy --port 8787       # local proxy (default base URL)
```

Configure the plugin through environment variables:

- `HEADROOM_BASE_URL` — proxy/cloud URL (defaults to `http://localhost:8787`)
- `HEADROOM_API_KEY` — Headroom Cloud API key (optional for local proxy)
- `HEADROOM_MODEL` — model used for tokenisation (defaults to `gpt-4o`)

If the proxy is unreachable, Headroom falls back to returning the content
uncompressed, so tool calls never hard-fail.

## Install

```bash
cline plugin install https://github.com/<owner>/headroom-cline-plugin.git
cline config   # confirm it appears under the plugin tab
```

## Use programmatically

The default export is configured from the environment. For explicit
configuration, use the factory:

```ts
import { createHeadroomPlugin } from "headroom-cline-plugin"
import { Agent } from "@cline/sdk"

const agent = new Agent({
  providerId: "anthropic",
  modelId: "claude-sonnet-4-6",
  apiKey: process.env.ANTHROPIC_API_KEY,
  plugins: [
    createHeadroomPlugin({
      baseUrl: "http://localhost:8787",
      model: "gpt-4o",
      tokenBudget: 4000,
      verbose: true,
      // Transparently compress context above ~8k tokens before each model call.
      autoCompact: true,
      autoCompactThreshold: 8000,
    }),
  ],
})

await agent.run("Read the build logs, compress them with headroom_compress, then summarise the failure.")
```

### Auto-compaction

With `autoCompact: true`, the `beforeModel` hook estimates the size of the
outgoing context and, when it exceeds `autoCompactThreshold` (default `8000`
estimated tokens), compresses it in place through Headroom. This gives you
transparent token savings without the model having to call `headroom_compress`
itself. It is opt-in because it rewrites the outgoing request; it is also
fail-open, so any error leaves the request untouched.

## Development

```bash
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
```

Tests inject mock Headroom functions via the `deps` option, so the suite runs
without a live proxy.

## License

Apache-2.0
