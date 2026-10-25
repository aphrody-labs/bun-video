const fs = require('node:fs');

const wrongDistFileExists = await Bun.file('dist/index.js', 'utf-8').exists();
if (wrongDistFileExists) {
	throw new Error('Wrong dist file exists');
}

const wrongDistFileExists2 = await Bun.file('dist/index.mjs', 'utf-8').exists();
if (wrongDistFileExists2) {
	throw new Error('Wrong dist file exists');
}
