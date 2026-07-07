/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ModelConfig {
	provider: 'anthropic' | 'openai' | 'gemini' | 'unknown' | 'langchain_direct';
	llmType: string;
	apiKey: string;
	model: string;
	baseURL?: string;
	isOAuth: boolean;
	originalModel?: any;
}

export interface BinaryDoc {
	data: string;
	mediaType: string;
	fileName: string;
}

export interface ChatMessage {
	role: 'user' | 'assistant' | 'system';
	content: string | any[];
}

export interface ProviderRequest {
	config: ModelConfig;
	systemPrompt: string;
	messages: ChatMessage[];
	docs: BinaryDoc[];
	temperature: number;
	topP: number;
	topK: number;
	maxTokens: number;
	stopSequences: string[];
	timeout: number;
	extendedThinking: boolean;
	thinkingBudget: number;
	promptCaching: boolean;
	cacheSystem: boolean;
	cacheSystemTtl: '5m' | '1h';
	cacheUserMessage: boolean;
	cacheUserMessageTtl: '5m' | '1h';
	frequencyPenalty: number;
	presencePenalty: number;
	responseFormat: string;
	geminiThinkingBudget: number;
	userId: string;
}

export interface ProviderResponse {
	text: string;
	thinking?: string;
	model: string;
	provider: string;
	stopReason: string;
	usage: Record<string, any>;
	raw?: any;
}

export interface OutputSchema {
	type?: string;
	properties?: Record<string, any>;
	required?: string[];
	[key: string]: any;
}

export interface ParseResult {
	success: boolean;
	data?: any;
	text?: string;
	error?: string;
}
