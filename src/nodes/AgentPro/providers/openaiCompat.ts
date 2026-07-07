/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ProviderRequest, ProviderResponse } from '../types';
import { formatDocsOpenAI } from '../binaryHandler';

// ═══════════════════════════════════════════════════════════════════
// OpenAI-Compatible Provider — Direct API caller
// ═══════════════════════════════════════════════════════════════════
// Works with OpenAI, DeepSeek, xAI, QWEN, Groq, and any other
// provider that implements the OpenAI chat completions API.

function isReasoningModel(model: string): boolean {
	return (
		model.startsWith('o1') ||
		model.startsWith('o3') ||
		model.startsWith('o4') ||
		model.includes('reasoner') ||
		model.includes('qwq')
	);
}

export async function callOpenAICompat(req: ProviderRequest): Promise<ProviderResponse> {
	const { config } = req;
	const baseUrl = (config.baseURL || 'https://api.openai.com/v1').replace(/\/$/, '');
	const reasoning = isReasoningModel(config.model);

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Authorization: `Bearer ${config.apiKey}`,
	};

	// Messages
	const messages: any[] = [];
	if (req.systemPrompt) {
		messages.push({ role: 'system', content: req.systemPrompt });
	}

	for (const msg of req.messages) {
		if (msg.role === 'system') continue;

		// Last user message gets binary docs
		const isLastUser = msg === req.messages[req.messages.length - 1] && msg.role === 'user';
		if (isLastUser && req.docs.length > 0) {
			const parts: any[] = [];
			parts.push(...formatDocsOpenAI(req.docs));
			parts.push({ type: 'text', text: msg.content as string });
			messages.push({ role: 'user', content: parts });
		} else if (typeof msg.content === 'string') {
			messages.push({ role: msg.role, content: msg.content });
		} else {
			messages.push({ role: msg.role, content: msg.content });
		}
	}

	// Body
	const body: any = { model: config.model, messages };

	if (!reasoning) {
		body.temperature = req.temperature;
		if (req.topP < 1) body.top_p = req.topP;
		if (req.frequencyPenalty !== 0) body.frequency_penalty = req.frequencyPenalty;
		if (req.presencePenalty !== 0) body.presence_penalty = req.presencePenalty;
	}

	if (req.maxTokens > 0) {
		body[reasoning ? 'max_completion_tokens' : 'max_tokens'] = req.maxTokens;
	}
	if (req.stopSequences.length > 0) body.stop = req.stopSequences;
	if (req.userId) body.user = req.userId;
	if (req.responseFormat && req.responseFormat !== 'text') {
		body.response_format = { type: req.responseFormat };
	}

	// Execute
	const url = `${baseUrl}/chat/completions`;
	const controller = new AbortController();
	const tid = setTimeout(() => controller.abort(), req.timeout);
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		clearTimeout(tid);
		if (!res.ok) {
			const errText = await res.text();
			throw new Error(`${config.llmType} HTTP ${res.status}: ${errText}`);
		}
		const json: any = await res.json();
		const choice = json.choices?.[0] || {};
		return {
			text: choice.message?.content || '',
			thinking: choice.message?.reasoning_content || choice.message?.reasoning || undefined,
			model: json.model,
			provider: config.llmType,
			stopReason: choice.finish_reason,
			usage: json.usage || {},
			raw: json,
		};
	} catch (e) {
		clearTimeout(tid);
		if (e instanceof Error && e.name === 'AbortError')
			throw new Error(`${config.llmType} timeout after ${req.timeout}ms`);
		throw e;
	}
}
