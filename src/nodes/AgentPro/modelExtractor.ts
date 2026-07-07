/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ModelConfig } from './types';

// ═══════════════════════════════════════════════════════════════════
// Model Extractor
// ═══════════════════════════════════════════════════════════════════
// Extracts API credentials and config from LangChain BaseChatModel
// instances received from n8n's ai_languageModel sub-nodes.
//
// n8n wraps sub-node objects in a logWrapper proxy, which can break
// standard detection methods (_llmType, constructor.name). We use
// multiple fallback strategies including deep property inspection.

const OAUTH_PREFIX = 'sk-ant-oat';

/**
 * Detect the provider type from a (possibly proxied) LangChain model object.
 * Returns a string like 'anthropic', 'openai', 'googlegenerativeai', etc.
 */
function detectLlmType(model: any): string {
	// Strategy 0: Check model string
	try {
		const mName = String(
			model.model ||
				model.modelName ||
				model.modelId ||
				model.lc_kwargs?.model ||
				model.lc_kwargs?.modelName ||
				'',
		).toLowerCase();
		if (mName.includes('claude')) return 'anthropic';
		if (mName.includes('gemini') || mName.includes('models/')) return 'googlegenerativeai';
		if (mName.includes('gpt')) return 'openai';
	} catch {
		/* skip */
	}

	// Strategy 1: _llmType() method — most reliable when not proxied
	try {
		if (typeof model._llmType === 'function') {
			const t = model._llmType();
			if (t && typeof t === 'string' && t !== 'unknown') {
				if (t === 'anthropic' || t.includes('claude') || t.includes('anthropic'))
					return 'anthropic';
				if (t === 'openai' || t.includes('openai')) return 'openai';
				if (t === 'googlegenerativeai' || t.includes('google') || t.includes('gemini'))
					return 'googlegenerativeai';
				return t;
			}
		}
	} catch {
		/* proxy may throw */
	}

	// Strategy 2: constructor name (may be mangled by proxy/bundler)
	try {
		const ctorName = model.constructor?.name || '';
		if (ctorName.includes('Anthropic')) return 'anthropic';
		if (ctorName.includes('GoogleGenerativeAI') || ctorName.includes('Gemini'))
			return 'googlegenerativeai';
		if (ctorName.includes('OpenAI')) return 'openai';
	} catch {
		/* skip */
	}

	// Strategy 3: lc_namespace array
	try {
		if (Array.isArray(model.lc_namespace)) {
			const ns = model.lc_namespace.join('.').toLowerCase();
			if (ns.includes('anthropic')) return 'anthropic';
			if (ns.includes('google')) return 'googlegenerativeai';
			if (ns.includes('openai')) return 'openai';
		}
	} catch {
		/* skip */
	}

	// Strategy 4: Check for Anthropic-specific properties
	if (
		model.anthropicApiKey !== undefined ||
		model.apiUrl !== undefined ||
		model.lc_kwargs?.anthropicApiKey
	) {
		return 'anthropic';
	}
	if (typeof model.token === 'string' && model.token.startsWith('sk-ant-')) {
		return 'anthropic';
	}
	if (typeof model.modelId === 'string' && model.modelId.startsWith('claude-')) {
		return 'anthropic';
	}

	// Strategy 5: Check for Gemini-specific properties
	if (
		model.safetySettings !== undefined ||
		model.convertSystemMessageToHumanContent !== undefined ||
		model.lc_kwargs?.apiKey
	) {
		// Caution: openai also has apiKey, but if it fell through, maybe it's gemini.
		// We'll rely on Strategy 0 largely.
	}

	// Strategy 6: Check for OpenAI-specific properties
	if (
		model.organization !== undefined ||
		model.clientConfig !== undefined ||
		model.lc_kwargs?.openAIApiKey
	) {
		return 'openai';
	}

	// Strategy 7: Deep-walk the prototype chain looking for _llmType
	try {
		let proto = Object.getPrototypeOf(model);
		let depth = 0;
		while (proto && depth < 10) {
			if (typeof proto._llmType === 'function') {
				const t = proto._llmType.call(model);
				if (t && typeof t === 'string' && t !== 'unknown') return t;
			}
			proto = Object.getPrototypeOf(proto);
			depth++;
		}
	} catch {
		/* skip */
	}

	// Strategy 8: Check string coercion / toString
	try {
		const str = String(model).toLowerCase();
		if (str.includes('anthropic')) return 'anthropic';
		if (str.includes('gemini') || str.includes('google')) return 'googlegenerativeai';
		if (str.includes('openai')) return 'openai';
	} catch {
		/* skip */
	}

	return 'unknown';
}

/**
 * Extract provider config from a LangChain model object.
 */
export function extractModelConfig(model: any): ModelConfig {
	if (!model) {
		throw new Error('No model object provided. Connect a Chat Model sub-node.');
	}

	const llmType = detectLlmType(model);
	const kw = model.lc_kwargs || {};

	if (llmType === 'anthropic') {
		const apiKey =
			model.apiKey || model.anthropicApiKey || model.token || kw.anthropicApiKey || kw.apiKey || '';
		const modelName =
			model.model ||
			model.modelName ||
			model.modelId ||
			kw.modelName ||
			kw.model ||
			'claude-sonnet-4-6';
		return {
			provider: 'anthropic',
			llmType,
			apiKey,
			model: modelName,
			baseURL: model.apiUrl || model.clientOptions?.baseURL || kw.apiUrl || undefined,
			isOAuth: typeof apiKey === 'string' && apiKey.startsWith(OAUTH_PREFIX),
		};
	}

	if (llmType === 'googlegenerativeai') {
		return {
			provider: 'gemini',
			llmType,
			apiKey: model.apiKey || kw.apiKey || '',
			model: model.model || model.modelName || kw.modelName || kw.model || 'gemini-2.0-flash',
			baseURL: model.baseUrl || kw.baseUrl || undefined,
			isOAuth: false,
		};
	}

	if (llmType === 'unknown') {
		// Safety net for obscured keys inside arrays / proxies
		try {
			const potentialKeys = [
				model.apiKey,
				model.anthropicApiKey,
				kw.anthropicApiKey,
				kw.apiKey,
				model.openAIApiKey,
			];
			for (const k of potentialKeys) {
				if (typeof k === 'string' && k.startsWith('sk-ant-')) {
					return {
						provider: 'anthropic',
						llmType: 'anthropic',
						apiKey: k,
						model:
							model.model || model.modelName || kw.modelName || kw.model || 'claude-sonnet-4-6',
						baseURL: model.apiUrl || model.clientOptions?.baseURL || undefined,
						isOAuth: k.startsWith(OAUTH_PREFIX),
					};
				}
			}
		} catch {
			/* skip */
		}
	}

	return {
		provider: 'langchain_direct',
		llmType: 'langchain_direct',
		apiKey: '',
		model: model.model || model.modelName || kw.modelName || kw.model || 'unknown',
		isOAuth: false,
		originalModel: model,
	};
}
