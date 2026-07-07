import {
	ISupplyDataFunctions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { BaseMessage, AIMessageChunk } from '@langchain/core/messages';
import { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';

// ---------------------------------------------------------------------------
// Constants & Limits
// ---------------------------------------------------------------------------
const MODEL_MAX_TOKENS: Record<string, number> = {
	'claude-3-7-sonnet-20250219': 16384,
	'claude-3-7-sonnet-latest': 16384,
	'claude-3-5-sonnet-20241022': 8192,
	'claude-3-5-sonnet-20240620': 8192,
	'claude-3-5-sonnet-latest': 8192,
	'claude-3-opus-20240229': 4096,
};

const DEFAULT_MAX_TOKENS = 8192;
const CLAUDE_CLI_USER_AGENT = 'claude-cli/2.1.74 (external, cli)';
// Prompt caching is GA since Dec 2024 — no beta header needed.
// `prompt-caching-scope-2026-01-05` introduces workspace-level scoping that
// breaks cross-run cache hits in stateless n8n environments, so we DON'T send it.
// `oauth-2025-04-20` is required for the OAuth flow; `claude-code-20250219` is
// kept for compat.
const OAUTH_BETAS = 'claude-code-20250219,oauth-2025-04-20';
// Claude Code OAuth requires this exact identity string as the first system
// block (verified against promptfoo's Anthropic provider + leaked OAuth refs).
const OAUTH_BILLING_HEADER = "You are Claude Code, Anthropic's official CLI for Claude.";

function isOAuthToken(token: string): boolean {
	return token.startsWith('sk-ant-oat');
}

function buildAuthHeaders(token: string) {
	const headers: Record<string, string> = {
		accept: 'application/json',
		'anthropic-version': '2023-06-01',
		'content-type': 'application/json',
	};

	if (isOAuthToken(token)) {
		headers['authorization'] = `Bearer ${token}`;
		headers['anthropic-beta'] = OAUTH_BETAS;
		headers['anthropic-dangerous-direct-browser-access'] = 'true';
		headers['user-agent'] = CLAUDE_CLI_USER_AGENT;
		headers['x-app'] = 'cli';
	} else {
		headers['x-api-key'] = token;
		// No beta header — prompt caching is GA on the API-key path.
	}

	return headers;
}

function getMessagesUrl(token: string) {
	return isOAuthToken(token)
		? 'https://api.anthropic.com/v1/messages?beta=true'
		: 'https://api.anthropic.com/v1/messages';
}

// ---------------------------------------------------------------------------
// Block Conversion
// ---------------------------------------------------------------------------
function convertContentBlockToAnthropic(block: any): any {
	if (typeof block === 'string') return { type: 'text', text: block };
	const blockType = block.type || '';
	if (blockType === 'text') return { type: 'text', text: block.text || '' };

	if (blockType === 'image_url') {
		const imageUrl = block.image_url?.url || '';
		const dataUriMatch = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
		if (dataUriMatch) {
			return {
				type: 'image',
				source: { type: 'base64', media_type: dataUriMatch[1], data: dataUriMatch[2] },
			};
		}
		if (imageUrl.startsWith('http')) {
			return { type: 'image', source: { type: 'url', url: imageUrl } };
		}
		return { type: 'text', text: `[Image: ${imageUrl.substring(0, 100)}...]` };
	}

	if (
		blockType === 'image' ||
		blockType === 'document' ||
		blockType === 'tool_result' ||
		blockType === 'tool_use'
	)
		return block;
	return { type: 'text', text: typeof block === 'string' ? block : JSON.stringify(block) };
}

function convertContentToAnthropic(content: any): any {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) return content.map(convertContentBlockToAnthropic);
	return convertContentBlockToAnthropic(content);
}

function convertMessages(messages: BaseMessage[]): any[] {
	return messages
		.map((msg: any) => {
			const msgType = msg._getType();
			if (msgType === 'tool') {
				return {
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: msg.tool_call_id || msg.additional_kwargs?.tool_call_id,
							content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
						},
					],
				};
			}
			const role = msgType === 'ai' ? 'assistant' : 'user';
			if (msgType === 'ai' && msg.tool_calls && msg.tool_calls.length > 0) {
				const content: any[] = [];
				const textContent = typeof msg.content === 'string' ? msg.content : '';
				if (textContent) content.push({ type: 'text', text: textContent });
				for (const tc of msg.tool_calls) {
					content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
				}
				return { role, content };
			}
			return { role, content: convertContentToAnthropic(msg.content) };
		})
		.filter((msg) => {
			if (typeof msg.content === 'string' && msg.content.trim() === '') return false;
			return true;
		});
}

