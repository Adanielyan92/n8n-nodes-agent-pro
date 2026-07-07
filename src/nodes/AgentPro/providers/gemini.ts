/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ProviderRequest, ProviderResponse } from '../types';
import { formatDocsGemini } from '../binaryHandler';

// ═══════════════════════════════════════════════════════════════════
// Google Gemini Provider — Direct API caller
// ═══════════════════════════════════════════════════════════════════

export async function callGemini(req: ProviderRequest): Promise<ProviderResponse> {
	const { config } = req;
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;

	// Build contents with conversation history
	const contents: any[] = [];
	for (const msg of req.messages) {
		if (msg.role === 'system') continue;

		const isLastUser = msg === req.messages[req.messages.length - 1] && msg.role === 'user';
		if (isLastUser && req.docs.length > 0) {
			const parts: any[] = [];
			parts.push(...formatDocsGemini(req.docs));
			parts.push({ text: msg.content as string });
			contents.push({ role: 'user', parts });
		} else {
			contents.push({
				role: msg.role === 'user' ? 'user' : 'model',
				parts: [{ text: msg.content as string }],
			});
		}
	}

	// Body
	const body: any = {
		contents,
		generationConfig: { temperature: req.temperature },
	};

	if (req.topP < 1) body.generationConfig.topP = req.topP;
	if (req.topK > -1) body.generationConfig.topK = req.topK;
	if (req.maxTokens > 0) body.generationConfig.maxOutputTokens = req.maxTokens;
	if (req.stopSequences.length > 0) body.generationConfig.stopSequences = req.stopSequences;

	if (req.geminiThinkingBudget > 0 && config.model.includes('2.5')) {
		body.generationConfig.thinkingConfig = { thinkingBudget: req.geminiThinkingBudget };
	}

	if (req.responseFormat === 'json_object') {
		body.generationConfig.responseMimeType = 'application/json';
	}

	if (req.systemPrompt) {
		body.systemInstruction = { parts: [{ text: req.systemPrompt }] };
	}

	// Execute
	const controller = new AbortController();
	const tid = setTimeout(() => controller.abort(), req.timeout);
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		clearTimeout(tid);
		if (!res.ok) {
			const errText = await res.text();
			throw new Error(`Gemini HTTP ${res.status}: ${errText}`);
		}
		const json: any = await res.json();
		const candidate = json.candidates?.[0] || {};
		const allParts = candidate.content?.parts || [];
		const text = allParts
			.filter((p: any) => p.text !== undefined && !p.thought)
			.map((p: any) => p.text)
			.join('');
		const thinking =
			allParts
				.filter((p: any) => p.thought === true)
				.map((p: any) => p.text)
				.join('') || undefined;
		return {
			text,
			thinking,
			model: config.model,
			provider: 'gemini',
			stopReason: candidate.finishReason,
			usage: json.usageMetadata || {},
			raw: json,
		};
	} catch (e) {
		clearTimeout(tid);
		if (e instanceof Error && e.name === 'AbortError')
			throw new Error(`Gemini timeout after ${req.timeout}ms`);
		throw e;
	}
}
