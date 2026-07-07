/**
 * ESLint config for n8n custom node packages.
 *
 * To activate after pulling the repo:
 *   npm install --save-dev eslint@^8 @typescript-eslint/parser @typescript-eslint/eslint-plugin eslint-plugin-n8n-nodes-base
 *   npm run lint:eslint
 *
 * The base ruleset (`eslint-plugin-n8n-nodes-base`) enforces the same
 * conventions used by official n8n nodes — naming, displayName casing,
 * description style, required fields, etc.
 */
module.exports = {
	root: true,
	env: { node: true, es2022: true },
	parser: '@typescript-eslint/parser',
	parserOptions: {
		ecmaVersion: 2022,
		sourceType: 'module',
		project: ['./tsconfig.json'],
	},
	plugins: ['@typescript-eslint', 'n8n-nodes-base'],
	extends: [
		'eslint:recommended',
		'plugin:@typescript-eslint/recommended',
		'plugin:n8n-nodes-base/community',
		'plugin:n8n-nodes-base/credentials',
		'plugin:n8n-nodes-base/nodes',
	],
	ignorePatterns: ['dist/', 'node_modules/', '*.js'],
	rules: {
		'@typescript-eslint/no-explicit-any': 'off',
		'@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
		'@typescript-eslint/no-non-null-assertion': 'warn',
		'no-console': ['warn', { allow: ['warn', 'error'] }],
	},
	overrides: [
		{
			files: ['src/credentials/*.ts'],
			rules: {
				'n8n-nodes-base/cred-class-field-documentation-url-missing': 'off',
			},
		},
	],
};
