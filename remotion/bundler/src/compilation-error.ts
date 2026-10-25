export type CompilationErrorDetails = {
	message: string;
	moduleName?: string;
	moduleIdentifier?: string;
	loc?: string;
	details?: string;
};

/** Keep the failing module and location when compiler diagnostics are forwarded. */
export const formatCompilationError = (
	error: string | CompilationErrorDetails,
): string => {
	if (typeof error === 'string') return error;
	return [
		error.message,
		error.moduleName ? `Module: ${error.moduleName}` : null,
		error.moduleIdentifier ? `Identifier: ${error.moduleIdentifier}` : null,
		error.loc ? `Location: ${error.loc}` : null,
		error.details,
	]
		.filter(
			(value): value is string => typeof value === 'string' && value.length > 0,
		)
		.join('\n');
};
