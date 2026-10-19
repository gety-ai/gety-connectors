// Prefixed one-line logs and a progress heartbeat.
//
// The host forwards console output as log frames, and any frame resets its
// 10-minute idle timer. `progress` is the heartbeat: call it at real progress
// points (a request, a page, a file finished), never from a timer. A timer
// would keep a stuck request looking alive and defeat the host's hang
// detection; per-request timeouts (`abort.withTimeout`) bound the gaps
// between progress points instead. Never log config values.

export type LogDetails = Record<string, string | number | boolean | undefined>;

export interface Logger {
	info(message: string, details?: LogDetails): void;
	warn(message: string, details?: LogDetails): void;
	/** `warn`, at most once per `key` for the logger's lifetime. */
	warnOnce(key: string, message: string, details?: LogDetails): void;
	/**
	 * `info` at a real progress point, skipped when the logger wrote any line
	 * less than `progressIntervalMs` ago.
	 */
	progress(message: string, details?: LogDetails): void;
}

export const DEFAULT_PROGRESS_INTERVAL_MS = 60_000;

/**
 * A logger writing `[prefix] message (key=value, ...)` through
 * `console.info`/`console.warn`. Undefined details are omitted; strings that
 * are empty or contain whitespace, quotes, `,`, `=` or parentheses are
 * JSON-quoted.
 */
export function createLogger(
	prefix: string,
	options: { progressIntervalMs?: number; now?: () => number } = {},
): Logger {
	const interval = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
	const now = options.now ?? Date.now;
	const warned = new Set<string>();
	let lastLineAt = -Infinity;

	const write = (
		level: 'info' | 'warn',
		message: string,
		details: LogDetails | undefined,
	) => {
		lastLineAt = now();
		const line = `[${prefix}] ${message}${formatDetails(details)}`;
		if (level === 'warn') {
			console.warn(line);
		} else {
			console.info(line);
		}
	};

	return {
		info: (message, details) => write('info', message, details),
		warn: (message, details) => write('warn', message, details),
		warnOnce: (key, message, details) => {
			if (!warned.has(key)) {
				warned.add(key);
				write('warn', message, details);
			}
		},
		progress: (message, details) => {
			if (now() - lastLineAt >= interval) {
				write('info', message, details);
			}
		},
	};
}

function formatDetails(details: LogDetails | undefined): string {
	if (details === undefined) {
		return '';
	}
	const parts: string[] = [];
	for (const [key, value] of Object.entries(details)) {
		if (value === undefined) {
			continue;
		}
		const text = typeof value === 'string' &&
				(value === '' || /[\s"',=()]/.test(value))
			? JSON.stringify(value)
			: String(value);
		parts.push(`${key}=${text}`);
	}
	return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}
