# n8n-nodes-agent-pro

> An advanced drop-in replacement for n8n's built-in **AI Agent** node — with native PDF & image support, structured prompts, prompt caching, fallback models, and first-class support for **Claude Code OAuth tokens (Claude Max plan)**.

[![npm version](https://img.shields.io/npm/v/n8n-nodes-agent-pro.svg)](https://www.npmjs.com/package/n8n-nodes-agent-pro)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Why this exists

n8n's official `@n8n/nodes-langchain` Tools Agent is excellent, but it has a few hard limits that this node removes:

- It cannot consume **Claude Code OAuth tokens** (`sk-ant-oat...`) issued by the Claude Pro / Max plan, so workflows must pay per-token through the standard Anthropic API.
- PDFs attached to an item are passed as a text marker rather than as native Anthropic `document` blocks.
- The system prompt is a single free-text field, with no structured sections (Role / Rules / Instructions / Context / Output Format).
- There is no built-in **auto-fix** loop for JSON / schema-constrained output.
- Anthropic prompt caching is not exposed.

**Agent Pro** keeps full compatibility with n8n's sub-node ecosystem (Chat Model, Memory, Tools, Output Parser) and adds the features above on top.

---

## The Claude Max / Claude Code unlock

If you are on a **Claude Pro** or **Claude Max** subscription, you can mint a long-lived OAuth token via [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and pass it into Agent Pro as your Anthropic API key. Agent Pro detects the `sk-ant-oat...` prefix automatically and routes the request through the OAuth endpoint instead of the metered API.

In practice this means:

- Your **Claude subscription quota** is what powers the agent, not your API credit balance.
- Long-running workflows that would be cost-prohibitive on the metered API become viable.
- You still get to use any tool, memory, parser, or fallback model that n8n natively supports.

> **Important:** Claude OAuth tokens are bound to your personal subscription and are subject to Anthropic's terms of service. Treat them like passwords. They are intended for personal automation, not for reselling agent capacity.

This is, to our knowledge, the simplest path to using a Claude Max subscription inside an n8n workflow today.

---

## Features

### Core
- **Sub-node architecture**: connect any LangChain `Chat Model`, `Memory`, `Tool`, and `Output Parser` sub-node — same UX as the native AI Agent.
- **Fallback model**: toggle on `Enable Fallback Model` and a second chat model input appears. If the primary call throws, LangChain's `withFallbacks()` runnable retries with the fallback automatically.
- **Tools agent**: full LangChain `createToolCallingAgent` loop with configurable max iterations.
- **Direct API path**: when the connected model exposes its API key, Agent Pro bypasses LangChain and calls the provider directly — enabling features below.

### Multimodal
- Native **PDF** support for Anthropic (sent as `document` blocks, not text markers).
- Native **image** support across all providers (Anthropic, OpenAI, Gemini).
- Per-execution control via `Binary Document Properties` (comma-separated) or `Pass All Binary Data`.

### Structured prompting
- Five distinct system-prompt sections: **Role**, **Rules**, **Instructions / Skills**, **Context**, **Output Format**. Each renders as a clearly-delimited block.
- **Few-shot examples**: add `{input, output}` pairs in the UI; they're injected as assistant/user turns before the live user message.
- **Output Schema** field: provide JSON Schema and the model is told to emit conformant JSON.

### Output handling
- Three output modes: `Text`, `JSON (parse)`, `Structured (schema-validated)`.
- **Auto-fix**: on a parse failure, Agent Pro re-asks the same model with the error appended, then re-parses. Works for both built-in parsing and connected `Output Parser` sub-nodes.

### Anthropic prompt caching
- Master toggle plus separate switches for `Cache System Prompt` and `Cache User Message + Attachments`.
- Configurable TTL per cache block (`5m` or `1h`).
- Typical real-world saving on repeat calls: ~90 % of input tokens billed.

### Reliability
- Per-call **timeout** (default 120 s).
- **Exponential-backoff retries** on `5xx`, `429`, `ECONNRESET`, `ETIMEDOUT`.
- Configurable `Max Tool Iterations` for the agent loop.

---

## Installation

### As an npm package (recommended)

```bash
# Inside your n8n custom-nodes folder, e.g. ~/.n8n/custom
npm install n8n-nodes-agent-pro
```

Then restart n8n. The node appears under **AI → Agents → Agent Pro**.

### From a local tarball

```bash
npm install /path/to/n8n-nodes-agent-pro-3.3.17.tgz
```

Useful for testing pre-release builds.

---

## Quick start

1. Drop an **Agent Pro** node onto the canvas.
2. Connect a **Chat Model** sub-node (e.g. Anthropic). Paste your Anthropic API key — or your `sk-ant-oat...` Claude Code OAuth token.
3. (Optional) Connect a `Memory`, any number of `Tool` sub-nodes, and/or an `Output Parser`.
4. Fill in **Role / Rules / Instructions / Context / Output Format** as needed.
5. Set **User Message** (expression like `={{ $json.message }}` works).
6. Pick your **Output Format** (`text`, `json`, or `structured`). For schema output, paste your JSON schema.
7. Run.

---

## Credits

This node would not exist without prior work by:

- **[n8n](https://github.com/n8n-io/n8n)** — particularly the [`@n8n/nodes-langchain`](https://github.com/n8n-io/n8n/tree/master/packages/%40n8n/nodes-langchain) package. Agent Pro mirrors n8n's native Tools Agent architecture (sub-node wiring, fallback runnable, prompt template structure, output-parser plumbing) and could not have shipped without that reference implementation. Many specific implementation details — `MessagesPlaceholder('chat_history')`, the `{system_message}` / `{formatting_instructions}` placeholders, the reverse-ordered multi-model input array — are direct ports of patterns from there.
- **[chynten/n8n-nodes-claude-pro](https://github.com/chynten/n8n-nodes-claude-pro)** — for pioneering the use of Claude OAuth tokens inside an n8n custom node, and for demonstrating the `sk-ant-oat...` detection pattern.

If you're building agents in n8n, please support both projects.

---

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the priority list (additional provider adapters, forced-tool output parsing, token-usage reporting, tests), local-dev commands, and the project's style guide.

A short version history is in [CHANGELOG.md](CHANGELOG.md).

---

## License

[MIT](LICENSE) © SquareSigns and contributors.
