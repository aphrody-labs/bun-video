import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';

export const resolveFrom = (
	fromDirectory: string,
	moduleId: string,
): string => {
	try {
		fromDirectory = fs.realpathSync(fromDirectory);
	} catch (error) {
		if ((error as {code: string}).code === 'ENOENT') {
			fromDirectory = path.resolve(fromDirectory);
		} else {
			throw error;
		}
	}

	const fromFile = path.join(fromDirectory, 'noop.js');

	const resolveFileName = () =>
		// @ts-expect-error
		Module._resolveFilename(moduleId, {
			id: fromFile,
			filename: fromFile,
			// @ts-expect-error
			paths: Module._nodeModulePaths(fromDirectory),
		});

	return resolveFileName();
};
