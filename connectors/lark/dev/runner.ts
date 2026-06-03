import { type DocUpdate, type PollResult } from '@gety-ai/connector-sdk';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type UpsertDoc = Extract<DocUpdate, { kind: 'upsert' }>['doc'];

interface Manifest {
	id: string;
	name?: string;
	version?: string;
	entry: string;
	config?: {
		fields?: ManifestConfigField[];
	};
}

interface ManifestConfigField {
	id: string;
	type: string;
	required?: boolean;
	default_value?: unknown;
}

interface RuntimeConnector {
	config: Record<string, unknown>;
	lastState: unknown;
	signal: AbortSignal;
	onLoad?(): void | Promise<void>;
	poll(): AsyncGenerator<PollResult, void, unknown>;
}

interface RunnerOptions {
	polls: number;
	intervalSeconds: number;
	resetState: boolean;
	statePath: string;
	outDir: string;
}

interface ConfigValueResult {
	id: string;
	type: string;
	envNames: string[];
	source: 'env' | 'default' | 'implicit_default';
	value?: unknown;
}

interface PollSummary {
	poll: number;
	results: number;
	updates: number;
	upserts: number;
	deletes: number;
	stateChanged: boolean;
}

const manifestPath = resolve('manifest.json');
const defaultStatePath = resolve('dev/.runner/state.json');
const defaultRunsDir = resolve('dev/runs');

if (import.meta.main) {
	await main();
}

async function main(): Promise<void> {
	const options = parseArgs(Deno.args);
	const manifest = await readJson<Manifest>(manifestPath);
	const configResults = resolveConfig(manifest.config?.fields ?? []);
	const config = buildConfig(configResults);
	const stateBefore = options.resetState
		? null
		: await readJsonIfExists(options.statePath);

	const runDir = await createRunDir(options.outDir);
	const docsDir = join(runDir, 'docs');
	await Deno.mkdir(docsDir, { recursive: true });

	const updates: DocUpdate[] = [];
	const deletes: string[] = [];
	const pollSummaries: PollSummary[] = [];
	let state = stateBefore;
	let docIndex = 0;

	for (let poll = 1; poll <= options.polls; poll += 1) {
		const beforePollState = state;
		const abortController = new AbortController();
		const connector = await loadConnector(manifest.entry, poll);

		connector.config = config;
		connector.lastState = state;
		connector.signal = abortController.signal;
		await connector.onLoad?.();

		let resultCount = 0;
		let pollUpdates = 0;
		let pollUpserts = 0;
		let pollDeletes = 0;

		for await (const result of connector.poll()) {
			resultCount += 1;
			if (result.state !== undefined) {
				state = result.state;
			}

			for (const update of result.updates) {
				updates.push(update);
				pollUpdates += 1;

				if (update.kind === 'upsert') {
					pollUpserts += 1;
					docIndex += 1;
					await writeDocSnapshot(docsDir, runDir, update.doc, docIndex);
				} else {
					pollDeletes += 1;
					deletes.push(update.id);
				}
			}
		}

		pollSummaries.push({
			poll,
			results: resultCount,
			updates: pollUpdates,
			upserts: pollUpserts,
			deletes: pollDeletes,
			stateChanged: JSON.stringify(beforePollState) !== JSON.stringify(state),
		});

		if (poll < options.polls && options.intervalSeconds > 0) {
			await delay(options.intervalSeconds * 1000);
		}
	}

	await writeJson(join(runDir, 'summary.json'), {
		manifest: {
			id: manifest.id,
			name: manifest.name,
			version: manifest.version,
			entry: manifest.entry,
		},
		config: configResults.map((result) => ({
			id: result.id,
			type: result.type,
			env_names: result.envNames,
			source: result.source,
		})),
		state_path: options.statePath,
		run_dir: runDir,
		polls: pollSummaries,
		totals: {
			updates: updates.length,
			upserts: updates.filter((update) => update.kind === 'upsert').length,
			deletes: deletes.length,
			doc_types: docTypeCounts(updates),
		},
	});
	await writeJson(join(runDir, 'state.before.json'), stateBefore);
	await writeJson(join(runDir, 'state.after.json'), state);
	await writeJson(join(runDir, 'updates.json'), updates);
	await writeJson(join(runDir, 'deletes.json'), deletes);
	await writeJson(options.statePath, state);

	console.log(`Connector run snapshot written to ${runDir}`);
	console.log(`Updates: ${updates.length}, deletes: ${deletes.length}`);
}

