import assert from 'node:assert/strict';
import {
	isRecord,
	nonEmptyString,
	parseJsonObject,
	stringValue,
} from './json.ts';

Deno.test('isRecord accepts plain objects only', () => {
	assert.equal(isRecord({}), true);
	assert.equal(isRecord({ a: 1 }), true);
	for (const value of [null, undefined, [], [1], 'a', 1, true]) {
		assert.equal(isRecord(value), false, JSON.stringify(value));
	}
});

Deno.test('stringValue keeps empty strings, nonEmptyString does not', () => {
	assert.equal(stringValue(''), '');
	assert.equal(stringValue('a'), 'a');
	assert.equal(stringValue(1), undefined);
	assert.equal(nonEmptyString(''), undefined);
	assert.equal(nonEmptyString(' '), ' ');
	assert.equal(nonEmptyString(null), undefined);
});

Deno.test('parseJsonObject returns objects and nothing else', () => {
	assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
	for (const text of ['[1]', 'null', '1', '"s"', '{bad', '']) {
		assert.equal(parseJsonObject(text), undefined, text);
	}
});
