import assert from 'node:assert/strict';
import { sha256Hex } from './hash.ts';

Deno.test('sha256Hex matches the standard test vectors', async () => {
	assert.equal(
		await sha256Hex(''),
		'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
	);
	assert.equal(
		await sha256Hex('abc'),
		'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
	);
});

Deno.test('sha256Hex hashes strings as UTF-8, like the equivalent bytes', async () => {
	for (const text of ['abc', '飞书 📄']) {
		assert.equal(
			await sha256Hex(text),
			await sha256Hex(new TextEncoder().encode(text)),
		);
	}
	const view = new Uint8Array([0, 97, 98, 99, 0]).subarray(1, 4);
	assert.equal(await sha256Hex(view), await sha256Hex('abc'));
});
