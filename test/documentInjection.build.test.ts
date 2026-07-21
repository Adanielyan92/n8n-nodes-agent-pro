import { describe, it, expect } from 'vitest';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
	buildDocumentBlock,
	buildInjectionMessage,
	renderCatalog,
	buildToolsSystemMessage,
} from '../src/nodes/AgentPro/documentInjection';

describe('buildDocumentBlock', () => {
	it('emits an image_url block for images (any provider)', () => {
		const b = buildDocumentBlock({ mediaType: 'image/png', fileName: 'x.png', data: 'AAA' }, false);
		expect(b.type).toBe('image_url');
		expect(b.image_url.url).toBe('data:image/png;base64,AAA');
	});
	it('emits an Anthropic document block for PDFs on Anthropic', () => {
		const b = buildDocumentBlock({ mediaType: 'application/pdf', fileName: 'r.pdf', data: 'BBB' }, true);
		expect(b.type).toBe('document');
		expect(b.source).toEqual({ type: 'base64', media_type: 'application/pdf', data: 'BBB' });
	});
	it('emits a text marker for PDFs on non-Anthropic', () => {
		const b = buildDocumentBlock({ mediaType: 'application/pdf', fileName: 'r.pdf', data: 'BBB' }, false);
		expect(b.type).toBe('text');
		expect(b.text).toMatch(/r\.pdf/);
	});
});

describe('buildInjectionMessage', () => {
	it('builds one HumanMessage with intro text + block per document', () => {
		const msg = buildInjectionMessage(
			[{ mediaType: 'application/pdf', fileName: 'ref.pdf', data: 'BBB', note: 'reprint reference' }],
			true,
		);
		expect(msg).toBeInstanceOf(HumanMessage);
		const content = msg.content as any[];
		expect(content[0].type).toBe('text');
		expect(content[0].text).toMatch(/ref\.pdf/);
		expect(content[0].text).toMatch(/reprint reference/);
		expect(content[1].type).toBe('document');
	});
});

describe('renderCatalog', () => {
	it('renders a JSON-string catalog into a compact list', () => {
		const out = renderCatalog(
			JSON.stringify([
				{ id: 'att_1', name: '292097_Proof_Reprint.pdf', role_hint: 'reprint reference', pages: 1, bytes: 143893 },
			]),
		);
		expect(out).toMatch(/id=att_1/);
		expect(out).toMatch(/292097_Proof_Reprint\.pdf/);
		expect(out).toMatch(/reprint reference/);
	});
	it('returns null for empty/invalid input', () => {
		expect(renderCatalog('')).toBeNull();
		expect(renderCatalog('not json')).toBeNull();
		expect(renderCatalog('[]')).toBeNull();
		expect(renderCatalog(undefined)).toBeNull();
	});
});

describe('buildToolsSystemMessage', () => {
	it('applies cache_control on Anthropic when caching is on', () => {
		const m = buildToolsSystemMessage('SYS', { cacheSystem: true, cacheSystemTtl: '1h' }, true);
		expect(m).toBeInstanceOf(SystemMessage);
		const c = m.content as any[];
		expect(c[0].text).toBe('SYS');
		expect(c[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
	});
	it('uses a plain string when caching off or non-Anthropic', () => {
		expect(typeof buildToolsSystemMessage('SYS', undefined, true).content).toBe('string');
		expect(typeof buildToolsSystemMessage('SYS', { cacheSystem: true, cacheSystemTtl: '5m' }, false).content).toBe('string');
	});
});
