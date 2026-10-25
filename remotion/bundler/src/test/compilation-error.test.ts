import {expect, test} from 'bun:test';
import {formatCompilationError} from '../compilation-error';

test('forwards the actual module, loader identifier and compiler location', () => {
	expect(
		formatCompilationError({
			message: 'Named export version was not found',
			moduleName: './src/runtime.js',
			moduleIdentifier: 'loader!C:/project/src/runtime.js',
			loc: '12:4-18',
			details: 'Only the default export is available',
		}),
	).toBe(
		'Named export version was not found\nModule: ./src/runtime.js\nIdentifier: loader!C:/project/src/runtime.js\nLocation: 12:4-18\nOnly the default export is available',
	);
	expect(formatCompilationError({message: 'Compilation failed'})).toBe(
		'Compilation failed',
	);
	expect(formatCompilationError('Compiler string diagnostic')).toBe(
		'Compiler string diagnostic',
	);
});
