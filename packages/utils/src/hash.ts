// Content digests. Do not use for document ids that are already derived
// another way (for example Chrome's sha1 ids): changing the hash changes ids.

const encoder = new TextEncoder();

/** Lowercase hex SHA-256 of `data` (strings are hashed as UTF-8). */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
	const bytes = typeof data === 'string' ? encoder.encode(data) : data;
	const digest = await crypto.subtle.digest(
		'SHA-256',
		bytes as Uint8Array<ArrayBuffer>,
	);
	return Array.from(
		new Uint8Array(digest),
		(byte) => byte.toString(16).padStart(2, '0'),
	).join('');
}
