import { defineConfig } from '@vscode/test-cli';

export default defineConfig([
	{
		label: 'unit',
		files: 'out-test/test/unit/**/*.test.js'
	},
	{
		label: 'integration',
		files: 'out-test/test/integration/**/*.test.js',
		workspaceFolder: 'test-fixtures',
		mocha: {
			timeout: 60000
		}
	}
]);
