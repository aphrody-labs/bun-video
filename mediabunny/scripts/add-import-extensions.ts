import * as fs from 'node:fs';
import * as path from 'node:path';

// .js extensions are technically required in compliant ECMAScript, and Webpack needs them, so we add them here.

const walkDir = (dir: string) => {
	const files: string[] = [];
	const items = fs.readdirSync(dir);

	for (const item of items) {
		const fullPath = path.join(dir, item);
		const stat = fs.statSync(fullPath);

		if (stat.isDirectory()) {
			files.push(...walkDir(fullPath));
		} else if (item.endsWith('.js')) {
			files.push(fullPath);
		}
	}

	return files;
};

const fixFile = (filePath: string) => {
	const content = await Bun.file(filePath).text();
	const fixed = content.replace(
		/(\s+from\s+['"])([^'"]*)(['"])/g,
		'$1$2.js$3',
	);

	if (content !== fixed) {
		await Bun.write(filePath, fixed);
	}
};

const jsFiles = walkDir('dist');
jsFiles.forEach(fixFile);
