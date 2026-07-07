# Changelog

All notable changes to this project are documented here. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [3.3.19] – 2026-06-19

### Changed
- Repo hygiene: installed and ran the lint toolchain end-to-end. Prettier formatted every source file. ESLint with `eslint-plugin-n8n-nodes-base` is now clean across `src/`. Added `CHANGELOG.md` and `CONTRIBUTING.md`; trimmed the README to point at them.

### Fixed
- Removed dead variables (`canUseDirectApi`, `primaryAnthropicCache`, the outer `config`) that were assigned but never read.
- Removed unused imports across the providers and the ClaudeVision node.
- `throw new Error(...)` → `throw new NodeOperationError(...)` in the AgentPro fallback-failure branch (correct n8n error type, surfaces with the item index in the UI).
- Empty `catch {}` blocks now carry a one-line comment explaining the intent.
- Boolean field descriptions rewritten to start with "Whether…" per the n8n community lint rule.
- Credential `documentationUrl` restored to a real Anthropic doc URL (was a mangled identifier).

## [3.3.18] – 2026-06-19

### Fixed
- **Anthropic content-block arrays now flattened to text.** `runToolsAgent` previously returned `result.output` verbatim. For Anthropic, that's an array of `{ type: 'text', text: '...' }` blocks rather than a plain string. Downstream consumers — the output parser, `buildAutoFixPrompt`, JSON regex extractors — all assumed a string and crashed with `originalResponse.substring is not a function`. New `normalizeAgentOutput()` joins the blocks into a single string before returning.
- **`buildAutoFixPrompt` is defensive against non-string inputs.** Same root cause; an extra coercion layer prevents future regressions even if a new caller violates the contract.
- **Auto-unwrap of `{"output": {...}}` envelope for external parsers.** Models trained on LangChain examples often wrap structured replies inside an outer `output` key (mimicking n8n's native `format_final_json_response` forced-tool pattern). When the connected parser rejects the envelope, Agent Pro now tries unwrapping once before paying for an auto-fix LLM round-trip. Wired into both the tools and direct paths.

## [3.3.17] – 2026-06-19

### Fixed
- **Chat history reaches the model again.** Memory was being flattened to `{ role, content }` plain objects, but the tools agent's `MessagesPlaceholder('chat_history')` only accepts real LangChain `BaseMessage` instances. The flattened list was silently dropped. Two history representations are now kept — `BaseMessage[]` for the tools path, plain objects for the direct API path.
- **PDFs are sent to Anthropic via the tools path.** Previously replaced with a `[Attached PDF: …]` text marker; the model never saw the bytes. Anthropic-detected models now receive native `document` content blocks. Non-Anthropic providers retain the text marker (their adapters reject unknown block types).
- **Tools path honors temperature and max-tokens overrides.** The overrides were only applied in the direct API path. The tools path now binds them onto the model via `BaseChatModel.bind({ ... })` at agent-creation time.
- **Output parser format instructions injected into the system prompt.** When an output parser sub-node is connected, `getFormatInstructions()` is appended to `systemPrompt` on the first call (not just on the auto-fix retry), so the model knows the required schema before its first attempt.
- **Auto-fix retry now runs for external parser failures in both code paths.** Previously the retry loop only fired in the built-in `json`/`structured` branch of the direct path. External-parser failures in the tools path were silently swallowed.

### Changed
- Repo cleanup: removed `claude-vision-extracted/`, `scratch/`, helper scripts, and stale tarballs. Workflow JSONs moved to `docs/examples/`. Added `.gitignore`, `.eslintrc.js`, `.prettierrc.json`, `LICENSE`, and a full `README.md`.

## [3.3.16] – 2026-06-19

### Fixed
- **`INVALID_PROMPT_INPUT` from the tools agent.** The user-provided system prompt was being inlined into the template literal, so any `{` / `}` it contained (JSON examples, n8n expressions) got parsed as missing template variables. Switched to a `{system_message}` placeholder, with the actual content supplied at `executor.invoke({ system_message })` time — the same pattern n8n's native ToolsAgent uses.

## [3.3.15] – 2026-06-19

### Fixed
- **"createAgentFn is not a function" at tools-agent invocation.** The original code resolved `createToolCallingAgent` from `@langchain/core/agents` first. That module path resolves successfully but exports nothing useful — accessing the missing property returned `undefined`, and `try/catch` does not catch missing exports, only thrown imports. Fix:
  - Reordered module candidates to match n8n's evolution: `@langchain/classic/agents` (current n8n), then `langchain/agents` (older n8n), then `@langchain/core/agents` (last resort).
  - `importFirst()` now verifies `typeof === 'function'` before returning, so an empty barrel is treated as "not found" and the loop continues.
- **`Runnable.withFallbacks()` used for the fallback model**, mirroring n8n's native pattern — fallback only fires when the primary throws, with LangChain's standard error semantics. Manual try/catch retained as a defensive fallback when the runnable doesn't expose `withFallbacks`.

## [3.3.14] and earlier

Initial advanced AI agent node for n8n with multi-provider support (Anthropic / OpenAI / Gemini), prompt caching, structured output, fallback model toggle, PDF / image attachment, few-shot examples, and Claude Code OAuth (`sk-ant-oat...`) token detection. See git history (pre-release) for full details.

[3.3.18]: https://github.com/squaresigns/n8n-nodes-agent-pro/releases/tag/v3.3.18
[3.3.17]: https://github.com/squaresigns/n8n-nodes-agent-pro/releases/tag/v3.3.17
[3.3.16]: https://github.com/squaresigns/n8n-nodes-agent-pro/releases/tag/v3.3.16
[3.3.15]: https://github.com/squaresigns/n8n-nodes-agent-pro/releases/tag/v3.3.15
