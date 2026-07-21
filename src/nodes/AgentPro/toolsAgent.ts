/* eslint-disable @typescript-eslint/no-explicit-any */

import type { BinaryDoc } from './types';
import {
	detectDocumentPayload,
	buildDocumentBlock,
	buildInjectionMessage,
	buildToolsSystemMessage,
	renderCatalog,
	createFetchState,
	guardrailReject,
	recordFetch,
	isDocumentError,
	type DocumentPayload,
} from './documentInjection';

export interface RunToolsAgentOpts {
	model: any;
	tools: any[];
	systemPrompt: string;
	userMessage: string;
	docs: BinaryDoc[];
	/** LangChain BaseMessage[] from memory.loadMemoryVariables (real Human/AI instances). */
	history: any[];
	maxIterations: number;
	fallbackModel?: any;
	temperature?: number;
	maxTokens?: number;
	topP?: number;
	/** External output-parser format instructions appended to the system message. */
	formatInstructions?: string;
	/** Detected provider tag ('anthropic' | 'gemini' | 'openai' | other). */
	providerTag?: string;
	/** Document catalog (array or JSON string) rendered into the user message. */
	documentCatalog?: any;
	/** Max documents a tool may fetch into vision per run (default 3). */
	maxDocumentFetches?: number;
	/** Anthropic prompt caching (mirrors the direct path). */
	promptCaching?: boolean;
	cacheSystem?: boolean;
	cacheSystemTtl?: '5m' | '1h';
	cacheUserMessage?: boolean;
	cacheUserMessageTtl?: '5m' | '1h';
}

/**
 * Normalize an assistant `content` (string, block array, or object) to a
 * string — downstream parsers/regex all assume a string.
 */
function normalizeAgentOutput(output: any): string {
	if (output == null) return '';
	if (typeof output === 'string') return output;
	if (Array.isArray(output)) {
		return output
			.map((block) => {
				if (typeof block === 'string') return block;
				if (block && typeof block.text === 'string') return block.text;
				return '';
			})
			.join('');
	}
	if (typeof output === 'object' && typeof output.text === 'string') return output.text;
	try {
		return JSON.stringify(output);
	} catch {
		return String(output);
	}
}