function parseArgs(args: string[]): RunnerOptions {
	if (args.includes('--help')) {
		console.log([
			'Usage: deno task runner -- [options]',
			'',
			'Options:',
			'  --reset-state          Ignore the persisted runner state for this run.',
			'  --polls <count>        Number of poll cycles to run. Defaults to 1.',
			'  --interval <seconds>   Delay between poll cycles. Defaults to 0.',
			'  --state <path>         State file path. Defaults to dev/.runner/state.json.',
			'  --out-dir <path>       Snapshot output directory. Defaults to dev/runs.',
		].join('\n'));
		Deno.exit(0);
	}

	const runnerArgs = args.filter((arg) => arg !== '--');
	const options: RunnerOptions = {
		polls: 1,
		intervalSeconds: 0,
		resetState: false,
		statePath: defaultStatePath,
		outDir: defaultRunsDir,
	};

	for (let index = 0; index < runnerArgs.length; index += 1) {
		const arg = runnerArgs[index];
		if (arg === '--reset-state') {
			options.resetState = true;
			continue;
		}

		const value = runnerArgs[index + 1];
		if (value == null) {
			throw new Error(`Missing value for ${arg}.`);
		}

		if (arg === '--polls') {
			options.polls = positiveInteger(value, arg);
		} else if (arg === '--interval') {
			options.intervalSeconds = nonNegativeNumber(value, arg);
		} else if (arg === '--state') {
			options.statePath = resolve(value);
		} else if (arg === '--out-dir') {
			options.outDir = resolve(value);
		} else {
			throw new Error(`Unknown runner argument ${arg}.`);
		}
		index += 1;
	}

	return options;
}

function resolveConfig(fields: ManifestConfigField[]): ConfigValueResult[] {
	return fields.map((field) => {
		const envNames = configEnvNames(field.id);
		const envValue = firstEnvValue(envNames);
		if (envValue != null) {
			return {
				id: field.id,
				type: field.type,
				envNames,
				source: 'env',
				value: parseConfigValue(field, envValue),
			};
		}

		if (field.default_value !== undefined) {
			return {
				id: field.id,
				type: field.type,
				envNames,
				source: 'default',
				value: normalizeDefaultValue(field),
			};
		}

		if (field.required === true) {
			throw new Error(
				`Missing required config field "${field.id}". Set ${
					envNames.join(' or ')
				} in .env.`,
			);
		}

		return {
			id: field.id,
			type: field.type,
			envNames,
			source: 'implicit_default',
			value: implicitDefaultValue(field),
		};
	});
}

function buildConfig(results: ConfigValueResult[]): Record<string, unknown> {
	const config: Record<string, unknown> = {};
	for (const result of results) {
		setNestedConfig(config, result.id, result.value);
	}
	return config;
}

async function loadConnector(
	entry: string,
	poll: number,
): Promise<RuntimeConnector> {
	const modulePath = resolve(entry);
	const moduleUrl = pathToFileURL(modulePath);
	moduleUrl.searchParams.set('runner_poll', String(poll));
	const module = await import(moduleUrl.href) as {
		default?: unknown;
	};
	if (typeof module.default !== 'function') {
		throw new Error(`Connector entry "${entry}" must export a default class.`);
	}

	const Connector = module.default as new () => RuntimeConnector;
	return new Connector();
}

async function writeDocSnapshot(
	docsDir: string,
	runDir: string,
	doc: UpsertDoc,
	index: number,
): Promise<void> {
	const base = `${String(index).padStart(4, '0')}-${
		safeFileName(
			[doc.doc_type, doc.id].filter(Boolean).join('__') || 'doc',
		)
	}`;
	const content = typeof doc.content === 'string' ? doc.content : null;
	let contentPath: string | null = null;

	if (content != null) {
		const extension = doc.content_format === 'markdown' ? 'md' : 'txt';
		contentPath = join(docsDir, `${base}.${extension}`);
		await Deno.writeTextFile(contentPath, content);
	}

	const { content: _content, ...docMetadata } = doc;
	await writeJson(join(docsDir, `${base}.json`), {
		...docMetadata,
		content_file: contentPath == null ? null : relative(runDir, contentPath),
	});
}

