# Contributing to n8n-nodes-agent-pro

Thanks for your interest. The bar for incoming contributions is "leaves the node measurably better for someone running real workflows," not "perfect" — small, well-scoped PRs are easier to review and ship than large ones.

## What's most useful right now

Roughly in priority order:

1. **Additional provider adapters.** Today the direct API path covers Anthropic, OpenAI-compatible, and Gemini. The most-requested additions are AWS Bedrock, Google Vertex, and Azure OpenAI. Each adapter lives in `src/nodes/AgentPro/providers/` and implements the `ProviderResponse` contract in `src/nodes/AgentPro/types.ts`.
2. **`format_final_json_response` forced-tool path** for structured output. This is what n8n's native ToolsAgent V3 does and it's more robust than the current `getFormatInstructions()` + auto-fix pattern. See [n8n's `runAgent.ts`](https://github.com/n8n-io/n8n/blob/master/packages/%40n8n/nodes-langchain/nodes/agents/Agent/agents/ToolsAgent/V3/helpers/runAgent.ts) for the reference implementation.
3. **Token usage and stop-reason reporting on the tools path.** Currently only the direct path returns `response.usage` and `response.stopReason`. On the tools path this means reading `usage_metadata` / `response_metadata` off each `AIMessage` returned by the manual tool-calling loop in `toolsAgent.ts` and aggregating it.
4. **More tests.** A [vitest](https://vitest.dev/) suite now covers `documentInjection.ts` and the tool-calling loop — run it with `npm test`. Good next targets: unit tests for the pure functions in `promptBuilder.ts`, `outputParser.ts`, and `modelExtractor.ts`.

## Local development

```bash
git clone https://github.com/your-fork/n8n-nodes-agent-pro
cd n8n-nodes-agent-pro
npm install

# Hot-rebuild during development:
npm run dev

# Type check without emitting:
npm run typecheck

# Pack a tarball for testing in a real n8n install:
npm run package
# -> n8n-nodes-agent-pro-X.Y.Z.tgz
```

To test inside an n8n install, point n8n at the tarball:

```bash
# in the n8n custom-nodes folder (e.g. ~/.n8n/nodes on host, /home/node/.n8n/nodes inside Docker)
npm install /path/to/n8n-nodes-agent-pro-X.Y.Z.tgz
# then restart the n8n process — a process restart is required, not just a workflow re-run.
```

## Lint & format

```bash
npm run lint           # tsc --noEmit, fastest signal
npm run lint:eslint    # full ruleset (n8n community + @typescript-eslint)
npm run lint:fix       # eslint --fix
npm run format         # prettier --write
npm run format:check   # prettier --check (CI-friendly)
```

The ESLint config extends `eslint-plugin-n8n-nodes-base`, which is the same plugin n8n uses internally for its own nodes. Most rules around `displayName`, casing, descriptions, and required fields will be flagged automatically.

## Style guide

A few project-specific conventions worth knowing:

- **No comments on the *what*, comments on the *why*.** Self-explanatory code is preferred. Comments are reserved for genuinely non-obvious decisions — places where a future reader would otherwise revert the code. Several of those exist around LangChain import paths, prompt-template escaping, and content-block normalization; leave them in place.
- **Don't introduce new abstractions without a concrete second caller.** Helper functions, layered classes, and shared types should be added when there is real duplication, not preemptively.
- **Keep the two execution paths distinct.** `AgentPro.node.ts` has a "tools agent" path and a "direct API" path. They look similar but have meaningfully different constraints (LangChain agent loop vs. direct provider calls). Resist the urge to merge them — the duplication is mostly load-bearing.
- **Don't catch errors silently.** If a `try/catch` legitimately needs to swallow, leave a one-line comment explaining what the failure mode is and why the caller can safely proceed without the result.
- **Test against a real Anthropic key, including one OAuth (`sk-ant-oat...`) token if you can.** The OAuth path has subtle differences (different base URL, header shape, streaming behavior) that mock tests will miss.

## Release process

1. Pick the next [SemVer](https://semver.org/) bump:
   - Patch: bug fix, no behavior change for green-path users.
   - Minor: new feature, no breaking change.
   - Major: breaking change to inputs/outputs/credentials.
2. Update `package.json` `version`.
3. Add an entry to `CHANGELOG.md` under a new heading. Each bullet should be understandable to someone who has not read the code.
4. `npm run package` to produce the `.tgz` and confirm the dist builds cleanly.
5. Tag and publish — `npm publish` for the npm registry, plus a GitHub release with the tarball attached.

## Reporting issues

Useful bug reports include:

- The version of Agent Pro (`cat node_modules/n8n-nodes-agent-pro/package.json | grep version`).
- The version of n8n you're running, and whether it's cloud or self-hosted.
- Which Chat Model sub-node, and whether you're passing a Claude OAuth token or a standard API key.
- A minimal reproduction — either an exported workflow JSON in `docs/examples/` style, or a short description of which sub-nodes were connected.
- The full error including the stack trace (n8n's "Error details" panel has a copy button).

A working reproduction will get a fix faster than a written description, every time.

## License

By contributing, you agree that your contributions will be licensed under the [MIT license](LICENSE).
