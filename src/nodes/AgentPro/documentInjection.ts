/* eslint-disable @typescript-eslint/no-explicit-any */
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

export interface DocumentPayload {
	mediaType: string;
	fileName: string;
	data: string; // raw base64 (no data: prefix)
	note?: string;
}

// Raw-decoded ceiling. 20 MB decoded ≈ 27 MB base64, under Anthropic's
// 32 MB per-document cap. Files API (which would lift this) is deferred.
export const MAX_DOC_BYTES = 20 * 1024 * 1024;

const isSupportedMedia = (m: string): boolean =>
	m === 'application/pdf' || m.startsWith('image/');

function fromMarkerObject(o: any): DocumentPayload | null {
	if (
		o &&
		typeof o === 'object' &&
		o.__agentProDocument === true &&
		typeof o.data === 'string' &&
		typeof o.mediaType === 'string' &&
		isSupportedMedia(o.mediaType)
	) {
		return {
			mediaType: o.mediaType,
			fileName: typeof o.fileName === 'string' && o.fileName ? o.fileName : 'document',
			data: o.data,
			note: typeof o.note === 'string' ? o.note : undefined,
		};
	}
	return null;
}

/**
 * Recognize a document payload from a tool's return value. Supported:
 *   1. the `__agentProDocument` marker object (primary contract)
 *   2. that marker serialized as a JSON string
 *   3. a bare `data:<mime>;base64,<...>` URI string (best-effort)
 * Never throws; unrecognized input → null (treated as normal text).
 */
export function detectDocumentPayload(raw: any): DocumentPayload | null {
	if (raw && typeof raw === 'object') {
		const d = fromMarkerObject(raw);
		if (d) return d;
	}
	if (typeof raw === 'string') {
		const s = raw.trim();
		if (s.startsWith('{')) {
			try {
				const d = fromMarkerObject(JSON.parse(s));
				if (d) return d;
			} catch {
				/* not JSON */
			}
		}
		const m = /^data:([^;]+);base64,(.+)$/s.exec(s);
		if (m && isSupportedMedia(m[1])) {
			return { mediaType: m[1], fileName: 'document', data: m[2] };
		}
	}
	return null;
}

export function decodedByteLength(b64: string): number {
	const len = b64.length;
	if (len === 0) return 0;
	const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
	return Math.floor((len * 3) / 4) - pad;
}

export interface FetchState {
	count: number;
	seen: Set<string>;
}

export function createFetchState(): FetchState {
	return { count: 0, seen: new Set<string>() };
}

const keyOf = (doc: DocumentPayload): string => (doc.fileName || 'document').toLowerCase();

/**
 * Returns a human-readable rejection reason (→ becomes a tool-error the model
 * can act on) or null when the document is safe to inject. Order: de-dup,
 * fetch cap, byte cap.
 */
export function guardrailReject(
	doc: DocumentPayload,
	state: FetchState,
	maxFetches: number,
): string | null {
	if (state.seen.has(keyOf(doc))) {
		return `Already fetched "${doc.fileName}"; not re-loading it.`;
	}
	if (state.count >= maxFetches) {
		return `Fetch limit reached (${maxFetches} document(s) this run). Proceed with the proofs you already have.`;
	}
	const bytes = decodedByteLength(doc.data);
	if (bytes > MAX_DOC_BYTES) {
		const mb = (bytes / (1024 * 1024)).toFixed(1);
		return `Document "${doc.fileName}" is too large (${mb} MB) to load inline. Proceed with the available proofs, or request a smaller/paged reference.`;
	}
	return null;
}

export function recordFetch(doc: DocumentPayload, state: FetchState): void {
	state.count += 1;
	state.seen.add(keyOf(doc));
}

/**
 * True when an error thrown by model.invoke is an Anthropic document-rejection
 * (page/size/invalid). Deliberately narrow so genuine model/transport failures
 * still route to the fallback model.
 */
export function isDocumentError(err: unknown): boolean {
	const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
	return /too many pages|document[^.]*too large|too large[^.]*document|invalid[^.]*document|could not process (the )?(document|pdf)|unsupported document|page limit|exceeds[^.]*100 page/.test(
		msg,
	);
}

/**
 * Build a single provider-aware content block for a document/image. Reused for
 * both mid-loop injections and the initial attached-docs (BinaryDoc) message.
 */
export function buildDocumentBlock(
	doc: { mediaType: string; fileName: string; data: string },
	isAnthropic: boolean,
): any {
	if (doc.mediaType.startsWith('image/')) {
		return { type: 'image_url', image_url: { url: `data:${doc.mediaType};base64,${doc.data}` } };
	}
	// application/pdf
	if (isAnthropic) {
		return {
			type: 'document',
			source: { type: 'base64', media_type: 'application/pdf', data: doc.data },
		};
	}
	return {
		type: 'text',
		text: `[Fetched PDF: ${doc.fileName} — the connected model provider does not support inline PDFs, so it could not be shown visually.]`,
	};
}

/**
 * Build the follow-up user message that carries fetched documents into vision.
 * One intro text block + one media block per document.
 */
export function buildInjectionMessage(
	injections: DocumentPayload[],
	isAnthropic: boolean,
): HumanMessage {
	const content: any[] = [];
	for (const doc of injections) {
		const label = doc.note ? `${doc.fileName} (${doc.note})` : doc.fileName;
		content.push({
			type: 'text',
			text: `Fetched document: ${label}. Read it and use it for this task.`,
		});
		content.push(buildDocumentBlock(doc, isAnthropic));
	}
	return new HumanMessage({ content });
}

/**
 * Render a document catalog (array, or JSON string of an array) into a compact
 * text block for the user message. Returns null when empty/unparseable.
 */
export function renderCatalog(catalog: any): string | null {
	let arr: any = catalog;
	if (typeof catalog === 'string') {
		const s = catalog.trim();
		if (!s) return null;
		try {
			arr = JSON.parse(s);
		} catch {
			return null;
		}
	}
	if (!Array.isArray(arr) || arr.length === 0) return null;
	const lines = arr.map((d: any) => {
		const parts: string[] = [];
		if (d && d.id != null) parts.push(`id=${d.id}`);
		if (d && d.name != null) parts.push(`name=${d.name}`);
		if (d && d.role_hint != null) parts.push(`role=${d.role_hint}`);
		if (d && d.pages != null) parts.push(`pages=${d.pages}`);
		if (d && d.bytes != null) parts.push(`~${Math.round(Number(d.bytes) / 1024)}KB`);
		return `- ${parts.join('  ')}`;
	});
	return (
		'Fetchable documents (use the fetch tool only when the attached proofs are insufficient; ' +
		'fetch only what you need, and prefer the correct reprint/reference proof):\n' +
		lines.join('\n')
	);
}

export interface SystemCacheConfig {
	cacheSystem: boolean;
	cacheSystemTtl: '5m' | '1h';
}

/**
 * Build the system message for the tools loop, applying Anthropic prompt-cache
 * control when enabled (the old AgentExecutor tools path did NOT cache — this
 * restores the QC agent's caching once it gains a tool).
 */
export function buildToolsSystemMessage(
	system: string,
	cache: SystemCacheConfig | undefined,
	isAnthropic: boolean,
): SystemMessage {
	if (cache && cache.cacheSystem && isAnthropic) {
		const cc: any = { type: 'ephemeral' };
		if (cache.cacheSystemTtl === '1h') cc.ttl = '1h';
		return new SystemMessage({ content: [{ type: 'text', text: system, cache_control: cc }] });
	}
	return new SystemMessage(system);
}
