import {expect, test} from 'bun:test';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workerPath = path.join(
	__dirname,
	'fixtures/browser-download-lock-worker.ts',
);

const runWorker = ({
	lockPath,
	eventsPath,
	name,
	releaseSignal,
}: {
	lockPath: string;
	eventsPath: string;
	name: string;
	releaseSignal: string | null;
}): Promise<void> => {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				workerPath,
				lockPath,
				eventsPath,
				name,
				...(releaseSignal === null ? [] : [releaseSignal]),
			],
			{stdio: 'inherit'},
		);

		child.on('error', reject);
		child.on('exit', (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`Browser download lock worker exited with ${code}`));
			}
		});
	});
};

const waitForEvent = async ({
	eventsPath,
	event,
}: {
	eventsPath: string;
	event: string;
}): Promise<void> => {
	for (let attempts = 0; attempts < 500; attempts++) {
		const events = (await Bun.file(eventsPath).exists())
			? await Bun.file(eventsPath).text()
			: '';
		if (events.includes(event)) {
			return;
		}

		await new Promise<void>((resolve) => {
			setTimeout(resolve, 10);
		});
	}

	throw new Error(`Timed out waiting for event: ${event}`);
};

test(
	'serializes browser downloads across processes',
	async () => {
		const temporaryDirectory = fs.mkdtempSync(
			path.join(os.tmpdir(), 'remotion-browser-lock-'),
		);
		const lockPath = path.join(temporaryDirectory, 'download.lock');
		const eventsPath = path.join(temporaryDirectory, 'events');
		const releaseSignal = path.join(temporaryDirectory, 'release');

		try {
			const firstWorker = runWorker({
				lockPath,
				eventsPath,
				name: 'first',
				releaseSignal,
			});
			await waitForEvent({eventsPath, event: 'first:acquired'});

			const secondWorker = runWorker({
				lockPath,
				eventsPath,
				name: 'second',
				releaseSignal: null,
			});
			await waitForEvent({eventsPath, event: 'second:attempting'});

			expect(await Bun.file(eventsPath).text()).not.toContain(
				'second:acquired',
			);

			await Bun.write(releaseSignal, '');
			await Promise.all([firstWorker, secondWorker]);

			expect(await Bun.file(eventsPath).text()).toContain('second:released');
			expect(await Bun.file(lockPath).exists()).toBe(false);
		} finally {
			fs.rmSync(temporaryDirectory, {recursive: true, force: true});
		}
	},
	{timeout: 10_000},
);
