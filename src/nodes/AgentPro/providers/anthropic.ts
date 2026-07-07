/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ProviderRequest, ProviderResponse } from '../types';
import { formatDocsAnthropic } from '../binaryHandler';

// ═══════════════════════════════════════════════════════════════════
// Anthropic Provider — Direct API caller
// ═══════════════════════════════════════════════════════════════════

// Beta headers policy (per Anthropic release notes 2025–2026):
//   - Prompt caching went GA Dec 17 2024 — `prompt-caching-2024-07-31` not needed.
//   - 1-hour cache TTL went GA Aug 13 2025 — `extended-cache-ttl-2025-04-11` not needed.
//   - Automatic caching launched Feb 19 2026 — `cache_control` alone is sufficient.
//   - `prompt-caching-scope-2026-01-05` opts in to workspace-level cache isolation.
//     Claude Code CLI uses it because its workspace context is stable. In our
//     stateless n8n runs, that scoping prevented cross-run hits — removed.
// OAuth flow (verified against Promptfoo's Claude Code integration and the
// leaked Claude Code OAuth reference): send only `oauth-2025-04-20`
// (required) plus `claude-code-20250219` for compatibility.
// `interleaved-thinking-2025-05-14` is optional and only relevant when
// extended thinking with tool interleaving is actually used — we keep it on
// both paths because our agent loop can request thinking mid-flow.
const OAUTH_BETAS = 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14';
const APIKEY_BETAS = 'interleaved-thinking-2025-05-14';
const CLI_UA = 'claude-cli/2.1.74 (external, cli)';
// Claude Code's required identity system block. Must be the FIRST system
// block on every OAuth request — Anthropic's OAuth backend verifies this.
// Confirmed from promptfoo's Anthropic provider and the leaked Claude Code
// OAuth reference implementation.
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

const MAX_TOKENS: Record<string, number> = {
	'claude-opus-4-6': 128000,
	'claude-sonnet-4-6': 64000,
	'claude-opus-4-5': 64000,
	'claude-sonnet-4-5': 64000,
	'claude-haiku-4-5': 64000,
	'claude-opus-4-1': 32000,
	'claude-sonnet-4-0': 64000,
	'claude-3-7-sonnet-latest': 16384,
	'claude-3-5-sonnet-latest': 8192,
	'claude-3-5-haiku-latest': 8192,
};

function getMaxTokens(model: string): number {
	if (MAX_TOKENS[model]) return MAX_TOKENS[model];
	if (model.includes('opus-4-6') || model.includes('opus-4-5')) return 64000;
	if (model.includes('sonnet-4')) return 64000;
	if (model.includes('haiku-4')) return 64000;
	if (model.includes('opus-4')) return 32000;
	if (model.startsWith('claude-3-7')) return 16384;
	if (model.startsWith('claude-3-5')) return 8192;
	if (model.startsWith('claude-3-')) return 4096;
	return 16384;
}