function extractSystemMessage(messages: BaseMessage[]) {
	const systemMsgs = messages.filter((m) => m._getType() === 'system');
	const filtered = messages.filter((m) => m._getType() !== 'system');
	const system =
		systemMsgs.length > 0
			? systemMsgs
					.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
					.join('\\n')
			: undefined;
	return { system, filtered };
}

async function* parseSSEEvents(stream: any) {
	let buffer = '';
	for await (const chunk of stream) {
		buffer += chunk.toString();
		const parts = buffer.split('\\n\\n');
		buffer = parts.pop() || '';
		for (const part of parts) {
			if (!part.trim()) continue;
			let event = '';
			let data = '';
			for (const line of part.split('\\n')) {
				if (line.startsWith('event:')) event = line.slice(6).trim();
				else if (line.startsWith('data:')) data = line.slice(5).trim();
			}
			if (event && data) {
				try {
					yield { event, data: JSON.parse(data) };
				} catch {
					/* skip */
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Model Implementation
// ---------------------------------------------------------------------------
export class ClaudeVisionChatModel extends BaseChatModel {
	lc_serializable = false;
	token: string;
	modelId: string;
	maxTokens: number;
	temperature: number;
	topP?: number;
	topK?: number;
	extendedThinking: boolean;
	thinkingBudget: number;
	timeout: number;
	maxRetries: number;
	boundTools?: any[];
	binaryDocuments?: any[];
	promptCaching: boolean;

	constructor(fields: any) {
		super({});
		this.token = fields.token;
		this.modelId = fields.modelId;
		this.maxTokens =
			fields.maxTokens > 0
				? fields.maxTokens
				: MODEL_MAX_TOKENS[fields.modelId] || DEFAULT_MAX_TOKENS;
		this.temperature = fields.temperature ?? 0;
		this.topP = fields.topP;
		this.topK = fields.topK;
		this.extendedThinking = fields.extendedThinking || false;
		this.thinkingBudget = fields.thinkingBudget || 1024;
		this.timeout = fields.timeout || 300000; // 5 mins default
		this.maxRetries = fields.maxRetries ?? 1;
		this.boundTools = fields.tools;
		this.binaryDocuments = fields.binaryDocuments || [];
		this.promptCaching = fields.promptCaching !== false;
	}

	_llmType() {
		return 'claude-vision';
	}

	bindTools(tools: any[], _kwargs?: any): this {
		const anthropicTools = tools.map((tool) => {
			const openAiTool = convertToOpenAITool(tool);
			const params = { ...(openAiTool.function.parameters || { type: 'object', properties: {} }) };
			delete (params as any).$schema;
			return {
				name: openAiTool.function.name,
				description: openAiTool.function.description || '',
				input_schema: params,
			};
		});
		return new ClaudeVisionChatModel({
			...this,
			token: this.token,
			modelId: this.modelId,
			tools: anthropicTools,
		}) as this;
	}

	async _generate(messages: BaseMessage[], options: any, _runManager: any): Promise<ChatResult> {
		return this._withRetry(() => this._callApi(messages, options));
	}

	_isRetryableError(error: unknown) {
		if (error instanceof Error) {
			const msg = error.message;
			if (msg.includes('HTTP 5') || msg.includes('timed out') || msg.includes('ECONN')) return true;
		}
		return false;
	}

	async _withRetry<T>(fn: () => Promise<T>): Promise<T> {
		let lastError;
		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			try {
				return await fn();
			} catch (error) {
				lastError = error;
				if (attempt < this.maxRetries && this._isRetryableError(error)) {
					await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
					continue;
				}
				throw error;
			}
		}
		throw lastError;
	}

	_injectBinaryDocuments(apiMessages: any[]) {
		if (!this.binaryDocuments || this.binaryDocuments.length === 0) return;

		let targetMsgIdx = apiMessages.findIndex((m) => m.role === 'user');
		if (targetMsgIdx === -1) {
			apiMessages.push({ role: 'user', content: [] });
			targetMsgIdx = apiMessages.length - 1;
		}

		const userMsg = apiMessages[targetMsgIdx];
		let contentArray = [];
		if (typeof userMsg.content === 'string') {
			contentArray = [{ type: 'text', text: userMsg.content }];
		} else if (Array.isArray(userMsg.content)) {
			contentArray = [...userMsg.content];
		} else {
			contentArray = [userMsg.content];
		}

		const docBlocks: any[] = [];
		for (const doc of this.binaryDocuments) {
			const mediaType = doc.mediaType.toLowerCase();
			if (mediaType === 'application/pdf') {
				docBlocks.push({ type: 'text', text: `Attached document: ${doc.fileName}` });
				docBlocks.push({
					type: 'document',
					source: { type: 'base64', media_type: 'application/pdf', data: doc.data },
				});
			} else if (mediaType.startsWith('image/')) {
				docBlocks.push({ type: 'text', text: `Attached image: ${doc.fileName}` });
				docBlocks.push({
					type: 'image',
					source: { type: 'base64', media_type: mediaType, data: doc.data },
				});
			}
		}

		userMsg.content = [...docBlocks, ...contentArray];
	}

	_buildRequestBody(messages: BaseMessage[], options: any) {
		const { system, filtered } = extractSystemMessage(messages);
		const apiMessages = convertMessages(filtered);

		this._injectBinaryDocuments(apiMessages);

		if (apiMessages.length === 0) {
			apiMessages.push({ role: 'user', content: 'Hello' });
		}

		// Apply Prompt Caching to large contexts if enabled
		if (this.promptCaching) {
			// Cache the last piece of the user message (often where the large attached documents are)
			for (let i = apiMessages.length - 1; i >= 0; i--) {
				if (apiMessages[i].role === 'user' && Array.isArray(apiMessages[i].content)) {
					const blocks = apiMessages[i].content;
					if (blocks.length > 0) {
						blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
						break;
					}
				}
			}
		}

		const body: any = {
			model: this.modelId,
			max_tokens: this.maxTokens,
			messages: apiMessages,
		};

		if (isOAuthToken(this.token)) {
			const systemParts: any[] = [{ type: 'text', text: OAUTH_BILLING_HEADER }];
			if (system) {
				const sysBlock: any = { type: 'text', text: system };
				if (this.promptCaching) sysBlock.cache_control = { type: 'ephemeral' };
				systemParts.push(sysBlock);
			}
			body.system = systemParts;
		} else if (system) {
			const sysBlock: any = { type: 'text', text: system };
			if (this.promptCaching) sysBlock.cache_control = { type: 'ephemeral' };
			body.system = [sysBlock];
		}

		const tools = options.tools && options.tools.length > 0 ? options.tools : this.boundTools;
		if (tools && tools.length > 0) {
			body.tools = tools;
		}

		if (this.extendedThinking && this.thinkingBudget) {
			const block = { type: 'enabled', budget_tokens: this.thinkingBudget };
			body.thinking = block;
			body.temperature = 1;
		} else {
			body.temperature = this.temperature;
			if (this.topP !== undefined && this.topP < 1) body.top_p = this.topP;
			if (this.topK !== undefined && this.topK > -1) body.top_k = this.topK;
		}

		return body;
	}

	async _callApi(messages: BaseMessage[], options: any): Promise<ChatResult> {
		const body = this._buildRequestBody(messages, options);
		const headers = buildAuthHeaders(this.token);

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout);

		let response: any;
		try {
			const res = await fetch(getMessagesUrl(this.token), {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: controller.signal as any,
			});
			clearTimeout(timeoutId);

			if (!res.ok) {
				const rawData = await res.text();
				let errorMsg = rawData;
				try {
					const json = JSON.parse(rawData);
					errorMsg = json?.error?.message || rawData;
				} catch {
					// ignored — best-effort
				}
				// eslint-disable-next-line n8n-nodes-base/node-execute-block-wrong-error-thrown
				throw new Error(`Anthropic API error (HTTP ${res.status}): ${errorMsg}`);
			}
			response = await res.json();
		} catch (error) {
			clearTimeout(timeoutId);
			if (error instanceof Error && error.name === 'AbortError')
				// eslint-disable-next-line n8n-nodes-base/node-execute-block-wrong-error-thrown
				throw new Error(`Anthropic API request timed out after ${this.timeout}ms`);
			throw error;
		}

		const textBlocks = response.content.filter((b: any) => b.type === 'text');
		const toolUseBlocks = response.content.filter((b: any) => b.type === 'tool_use');
		const text = textBlocks.map((b: any) => b.text || '').join('');

		const toolCalls = toolUseBlocks.map((b: any) => ({
			name: b.name || '',
			args: b.input || {},
			id: b.id || '',
			type: 'tool_call',
		}));

		const aiMessage = new AIMessageChunk({
			content: text,
			tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
			additional_kwargs: {
				usage: {
					input_tokens: response.usage?.input_tokens,
					output_tokens: response.usage?.output_tokens,
					cache_creation_input_tokens: response.usage?.cache_creation_input_tokens,
					cache_read_input_tokens: response.usage?.cache_read_input_tokens,
				},
			},
		});

		return {
			generations: [{ text, message: aiMessage }],
			llmOutput: { usage: aiMessage.additional_kwargs.usage },
		};
	}

	async *_streamResponseChunks(
		messages: BaseMessage[],
		options: any,
		runManager?: any,
	): AsyncGenerator<ChatGenerationChunk> {
		const body = this._buildRequestBody(messages, options);
		body.stream = true;
		const headers = buildAuthHeaders(this.token);

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout);

		let res;
		try {
			res = await fetch(getMessagesUrl(this.token), {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: controller.signal as any,
			});
			clearTimeout(timeoutId);
		} catch (e) {
			clearTimeout(timeoutId);
			if (e instanceof Error && e.name === 'AbortError')
				// eslint-disable-next-line n8n-nodes-base/node-execute-block-wrong-error-thrown
				throw new Error(`Anthropic API timeout (${this.timeout}ms)`);
			throw e;
		}

		if (!res.ok) {
			const rawData = await res.text();
			// eslint-disable-next-line n8n-nodes-base/node-execute-block-wrong-error-thrown
			throw new Error(`Anthropic stream error: ${rawData}`);
		}

		const streamIterable = {
			[Symbol.asyncIterator]() {
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				const reader = res.body!.getReader();
				return {
					async next() {
						const { done, value } = await reader.read();
						if (done) return { done: true, value: undefined };
						return { done: false, value: Buffer.from(value) };
					},
				};
			},
		};

		const toolBlocks = new Map();
		for await (const { event, data } of parseSSEEvents(streamIterable)) {
			if (event === 'message_stop') break;
			// eslint-disable-next-line n8n-nodes-base/node-execute-block-wrong-error-thrown
			if (event === 'error') throw new Error(`Anthropic stream error: ${JSON.stringify(data)}`);
			if (event === 'content_block_start' && data.content_block?.type === 'tool_use') {
				toolBlocks.set(data.index, {
					id: data.content_block.id,
					name: data.content_block.name,
					partialJson: '',
				});
			} else if (event === 'content_block_delta') {
				if (data.delta?.type === 'text_delta') {
					const deltaText = data.delta.text || '';
					const chunk = new ChatGenerationChunk({
						text: deltaText,
						message: new AIMessageChunk({ content: deltaText }),
					});
					yield chunk;
					await runManager?.handleLLMNewToken(deltaText);
				} else if (data.delta?.type === 'input_json_delta') {
					const block = toolBlocks.get(data.index);
					if (block) block.partialJson += data.delta.partial_json || '';
				}
			} else if (event === 'content_block_stop') {
				const block = toolBlocks.get(data.index);
				if (block) {
					let args = {};
					try {
						args = JSON.parse(block.partialJson);
					} catch {
						// ignored — best-effort
					}
					const chunk = new ChatGenerationChunk({
						text: '',
						message: new AIMessageChunk({
							content: '',
							tool_calls: [{ name: block.name, args, id: block.id, type: 'tool_call' }],
						}),
					});
					yield chunk;
					toolBlocks.delete(data.index);
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Node Type Definition
// ---------------------------------------------------------------------------
export class ClaudeVision implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Claude Vision LM',
		name: 'claudeVision',
		icon: 'file:claude-vision.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["modelId"]}}',
		description:
			'Claude Chat Model supporting Vision, PDF documents, and MAX tier OAuth tokens with full Prompt Caching.',
		defaults: { name: 'Claude Vision LM' },
		inputs: ['main'],
		outputs: ['main'],
		outputNames: ['Model'],
		credentials: [{ name: 'claudeVisionApi', required: true }],
		properties: [
			{
				displayName: 'Model ID',
				name: 'modelId',
				type: 'string',
				default: 'claude-3-5-sonnet-latest',
				description:
					'The Anthropic model to use (e.g. claude-3-7-sonnet-20250219, claude-3-5-sonnet-latest)',
			},
			{
				displayName: 'Extended Thinking',
				name: 'extendedThinking',
				type: 'boolean',
				default: false,
				description: 'Whether to enable chain-of-thought reasoning',
			},
			{
				displayName: 'Thinking Budget',
				name: 'thinkingBudget',
				type: 'number',
				typeOptions: { minValue: 1024 },
				default: 10000,
				displayOptions: { show: { extendedThinking: [true] } },
				description: 'Max tokens for thinking process',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Temperature',
						name: 'temperature',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 1 },
						default: 0,
					},
					{
						displayName: 'Max Tokens Override',
						name: 'maxTokensOverride',
						type: 'number',
						typeOptions: { minValue: -1 },
						default: -1,
					},
					{
						displayName: 'Timeout (Ms)',
						name: 'timeout',
						type: 'number',
						typeOptions: { minValue: 1000 },
						default: 300000,
						description: 'Maximum await time before failing request natively (default 5m/300k)',
					},
					{
						displayName: 'Max Retries',
						name: 'maxRetries',
						type: 'number',
						typeOptions: { minValue: 0, maxValue: 10 },
						default: 1,
					},
				],
			},
		],
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<any> {
		const credentials = await this.getCredentials('claudeVisionApi');
		const modelId = this.getNodeParameter('modelId', itemIndex) as string;
		const extendedThinking = this.getNodeParameter('extendedThinking', itemIndex, false) as boolean;
		let thinkingBudget = 0;
		if (extendedThinking)
			thinkingBudget = this.getNodeParameter('thinkingBudget', itemIndex, 1024) as number;
		const options = this.getNodeParameter('options', itemIndex, {}) as Record<string, any>;

		let token = credentials.apiKey as string;
		if (credentials.authType === 'oauth' && credentials.setupToken) {
			token = credentials.setupToken as string;
		}

		const model = new ClaudeVisionChatModel({
			token,
			modelId,
			temperature: options.temperature,
			maxTokens: options.maxTokensOverride,
			extendedThinking,
			thinkingBudget,
			timeout: options.timeout,
			maxRetries: options.maxRetries,
			promptCaching: true,
		});

		return {
			response: model,
		};
	}
}
