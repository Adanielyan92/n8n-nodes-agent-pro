import { describe, it, expect } from 'vitest';
import {
	detectDocumentPayload,
	decodedByteLength,
	createFetchState,
	guardrailReject,
	recordFetch,
	isDocumentError,
	MAX_DOC_BYTES,
} from '../src/nodes/AgentPro/documentInjection';

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('detectDocumentPayload', () => {
	it('detects the marker object', () => {
		const doc = detectDocumentPayload({
			__agentProDocument: true,
			mediaType: 'application/pdf',
			fileName: 'ref.pdf',
			data: b64('hello'),
			note: 'reprint reference',
		});
		expect(doc).not.toBeNull();
		expect(doc!.fileName).toBe('ref.pdf');
		expect(doc!.note).toBe('reprint reference');
	});

	it('detects a marker returned as a JSON string', () => {
		const raw = JSON.stringify({
			__agentProDocument: true,
			mediaType: 'image/png',
			fileName: 'x.png',
			data: b64('img'),
		});
		const doc = detectDocumentPayload(raw);
		expect(doc?.mediaType).toBe('image/png');
	});

	it('detects a bare data: URI string', () => {
		const doc = detectDocumentPayload(`data:application/pdf;base64,${b64('pdfbytes')}`);
		expect(doc?.mediaType).toBe('application/pdf');
		expect(doc?.fileName).toBe('document');
	});

	it('rejects unknown media types and plain text', () => {
		expect(detectDocumentPayload('just a normal tool answer')).toBeNull();
		expect(
			detectDocumentPayload({ __agentProDocument: true, mediaType: 'text/plain', data: b64('x') }),
		).toBeNull();
		expect(detectDocumentPayload(null)).toBeNull();
		expect(detectDocumentPayload(42)).toBeNull();
	});
});

describe('guardrails', () => {
	it('computes decoded byte length', () => {
		expect(decodedByteLength(b64('hello'))).toBe(5);
		expect(decodedByteLength('')).toBe(0);
	});

	it('rejects oversize documents', () => {
		const big = 'A'.repeat(Math.ceil((MAX_DOC_BYTES + 1) * 4) / 3);
		const reason = guardrailReject(
			{ mediaType: 'application/pdf', fileName: 'huge.pdf', data: big },
			createFetchState(),
			3,
		);
		expect(reason).toMatch(/too large/i);
	});

	it('rejects duplicates and enforces the fetch cap', () => {
		const state = createFetchState();
		const doc = { mediaType: 'application/pdf', fileName: 'a.pdf', data: b64('a') };
		expect(guardrailReject(doc, state, 3)).toBeNull();
		recordFetch(doc, state);
		expect(guardrailReject(doc, state, 3)).toMatch(/already fetched/i);

		const state2 = createFetchState();
		recordFetch({ mediaType: 'application/pdf', fileName: 'p.pdf', data: b64('p') }, state2);
		recordFetch({ mediaType: 'application/pdf', fileName: 'q.pdf', data: b64('q') }, state2);
		expect(
			guardrailReject({ mediaType: 'application/pdf', fileName: 'r.pdf', data: b64('r') }, state2, 2),
		).toMatch(/fetch limit/i);
	});
});

describe('isDocumentError', () => {
	it('matches Anthropic page/size document errors', () => {
		expect(isDocumentError(new Error('Anthropic HTTP 400: document has too many pages'))).toBe(true);
		expect(isDocumentError(new Error('the document is too large'))).toBe(true);
		expect(isDocumentError(new Error('invalid document source'))).toBe(true);
	});
	it('does not match generic transport errors', () => {
		expect(isDocumentError(new Error('ETIMEDOUT'))).toBe(false);
		expect(isDocumentError(new Error('HTTP 500 internal error'))).toBe(false);
	});
});