function configEnvNames(fieldId: string): string[] {
	const name = fieldId
		.replace(/[^0-9A-Za-z]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.toUpperCase();
	return [`GETY_CONFIG_${name}`, name];
}

function firstEnvValue(names: string[]): string | null {
	for (const name of names) {
		const value = Deno.env.get(name);
		if (value != null && value !== '') {
			return value;
		}
	}
	return null;
}

function parseConfigValue(field: ManifestConfigField, value: string): unknown {
	if (
		field.type === 'text' || field.type === 'password' ||
		field.type === 'dropdown' || field.type === 'directory'
	) {
		return value;
	}
	if (field.type === 'number') {
		const parsed = Number(value);
		if (!Number.isFinite(parsed)) {
			throw new Error(`Config field "${field.id}" must be a number.`);
		}
		return parsed;
	}
	if (field.type === 'checkbox') {
		return parseBoolean(value, field.id);
	}
	throw new Error(`Unsupported config field type "${field.type}".`);
}

function normalizeDefaultValue(field: ManifestConfigField): unknown {
	const value = field.default_value;
	if (typeof value === 'string') {
		return parseConfigValue(field, value);
	}
	if (field.type === 'checkbox' && typeof value === 'boolean') {
		return value;
	}
	if (
		field.type === 'number' && typeof value === 'number' &&
		Number.isFinite(value)
	) {
		return value;
	}
	if (
		(field.type === 'text' || field.type === 'password' ||
			field.type === 'dropdown' || field.type === 'directory') &&
		typeof value === 'string'
	) {
		return value;
	}
	throw new Error(
		`Default value for config field "${field.id}" has wrong type.`,
	);
}

function implicitDefaultValue(field: ManifestConfigField): unknown {
	if (field.type === 'checkbox') {
		return false;
	}
	if (field.type === 'number') {
		return 0;
	}
	if (
		field.type === 'text' || field.type === 'password' ||
		field.type === 'dropdown' || field.type === 'directory'
	) {
		return '';
	}
	throw new Error(`Unsupported config field type "${field.type}".`);
}

function parseBoolean(value: string, fieldId: string): boolean {
	const normalized = value.trim().toLowerCase();
	if (['1', 'true', 'yes', 'on'].includes(normalized)) {
		return true;
	}
	if (['0', 'false', 'no', 'off'].includes(normalized)) {
		return false;
	}
	throw new Error(`Config field "${fieldId}" must be a boolean.`);
}

function setNestedConfig(
	config: Record<string, unknown>,
	fieldId: string,
	value: unknown,
): void {
	const parts = fieldId.split('.');
	let target = config;
	for (const [index, part] of parts.entries()) {
		if (part === '') {
			throw new Error(`Invalid config field id "${fieldId}".`);
		}

		if (index === parts.length - 1) {
			target[part] = value;
			return;
		}

		const existing = target[part];
		if (!isRecord(existing)) {
			target[part] = {};
		}
		target = target[part] as Record<string, unknown>;
	}
}

function docTypeCounts(updates: DocUpdate[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const update of updates) {
		if (update.kind !== 'upsert') {
			continue;
		}
		const docType = update.doc.doc_type ?? 'unknown';
		counts[docType] = (counts[docType] ?? 0) + 1;
	}
	return counts;
}

function safeFileName(value: string): string {
	const safe = value.replace(/[^0-9A-Za-z._-]+/g, '_').replace(/^_+|_+$/g, '');
	return (safe || 'doc').slice(0, 140);
}

function positiveInteger(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer.`);
	}
	return parsed;
}

function nonNegativeNumber(value: string, name: string): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`${name} must be a non-negative number.`);
	}
	return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function createRunDir(outDir: string): Promise<string> {
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const runDir = join(outDir, timestamp);
	await Deno.mkdir(runDir, { recursive: true });
	return runDir;
}

async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await Deno.readTextFile(path)) as T;
}

async function readJsonIfExists(path: string): Promise<unknown> {
	try {
		return JSON.parse(await Deno.readTextFile(path)) as unknown;
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) {
			return null;
		}
		throw error;
	}
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await Deno.mkdir(dirname(path), { recursive: true });
	await Deno.writeTextFile(path, `${JSON.stringify(value, null, '\t')}\n`);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
