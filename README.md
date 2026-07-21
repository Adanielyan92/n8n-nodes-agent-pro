# n8n-nodes-agent-pro — Advanced AI Agent node for n8n (Claude, OpenAI & Gemini)

> **Agent Pro** is a drop-in replacement for n8n's built-in **AI Agent** node, with native **PDF & image (vision)** support, structured prompts, prompt caching, fallback models, on‑demand document fetch, and first‑class **Claude Max / Claude Code OAuth** support — so you can run agents on your **Claude subscription** instead of paying per token.

[![npm version](https://img.shields.io/npm/v/n8n-nodes-agent-pro.svg?color=FF6D5A&label=npm)](https://www.npmjs.com/package/n8n-nodes-agent-pro)
[![npm downloads](https://img.shields.io/npm/dm/n8n-nodes-agent-pro.svg?color=FF6D5A)](https://www.npmjs.com/package/n8n-nodes-agent-pro)
[![n8n community node](https://img.shields.io/badge/n8n-community%20node-EA4B71)](https://docs.n8n.io/integrations/community-nodes/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Adanielyan92/n8n-nodes-agent-pro?style=social)](https://github.com/Adanielyan92/n8n-nodes-agent-pro)

**Agent Pro** is an [n8n community node](https://docs.n8n.io/integrations/community-nodes/) — an advanced **n8n AI Agent** that keeps full compatibility with n8n's sub‑node ecosystem (Chat Model, Memory, Tools, Output Parser) and adds the capabilities the native agent is missing: **Anthropic Claude PDF vision**, **Claude Max (Claude Code OAuth) tokens**, Anthropic **prompt caching**, structured‑output auto‑fix, a fallback model, and a tool that can **fetch a document and let the model actually read it**.

---

## Table of contents

- [What is Agent Pro?](#what-is-agent-pro)
- [Agent Pro vs. the native n8n AI Agent](#agent-pro-vs-the-native-n8n-ai-agent)
- [Use Claude Max / Claude Code OAuth in n8n](#use-claude-max--claude-code-oauth-in-n8n)
- [Features](#features)
- [On-demand document fetch (tool → vision)](#on-demand-document-fetch-tool--vision)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Options reference](#options-reference)
- [Example use cases](#example-use-cases)
- [FAQ](#faq)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Credits](#credits)
- [License](#license)

---

## What is Agent Pro?

Agent Pro is a custom **n8n node** that runs an AI agent inside your n8n workflows. It speaks the same sub‑node protocol as n8n's official Tools Agent — connect any LangChain **Chat Model**, **Memory**, **Tool**, and **Output Parser** — so it drops straight into existing automations. On top of that base it adds a set of features that matter for real, production workflows:

- **Multi‑provider:** Anthropic **Claude**, **OpenAI** (and OpenAI‑compatible endpoints), and Google **Gemini**.
- **Claude Max / Claude Code OAuth:** run the agent on your Claude Pro/Max subscription via an `sk-ant-oat…` token instead of the metered Anthropic API.
- **Native PDF & image vision:** attach PDFs/images and Claude reads them as real documents, not as `[Attached PDF]` text markers.
- **On‑demand document fetch:** a connected tool can download a PDF/image at run time and have the model *see* it on the next turn.
- **Structured output** with JSON‑schema validation and an automatic **auto‑fix** retry loop.
- **Anthropic prompt caching** with per‑block TTLs — typically ~90% input‑token savings on repeat calls.
- **Fallback model** — connect a second Chat Model that takes over if the primary fails.

The package also ships a companion **Claude Vision** node for standalone image/PDF analysis.

---

## Agent Pro vs. the native n8n AI Agent

n8n's official `@n8n/nodes-langchain` Tools Agent is excellent — Agent Pro mirrors its architecture and removes a handful of hard limits:

| Capability | Native **AI Agent** | **Agent Pro** |
|---|:---:|:---:|
| Sub‑nodes (Chat Model / Memory / Tools / Output Parser) | ✅ | ✅ |
| **Claude Max / Claude Code OAuth (`sk-ant-oat…`)** | ❌ | ✅ |
| Native **PDF vision** for Anthropic (`document` blocks) | ❌ (text marker) | ✅ |
| **Image vision** across providers | partial | ✅ |
| **Tool fetches a document → model reads it** (vision) | ❌ | ✅ |
| Anthropic **prompt caching** (system + user, TTLs) | ❌ | ✅ |
| Structured system prompt (Role / Rules / Instructions / Context / Output) | ❌ (single field) | ✅ |
| Built‑in **auto‑fix** loop for JSON / schema output | ❌ | ✅ |
| **Fallback model** | ✅ | ✅ |
| Few‑shot examples in the UI | ❌ | ✅ |

If you only need a plain chat agent, the native node is perfect. Reach for Agent Pro when you need **Claude on your subscription**, **document vision**, **caching**, or **schema‑guaranteed output**.

---

## Use Claude Max / Claude Code OAuth in n8n

This is the headline feature and, as far as we know, the simplest way to use a **Claude Max** subscription inside an **n8n** workflow today.

If you're on **Claude Pro** or **Claude Max**, you can mint a long‑lived OAuth token via [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and paste it into Agent Pro as your Anthropic API key. Agent Pro detects the `sk-ant-oat…` prefix automatically and routes the request through the OAuth endpoint instead of the metered API.

What that means in practice:

- Your **Claude subscription quota** powers the agent — not your pay‑as‑you‑go API credit.
- Long‑running or high‑volume workflows that would be cost‑prohibitive on the metered API become viable.
- You still get every n8n sub‑node — tools, memory, output parsers, and a fallback model.

> **Responsible use:** Claude OAuth tokens are bound to your personal subscription and are subject to Anthropic's terms of service. Treat them like passwords. They're intended for personal automation, not for reselling agent capacity.

---

## Features

### Core
- **Sub‑node architecture** — connect any LangChain `Chat Model`, `Memory`, `Tool`, and `Output Parser`. Same UX as the native AI Agent.
- **Multi‑provider** — Anthropic Claude, OpenAI (and OpenAI‑compatible base URLs), Google Gemini.
- **Fallback model** — toggle `Enable Fallback Model` to reveal a second Chat Model input; if the primary fails, Agent Pro retries on the fallback automatically.
- **Tools agent** — a hand‑rolled LangChain tool‑calling loop (`model.bindTools().invoke()` over `BaseMessage[]`) with a configurable iteration cap. Because the node owns the message array, a tool can hand a document back into the model's *visual* context (see below).

### Multimodal / vision
- Native **PDF** support for Anthropic — sent as `document` blocks, so Claude reads the actual pages, not a text marker.
- Native **image** support across all providers.
- Attach per execution via `Binary Document Properties` (comma‑separated) or `Pass All Binary Data`.

### Structured prompting
- Five distinct system‑prompt sections — **Role**, **Rules**, **Instructions / Skills**, **Context**, **Output Format** — each rendered as a delimited block.
- **Few‑shot examples** — add `{input, output}` pairs in the UI; injected as turns before the live message.
- **Output Schema** — supply JSON Schema and the model is told to emit conformant JSON.

### Output handling
- Three modes: `Text`, `JSON (parse)`, `Structured (schema‑validated)`.
- **Auto‑fix** — on a parse failure, Agent Pro re‑asks the model with the error appended, then re‑parses. Works for the built‑in parser and connected `Output Parser` sub‑nodes.

### Anthropic prompt caching
- Master toggle plus separate switches for `Cache System Prompt` and `Cache User Message + Attachments`.
- Per‑block TTL (`5m` or `1h`). Now applied on **both** the tools path and the direct path.
- Typical real‑world saving on repeat calls: **~90%** of input tokens billed.

### Reliability
- Per‑call **timeout** (default 120 s).
- **Exponential‑backoff retries** on `5xx`, `429`, `ECONNRESET`, `ETIMEDOUT`.
- Configurable `Max Tool Iterations` for the agent loop.

---

## On-demand document fetch (tool → vision)

A normal tool result is text — so a tool that *downloads* a PDF can't get that PDF into the model's visual context. Agent Pro closes that gap.

A connected **tool can return a document** (PDF or image), and Agent Pro injects it into the conversation as a real **vision content block** — so the model *reads* it on the next turn instead of receiving stringified bytes.

**How it works:**

1. Use a **structured** tool (a Code Tool or sub‑workflow tool) that downloads the file (with credentials, if needed), base64‑encodes it, and returns a marker payload:

   ```jsonc
   {
     "__agentProDocument": true,
     "mediaType": "application/pdf",     // or image/png, image/jpeg, image/webp
     "fileName": "reference_proof.pdf",
     "data": "<base64>",
     "note": "reprint reference proof"    // optional; shown to the model
   }
   ```

2. Optionally fill the **Document Catalog** option — a JSON list of the documents the model *may* fetch — so it can pick the right reference on its own. It's rendered into the user message (not the cached system prompt) so it can vary per run.

3. Agent Pro delivers images as `image_url` blocks (all providers) and PDFs as native Anthropic `document` blocks, answers every tool call with a `tool_result`, and enforces guardrails: a per‑run fetch cap (`Max Document Fetches`), de‑duplication, a size limit, and **graceful over‑limit handling** (an oversized / 100‑plus‑page PDF is dropped with a note the model can act on, instead of crashing the run).

This is ideal for workflows where the correct reference — a proof, an invoice, an original design — is one of several attachments and the model should decide which one to open.

---

## Installation

### Option 1 — n8n Community Nodes (recommended)

In your n8n instance:

1. Go to **Settings → Community Nodes → Install**.
2. Enter the package name `n8n-nodes-agent-pro` and confirm.
3. The nodes appear under **AI → Agents → Agent Pro** (and **Claude Vision**).

> Self‑hosted only. n8n Cloud restricts community nodes to [verified packages](https://docs.n8n.io/integrations/community-nodes/).

### Option 2 — npm (self‑hosted / Docker)

```bash
# In your n8n custom-nodes folder, e.g. ~/.n8n/nodes (host) or /home/node/.n8n/nodes (Docker)
npm install n8n-nodes-agent-pro
```

Then **restart the n8n process** (a workflow re‑run is not enough).

### Option 3 — from a release tarball (pre‑release testing)

```bash
npm install /path/to/n8n-nodes-agent-pro-3.4.0.tgz
# then restart n8n
```

---

## Quick start

1. Drop an **Agent Pro** node onto the canvas.
2. Connect a **Chat Model** sub‑node (e.g. Anthropic). Paste your Anthropic API key — or your `sk-ant-oat…` Claude Code OAuth token.
3. (Optional) Connect **Memory**, any number of **Tool** sub‑nodes, and/or an **Output Parser**.
4. Fill in **Role / Rules / Instructions / Context / Output Format** as needed.
5. Set the **User Message** (an expression like `={{ $json.message }}` works).
6. Pick an **Output Format** (`text`, `json`, or `structured`). For schema output, paste your JSON Schema.
7. Run.

To attach a PDF/image for the model to read, set **Options → Binary Document Properties** (e.g. `data`) or enable **Pass All Binary Data**.

---

## Options reference

All settings live under the node's **Options** collection unless noted.

| Option | Type | Default | What it does |
|---|---|---|---|
| Role / Rules / Instructions / Context / Output Instructions | text | — | The five structured system‑prompt sections |
| User Message | text | expr | The live user turn (supports expressions) |
| Output Format | options | `text` | `text` · `json` · `structured` |
| Output Schema (JSON) | json | — | JSON Schema for `structured` output |
| Auto‑Fix JSON | boolean | `true` | Re‑ask the model to fix invalid JSON |
| Few‑Shot Examples | collection | — | `{input, output}` pairs injected as turns |
| Enable Fallback Model | boolean | `false` | Adds a second Chat Model input |
| Timeout (ms) | number | `120000` | Per‑call timeout |
| Max Retries | number | `2` | Backoff retries on 5xx/429/network errors |
| Max Tool Iterations | number | `10` | Agent‑loop cap (keep ≥ 2× Max Document Fetches) |
| Binary Document Properties | string | — | Comma‑separated binary props to attach (PDF/image) |
| Pass All Binary Data | boolean | `false` | Auto‑attach all binary items |
| **Document Catalog (JSON)** | string | — | List of documents a fetch tool may retrieve into vision |
| **Max Document Fetches** | number | `3` | Per‑run cap on tool‑fetched documents |
| Temperature / Max Output Tokens Override | number | `-1` | Override the model sub‑node settings (`-1` = inherit) |
| Prompt Caching (master) | boolean | `true` | Anthropic prompt‑caching on/off |
| Cache System Prompt · TTL | boolean · options | `true` · `5m` | Cache the system prompt (`5m` / `1h`) |
| Cache User Message + Attachments · TTL | boolean · options | `false` · `5m` | Cache the user turn + attached docs |
| Include Raw Response | boolean | `false` | Attach the full raw API response (debug) |

---

## Example use cases

- **Document QC / review** — attach a proof PDF, let the agent fetch the correct reference proof from a catalog, and compare them visually.
- **Invoice / receipt extraction** — feed a PDF and return schema‑validated JSON with `structured` output + auto‑fix.
- **Long‑running research agents on Claude Max** — run token‑heavy multi‑tool agents on your subscription via Claude Code OAuth.
- **Multi‑provider fallback** — primary on Claude, fallback on GPT‑4‑class or Gemini for resilience.

Sample workflows live in [`docs/examples/`](docs/examples/).

---

## FAQ

**How do I use Claude in n8n?**
Install Agent Pro, connect an Anthropic Chat Model sub‑node, and paste your Anthropic API key — or a Claude Code OAuth token to run on your Claude Max subscription. See [Quick start](#quick-start).

**Does this support Claude Max / Claude Pro?**
Yes. Paste an `sk-ant-oat…` token minted via Claude Code and Agent Pro routes through the OAuth endpoint automatically, so the agent runs on your subscription quota. See [Use Claude Max](#use-claude-max--claude-code-oauth-in-n8n).

**Is this an MCP server?**
No. Agent Pro is an n8n **AI Agent node** — it runs the agent loop inside n8n and connects to n8n Chat Model / Tool sub‑nodes. It's not the Model Context Protocol and doesn't wrap the Claude Code CLI. (You can still connect n8n's MCP tool nodes to it as tools.)

**Which providers and models work?**
Anthropic Claude, OpenAI + OpenAI‑compatible endpoints, and Google Gemini. Vision (PDF/image) is richest on Anthropic.

**Can the agent read PDFs?**
Yes — attach them via `Binary Document Properties`, and on Anthropic they're sent as native `document` blocks. A tool can also fetch a PDF at run time and have the model read it (see [document fetch](#on-demand-document-fetch-tool--vision)).

**Does it work on n8n Cloud?**
Community nodes on n8n Cloud are limited to verified packages; Agent Pro is intended for **self‑hosted** n8n. It works anywhere you can install community nodes.

**How is this different from the native n8n AI Agent?**
See the [comparison table](#agent-pro-vs-the-native-n8n-ai-agent). Short version: Claude Max OAuth, PDF/image vision, prompt caching, structured‑output auto‑fix, and tool‑fetched document vision.

---

## Troubleshooting

- **Node doesn't appear after install** — restart the n8n *process* (not just the workflow). Community nodes load at startup.
- **`sk-ant-oat…` token rejected** — confirm the token is current (Claude Code tokens rotate) and pasted as the Chat Model's API key, not the node.
- **PDF ignored by a non‑Anthropic model** — inline PDF vision is Anthropic‑only; other providers receive a text marker. Use a Claude model for PDF reading.
- **Fetched document not read** — the fetch tool must be a **structured** tool returning the `__agentProDocument` marker with base64 `data`; raw n8n binary isn't visible to the agent.
- **Cache never hits** — caching applies to Anthropic only, and the cached block must be identical across runs (keep per‑request data like the Document Catalog out of the system prompt — Agent Pro already does this).

---

## Roadmap

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Current priorities:

- Additional provider adapters (AWS Bedrock, Google Vertex, Azure OpenAI).
- `format_final_json_response` forced‑tool path for structured output.
- Token‑usage / stop‑reason reporting on the tools path.
- Anthropic **Files API** upload + PDF compression / page‑subsetting for large document fetch.

A full version history is in [CHANGELOG.md](CHANGELOG.md).

---

## Contributing

PRs welcome. [CONTRIBUTING.md](CONTRIBUTING.md) has the priority list, local‑dev commands (`npm run dev`, `npm run typecheck`, `npm test`, `npm run package`), the style guide, and the release process.

---

## Credits

This node stands on prior work:

- **[n8n](https://github.com/n8n-io/n8n)** — especially [`@n8n/nodes-langchain`](https://github.com/n8n-io/n8n/tree/master/packages/%40n8n/nodes-langchain). Agent Pro mirrors n8n's native Tools Agent architecture (sub‑node wiring, prompt‑template structure, output‑parser plumbing, the reverse‑ordered multi‑model input array) and could not have shipped without that reference implementation.
- **[chynten/n8n-nodes-claude-pro](https://github.com/chynten/n8n-nodes-claude-pro)** — for pioneering Claude OAuth tokens inside an n8n node and the `sk-ant-oat…` detection pattern.

If you build agents in n8n, please support both projects.

---

## License

[MIT](LICENSE) © SquareSigns and contributors.

---

<sub>**Keywords:** n8n AI agent node · n8n Claude / Anthropic node · n8n community node · Claude Max in n8n · Claude Code OAuth · n8n PDF / vision · n8n LangChain agent · OpenAI & Gemini for n8n.</sub>
