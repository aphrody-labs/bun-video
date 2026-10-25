const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');

const packageJson = JSON.parse(fs.readFileSync('package.json'));
const {version} = packageJson;
const src =
	`
// Automatically generated on publish

/**
 * @description Provides the current version number of the Remotion library.
 * @see [Documentation](https://remotion.dev/docs/version)
 * @returns {string} The current version of the remotion package
 */
export const VERSION = '${version}';
`.trim() + '\n';

await Bun.write(path.resolve(process.cwd(), 'src/version.ts'), src);

cp.execSync('bun run make');
cp.execSync('bun ../../../../../../scripts/aphrody/emit-typescript.ts -d');

const distFile = await Bun.file('dist/esm/version.mjs').text();

if (!distFile.includes(version)) {
	console.log('In dist file, did not include ' + JSON.stringify(version));
	process.exit(1);
}

const distFileCjs = await Bun.file('dist/cjs/version.js').text();

if (!distFileCjs.includes(version)) {
	console.log('In dist file, did not include ' + JSON.stringify(version));
	process.exit(1);
}

console.log('Updated version to v' + version);

const wrongDistFileExists = await Bun.file('dist/index.js', 'utf-8').exists();
if (wrongDistFileExists) {
	throw new Error('Wrong dist file exists');
}

const wrongDistFileExists2 = await Bun.file('dist/index.mjs', 'utf-8').exists();
if (wrongDistFileExists2) {
	throw new Error('Wrong dist file exists');
}
