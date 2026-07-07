/* eslint-disable @typescript-eslint/no-explicit-any */

import type { BinaryDoc } from './types';

export interface RunToolsAgentOpts {
	model: any;
	tools: any[];
	systemPrompt: string;
	userMessage: string;
	docs: BinaryDoc[];
	/**
	 * LangChain BaseMessage[] from memory.loadMemoryVariables. MUST be real
	 * HumanMessage/AIMessage instances — MessagesPlaceholder('chat_history')
	 * does NOT accept plain {role, content} objects (silently produces no
	 * history in the prompt).
	 */
	history: any[];
	maxIterations: number;
	fallbackModel?: any;
	/**
	 * If supplied (>=0), bound onto the model at agent-creation time so the
	 * tools path honors the same overrides the direct path applies.
	 */
	temperature?: number;
	maxTokens?: number;
	topP?: number;
	/**
	 * When an external output parser is connected, its format instructions
	 * are appended to the system message so the model actually knows the
	 * required schema. Matches the classic LangChain pattern.
	 */
	formatInstructions?: string;
	/**
	 * Detected provider tag ('anthropic' | 'gemini' | 'openai' | other).
	 * Used to decide whether PDFs can be sent as binary blocks vs. dropped.
	 */
	providerTag?: string;
}

/**
 * AgentExecutor.invoke() can return `output` as a plain string (OpenAI),
 * an array of content blocks (Anthropic: `[{type:'text', text:'...'}, ...]`),
 * or `null`/`undefined` when the agent halts without an answer. Downstream
 * code (output parsers, buildAutoFixPrompt, regex extractors) all assume a
 * string and crash on anything else — most visibly with
 * "originalResponse.substring is not a function". Normalize once here.
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
	if (typeof output === 'object' && typeof (output as any).text === 'string') {
		return (output as any).text;
	}
	try {
		return JSON.stringify(output);
	} catch {
		return String(output);
	}
}

export async function runToolsAgent(
	opts: RunToolsAgentOpts,
): Promise<{ text: string; intermediateSteps?: any[] }> {
	const { ChatPromptTemplate, MessagesPlaceholder } = await import('@langchain/core/prompts');

	// Build multimodal user content. Images use OpenAI-compatible image_url
	// blocks (every LangChain adapter understands these). PDFs are only
	// emitted for Anthropic models as native document blocks — other adapters
	// would error on the unrecognized type. For non-Anthropic + PDF we still
	// emit a text marker so the model at least knows a PDF was attached.
	const userContent: any[] = [];
	const isAnthropic = opts.providerTag === 'anthropic';
	for (const doc of opts.docs) {
		if (doc.mediaType.startsWith('image/')) {
			userContent.push({
				type: 'image_url',
				image_url: { url: `data:${doc.mediaType};base64,${doc.data}` },
			});
		} else if (doc.mediaType === 'application/pdf') {
			if (isAnthropic) {
				userContent.push({
					type: 'document',
					source: { type: 'base64', media_type: 'application/pdf', data: doc.data },
				});
			} else {
				userContent.push({
					type: 'text',
					text: `[Attached PDF: ${doc.fileName} — provider ${opts.providerTag || 'unknown'} does not support inline PDFs via the tools path]`,
				});
			}
		}
	}
	userContent.push({ type: 'text', text: opts.userMessage });

	// IMPORTANT: do NOT inline opts.systemPrompt as the template string. Any literal
	// `{` / `}` in the user-provided system prompt (JSON examples, code snippets, n8n
	// expressions) would be parsed as a missing template variable and throw
	// INVALID_PROMPT_INPUT. n8n's native ToolsAgent uses a `{system_message}` placeholder
	// and supplies the actual content at invoke() time — replicate that here.
	const prompt = ChatPromptTemplate.fromMessages([
		['system', '{system_message}'],
		new MessagesPlaceholder('chat_history'),
		['human', '{input}'],
		new MessagesPlaceholder('agent_scratchpad'),
	]);
	let systemMessageValue = opts.systemPrompt || 'You are a helpful assistant.';
	if (opts.formatInstructions && opts.formatInstructions.trim()) {
		systemMessageValue += '\n\n' + opts.formatInstructions.trim();
	}

	// Resolve LangChain agent helpers. Order matches n8n's own evolution:
	//   - Newer n8n (current @n8n/nodes-langchain) imports from '@langchain/classic/agents'
	//   - Older n8n versions import from 'langchain/agents'
	//   - '@langchain/core/agents' resolves but exports nothing useful — kept last as a long shot
	// importFirst verifies typeof === 'function' before returning so an empty
	// barrel (the @langchain/core/agents case) doesn't silently return undefined
	// and produce "createAgentFn is not a function" at call time.
	const importFirst = async (names: string[], exportName: string): Promise<any> => {
		for (const name of names) {
			try {
				const mod = (await import(name as any)) as any;
				if (mod && typeof mod[exportName] === 'function') return mod[exportName];
				if (mod && mod.default && typeof mod.default[exportName] === 'function') {
					return mod.default[exportName];
				}
			} catch {
				// module not resolvable here — try the next candidate
			}
		}
		return undefined;
	};

	const AGENT_MODULES = ['@langchain/classic/agents', 'langchain/agents', '@langchain/core/agents'];

	const createAgentFn: any = await importFirst(AGENT_MODULES, 'createToolCallingAgent');
	if (typeof createAgentFn !== 'function') {
		throw new Error(
			`Could not resolve createToolCallingAgent from any of: ${AGENT_MODULES.join(', ')}. ` +
				'Tool-calling requires the host n8n install to expose langchain agent helpers.',
		);
	}

	const AgentExecutor: any = await importFirst(AGENT_MODULES, 'AgentExecutor');
	if (typeof AgentExecutor !== 'function') {
		throw new Error(`Could not resolve AgentExecutor from any of: ${AGENT_MODULES.join(', ')}.`);
	}

	// Apply runtime overrides via .bind(). LangChain BaseChatModel.bind()
	// returns a Runnable that injects the kwargs into every call without
	// mutating the underlying model. Each provider names the params slightly
	// differently — we send both camelCase and snake_case so whichever the
	// adapter accepts gets used.
	const applyOverrides = (m: any): any => {
		if (!m || typeof m.bind !== 'function') return m;
		const kwargs: Record<string, any> = {};
		if (typeof opts.temperature === 'number' && opts.temperature >= 0) {
			kwargs.temperature = opts.temperature;
		}
		if (typeof opts.maxTokens === 'number' && opts.maxTokens > 0) {
			kwargs.maxTokens = opts.maxTokens;
			kwargs.max_tokens = opts.maxTokens;
			kwargs.maxOutputTokens = opts.maxTokens;
		}
		if (typeof opts.topP === 'number' && opts.topP >= 0 && opts.topP <= 1) {
			kwargs.topP = opts.topP;
			kwargs.top_p = opts.topP;
		}
		if (Object.keys(kwargs).length === 0) return m;
		try {
			return m.bind(kwargs);
		} catch {
			return m;
		}
	};

	const boundPrimary = applyOverrides(opts.model);
	const boundFallback = opts.fallbackModel ? applyOverrides(opts.fallbackModel) : undefined;

	const primaryAgent = await createAgentFn({
		llm: boundPrimary,
		tools: opts.tools,
		prompt,
	});

	// Use LangChain's Runnable.withFallbacks() so the fallback agent is ONLY
	// invoked when the primary agent throws — mirrors n8n's native Tools Agent.
	let agent: any = primaryAgent;
	if (boundFallback) {
		const fallbackAgent = await createAgentFn({
			llm: boundFallback,
			tools: opts.tools,
			prompt,
		});
		agent =
			typeof primaryAgent.withFallbacks === 'function'
				? primaryAgent.withFallbacks([fallbackAgent])
				: primaryAgent;
		// If withFallbacks isn't available, fall back to manual try/catch at invoke time.
		if (agent === primaryAgent) {
			(agent as any).__fallbackAgent = fallbackAgent;
		}
	}

	const executor = new AgentExecutor({
		agent,
		tools: opts.tools,
		maxIterations: opts.maxIterations,
		returnIntermediateSteps: true,
	});

	const input = userContent.length > 1 ? userContent : opts.userMessage;

	try {
		const result = await executor.invoke({
			input,
			chat_history: opts.history,
			system_message: systemMessageValue,
		});
		return {
			text: normalizeAgentOutput(result.output),
			intermediateSteps: result.intermediateSteps,
		};
	} catch (primaryError) {
		// Manual fallback only used when withFallbacks() wasn't available.
		const manualFallbackAgent = (agent as any).__fallbackAgent;
		if (!manualFallbackAgent) throw primaryError;

		const fallbackExecutor = new AgentExecutor({
			agent: manualFallbackAgent,
			tools: opts.tools,
			maxIterations: opts.maxIterations,
			returnIntermediateSteps: true,
		});
		const result = await fallbackExecutor.invoke({
			input,
			chat_history: opts.history,
			system_message: systemMessageValue,
		});
		return {
			text: normalizeAgentOutput(result.output),
			intermediateSteps: result.intermediateSteps,
		};
	}
}
