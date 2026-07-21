import { describe, it, expect } from 'vitest';
import { AIMessage, ToolMessage, HumanMessage } from '@langchain/core/messages';
import { runToolsAgent } from '../src/nodes/AgentPro/toolsAgent';

const b64 = (s: string) => Buffer.from(s).toString('base64');

// Mock LangChain chat model: bindTools returns a runnable whose invoke pops the
// next scripted response (an AIMessage, or an Error to throw). Records the
// messages seen on each invoke so tests can assert what was sent.
class MockModel {
	responses: any[];
	i = 0;
	seen: any[][] = [];
	boundKwargs: any;
	constructor(responses: any[]) {
		this.responses = responses;
	}
	bindTools(_tools: any[], kwargs?: any) {
		this.boundKwargs = kwargs;
		return this;
	}
	async invoke(messages: any[]) {
		this.seen.push(messages.slice());
		const r = this.responses[this.i++];
		if (r instanceof Error) throw r;
		return r;
	}
}

const tool = (name: string, fn: (args: any) => any) => ({
	name,
	invoke: async (args: any) => fn(args),
});

const base = {
	tools: [] as any[],
	systemPrompt: 'SYS',
	userMessage: 'do it',
	docs: [],
	history: [],
	maxIterations: 6,
	providerTag: 'anthropic',
};

