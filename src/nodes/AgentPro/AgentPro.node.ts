/* eslint-disable @typescript-eslint/no-explicit-any */

import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import type {
	ModelConfig,
	ProviderRequest,
	ProviderResponse,
	ChatMessage,
	OutputSchema,
	BinaryDoc,
	ParseResult,
} from './types';

import { extractModelConfig } from './modelExtractor';
import { buildSystemPrompt, buildMessages, buildAutoFixPrompt } from './promptBuilder';
import type { PromptSections, FewShotExample } from './promptBuilder';
import { parseOutput } from './outputParser';
import { collectBinaryDocs } from './binaryHandler';
import { callAnthropic } from './providers/anthropic';
import { callOpenAICompat } from './providers/openaiCompat';
import { callGemini } from './providers/gemini';
import { invokeLangchainModel } from './providers/langchainDirect';
import { runToolsAgent } from './toolsAgent';

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function callProvider(config: ModelConfig, req: ProviderRequest): Promise<ProviderResponse> {
	if (config.provider === 'anthropic') return callAnthropic(req);
	if (config.provider === 'gemini') return callGemini(req);
	return callOpenAICompat(req);
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			return await fn();
		} catch (e) {
			lastErr = e;
			const msg = e instanceof Error ? e.message : '';
			const retryable =
				msg.includes('HTTP 5') ||
				msg.includes('HTTP 429') ||
				msg.includes('timed out') ||
				msg.includes('timeout') ||
				msg.includes('ECONNRESET') ||
				msg.includes('ETIMEDOUT');
			if (attempt < maxRetries && retryable) {
				await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
				continue;
			}
			throw e;
		}
	}
	throw lastErr;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Node definition
// ═══════════════════════════════════════════════════════════════════════════════

