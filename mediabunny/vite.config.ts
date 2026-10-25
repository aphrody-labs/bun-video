import { defineConfig } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import tailwindcss from '@tailwindcss/vite';

const examplesDir = path.resolve(__dirname, './examples');

const exampleFolders = fs
	.readdirSync(examplesDir, { withFileTypes: true })
	.filter(dirent => dirent.isDirectory())
	.map(dirent => dirent.name);

const rollupInput = Object.fromEntries(
	exampleFolders.map(folderName => [
		folderName,
		path.resolve(examplesDir, folderName, 'index.html'),
	]),
);

export default defineConfig({
	resolve: {
		alias: {
			mediabunny: path.resolve(__dirname, './dist/bundles/mediabunny.mjs'),
		},
	},
	plugins: [
		tailwindcss(),
	],
	server: {
		hmr: false,
	},
	build: {
		outDir: 'dist-docs', // Build them directly into the docs build folder
		emptyOutDir: false,
		rollupOptions: {
			input: rollupInput,
		},
		minify: false,
	},
});
