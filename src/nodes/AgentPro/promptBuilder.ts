/* eslint-disable @typescript-eslint/no-explicit-any */

import type { OutputSchema, ChatMessage } from './types';

export interface PromptSections {
	role: string;
	rules: string;
	skills: string;
	context: string;
	outputInstructions: string;
	outputSchema?: OutputSchema;
}

export interface FewShotExample {
	input: string;
	output: string;
}

export function buildSystemPrompt(sections: PromptSections): string {
	const parts: string[] = [];

	if (sections.role.trim()) {
		parts.push(sections.role.trim());
	}

	if (sections.rules.trim()) {
		parts.push(
			'======================================================================\n' +
				'RULES\n' +
				'======================================================================\n\n' +
				sections.rules.trim(),
		);
	}

	if (sections.skills.trim()) {
		parts.push(
			'======================================================================\n' +
				'INSTRUCTIONS\n' +
				'======================================================================\n\n' +
				sections.skills.trim(),
		);
	}

	if (sections.context.trim()) {
		parts.push(
			'======================================================================\n' +
				'CONTEXT\n' +
				'======================================================================\n\n' +
				sections.context.trim(),
		);
	}

	if (sections.outputInstructions.trim() || sections.outputSchema) {
		let block =
			'======================================================================\n' +
			'OUTPUT FORMAT\n' +
			'======================================================================\n\n';

		if (sections.outputInstructions.trim()) {
			block += sections.outputInstructions.trim();
		}

		if (sections.outputSchema) {
			block +=
				'\n\nYou MUST respond with valid JSON matching this schema:\n```json\n' +
				JSON.stringify(sections.outputSchema, null, 2) +
				'\n```\n' +
				'Return ONLY the JSON object. No markdown fences. No explanatory text. ' +
				'The first character must be { and the last must be }.';
		}

		parts.push(block);
	}

	return parts.join('\n\n');
}

export function buildMessages(
	examples: FewShotExample[],
	history: ChatMessage[],
	userMessage: string,
): ChatMessage[] {
	const messages: ChatMessage[] = [];

	for (const ex of examples) {
		if (ex.input.trim() && ex.output.trim()) {
			messages.push({ role: 'user', content: ex.input });
			messages.push({ role: 'assistant', content: ex.output });
		}
	}

	for (const msg of history) {
		messages.push({ role: msg.role, content: msg.content });
	}

	messages.push({ role: 'user', content: userMessage });
	return messages;
}

export function buildAutoFixPrompt(
	originalResponse: unknown,
	parseError: string,
	schema?: OutputSchema,
): string {
	// originalResponse may arrive as a string (the normal case), an array of
	// content blocks (Anthropic via the tools agent), or even an object — any
	// non-string would previously crash with `.substring is not a function`.
	const responseText =
		typeof originalResponse === 'string'
			? originalResponse
			: (() => {
					try {
						return JSON.stringify(originalResponse);
					} catch {
						return String(originalResponse);
					}
				})();
	let prompt = `Your previous response could not be parsed as valid JSON.\n\nError: ${parseError}\n\n`;
	prompt += `Your response was:\n${responseText.substring(0, 2000)}\n\n`;
	prompt += 'Fix the JSON and return ONLY the corrected JSON object. ';
	prompt += 'No markdown fences, no explanation. First character must be { and last must be }.';
	if (schema) {
		prompt += `\n\nRequired schema:\n${JSON.stringify(schema, null, 2)}`;
	}
	return prompt;
}
