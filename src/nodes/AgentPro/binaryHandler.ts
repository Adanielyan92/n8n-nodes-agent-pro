/* eslint-disable @typescript-eslint/no-explicit-any */

import type { IExecuteFunctions } from 'n8n-workflow';
import type { BinaryDoc, ModelConfig } from './types';

export async function collectBinaryDocs(
	ctx: IExecuteFunctions,
	itemIndex: number,
	includeAll: boolean,
	propertyNames: string[],
): Promise<BinaryDoc[]> {
	const docs: BinaryDoc[] = [];
	try {
		const items = ctx.getInputData();
		if (!items || items.length <= itemIndex) return docs;
		const item = items[itemIndex];
		if (!item.binary) return docs;

		for (const key of Object.keys(item.binary)) {
			if (!includeAll && !propertyNames.includes(key)) continue;
			const bin = item.binary[key];
			const mime = bin.mimeType || 'application/octet-stream';
			if (mime === 'application/pdf' || mime.startsWith('image/')) {
				let b64 = '';
				try {
					const buf = await ctx.helpers.getBinaryDataBuffer(itemIndex, key);
					b64 = buf.toString('base64');
				} catch {
					if (bin.data) b64 = bin.data;
				}
				if (b64) docs.push({ data: b64, mediaType: mime, fileName: bin.fileName || key });
			}
		}
	} catch {
		/* binary not available */
	}
	return docs;
}

export function formatDocsAnthropic(docs: BinaryDoc[]): any[] {
	const content: any[] = [];
	for (const doc of docs) {
		if (doc.mediaType === 'application/pdf') {
			content.push({
				type: 'document',
				source: { type: 'base64', media_type: 'application/pdf', data: doc.data },
			});
		} else if (doc.mediaType.startsWith('image/')) {
			content.push({
				type: 'image',
				source: { type: 'base64', media_type: doc.mediaType, data: doc.data },
			});
		}
	}
	return content;
}

export function formatDocsGemini(docs: BinaryDoc[]): any[] {
	const parts: any[] = [];
	for (const doc of docs) {
		if (doc.mediaType === 'application/pdf' || doc.mediaType.startsWith('image/')) {
			parts.push({ inline_data: { mime_type: doc.mediaType, data: doc.data } });
		}
	}
	return parts;
}

export function formatDocsOpenAI(docs: BinaryDoc[]): any[] {
	const parts: any[] = [];
	for (const doc of docs) {
		if (doc.mediaType === 'application/pdf') {
			parts.push({
				type: 'text',
				text: `[Attached PDF: ${doc.fileName} — ${Math.round(doc.data.length / 1024)}KB]`,
			});
		} else if (doc.mediaType.startsWith('image/')) {
			parts.push({
				type: 'image_url',
				image_url: { url: `data:${doc.mediaType};base64,${doc.data}` },
			});
		}
	}
	return parts;
}

export function formatDocsForProvider(docs: BinaryDoc[], config: ModelConfig): any[] {
	if (config.provider === 'anthropic') return formatDocsAnthropic(docs);
	if (config.provider === 'gemini') return formatDocsGemini(docs);
	return formatDocsOpenAI(docs);
}