export class AgentPro implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Agent Pro',
		name: 'agentPro',
		icon: 'file:agent-pro.svg',
		group: ['transform'],
		version: [3],
		subtitle: 'Agent Pro',
		description:
			'Advanced AI Agent with sub-node models, tools, memory, structured output, fallback, and native PDF/image support.',
		defaults: { name: 'Agent Pro' },
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Agents'],
			},
			resources: {
				primaryDocumentation: [{ url: 'https://github.com/anthropics/n8n-nodes-agent-pro' }],
			},
		},

		// ─── Dynamic inputs expression ─────────────────────────────────────
		// Evaluated by n8n frontend to compute which AI connection sockets appear.
		inputs: `={{
((enableFallback) => {
	const inputs = [
		{ type: 'main' },
		{ type: '${NodeConnectionTypes.AiLanguageModel}', displayName: 'Chat Model', required: true, maxConnections: 1 },
		{ type: '${NodeConnectionTypes.AiMemory}', displayName: 'Memory', required: false, maxConnections: 1 },
		{ type: '${NodeConnectionTypes.AiTool}', displayName: 'Tools', required: false },
		{ type: '${NodeConnectionTypes.AiOutputParser}', displayName: 'Output Parser', required: false, maxConnections: 1 },
	];
	if (enableFallback) {
		inputs.push({ type: '${NodeConnectionTypes.AiLanguageModel}', displayName: 'Fallback Model', required: false, maxConnections: 1 });
	}
	return inputs;
})($parameter.enableFallback === true)
}}` as any,

		outputs: ['main'],

		properties: [
			// ═══════════════════════════════════════════════════════════════
			// FALLBACK TOGGLE
			// ═══════════════════════════════════════════════════════════════
			{
				displayName: 'Enable Fallback Model',
				name: 'enableFallback',
				type: 'boolean',
				default: false,
				description: 'Whether to allow connecting a second Chat Model as fallback. If the primary model fails, the fallback model is used.',
			},

			// ═══════════════════════════════════════════════════════════════
			// PROMPT SECTIONS
			// ═══════════════════════════════════════════════════════════════
			{
				displayName: 'Role / Persona',
				name: 'promptRole',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				description: 'Who the AI should be. Sets its identity and behavior.',
			},
			{
				displayName: 'Rules',
				name: 'promptRules',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				description: 'Hard constraints and guardrails the AI must follow',
			},
			{
				displayName: 'Instructions / Skills',
				name: 'promptSkills',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				description: 'Step-by-step instructions or capabilities',
			},
			{
				displayName: 'Context',
				name: 'promptContext',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				description: 'Background information, data, or reference material',
			},
			{
				displayName: 'Output Instructions',
				name: 'promptOutputInstructions',
				type: 'string',
				typeOptions: { rows: 3 },
				default: '',
				description: 'How the AI should format its response',
			},
			{
				displayName: 'User Message',
				name: 'userMessage',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '={{ $json.message || $json.text || $json.content || "" }}',
				description: 'The user message. Use expressions to pull from input.',
			},

			// ═══════════════════════════════════════════════════════════════
			// OUTPUT FORMAT
			// ═══════════════════════════════════════════════════════════════
			{
				displayName: 'Output Format',
				name: 'outputFormat',
				type: 'options',
				options: [
					{ name: 'Text', value: 'text' },
					{ name: 'JSON (Parse)', value: 'json' },
					{ name: 'Structured (Schema)', value: 'structured' },
				],
				default: 'text',
				description: 'How to parse the model response',
			},
			{
				displayName: 'Output Schema (JSON)',
				name: 'outputSchema',
				type: 'json',
				default: '{}',
				displayOptions: { show: { outputFormat: ['structured'] } },
				description: 'JSON Schema the output must conform to. Used for validation and auto-fix.',
			},
			{
				displayName: 'Auto-Fix JSON',
				name: 'autoFixJson',
				type: 'boolean',
				default: true,
				displayOptions: { show: { outputFormat: ['json', 'structured'] } },
				description:
					'Whether to send the error back to the model and ask it to fix the JSON when parsing fails',
			},

			// ═══════════════════════════════════════════════════════════════
			// FEW-SHOT EXAMPLES
			// ═══════════════════════════════════════════════════════════════
			{
				displayName: 'Few-Shot Examples',
				name: 'fewShotExamples',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				default: {},
				options: [
					{
						name: 'examples',
						displayName: 'Example',
						values: [
							{
								displayName: 'User Input',
								name: 'input',
								type: 'string',
								default: '',
							},
							{
								displayName: 'Expected Output',
								name: 'output',
								type: 'string',
								default: '',
							},
						],
					},
				],
			},

			// ═══════════════════════════════════════════════════════════════
			// OPTIONS (agent-level settings)
			// ═══════════════════════════════════════════════════════════════
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				// The community lint plugin wants items alphabetized; we keep them
				// grouped by topic (timeout/retries → binary → debug → model overrides
				// → caching) because that's how a user actually thinks about them.
				// eslint-disable-next-line n8n-nodes-base/node-param-collection-type-unsorted-items
				options: [
					// -- Timeout --
					{
						// eslint-disable-next-line n8n-nodes-base/node-param-display-name-miscased
						displayName: 'Timeout (ms)',
						name: 'timeout',
						type: 'number',
						typeOptions: { minValue: 1000 },
						default: 120000,
						description: 'Max wait time for API response',
					},
					// -- Max Retries --
					{
						displayName: 'Max Retries',
						name: 'maxRetries',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 10 },
						default: 2,
						description: 'Retries on 5xx, 429, network errors. Exponential backoff.',
					},
					// -- Max Tool Iterations --
					{
						displayName: 'Max Tool Iterations',
						name: 'maxToolIterations',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 50 },
						default: 10,
						description: 'Maximum agent loop iterations when tools are connected',
					},
					// -- User ID --
					{
						displayName: 'User ID (Metadata)',
						name: 'userId',
						type: 'string',
						default: '',
						description: 'External user ID for billing/abuse tracking',
					},
					// -- Binary document properties --
					{
						displayName: 'Binary Document Properties',
						name: 'binaryDocumentProperties',
						type: 'string',
						default: '',
						description:
							'Comma-separated binary property names to attach (PDFs, images). Example: "data,proof_on".',
					},
					{
						displayName: 'Pass All Binary Data',
						name: 'passAllBinaryData',
						type: 'boolean',
						default: false,
						description: 'Whether to auto-attach all binary items (PDFs + images)',
					},
					// -- Document fetch (tool → vision) --
					{
						displayName: 'Document Catalog (JSON)',
						name: 'documentCatalog',
						type: 'string',
						typeOptions: { rows: 3 },
						default: '',
						description:
							'JSON array of documents a connected fetch tool may retrieve into vision. Rendered into the user message so the model knows what it can fetch. Example: [{"id":"att_1","name":"ref.pdf","role_hint":"reprint reference"}].',
					},
					{
						displayName: 'Max Document Fetches',
						name: 'maxDocumentFetches',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 10 },
						default: 3,
						description:
							'Maximum number of documents a connected tool may fetch into vision per run (de-duplicated by file name).',
					},
					// -- Include Raw Response --
					{
						displayName: 'Include Raw Response',
						name: 'includeRaw',
						type: 'boolean',
						default: false,
						description:
							'Whether to include the full raw API response in output (for debugging)',
					},
					// ── Model setting overrides ──
					// These override the connected model sub-node's settings.
					// Leave at default (-1 / empty) to use the model's own config.
					{
						displayName: 'Temperature Override',
						name: 'temperatureOverride',
						type: 'number',
						typeOptions: { minValue: -1, maxValue: 2, numberPrecision: 1 },
						default: -1,
						description: 'Override the model temperature. -1 = use the model sub-node setting.',
					},
					{
						displayName: 'Max Output Tokens Override',
						name: 'maxTokensOverride',
						type: 'number',
						typeOptions: { minValue: -1 },
						default: -1,
						description: 'Override max output tokens. -1 = use the model sub-node setting.',
					},
					{
						displayName: 'Prompt Caching (Anthropic) — Master Switch',
						name: 'promptCaching',
						type: 'boolean',
						default: true,
						description: 'Whether Anthropic prompt caching is enabled. Master on/off switch — disable to bypass all caching.',
					},
					{
						displayName: 'Cache System Prompt',
						name: 'cacheSystem',
						type: 'boolean',
						default: true,
						description:
							'Whether to cache the system prompt (role + rules + instructions + context + output). Saves ~90% input cost on repeat calls. Requires the master switch above to be ON',
					},
					{
						displayName: 'System Prompt Cache TTL',
						name: 'cacheSystemTtl',
						type: 'options',
						options: [
							{ name: '5 Minutes (Cheaper Write, Shorter Hit Window)', value: '5m' },
							{ name: '1 Hour (Costlier Write, Much Longer Hit Window)', value: '1h' },
						],
						default: '5m',
						description:
							'How long the system prompt stays in cache. 1h costs 2x to write but lives 12x longer. Use 1h for bursty workloads where orders arrive minutes apart.',
						displayOptions: { show: { cacheSystem: [true] } },
					},
					{
						displayName: 'Cache User Message + Attachments',
						name: 'cacheUserMessage',
						type: 'boolean',
						default: false,
						description:
							'Whether to cache the final user message and its attached PDFs/images. Only useful when the same user input is submitted multiple times (e.g. retries, reprocessing). For unique per-request content (like QC orders), leave off',
					},
					{
						displayName: 'User Message Cache TTL',
						name: 'cacheUserMessageTtl',
						type: 'options',
						options: [
							{ name: '5 Minutes', value: '5m' },
							{ name: '1 Hour', value: '1h' },
						],
						default: '5m',
						description:
							'How long the user message + attachments stay in cache. Only applies when Cache User Message is ON.',
						displayOptions: { show: { cacheUserMessage: [true] } },
					},
				],
			},
		],
	};

	// ═══════════════════════════════════════════════════════════════════════
	// execute()
	// ═══════════════════════════════════════════════════════════════════════

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const results: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				// ── Gather parameters ──────────────────────────────────────
				const userMessage = this.getNodeParameter('userMessage', i, '') as string;
				const outputFormat = this.getNodeParameter('outputFormat', i, 'text') as
					| 'text'
					| 'json'
					| 'structured';
				const autoFixJson = this.getNodeParameter('autoFixJson', i, true) as boolean;
				const enableFallback = this.getNodeParameter('enableFallback', i, false) as boolean;

				let outputSchema: OutputSchema | undefined;
				if (outputFormat === 'structured') {
					try {
						const raw = this.getNodeParameter('outputSchema', i, '{}') as string;
						outputSchema = JSON.parse(raw) as OutputSchema;
					} catch {
						outputSchema = undefined;
					}
				}

				const options = this.getNodeParameter('options', i, {}) as Record<string, any>;

				// Agent Pro settings (from options UI)
				const timeout = (options.timeout ?? 120000) as number;
				const maxRetries = (options.maxRetries ?? 2) as number;
				const maxToolIterations = (options.maxToolIterations ?? 10) as number;
				const userId = (options.userId || '') as string;
				const includeRaw = (options.includeRaw ?? false) as boolean;
				const passAllBinary = (options.passAllBinaryData ?? false) as boolean;
				const binaryProps = ((options.binaryDocumentProperties || '') as string)
					.split(',')
					.map((s: string) => s.trim())
					.filter((s: string) => s.length > 0);

				// Model settings are read from the model object after it's loaded (see below)

				// ── Prompt sections ────────────────────────────────────────
				const promptRole = this.getNodeParameter('promptRole', i, '') as string;
				const promptRules = this.getNodeParameter('promptRules', i, '') as string;
				const promptSkills = this.getNodeParameter('promptSkills', i, '') as string;
				const promptContext = this.getNodeParameter('promptContext', i, '') as string;
				const promptOutputInstructions = this.getNodeParameter(
					'promptOutputInstructions',
					i,
					'',
				) as string;

				const sections: PromptSections = {
					role: promptRole,
					rules: promptRules,
					skills: promptSkills,
					context: promptContext,
					outputInstructions: promptOutputInstructions,
					outputSchema,
				};
				let systemPrompt = buildSystemPrompt(sections);

				// ── Few-shot examples ──────────────────────────────────────
				const fewShotParam = this.getNodeParameter('fewShotExamples', i, {}) as any;
				const examples: FewShotExample[] = (fewShotParam.examples || []).map((ex: any) => ({
					input: (ex.input || '') as string,
					output: (ex.output || '') as string,
				}));

				// ── Binary docs ────────────────────────────────────────────
				const docs: BinaryDoc[] = await collectBinaryDocs(
					this as any,
					i,
					passAllBinary,
					binaryProps,
				);

				// ── Get primary & (optional) fallback models ───────────────
				// When multiple AiLanguageModel inputs are defined (primary + fallback),
				// n8n returns ALL connected models as a single array from one call —
				// and that array is in REVERSED UI order (verified empirically and
				// mirrors n8n's own getChatModel() in @n8n/nodes-langchain Tools Agent V3).
				// So we reverse before indexing: index 0 = primary slot, 1 = fallback slot.
				const connectedModels = (await this.getInputConnectionData(
					NodeConnectionTypes.AiLanguageModel,
					i,
				)) as any;

				const pickModel = (modelIndex: number): any | undefined => {
					if (Array.isArray(connectedModels)) {
						if (connectedModels.length <= modelIndex) return undefined;
						const reversed = [...connectedModels].reverse();
						return reversed[modelIndex];
					}
					return modelIndex === 0 ? connectedModels : undefined;
				};

				const primaryModel = pickModel(0);

				if (!primaryModel) {
					throw new NodeOperationError(
						this.getNode(),
						'No Chat Model connected. Connect a Chat Model sub-node.',
						{ itemIndex: i },
					);
				}

				// ── Get tools (if connected) ───────────────────────────────
				let tools: any[] = [];
				try {
					const toolData = await this.getInputConnectionData(NodeConnectionTypes.AiTool, i);
					if (Array.isArray(toolData)) {
						tools = toolData;
					} else if (toolData) {
						tools = [toolData];
					}
				} catch {
					// no tools connected
				}

				// ── Get memory (if connected) ──────────────────────────────
				let memory: any = null;
				try {
					memory = await this.getInputConnectionData(NodeConnectionTypes.AiMemory, i);
				} catch {
					// no memory connected
				}

				// ── Load chat history from memory ──────────────────────────
				// We need TWO representations:
				//   - rawHistory: original LangChain BaseMessage[] for the tools-agent path
				//     (MessagesPlaceholder requires real HumanMessage/AIMessage instances —
				//     plain {role, content} objects are silently dropped).
				//   - history: flattened {role, content} for the direct-API providers which
				//     speak that shape natively (Anthropic/OpenAI/Gemini JSON requests).
				const history: ChatMessage[] = [];
				let rawHistory: any[] = [];
				if (memory && typeof memory.loadMemoryVariables === 'function') {
					try {
						const memVars = await memory.loadMemoryVariables({});
						const chatHistory = memVars.chat_history || memVars.history || [];
						if (Array.isArray(chatHistory)) {
							rawHistory = chatHistory;
							for (const msg of chatHistory) {
								if (msg.content !== undefined) {
									const role =
										msg._getType?.() === 'human' ||
										msg.role === 'user' ||
										msg._getType?.() === 'user'
											? 'user'
											: 'assistant';
									history.push({
										role,
										content:
											typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
									});
								}
							}
						}
					} catch {
						// memory load failed, proceed without history
					}
				}

				// ── Get output parser sub-node (if connected) ──────────────
				let externalParser: any = null;
				try {
					externalParser = await this.getInputConnectionData(NodeConnectionTypes.AiOutputParser, i);
				} catch {
					// no output parser connected
				}

				// If a parser is connected, append its format instructions to the
				// system prompt so the model on the FIRST call already knows the
				// required schema (rather than only learning about it on a retry).
				// The native n8n agent does this too — without it the model is
				// flying blind and almost always emits prose that fails to parse.
				if (externalParser && typeof externalParser.getFormatInstructions === 'function') {
					try {
						const instr = externalParser.getFormatInstructions();
						if (typeof instr === 'string' && instr.trim()) {
							systemPrompt = systemPrompt ? systemPrompt + '\n\n' + instr.trim() : instr.trim();
						}
					} catch {
						/* parser doesn't implement getFormatInstructions */
					}
				}

				// ── Get fallback model (if enabled) ────────────────────────
				// Same reversed-array pattern as primary — pick index 1 after reversal.
				let fallbackModel: any = null;
				if (enableFallback) {
					fallbackModel = pickModel(1) ?? null;
					if (!fallbackModel) {
						throw new NodeOperationError(
							this.getNode(),
							'Fallback Model is enabled but no fallback Chat Model is connected. Connect one, or disable the Fallback Model option.',
							{ itemIndex: i },
						);
					}
				}

				// ────────────────────────────────────────────────────────────
				// EXECUTION PATH: TOOLS CONNECTED
				// ────────────────────────────────────────────────────────────
				// Some LangChain-trained models wrap structured replies in
				// `{"output": {...}}` (mimicking n8n's native forced-tool pattern). When
				// the connected external parser rejects this envelope, retry once with
				// the unwrapped inner object — same normalization n8n's finalizeResult
				// does. Returns undefined if it can't safely unwrap.
				const tryUnwrapOutputEnvelope = (raw: string): string | undefined => {
					if (typeof raw !== 'string') return undefined;
					let text = raw.trim();
					if (text.startsWith('```json')) text = text.slice(7);
					else if (text.startsWith('```')) text = text.slice(3);
					if (text.endsWith('```')) text = text.slice(0, -3);
					text = text.trim();
					try {
						const obj = JSON.parse(text);
						if (
							obj &&
							typeof obj === 'object' &&
							!Array.isArray(obj) &&
							Object.keys(obj).length === 1 &&
							obj.output &&
							typeof obj.output === 'object'
						) {
							return JSON.stringify(obj.output);
						}
					} catch {
						/* not JSON, can't unwrap */
					}
					return undefined;
				};

				if (tools.length > 0) {
					// Detect provider tag so the tools agent knows whether it can send
					// PDFs as Anthropic document blocks vs. having to drop them.
					let providerTagForTools: string | undefined;
					try {
						const cfg = extractModelConfig(primaryModel);
						providerTagForTools = cfg.provider !== 'langchain_direct' ? cfg.provider : undefined;
					} catch {
						/* leave undefined */
					}

					const tempOverrideForTools = (options.temperatureOverride ?? -1) as number;
					const maxTokOverrideForTools = (options.maxTokensOverride ?? -1) as number;

					const documentCatalogForTools = (options.documentCatalog || '') as string;
					const maxDocumentFetchesForTools = (options.maxDocumentFetches ?? 3) as number;
					// Caching config (the tools path previously applied none). Declared
					// inside this if-block so it does not collide with the direct path's
					// own declarations later in execute().
					const promptCachingForTools = (options.promptCaching ?? true) as boolean;
					const cacheSystemForTools = (options.cacheSystem ?? true) as boolean;
					const cacheSystemTtlForTools = (options.cacheSystemTtl ?? '5m') as '5m' | '1h';
					const cacheUserMessageForTools = (options.cacheUserMessage ?? false) as boolean;
					const cacheUserMessageTtlForTools = (options.cacheUserMessageTtl ?? '5m') as '5m' | '1h';

					// systemPrompt already includes parser format instructions (appended
					// above where externalParser is loaded), so we don't pass them again
					// via the formatInstructions opt — that would duplicate them.
					const agentResult = await runToolsAgent({
						model: primaryModel,
						tools,
						systemPrompt,
						userMessage,
						docs,
						// Pass the original BaseMessage[] from memory, NOT the flattened
						// {role, content} list — MessagesPlaceholder requires real
						// HumanMessage/AIMessage instances.
						history: rawHistory,
						maxIterations: maxToolIterations,
						fallbackModel: fallbackModel || undefined,
						temperature: tempOverrideForTools >= 0 ? tempOverrideForTools : undefined,
						maxTokens: maxTokOverrideForTools > 0 ? maxTokOverrideForTools : undefined,
						providerTag: providerTagForTools,
						documentCatalog: documentCatalogForTools,
						maxDocumentFetches: maxDocumentFetchesForTools,
						promptCaching: promptCachingForTools,
						cacheSystem: cacheSystemForTools,
						cacheSystemTtl: cacheSystemTtlForTools,
						cacheUserMessage: cacheUserMessageForTools,
						cacheUserMessageTtl: cacheUserMessageTtlForTools,
					});

					let finalText = agentResult.text;

					// Parse output. When an external parser fails, run the same auto-fix
					// retry the built-in json/structured branch uses — re-ask the model
					// with the parser's own format instructions plus the error so it can
					// correct the output. Mirrors what users expect from n8n's native
					// agent (which uses OutputFixingParser for this).
					let parsedOutput: any;
					if (externalParser && typeof externalParser.parse === 'function') {
						try {
							parsedOutput = await externalParser.parse(finalText);
						} catch (parseErr) {
							// Try unwrapping a `{"output": {...}}` envelope before auto-fix —
							// cheaper than a full LLM round-trip when the model just wrapped
							// the schema in an outer key.
							const unwrapped = tryUnwrapOutputEnvelope(finalText);
							if (unwrapped) {
								try {
									parsedOutput = await externalParser.parse(unwrapped);
									finalText = unwrapped;
								} catch {
									/* fall through to auto-fix */
								}
							}
							if (parsedOutput === undefined && autoFixJson) {
								const fixPrompt = buildAutoFixPrompt(
									finalText,
									parseErr instanceof Error ? parseErr.message : String(parseErr),
									outputSchema,
								);
								try {
									const fixResult = await runToolsAgent({
										model: primaryModel,
										tools: [], // no tools on the fix call — pure text rewrite
										systemPrompt, // already has parser format instructions appended
										userMessage: fixPrompt,
										docs: [], // attachments already consumed
										history: rawHistory,
										maxIterations: 1,
										fallbackModel: fallbackModel || undefined,
										temperature: tempOverrideForTools >= 0 ? tempOverrideForTools : undefined,
										maxTokens: maxTokOverrideForTools > 0 ? maxTokOverrideForTools : undefined,
										providerTag: providerTagForTools,
										promptCaching: promptCachingForTools,
										cacheSystem: cacheSystemForTools,
										cacheSystemTtl: cacheSystemTtlForTools,
									});
									try {
										parsedOutput = await externalParser.parse(fixResult.text);
										finalText = fixResult.text;
									} catch {
										parsedOutput = undefined;
									}
								} catch {
									parsedOutput = undefined;
								}
							}
							// If neither unwrap nor auto-fix recovered, parsedOutput stays undefined.
						}
					} else if (outputFormat !== 'text') {
						let parseResult = parseOutput(finalText, outputFormat, outputSchema);
						// Built-in auto-fix for json/structured outputs on the tools path
						// (previously only the direct path had this).
						if (!parseResult.success && autoFixJson) {
							const fixPrompt = buildAutoFixPrompt(
								finalText,
								parseResult.error || 'Unknown parse error',
								outputSchema,
							);
							try {
								const fixResult = await runToolsAgent({
									model: primaryModel,
									tools: [],
									systemPrompt,
									userMessage: fixPrompt,
									docs: [],
									history: rawHistory,
									maxIterations: 1,
									fallbackModel: fallbackModel || undefined,
									temperature: tempOverrideForTools >= 0 ? tempOverrideForTools : undefined,
									maxTokens: maxTokOverrideForTools > 0 ? maxTokOverrideForTools : undefined,
									providerTag: providerTagForTools,
									promptCaching: promptCachingForTools,
									cacheSystem: cacheSystemForTools,
									cacheSystemTtl: cacheSystemTtlForTools,
								});
								parseResult = parseOutput(fixResult.text, outputFormat, outputSchema);
								if (parseResult.success) finalText = fixResult.text;
							} catch {
								// auto-fix call failed, keep original parseResult
							}
						}
						if (parseResult.success) {
							parsedOutput = parseResult.data ?? parseResult.text;
						}
					}

					// Save to memory
					if (memory && typeof memory.saveContext === 'function') {
						try {
							await memory.saveContext({ input: userMessage }, { output: finalText });
						} catch {
							// memory save failed silently
						}
					}

					const output: Record<string, any> = {
						text: finalText,
						provider: 'tools-agent',
						mode: 'tools',
					};
					if (enableFallback) {
						const describe = (m: any): Record<string, any> => ({
							model: m?.model || m?.modelName || m?.modelId || null,
							ctor: m?.constructor?.name || null,
							llmType: (() => {
								try {
									return typeof m?._llmType === 'function' ? m._llmType() : null;
								} catch {
									return null;
								}
							})(),
							lcNamespace: Array.isArray(m?.lc_namespace) ? m.lc_namespace.join('.') : null,
						});
						output.fallbackDebug = {
							primary: describe(primaryModel),
							fallback: fallbackModel ? describe(fallbackModel) : null,
							// Tools path delegates to LangChain's withFallbacks() — we can't
							// reliably know from here whether primary or fallback answered.
							// Check intermediateSteps or provider fields for the truth.
							invoked: null,
						};
					}
					if (parsedOutput !== undefined) output.parsed = parsedOutput;
					if (agentResult.intermediateSteps)
						output.intermediateSteps = agentResult.intermediateSteps;

					results.push({
						json: { ...items[i].json, agentPro: output },
					});
					continue;
				}

				// ────────────────────────────────────────────────────────────
				// EXECUTION PATH: DIRECT API (no tools)
				// ────────────────────────────────────────────────────────────
				// Strategy (modeled after n8n's native AI Agent):
				// 1. Try to identify model & extract API key via extractModelConfig
				// 2. If we get a known provider with a valid API key → use direct API
				//    (this enables prompt caching, PDF injection, etc.)
				// 3. If we can't extract credentials (native n8n models hide them
				//    behind logWrapper proxy) → invoke model directly via LangChain
				//    .invoke(), exactly as n8n's native agent does.

				const messages = buildMessages(examples, history, userMessage);
				const m = primaryModel as any;
				const tempOverride = (options.temperatureOverride ?? -1) as number;
				const maxTokOverride = (options.maxTokensOverride ?? -1) as number;
				const temperature = tempOverride >= 0 ? tempOverride : (m.temperature ?? 0.7);
				const topP = m.topP ?? m.top_p ?? 1;
				const topK = m.topK ?? m.top_k ?? -1;
				const maxTokens =
					maxTokOverride > 0
						? maxTokOverride
						: (m.maxTokens ?? m.maxOutputTokens ?? m.max_tokens ?? -1);
				const extendedThinking = m.extendedThinking ?? false;
				const thinkingBudget = m.thinkingBudget ?? 10000;
				const promptCaching = (options.promptCaching ?? true) as boolean;
				const cacheSystem = (options.cacheSystem ?? true) as boolean;
				const cacheSystemTtl = (options.cacheSystemTtl ?? '5m') as '5m' | '1h';
				const cacheUserMessage = (options.cacheUserMessage ?? false) as boolean;
				const cacheUserMessageTtl = (options.cacheUserMessageTtl ?? '5m') as '5m' | '1h';
				const frequencyPenalty = m.frequencyPenalty ?? m.frequency_penalty ?? 0;
				const presencePenalty = m.presencePenalty ?? m.presence_penalty ?? 0;
				const geminiThinkingBudget = m.thinkingConfig?.thinkingBudget ?? 0;
				const stopSequences: string[] = m.stopSequences ?? m.stop ?? [];
				const responseFormat = 'text';

				// Anthropic cache config for the LangChain fallthrough path.
				// Only meaningful when the underlying adapter is Anthropic — @langchain/anthropic
				// forwards cache_control on content blocks to the API. Other adapters ignore it
				// (or could error), so we gate it strictly on provider detection.
				const buildAnthropicCache = (modelConfig: { provider: string } | null | undefined) => {
					if (!promptCaching) return undefined;
					if (!modelConfig || modelConfig.provider !== 'anthropic') return undefined;
					return {
						enabled: true,
						cacheSystem,
						cacheSystemTtl,
						cacheUserMessage,
						cacheUserMessageTtl,
					};
				};

				// Predict the provider tag that invokeLangchainModel/callProvider will
				// stamp onto the response. Used for the unified fallbackDebug output so
				// primary/fallback/invoked all report the same granularity.
				const getExpectedProvider = (m: any): string | null => {
					if (!m) return null;
					try {
						const cfg = extractModelConfig(m);
						const wouldUseDirectApi = cfg.provider !== 'langchain_direct' && !!cfg.apiKey;
						if (!wouldUseDirectApi) return 'langchain-native';
						if (cfg.provider === 'anthropic') return cfg.isOAuth ? 'claudeCode' : 'anthropic';
						return cfg.provider;
					} catch {
						return null;
					}
				};

				// Build a ProviderRequest for any (model, config) pair using the shared
				// execution parameters. Avoids duplication between primary and fallback paths.
				const buildProviderRequest = (cfg: ModelConfig, msgs: ChatMessage[]): ProviderRequest => ({
					config: cfg,
					systemPrompt,
					messages: msgs,
					docs,
					temperature,
					topP,
					topK,
					maxTokens,
					stopSequences,
					timeout,
					extendedThinking,
					thinkingBudget,
					promptCaching,
					cacheSystem,
					cacheSystemTtl,
					cacheUserMessage,
					cacheUserMessageTtl,
					frequencyPenalty,
					presencePenalty,
					responseFormat,
					geminiThinkingBudget,
					userId,
				});

				// Single entry point for running ANY model (primary or fallback). Chooses
				// the direct-API vs LangChain path independently for each call, so a
				// primary that runs via LangChain doesn't force the fallback to do the same.
				const runModel = async (
					m: any,
					msgs: ChatMessage[],
					retries: number,
				): Promise<ProviderResponse> => {
					const cfg = extractModelConfig(m);
					const useDirect = cfg.provider !== 'langchain_direct' && !!cfg.apiKey;
					if (useDirect) {
						const req = buildProviderRequest(cfg, msgs);
						return await withRetry(() => callProvider(cfg, req), retries);
					}
					return await invokeLangchainModel({
						model: m,
						systemPrompt,
						messages: msgs,
						docs,
						timeout,
						anthropicCache: buildAnthropicCache(cfg),
					});
				};

				let response: ProviderResponse;
				let usedFallback = false;
				let primaryError: unknown = null;

				try {
					response = await runModel(primaryModel, messages, maxRetries);
				} catch (err) {
					primaryError = err;
					if (!fallbackModel) throw err;
					usedFallback = true;
					try {
						response = await runModel(fallbackModel, messages, maxRetries);
					} catch (fallbackError) {
						const pMsg = err instanceof Error ? err.message : String(err);
						const fMsg =
							fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
						throw new NodeOperationError(
							this.getNode(),
							`Primary model failed: ${pMsg}\nFallback model also failed: ${fMsg}`,
							{ itemIndex: i },
						);
					}
				}

				let finalText = response.text;

				// ── Output parsing ─────────────────────────────────────────
				let parsedOutput: any;
				if (externalParser && typeof externalParser.parse === 'function') {
					// systemPrompt already has parser format instructions appended (see
					// above where externalParser is loaded), so the model on this first
					// call already knew the schema. If it still fails: (1) try unwrapping
					// a `{"output": {...}}` envelope, (2) then auto-fix retry.
					try {
						parsedOutput = await externalParser.parse(finalText);
					} catch (parseErr) {
						const unwrapped = tryUnwrapOutputEnvelope(finalText);
						if (unwrapped) {
							try {
								parsedOutput = await externalParser.parse(unwrapped);
								finalText = unwrapped;
							} catch {
								/* fall through to auto-fix */
							}
						}
						if (parsedOutput === undefined && autoFixJson) {
							const fixPrompt = buildAutoFixPrompt(
								finalText,
								parseErr instanceof Error ? parseErr.message : String(parseErr),
								outputSchema,
							);
							const fixMessages: ChatMessage[] = [
								...messages,
								{ role: 'assistant', content: finalText },
								{ role: 'user', content: fixPrompt },
							];
							try {
								const modelForFix = usedFallback ? fallbackModel : primaryModel;
								const fixResponse = await runModel(modelForFix, fixMessages, 1);
								try {
									parsedOutput = await externalParser.parse(fixResponse.text);
									finalText = fixResponse.text;
								} catch {
									parsedOutput = undefined;
								}
							} catch {
								parsedOutput = undefined;
							}
						}
						// If neither unwrap nor auto-fix recovered, parsedOutput stays undefined.
					}
				} else if (outputFormat !== 'text') {
					let parseResult: ParseResult = parseOutput(finalText, outputFormat, outputSchema);

					// Auto-fix: ask whichever model produced the bad JSON to fix it.
					// We deliberately re-use the model that actually answered (primary or
					// fallback) so the retry is consistent with the successful call's style.
					if (!parseResult.success && autoFixJson) {
						const fixPrompt = buildAutoFixPrompt(
							finalText,
							parseResult.error || 'Unknown parse error',
							outputSchema,
						);
						const fixMessages: ChatMessage[] = [
							...messages,
							{ role: 'assistant', content: finalText },
							{ role: 'user', content: fixPrompt },
						];
						try {
							const modelForFix = usedFallback ? fallbackModel : primaryModel;
							const fixResponse = await runModel(modelForFix, fixMessages, 1);
							parseResult = parseOutput(fixResponse.text, outputFormat, outputSchema);
							if (parseResult.success) {
								finalText = fixResponse.text;
							}
						} catch {
							// auto-fix call failed, keep original parseResult
						}
					}

					if (parseResult.success) {
						parsedOutput = parseResult.data ?? parseResult.text;
					}
				}

				// ── Save to memory ─────────────────────────────────────────
				if (memory && typeof memory.saveContext === 'function') {
					try {
						await memory.saveContext({ input: userMessage }, { output: finalText });
					} catch {
						// memory save failed silently
					}
				}

				// ── Build output ───────────────────────────────────────────
				const output: Record<string, any> = {
					text: finalText,
					model: response.model,
					provider: response.provider,
					stopReason: response.stopReason,
					usage: response.usage,
					mode: 'direct',
					usedFallback,
				};
				if (usedFallback && primaryError instanceof Error) {
					output.primaryError = primaryError.message;
				}
				if (enableFallback) {
					const describe = (m: any): Record<string, any> => ({
						model: m?.model || m?.modelName || m?.modelId || null,
						ctor: m?.constructor?.name || null,
						llmType: (() => {
							try {
								return typeof m?._llmType === 'function' ? m._llmType() : null;
							} catch {
								return null;
							}
						})(),
						lcNamespace: Array.isArray(m?.lc_namespace) ? m.lc_namespace.join('.') : null,
						provider: getExpectedProvider(m),
					});
					const invokedModel = usedFallback ? fallbackModel : primaryModel;
					output.fallbackDebug = {
						primary: describe(primaryModel),
						fallback: fallbackModel ? describe(fallbackModel) : null,
						invoked: {
							...describe(invokedModel),
							// Override predicted provider with the ACTUAL provider tag
							// returned by the live call (should match describe().provider
							// — if they diverge it's a detection bug worth investigating).
							provider: response.provider,
							slot: usedFallback ? 'fallback' : 'primary',
						},
					};
				}
				if (response.thinking) output.thinking = response.thinking;
				if (parsedOutput !== undefined) output.parsed = parsedOutput;
				if (includeRaw) output.raw = response.raw;

				results.push({
					json: { ...items[i].json, agentPro: output },
				});
			} catch (error) {
				if (this.continueOnFail()) {
					results.push({
						json: {
							...items[i].json,
							agentPro: {
								error: true,
								message: error instanceof Error ? error.message : String(error),
							},
						},
					});
				} else {
					throw new NodeOperationError(
						this.getNode(),
						error instanceof Error ? error.message : String(error),
						{ itemIndex: i },
					);
				}
			}
		}

		return [results];
	}
}
