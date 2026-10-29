import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = import.meta.dir;

const LICENSE_HEADER = `/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */`;

const missingFiles: string[] = [];

const checkFile = (filePath: string) => {
	const content = await Bun.file(filePath).text();
	if (!content.startsWith(LICENSE_HEADER)) {
		missingFiles.push(filePath);
	}
};

const checkDirectory = (dirPath: string) => {
	const entries = fs.readdirSync(dirPath, { withFileTypes: true });

	for (const entry of entries) {
		const fullPath = path.join(dirPath, entry.name);
		if (entry.isDirectory()) {
			checkDirectory(fullPath);
		} else if (entry.name.endsWith('.ts') || entry.name.endsWith('.c')) {
			checkFile(fullPath);
		}
	}
};

checkDirectory(path.join(__dirname, '..', 'src'));
checkDirectory(path.join(__dirname, '..', 'shared'));
checkDirectory(path.join(__dirname, '..', 'packages', 'mp3-encoder', 'src'));
checkDirectory(path.join(__dirname, '..', 'packages', 'ac3', 'src'));
checkDirectory(path.join(__dirname, '..', 'packages', 'dts', 'src'));
checkDirectory(path.join(__dirname, '..', 'packages', 'flac-encoder', 'src'));
checkDirectory(path.join(__dirname, '..', 'packages', 'aac-encoder', 'src'));
checkDirectory(path.join(__dirname, '..', 'packages', 'prores', 'src'));
checkDirectory(path.join(__dirname, '..', 'packages', 'server', 'src'));

if (missingFiles.length > 0) {
	console.error('Files missing license header:');
	missingFiles.forEach(file => console.error(`  ${file}`));
	process.exit(1);
}