function safeStringify(v: any): string {
	if (typeof v === 'string') return v;
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

function buildOverrideKwargs(opts: RunToolsAgentOpts): Record<string, any> {
	const k: Record<string, any> = {};
	if (typeof opts.temperature === 'number' && opts.temperature >= 0) k.temperature = opts.temperature;
	if (typeof opts.maxTokens === 'number' && opts.maxTokens > 0) {
		k.maxTokens = opts.maxTokens;
		k.max_tokens = opts.maxTokens;
		k.maxOutputTokens = opts.maxTokens;
	}
	if (typeof opts.topP === 'number' && opts.topP >= 0 && opts.topP <= 1) {
		k.topP = opts.topP;
		k.top_p = opts.topP;
	}
	return k;
}

/**
 * Manual LangChain tool-calling loop. Uses model.bindTools(...).invoke(messages)
 * over a hand-managed BaseMessage[] — the same machinery createToolCallingAgent
 * wraps — so a tool that returns a document payload can have that document
 * injected as a follow-up user message (a vision content block) that the model
 * reads on the next turn. Every tool_use is answered by a tool_result.
 */
export async function runToolsAgent(
	opts: RunToolsAgentOpts,
): Promise<{ text: string; intermediateSteps?: any[] }> {
	const { HumanMessage, ToolMessage } = await import('@langchain/core/messages');

	const isAnthropic = opts.providerTag === 'anthropic';

	if (!opts.model || typeof opts.model.bindTools !== 'function') {
		throw new Error(
			'The connected Chat Model does not support tool calling (no bindTools). ' +
				'Connect a tool-capable model, or remove the connected tools.',
		);
	}

	const kwargs = buildOverrideKwargs(opts);
	const hasKwargs = Object.keys(kwargs).length > 0;
	const bindOne = (m: any): any => (hasKwargs ? m.bindTools(opts.tools, kwargs) : m.bindTools(opts.tools));

	const bound = bindOne(opts.model);
	const boundFallback =
		opts.fallbackModel && typeof opts.fallbackModel.bindTools === 'function'
			? bindOne(opts.fallbackModel)
			: undefined;

	// System message (with Anthropic cache_control when enabled).
	let systemText = opts.systemPrompt || 'You are a helpful assistant.';
	if (opts.formatInstructions && opts.formatInstructions.trim()) {
		systemText += '\n\n' + opts.formatInstructions.trim();
	}
	const cacheCfg =
		opts.promptCaching && opts.cacheSystem
			? { cacheSystem: true, cacheSystemTtl: opts.cacheSystemTtl || ('5m' as '5m' | '1h') }
			: undefined;

	// Initial user content: attached docs (BinaryDoc) + catalog + user text.
	const userParts: any[] = [];
	for (const doc of opts.docs) {
		userParts.push(buildDocumentBlock(doc, isAnthropic));
	}
	const catalogText = renderCatalog(opts.documentCatalog);
	if (catalogText) userParts.push({ type: 'text', text: catalogText });
	const lastTextPart: any = { type: 'text', text: opts.userMessage };
	if (opts.promptCaching && opts.cacheUserMessage && isAnthropic) {
		const cc: any = { type: 'ephemeral' };
		if (opts.cacheUserMessageTtl === '1h') cc.ttl = '1h';
		lastTextPart.cache_control = cc;
	}
	userParts.push(lastTextPart);

	const messages: any[] = [buildToolsSystemMessage(systemText, cacheCfg, isAnthropic)];
	if (Array.isArray(opts.history)) messages.push(...opts.history);
	// If the only user part is plain text with no cache_control, pass a string.
	const userIsPlain = userParts.length === 1 && !lastTextPart.cache_control;
	messages.push(userIsPlain ? new HumanMessage(opts.userMessage) : new HumanMessage({ content: userParts }));

	const toolsByName = new Map<string, any>();
	for (const t of opts.tools) {
		if (t && typeof t.name === 'string') toolsByName.set(t.name, t);
	}

	const intermediateSteps: any[] = [];
	const fetchState = createFetchState();
	const maxFetches =
		typeof opts.maxDocumentFetches === 'number' && opts.maxDocumentFetches > 0
			? opts.maxDocumentFetches
			: 3;

	// Per-invoke fallback: switch once, no tool re-execution. A document
	// rejection (page/size) must NOT route to the fallback — the fallback would
	// re-invoke with the same oversized document still attached and also fail,
	// wasting a call and permanently pinning the run to the fallback. Let those
	// errors propagate straight to the pendingInjection catch, which drops the
	// document and retries the healthy primary. Fallback stays for genuine
	// model/transport failures.
	let activeModel = bound;
	let switchedToFallback = false;
	const invoke = async (msgs: any[]): Promise<any> => {
		try {
			return await activeModel.invoke(msgs);
		} catch (err) {
			if (boundFallback && !switchedToFallback && !isDocumentError(err)) {
				switchedToFallback = true;
				activeModel = boundFallback;
				return await activeModel.invoke(msgs);
			}
			throw err;
		}
	};

	const step = (tc: any, observation: string) =>
		intermediateSteps.push({
			action: { tool: tc.name, toolInput: tc.args, log: '' },
			observation,
		});

	let lastAi: any = null;
	let pendingInjection = false;

	for (let iter = 0; iter < opts.maxIterations; iter++) {
		let ai: any;
		if (pendingInjection) {
			// The invoke that follows an injection is where Anthropic enforces the
			// per-document page/size limit (at the API, not at tool.invoke). On such
			// an error, drop the just-injected message, hand the model a note, and
			// re-invoke once. Non-document errors propagate (→ fallback via invoke()).
			try {
				ai = await invoke(messages);
			} catch (err) {
				if (isDocumentError(err) && messages[messages.length - 1] instanceof HumanMessage) {
					messages.pop();
					// Word this to clearly OVERRIDE the earlier "delivered as a visual
					// attachment" tool-result ack, which is still in history.
					messages.push(
						new HumanMessage(
							'The reference document mentioned in the previous tool result could NOT be loaded ' +
								"(it exceeds the model's 100-page / size limit) and is not attached. Disregard that " +
								'attachment. Proceed with the available proofs, or ask for a specific page range.',
						),
					);
					ai = await invoke(messages);
				} else {
					throw err;
				}
			}
			pendingInjection = false;
		} else {
			ai = await invoke(messages);
		}

		messages.push(ai);
		lastAi = ai;

		const toolCalls = Array.isArray(ai.tool_calls) ? ai.tool_calls : [];
		if (toolCalls.length === 0) {
			return { text: normalizeAgentOutput(ai.content), intermediateSteps };
		}

		const injections: DocumentPayload[] = [];
		for (const tc of toolCalls) {
			const tool = toolsByName.get(tc.name);
			if (!tool) {
				messages.push(
					new ToolMessage({ content: `Error: unknown tool "${tc.name}".`, tool_call_id: tc.id, status: 'error' }),
				);
				step(tc, `Error: unknown tool "${tc.name}"`);
				continue;
			}
			let raw: any;
			try {
				raw = await tool.invoke(tc.args);
			} catch (e) {
				const m = e instanceof Error ? e.message : String(e);
				messages.push(
					new ToolMessage({ content: `Error running tool "${tc.name}": ${m}`, tool_call_id: tc.id, status: 'error' }),
				);
				step(tc, `Error: ${m}`);
				continue;
			}

			const doc = detectDocumentPayload(raw);
			if (!doc) {
				const obs = safeStringify(raw);
				messages.push(new ToolMessage({ content: obs, tool_call_id: tc.id }));
				step(tc, obs);
				continue;
			}

			const reject = guardrailReject(doc, fetchState, maxFetches);
			if (reject) {
				messages.push(new ToolMessage({ content: reject, tool_call_id: tc.id, status: 'error' }));
				step(tc, reject);
				continue;
			}

			recordFetch(doc, fetchState);
			messages.push(
				new ToolMessage({
					content: 'Document delivered as a visual attachment in the following message.',
					tool_call_id: tc.id,
					status: 'success',
				}),
			);
			step(tc, `[document delivered: ${doc.fileName}]`);
			injections.push(doc);
		}

		if (injections.length > 0) {
			messages.push(buildInjectionMessage(injections, isAnthropic));
			pendingInjection = true;
		}
	}

	const finalText = normalizeAgentOutput(lastAi?.content);
	return {
		text:
			finalText && finalText.trim()
				? finalText
				: `[Agent stopped after ${opts.maxIterations} iteration(s) without producing a final answer.]`,
		intermediateSteps,
	};
}
