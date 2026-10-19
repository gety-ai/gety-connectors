// Shared helpers for the repository scripts: connector discovery, JSON I/O
// and the package.json fields derived from each connector's manifest.json.

export const repoRoot = new URL('../', import.meta.url);
export const npmScope = '@gety-connectors';
export const repositoryUrl =
	'git+https://github.com/gety-ai/gety-connectors.git';
/** SPDX license of every published package (text in the root LICENSE). */
export const license = 'Apache-2.0';
export const catalogDir = new URL('packages/catalog/', repoRoot);

export interface Manifest {
	id: string;
	name: string;
	version: string;
	entry: string;
	icon?: string;
	description?: string;
	[key: string]: unknown;
}

export interface PackageJson {
	name: string;
	version: string;
	description?: string;
	license?: string;
	files?: string[];
	repository?: { type?: string; url?: string; directory?: string };
	publishConfig?: { access?: string };
	gety?: Manifest;
	[key: string]: unknown;
}

export interface Connector {
	/** Directory name under connectors/, also the npm package name suffix. */
	short: string;
	dir: URL;
	packageName: string;
}

export async function listConnectors(): Promise<Connector[]> {
	const root = new URL('connectors/', repoRoot);
	const connectors: Connector[] = [];
	for await (const entry of Deno.readDir(root)) {
		if (!entry.isDirectory) {
			continue;
		}
		const dir = new URL(`${entry.name}/`, root);
		if (!(await exists(new URL('manifest.json', dir)))) {
			continue;
		}
		connectors.push({
			short: entry.name,
			dir,
			packageName: `${npmScope}/${entry.name}`,
		});
	}
	return connectors.sort((a, b) => a.packageName.localeCompare(b.packageName));
}

export async function exists(path: URL): Promise<boolean> {
	try {
		await Deno.stat(path);
		return true;
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) {
			return false;
		}
		throw error;
	}
}

export async function readJson<T>(path: URL): Promise<T> {
	return JSON.parse(await Deno.readTextFile(path)) as T;
}

/** The repository's JSON style: tab indentation and a trailing newline. */
export function formatJson(value: unknown): string {
	return `${JSON.stringify(value, null, '\t')}\n`;
}

/** Files every connector package publishes: entry, its source map, icon, changelog. */
export function packageFiles(manifest: Manifest): string[] {
	const files = [manifest.entry, `${manifest.entry}.map`];
	if (manifest.icon) {
		files.push(manifest.icon);
	}
	files.push('CHANGELOG.md');
	return files.map((path) => path.replace(/^\.\//, ''));
}

export function oneLine(text: string | undefined): string {
	return (text ?? '').split(/\r?\n/)[0].trim();
}

/** Top-level `"version"` of a tab-indented manifest.json. */
const manifestVersionPattern = /^(\t"version"\s*:\s*")([^"]*)(")/m;

/**
 * Rewrites only the top-level version in manifest.json text, so the rest of
 * the file keeps its formatting.
 */
export function setManifestVersion(text: string, version: string): string {
	if (!manifestVersionPattern.test(text)) {
		throw new Error('manifest.json has no tab-indented top-level "version"');
	}
	return text.replace(manifestVersionPattern, `$1${version}$3`);
}

export function equalJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortKeys);
	}
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.keys(value).sort().map((key) => [
				key,
				sortKeys((value as Record<string, unknown>)[key]),
			]),
		);
	}
	return value;
}