describe('runToolsAgent loop', () => {
	it('returns final text when the model stops calling tools', async () => {
		const model = new MockModel([new AIMessage('all done')]);
		const res = await runToolsAgent({ ...base, model } as any);
		expect(res.text).toBe('all done');
	});

	it('feeds a text tool result back as a ToolMessage', async () => {
		const model = new MockModel([
			new AIMessage({ content: '', tool_calls: [{ name: 'weather', args: { city: 'LA' }, id: 't1', type: 'tool_call' }] }),
			new AIMessage('it is sunny'),
		]);
		const res = await runToolsAgent({ ...base, model, tools: [tool('weather', () => 'sunny')] } as any);
		expect(res.text).toBe('it is sunny');
		const secondInvokeMsgs = model.seen[1];
		const tm = secondInvokeMsgs.find((m: any) => m instanceof ToolMessage);
		expect(tm.content).toBe('sunny');
		expect(tm.tool_call_id).toBe('t1');
	});

	it('injects a fetched PDF as a document block on the next turn', async () => {
		const model = new MockModel([
			new AIMessage({ content: '', tool_calls: [{ name: 'fetch', args: { id: 'a' }, id: 't1', type: 'tool_call' }] }),
			new AIMessage('order 292097'),
		]);
		const doc = { __agentProDocument: true, mediaType: 'application/pdf', fileName: 'ref.pdf', data: b64('pdf') };
		const res = await runToolsAgent({ ...base, model, tools: [tool('fetch', () => doc)] } as any);
		expect(res.text).toBe('order 292097');
		const msgs = model.seen[1];
		const ack = msgs.find((m: any) => m instanceof ToolMessage);
		expect(ack.content).toMatch(/visual attachment/i);
		const injected = msgs.find(
			(m: any) => m instanceof HumanMessage && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'document'),
		);
		expect(injected).toBeTruthy();
	});

	it('injects a fetched image as an image_url block', async () => {
		const model = new MockModel([
			new AIMessage({ content: '', tool_calls: [{ name: 'fetch', args: {}, id: 't1', type: 'tool_call' }] }),
			new AIMessage('read the png'),
		]);
		const doc = { __agentProDocument: true, mediaType: 'image/png', fileName: 'x.png', data: b64('img') };
		await runToolsAgent({ ...base, model, tools: [tool('fetch', () => doc)] } as any);
		const msgs = model.seen[1];
		const injected = msgs.find(
			(m: any) => m instanceof HumanMessage && Array.isArray(m.content) && m.content.some((b: any) => b.type === 'image_url'),
		);
		expect(injected).toBeTruthy();
	});

	it('rejects an oversize document gracefully and continues', async () => {
		const big = 'A'.repeat(Math.ceil((20 * 1024 * 1024 + 8) * 4) / 3);
		const model = new MockModel([
			new AIMessage({ content: '', tool_calls: [{ name: 'fetch', args: {}, id: 't1', type: 'tool_call' }] }),
			new AIMessage('proceeded without it'),
		]);
		const doc = { __agentProDocument: true, mediaType: 'application/pdf', fileName: 'huge.pdf', data: big };
		const res = await runToolsAgent({ ...base, model, tools: [tool('fetch', () => doc)] } as any);
		expect(res.text).toBe('proceeded without it');
		const msgs = model.seen[1];
		const tm = msgs.find((m: any) => m instanceof ToolMessage);
		expect(tm.content).toMatch(/too large/i);
		expect(msgs.some((m: any) => m instanceof HumanMessage && Array.isArray(m.content))).toBe(false);
	});

	it('handles a post-injection document API error by dropping the doc and re-invoking, WITHOUT burning the fallback', async () => {
		const model = new MockModel([
			new AIMessage({ content: '', tool_calls: [{ name: 'fetch', args: {}, id: 't1', type: 'tool_call' }] }),
			new Error('Anthropic HTTP 400: document has too many pages'),
			new AIMessage('used available proofs'),
		]);
		// A fallback IS connected; a document error must NOT route to it.
		const fallback = new MockModel([new AIMessage('SHOULD NOT BE CALLED')]);
		const doc = { __agentProDocument: true, mediaType: 'application/pdf', fileName: 'big.pdf', data: b64('x') };
		const res = await runToolsAgent({ ...base, model, fallbackModel: fallback, tools: [tool('fetch', () => doc)] } as any);
		expect(res.text).toBe('used available proofs');
		expect(fallback.i).toBe(0); // guards the fallback-routing fix: document errors bypass the fallback
		const retryMsgs = model.seen[2];
		const note = retryMsgs.filter((m: any) => m instanceof HumanMessage).pop();
		expect(typeof note.content === 'string' ? note.content : JSON.stringify(note.content)).toMatch(/could not be loaded|not be loaded/i);
	});

	it('switches to the fallback model when the primary invoke throws', async () => {
		const primary = new MockModel([new Error('primary down')]);
		const fallback = new MockModel([new AIMessage('answered by fallback')]);
		const res = await runToolsAgent({ ...base, model: primary, fallbackModel: fallback } as any);
		expect(res.text).toBe('answered by fallback');
	});

	it('answers every tool_call with a matching tool_call_id', async () => {
		const model = new MockModel([
			new AIMessage({ content: '', tool_calls: [
				{ name: 'a', args: {}, id: 't1', type: 'tool_call' },
				{ name: 'b', args: {}, id: 't2', type: 'tool_call' },
			] }),
			new AIMessage('done'),
		]);
		await runToolsAgent({ ...base, model, tools: [tool('a', () => 'ra'), tool('b', () => 'rb')] } as any);
		const ids = model.seen[1].filter((m: any) => m instanceof ToolMessage).map((m: any) => m.tool_call_id).sort();
		expect(ids).toEqual(['t1', 't2']);
	});

	it('throws a clear error when the model has no bindTools', async () => {
		await expect(runToolsAgent({ ...base, model: {} } as any)).rejects.toThrow(/tool calling/i);
	});

	it('returns a sentinel when maxIterations is exhausted mid-tool-use', async () => {
		const tc = () =>
			new AIMessage({ content: '', tool_calls: [{ name: 'loop', args: {}, id: 't', type: 'tool_call' }] });
		const model = new MockModel([tc(), tc(), tc(), tc()]);
		const res = await runToolsAgent({
			...base,
			model,
			tools: [tool('loop', () => 'again')],
			maxIterations: 2,
		} as any);
		expect(res.text).toMatch(/stopped after 2 iteration/i);
	});

	it('renders the catalog into the user message and caches the system prompt on Anthropic', async () => {
		const model = new MockModel([new AIMessage('ok')]);
		await runToolsAgent({
			...base,
			model,
			documentCatalog: JSON.stringify([
				{ id: 'att_1', name: 'ref.pdf', role_hint: 'reprint reference' },
			]),
			promptCaching: true,
			cacheSystem: true,
			cacheSystemTtl: '5m',
		} as any);
		const msgs = model.seen[0];
		const sys = msgs[0];
		expect(Array.isArray(sys.content)).toBe(true);
		expect((sys.content as any[])[0].cache_control).toEqual({ type: 'ephemeral' });
		const human = msgs[msgs.length - 1];
		const humanText = Array.isArray(human.content)
			? (human.content as any[]).map((b) => b.text || '').join(' ')
			: (human.content as string);
		expect(humanText).toMatch(/att_1/);
		expect(humanText).toMatch(/ref\.pdf/);
	});

	it('de-dupes the same document fetched twice within a run', async () => {
		const doc = {
			__agentProDocument: true,
			mediaType: 'application/pdf',
			fileName: 'ref.pdf',
			data: b64('x'),
		};
		const model = new MockModel([
			new AIMessage({ content: '', tool_calls: [{ name: 'fetch', args: {}, id: 't1', type: 'tool_call' }] }),
			new AIMessage({ content: '', tool_calls: [{ name: 'fetch', args: {}, id: 't2', type: 'tool_call' }] }),
			new AIMessage('done'),
		]);
		await runToolsAgent({ ...base, model, tools: [tool('fetch', () => doc)] } as any);
		const toolMsgs = model.seen[2].filter((m: any) => m instanceof ToolMessage);
		expect(toolMsgs.some((m: any) => /already fetched/i.test(m.content))).toBe(true);
	});
});
