/* eslint-disable @typescript-eslint/no-explicit-any */

import { HumanMessage, SystemMessage, AIMessage } from '@langchain/core/messages';
import type { ProviderResponse, BinaryDoc, ChatMessage } from '../types';

// ═══════════════════════════════════════════════════════════════════
// LangChain Direct Provider
// ═══════════════════════════════════════════════════════════════════
// Invokes a LangChain BaseChatModel directly through its standard
// .invoke() API — exactly how n8n's native AI Agent works.
// This avoids any need to extract API keys from the model object.

/**
 * Invoke a LangChain BaseChatModel directly.
 * This is the safest path for models where we cannot (or should not)
 * extract API credentials — e.g. native n8n Anthropic/OpenAI/Gemini
 * chat model nodes wrapped in logWrapper proxy.
 */
export interface AnthropicCacheConfig {
	enabled: boolean;
	cacheSystem: boolean;
	cacheSystemTtl: '5m' | '1h';
	cacheUserMessage: boolean;
	cacheUserMessageTtl: '5m' | '1h';
}

export async function invokeLangchainModel(params: {
	model: any;
	systemPrompt: string;
	messages: ChatMessage[];
	docs: BinaryDoc[];
	timeout: number;
	anthropicCache?: AnthropicCacheConfig;
}): Promise<ProviderResponse> {
	const { model, systemPrompt, messages: chatMessages, docs, timeout, anthropicCache } = params;

	// Cache_control only applies when the underlying adapter is Anthropic.
	// @langchain/anthropic forwards cache_control on content blocks to the API.
	const cacheCfg = anthropicCache && anthropicCache.enabled ? anthropicCache : undefined;
	const buildCacheControl = (ttl: '5m' | '1h'): any => {
		const cc: any = { type: 'ephemeral' };
		if (ttl === '1h') cc.ttl = '1h';
		return cc;
	};

	// Build LangChain message array
	const lcMessages: any[] = [];

	if (systemPrompt) {
		if (cacheCfg && cacheCfg.cacheSystem) {
			lcMessages.push(
				new SystemMessage({
					content: [
						{
							type: 'text',
							text: systemPrompt,
							cache_control: buildCacheControl(cacheCfg.cacheSystemTtl),
						},
					],
				}),
			);
		} else {
			lcMessages.push(new SystemMessage(systemPrompt));
		}
	}

	for (const msg of chatMessages) {
		if (msg.role === 'system') continue;

		const isLastUser = msg === chatMessages[chatMessages.length - 1] && msg.role === 'user';

		if (msg.role === 'assistant') {
			lcMessages.push(new AIMessage(msg.content as string));
			continue;
		}

		// For the last user message, inject binary documents
		if (isLastUser && docs.length > 0) {
			const contentParts: any[] = [];
			for (const d of docs) {
				if (d.mediaType === 'application/pdf') {
					// PDF as base64 document block (Anthropic-style)
					contentParts.push({
						type: 'image_url',
						image_url: { url: `data:${d.mediaType};base64,${d.data}` },
					});
				} else if (d.mediaType.startsWith('image/')) {
					contentParts.push({
						type: 'image_url',
						image_url: { url: `data:${d.mediaType};base64,${d.data}` },
					});
				} else {
					contentParts.push({
						type: 'text',
						text: `[[Attached File: ${d.fileName}]]`,
					});
				}
			}
			const lastTextPart: any = { type: 'text', text: msg.content as string };
			if (cacheCfg && cacheCfg.cacheUserMessage) {
				lastTextPart.cache_control = buildCacheControl(cacheCfg.cacheUserMessageTtl);
			}
			contentParts.push(lastTextPart);
			lcMessages.push(new HumanMessage({ content: contentParts }));
		} else if (isLastUser && cacheCfg && cacheCfg.cacheUserMessage) {
			lcMessages.push(
				new HumanMessage({
					content: [
						{
							type: 'text',
							text: msg.content as string,
							cache_control: buildCacheControl(cacheCfg.cacheUserMessageTtl),
						},
					],
				}),
			);
		} else {
			lcMessages.push(new HumanMessage(msg.content as string));
		}
	}

	const controller = new AbortController();
	const tid = setTimeout(() => controller.abort(), timeout);

	try {
		const result = await model.invoke(lcMessages, {
			signal: controller.signal,
		});
		clearTimeout(tid);

		const text =
			typeof result.content === 'string'
				? result.content
				: typeof result === 'string'
					? result
					: JSON.stringify(result.content || result);

		return {
			text,
			model: result.response_metadata?.model || 'langchain-native',
			provider: 'langchain-native',
			stopReason:
				result.response_metadata?.stop_reason || result.response_metadata?.finish_reason || 'stop',
			usage: result.usage_metadata || result.response_metadata?.usage || {},
			raw: result.response_metadata,
		};
	} catch (e) {
		clearTimeout(tid);
		if (e instanceof Error && e.name === 'AbortError') {
			throw new Error(`Model timeout after ${timeout}ms`);
		}
		throw e;
	}
}
