// Narrowing for untrusted JSON (API responses, log lines, CLI output).

/** A plain JSON object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `value` when it is a string, including the empty string. */
export function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

/** `value` when it is a non-empty string. */
export function nonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

/** `text` parsed as a JSON object; undefined for invalid JSON or non-objects. */
export function parseJsonObject(
	text: string,
): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(text);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}
