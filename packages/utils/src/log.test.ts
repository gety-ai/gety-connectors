import assert from 'node:assert/strict';
import { createLogger } from './log.ts';

function captureConsole(body: () => void): { info: string[]; warn: string[] } {
	const captured = { info: [] as string[], warn: [] as string[] };
	const { info, warn } = console;
	console.info = (line: string) => captured.info.push(line);
	console.warn = (line: string) => captured.warn.push(line);
	try {
		body();
	} finally {
		console.info = info;
		console.warn = warn;
	}
	return captured;
}

Deno.test('lines carry the prefix and serialized details', () => {
	const out = captureConsole(() => {
		const log = createLogger('notion');
		log.info('sync started');
		log.info('page fetched', {
			pages: 3,
			title: 'Q3 plan',
			done: false,
			skipped: undefined,
			empty: '',
			tricky: 'a,b=c',
		});
		log.warn('slow', { ms: 1200 });
		log.info('no details', {});
	});
	assert.deepEqual(out.info, [
		'[notion] sync started',
		'[notion] page fetched (pages=3, title="Q3 plan", done=false, empty="", tricky="a,b=c")',
		'[notion] no details',
	]);
	assert.deepEqual(out.warn, ['[notion] slow (ms=1200)']);
});

Deno.test('warnOnce warns once per key', () => {
	const out = captureConsole(() => {
		const log = createLogger('feishu');
		log.warnOnce('wiki', 'wiki metadata unavailable');
		log.warnOnce('wiki', 'wiki metadata unavailable');
		log.warnOnce('drive', 'drive metadata unavailable');
	});
	assert.deepEqual(out.warn, [
		'[feishu] wiki metadata unavailable',
		'[feishu] drive metadata unavailable',
	]);
});

Deno.test('progress is throttled against the last line of any kind', () => {
	let now = 0;
	const out = captureConsole(() => {
		const log = createLogger('x', { progressIntervalMs: 100, now: () => now });
		log.progress('p0'); // first progress line is written
		now = 50;
		log.progress('p50'); // too soon
		now = 100;
		log.progress('p100'); // interval elapsed
		now = 150;
		log.info('i150'); // any line resets the interval
		now = 220;
		log.progress('p220'); // 70 ms after i150
		now = 250;
		log.progress('p250');
	});
	assert.deepEqual(out.info, ['[x] p0', '[x] p100', '[x] i150', '[x] p250']);
});

Deno.test('the default progress interval is one minute', () => {
	let now = 1_000_000;
	const out = captureConsole(() => {
		const log = createLogger('x', { now: () => now });
		log.progress('a');
		now += 59_999;
		log.progress('b');
		now += 1;
		log.progress('c');
	});
	assert.deepEqual(out.info, ['[x] a', '[x] c']);
});
