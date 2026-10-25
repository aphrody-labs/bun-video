import {expect, test} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {copyDir, directoryExists} from '../copy-dir';

test('public asset directories are detected and their real files reach the bundle', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'remotion-public-folder-'));
	const cleanupDirectory = resolve(directory);
	if (
		dirname(cleanupDirectory) !== resolve(tmpdir()) ||
		!basename(cleanupDirectory).startsWith('remotion-public-folder-')
	) {
		throw new Error('Unexpected temporary test directory');
	}
	try {
		const source = join(directory, 'public');
		const asset = join(source, 'media.bin');
		await Bun.write(asset, new Uint8Array([0, 1, 255, 42]));
		expect(await directoryExists(source)).toBe(true);
		expect(await directoryExists(asset)).toBe(false);
		expect(await directoryExists(join(directory, 'missing'))).toBe(false);
		const target = join(directory, 'bundle-public');
		const copied = await copyDir({
			src: source,
			dest: target,
			onSymlinkDetected() {},
			onProgress() {},
			copiedBytes: 0,
			lastReportedProgress: 0,
		});
		expect(copied).toBe(4);
		expect(
			new Uint8Array(await Bun.file(join(target, 'media.bin')).arrayBuffer()),
		).toEqual(new Uint8Array([0, 1, 255, 42]));
	} finally {
		await rm(cleanupDirectory, {recursive: true, force: true});
	}
});
