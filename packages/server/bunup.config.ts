import { defineConfig } from 'bunup'

export default defineConfig([
	{
		name: 'main',
		entry: './src/index.ts',
		outDir: './dist',
		format: 'esm',
		dts: true,
		clean: true,
		splitting: false,
	},
	{
		name: 'cli',
		entry: './src/cli/index.ts',
		outDir: './dist/cli',
		format: 'esm',
		dts: false,
		clean: false,
		splitting: false,
	},
])
