/* eslint-disable @typescript-eslint/no-explicit-any */

import type { OutputSchema, ParseResult } from './types';

export function parseOutput(
	raw: string,
	format: 'text' | 'json' | 'structured',
	schema?: OutputSchema,
): ParseResult {
	if (format === 'text') {
		return { success: true, text: raw };
	}

	const jsonResult = extractJson(raw);
	if (!jsonResult.success) return jsonResult;

	if (format === 'structured' && schema) {
		const errors = validateSchema(jsonResult.data, schema);
		if (errors.length > 0) {
			return {
				success: false,
				data: jsonResult.data,
				error: `Schema validation failed: ${errors.join('; ')}`,
			};
		}
	}

	return jsonResult;
}

function extractJson(raw: string): ParseResult {
	let text = raw.trim();

	if (text.startsWith('```json')) text = text.slice(7);
	else if (text.startsWith('```')) text = text.slice(3);
	if (text.endsWith('```')) text = text.slice(0, -3);
	text = text.trim();

	if (!text.startsWith('{') && !text.startsWith('[')) {
		const idx = text.indexOf('{');
		if (idx !== -1) text = text.substring(idx);
	}

	const isArray = text.startsWith('[');
	const closingChar = isArray ? ']' : '}';
	if (!text.endsWith(closingChar)) {
		const lastClose = text.lastIndexOf(closingChar);
		if (lastClose !== -1) text = text.substring(0, lastClose + 1);
	}
	text = text.trim();

	try {
		const data = JSON.parse(text);
		return { success: true, data };
	} catch (e) {
		return {
			success: false,
			error: `JSON parse error: ${(e as Error).message} (first 200 chars: ${text.substring(0, 200)})`,
		};
	}
}

function validateSchema(data: any, schema: OutputSchema): string[] {
	const errors: string[] = [];
	if (!data || typeof data !== 'object') {
		errors.push('Response is not an object');
		return errors;
	}

	if (schema.required) {
		for (const field of schema.required) {
			if (!(field in data)) errors.push(`Missing required field: ${field}`);
		}
	}

	if (schema.properties) {
		for (const [key, propSchema] of Object.entries(schema.properties)) {
			if (!(key in data)) continue;
			const value = data[key];
			const expectedType = (propSchema as any).type;

			if (expectedType === 'string' && typeof value !== 'string')
				errors.push(`'${key}' should be string, got ${typeof value}`);
			else if (expectedType === 'number' && typeof value !== 'number')
				errors.push(`'${key}' should be number, got ${typeof value}`);
			else if (
				expectedType === 'integer' &&
				(typeof value !== 'number' || !Number.isInteger(value))
			)
				errors.push(`'${key}' should be integer`);
			else if (expectedType === 'boolean' && typeof value !== 'boolean')
				errors.push(`'${key}' should be boolean, got ${typeof value}`);
			else if (expectedType === 'array' && !Array.isArray(value))
				errors.push(`'${key}' should be array, got ${typeof value}`);

			if ((propSchema as any).enum && !((propSchema as any).enum as any[]).includes(value)) {
				errors.push(`'${key}' must be one of: ${(propSchema as any).enum.join(', ')}`);
			}
		}
	}

	return errors;
}