export async function callAnthropic(req: ProviderRequest): Promise<ProviderResponse> {
	const { config } = req;
	const headers: Record<string, string> = {
		accept: 'application/json',
		'anthropic-version': '2023-06-01',
		'content-type': 'application/json',
	};

	const sysCacheOn = req.promptCaching && req.cacheSystem;
	const msgCacheOn = req.promptCaching && req.cacheUserMessage;

	if (config.isOAuth) {
		headers['authorization'] = `Bearer ${config.apiKey}`;
		headers['anthropic-beta'] = OAUTH_BETAS;
		headers['anthropic-dangerous-direct-browser-access'] = 'true';
		headers['user-agent'] = CLI_UA;
		headers['x-app'] = 'cli';
	} else {
		headers['x-api-key'] = config.apiKey;
		headers['anthropic-beta'] = APIKEY_BETAS;
	}

	const url = config.isOAuth
		? `${config.baseURL || 'https://api.anthropic.com'}/v1/messages?beta=true`
		: `${config.baseURL || 'https://api.anthropic.com'}/v1/messages`;

	// System prompt — OAuth requires Claude Code identity as the FIRST block
	let system: any;
	if (config.isOAuth) {
		const parts: any[] = [{ type: 'text', text: CLAUDE_CODE_IDENTITY }];
		if (req.systemPrompt) parts.push({ type: 'text', text: req.systemPrompt });
		system = parts;
	} else {
		system = req.systemPrompt || undefined;
	}

	// System-prompt caching
	if (sysCacheOn) {
		const sysCacheControl: any = { type: 'ephemeral' };
		if (req.cacheSystemTtl === '1h') sysCacheControl.ttl = '1h';
		if (Array.isArray(system) && system.length > 0) {
			system[system.length - 1].cache_control = sysCacheControl;
		} else if (typeof system === 'string') {
			system = [{ type: 'text', text: system, cache_control: sysCacheControl }];
		}
	}

	// Build messages — convert ChatMessage[] to Anthropic format
	const messages: any[] = [];
	for (const msg of req.messages) {
		if (msg.role === 'system') continue; // system handled separately

		// Last user message gets binary docs injected
		const isLastUser = msg === req.messages[req.messages.length - 1] && msg.role === 'user';

		if (isLastUser && req.docs.length > 0) {
			const content: any[] = [];
			content.push(...formatDocsAnthropic(req.docs));
			content.push({ type: 'text', text: msg.content as string });
			if (msgCacheOn) {
				const msgCacheControl: any = { type: 'ephemeral' };
				if (req.cacheUserMessageTtl === '1h') msgCacheControl.ttl = '1h';
				content[content.length - 1].cache_control = msgCacheControl;
			}
			messages.push({ role: 'user', content });
		} else if (isLastUser && msgCacheOn) {
			// No docs on last user message — still cache the text block if requested
			const msgCacheControl: any = { type: 'ephemeral' };
			if (req.cacheUserMessageTtl === '1h') msgCacheControl.ttl = '1h';
			messages.push({
				role: 'user',
				content: [{ type: 'text', text: msg.content as string, cache_control: msgCacheControl }],
			});
		} else {
			messages.push({ role: msg.role, content: msg.content });
		}
	}

	// Request body
	const effectiveMax = req.maxTokens > 0 ? req.maxTokens : getMaxTokens(config.model);
	const body: any = { model: config.model, max_tokens: effectiveMax, messages };

	if (system) body.system = system;

	if (req.extendedThinking && req.thinkingBudget > 0) {
		const budget = Math.max(1024, Math.min(req.thinkingBudget, effectiveMax - 1));
		body.thinking = { type: 'enabled', budget_tokens: budget };
		body.temperature = 1;
	} else {
		body.temperature = req.temperature;
		if (req.topP < 1) body.top_p = req.topP;
		if (req.topK > -1) body.top_k = req.topK;
	}

	if (req.stopSequences.length > 0) body.stop_sequences = req.stopSequences;
	if (req.userId) body.metadata = { user_id: req.userId };

	// Execute
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
			throw new Error(`Anthropic HTTP ${res.status}: ${errText}`);
		}
		const json: any = await res.json();
		const text = (json.content || [])
			.filter((b: any) => b.type === 'text')
			.map((b: any) => b.text)
			.join('');
		const thinking = (json.content || [])
			.filter((b: any) => b.type === 'thinking')
			.map((b: any) => b.thinking)
			.join('');
		return {
			text,
			thinking: thinking || undefined,
			model: json.model,
			provider: config.isOAuth ? 'claudeCode' : 'anthropic',
			stopReason: json.stop_reason,
			usage: json.usage || {},
			raw: json,
		};
	} catch (e) {
		clearTimeout(tid);
		if (e instanceof Error && e.name === 'AbortError')
			throw new Error(`Anthropic timeout after ${req.timeout}ms`);
		throw e;
	}
}
