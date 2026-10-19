type LogValue = boolean | number | string | undefined;

export function logInfo(
	message: string,
	details: Record<string, LogValue> = {},
): void {
	const suffix = Object.entries(details)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${key}=${value}`)
		.join(', ');

	console.info(`[linear] ${message}${suffix === '' ? '' : ` (${suffix})`}`);
}

export function hasValue(value: unknown): boolean {
	return value != null && value !== '';
}
