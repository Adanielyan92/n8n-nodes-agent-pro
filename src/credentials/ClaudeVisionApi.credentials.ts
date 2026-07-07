import { ICredentialType, INodeProperties } from 'n8n-workflow';

export class ClaudeVisionApi implements ICredentialType {
	name = 'claudeVisionApi';
	displayName = 'Claude Vision API';
	// eslint-disable-next-line n8n-nodes-base/cred-class-field-documentation-url-miscased
	documentationUrl =
		'https://docs.anthropic.com/en/docs/claude-code/cli-reference#claude-setup-token';

	properties: INodeProperties[] = [
		{
			displayName: 'Auth Type',
			name: 'authType',
			type: 'options',
			options: [
				{
					name: 'Setup Token (OAuth / MAX Plan)',
					value: 'oauth',
				},
				{
					name: 'API Key (Pay-per-Use)',
					value: 'apiKey',
				},
			],
			default: 'oauth',
			description:
				'Choose OAuth setup-token for Claude MAX plan credits, or API Key for standard billing',
		},
		{
			displayName: 'Setup Token',
			name: 'setupToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			displayOptions: {
				show: {
					authType: ['oauth'],
				},
			},
			description:
				'OAuth token from "claude setup-token" (sk-ant-oat01-*). Tokens expire every few hours.',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			displayOptions: {
				show: {
					authType: ['apiKey'],
				},
			},
			description: 'Anthropic API key (sk-ant-api03-*) from console.anthropic.com',
		},
	];

	authenticate = {
		type: 'generic' as const,
		properties: {
			headers: {
				'anthropic-version': '2023-06-01',
				'content-type': 'application/json',
				accept: 'application/json',
				'x-api-key': '={{$credentials.apiKey || ""}}',
				Authorization: '={{$credentials.setupToken ? "Bearer " + $credentials.setupToken : ""}}',
			},
		},
	};

	test = {
		request: {
			baseURL: 'https://api.anthropic.com',
			url: '/v1/models',
			method: 'GET' as const,
		},
	};
}
