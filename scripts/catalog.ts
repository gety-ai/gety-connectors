// Builds the @gety-connectors/catalog package, the list of official and
// community connectors that Gety's connector gallery reads in a single request:
// the `getyCatalog` field of the registry's
// `<registry>/@gety-connectors%2Fcatalog/latest` document.
//
// The release workflow runs this after publishing the connectors, and on every
// push to main with nothing to version or publish (the catalog job). Official
// entries: names, descriptions and icons come from the connector manifests at
// the checked-out commit; each connector's `version` is its registry
// `dist-tags.latest` and `publishedAt` the registry's publish time of that
// version. Community entries: one per registration file
// community/<manifest id>.json, which names an npm package, an exact version
// and the author's GitHub user name; name, description and icon come from that
// version's `gety` manifest and tarball, `publishedAt` from the packument, and
// the author's numeric id from the GitHub API. The catalog's own version is the
// published catalog's plus a patch; when the generated catalog equals the
// published one there is nothing to publish.
//
//   deno task catalog                print the package.json it would publish
//   deno task catalog --out <dir>    write the package to <dir> (a new
//                                    directory) for `npm publish <dir>`; when
//                                    nothing changed, <dir> is not created
//   --registry <url>                 registry to read (default npmjs.org)
//
// GITHUB_TOKEN, when set, authenticates the GitHub API requests: anonymous
// ones are limited to 60 an hour.

import { encodeBase64 } from '@std/encoding/base64';
import { UntarStream } from '@std/tar/untar-stream';
import { decode, type DecodedPng, encode, type ImageData } from 'fast-png';
import {
	catalogDir,
	type Connector,
	equalJson,
	formatJson,
	listConnectors,
	type Manifest,
	oneLine,
	type PackageJson,
	readJson,
	repoRoot,
} from './connectors.ts';

/** Raster icons larger than this (in either dimension) are downscaled. */
export const catalogIconSize = 128;
/** Upper bound for one icon's bytes after downscaling. */
const maxIconBytes = 24 * 1024;
/** Largest PNG width or height decoded (to downscale it). */
export const maxPngIconSize = 2048;
/** Version of the first catalog, published by hand (README, "First publish"). */
export const firstCatalogVersion = '0.1.0';
export const defaultRegistry = 'https://registry.npmjs.org/';
const githubApi = 'https://api.github.com/';
/** The community registrations, community/<manifest id>.json. */
export const communityDir = new URL('community/', repoRoot);

export interface CatalogEntry {
	package: string;
	name: string;
	description: string;
	icon: string;
	/** The registered version; installing from the catalog installs it. */
	version: string;
	publishedAt: string;
	/** Community entries name their author; official entries have none. */
	author?: CatalogAuthor;
}

export interface CatalogAuthor {
	/** GitHub user name, as registered. */
	github: string;
	/** The GitHub user's numeric id, which survives renames. */
	githubId: number;
}

export interface Catalog {
	official: CatalogEntry[];
	community: CatalogEntry[];
}

/** A connector's `dist-tags.latest` on npm and when it was published. */
export interface Release {
	version: string;
	publishedAt: string;
}

/** A community registration file: the whole of its content. */
interface Registration {
	package: string;
	version: string;
	author: { github: string };
}

/**
 * packages/catalog/package.json: the published package.json without `version`
 * and `getyCatalog`. It is `private` so that changesets neither versions nor
 * publishes it; the generated package drops the flag.
 */
export interface CatalogTemplate {
	name: string;
	private?: boolean;
	[key: string]: unknown;
}

export type CatalogPackageJson = PackageJson & { getyCatalog: Catalog };

/** The fields of the registry's `/latest` document of the catalog read here. */
export interface PublishedCatalog {
	version: string;
	getyCatalog?: unknown;
}

export interface RegistryOptions {
	/** Registry base URL, e.g. https://registry.npmjs.org/. */
	registry: string;
	/** Every request: the registry, tarballs and the GitHub API. */
	fetch?: (url: URL, init: RequestInit) => Promise<Response>;
	/** Reads of the connector packuments before failing; see latestReleases. */
	attempts?: number;
	/** Wait between two reads, in milliseconds. */
	retryDelayMs?: number;
}

export interface CatalogOptions extends RegistryOptions {
	/** Sent to the GitHub API, which limits anonymous requests. */
	githubToken?: string;
	/** Directory of the registrations: communityDir, or a test's own. */
	communityDir: URL;
}

export type CatalogBuild =
	| { changed: false; published: PublishedCatalog }
	| { changed: true; pkg: CatalogPackageJson };

export const catalogTemplatePath = new URL('package.json', catalogDir);

/**
 * Generates the catalog package from the connectors at the checked-out
 * commit, the community registrations and the registry, or reports that the
 * published catalog already matches.
 */
export async function buildCatalogPackage(
	options: CatalogOptions,
): Promise<CatalogBuild> {
	const connectors = await listConnectors();
	const catalog: Catalog = {
		official: await officialCatalog(
			connectors,
			await latestReleases(connectors, options),
		),
		community: await communityCatalog(options),
	};
	const template = await readJson<CatalogTemplate>(catalogTemplatePath);
	const document = await registryJson(
		options,
		`${registryPath(template.name)}/latest`,
	);
	let published: PublishedCatalog | undefined;
	if (document !== undefined) {
		const version = property(document, 'version');
		if (typeof version !== 'string') {
			throw new Error(`${template.name}: the registry's latest has no version`);
		}
		published = { version, getyCatalog: property(document, 'getyCatalog') };
	}
	const version = nextCatalogVersion(published, catalog);
	if (version === undefined) {
		// Only a published catalog can be equal to the generated one.
		return { changed: false, published: published! };
	}
	return { changed: true, pkg: catalogPackage(template, catalog, version) };
}

export async function officialCatalog(
	connectors: Connector[],
	releases: ReadonlyMap<string, Release>,
): Promise<CatalogEntry[]> {
	const entries: CatalogEntry[] = [];
	for (const connector of connectors) {
		const release = releases.get(connector.packageName);
		if (!release) {
			throw new Error(`${connector.packageName}: no npm release`);
		}
		entries.push({ ...(await catalogEntry(connector)), ...release });
	}
	return entries;
}

/**
 * The npm release of every connector. Its `dist-tags.latest` must be the
 * version in the connector's package.json at the checked-out commit: after a
 * successful publish run every connector is on npm at that version, and a
 * catalog must not list a connector Gety cannot install. Right after a
 * publish the registry's CDN may still serve the previous packument (it is
 * cached for up to five minutes), so a mismatch is read again for a while
 * before the build fails.
 */
export async function latestReleases(
	connectors: Connector[],
	options: RegistryOptions,
): Promise<Map<string, Release>> {
	const attempts = options.attempts ?? 25;
	const retryDelayMs = options.retryDelayMs ?? 15_000;
	const releases = new Map<string, Release>();
	let pending = connectors;
	for (let attempt = 1;; attempt++) {
		const problems: string[] = [];
		const unresolved: Connector[] = [];
		for (const connector of pending) {
			const release = await connectorRelease(connector, options);
			if (typeof release === 'string') {
				problems.push(`${connector.packageName}: ${release}`);
				unresolved.push(connector);
			} else {
				releases.set(connector.packageName, release);
			}
		}
		if (problems.length === 0) {
			return releases;
		}
		if (attempt >= attempts) {
			throw new Error(
				`the registry does not have every connector at its checked-out version; publish them first (README, "First publish"):\n  ${
					problems.join('\n  ')
				}`,
			);
		}
		console.error(
			`waiting for the registry (read ${attempt} of ${attempts}):\n  ${
				problems.join('\n  ')
			}`,
		);
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, retryDelayMs);
		await promise;
		pending = unresolved;
	}
}

/** The connector's release, or why the registry does not have it yet. */
async function connectorRelease(
	connector: Connector,
	options: RegistryOptions,
): Promise<Release | string> {
	const { version } = await readJson<PackageJson>(
		new URL('package.json', connector.dir),
	);
	const packument = await registryJson(
		options,
		registryPath(connector.packageName),
	);
	if (packument === undefined) {
		return `not on npm (package.json has ${version})`;
	}
	const latest = property(property(packument, 'dist-tags'), 'latest');
	if (latest !== version) {
		return `dist-tags.latest is ${
			latest ?? 'missing'
		}, package.json has ${version}`;
	}
	const time = property(property(packument, 'time'), version);
	if (typeof time !== 'string' || Number.isNaN(Date.parse(time))) {
		return `the packument has no publish time for ${version}`;
	}
	return { version, publishedAt: new Date(time).toISOString() };
}

/** `value[key]` when value is a JSON object, otherwise undefined. */
function property(value: unknown, key: string): unknown {
	return isObject(value) ? value[key] : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The version to publish the catalog at: the first version when none is
 * published, the published version plus a patch when the catalog changed, and
 * undefined when the published catalog already equals it.
 */
export function nextCatalogVersion(
	published: PublishedCatalog | undefined,
	catalog: Catalog,
): string | undefined {
	if (!published) {
		return firstCatalogVersion;
	}
	if (equalJson(published.getyCatalog, catalog)) {
		return undefined;
	}
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(published.version);
	if (!match) {
		throw new Error(
			`the published catalog version ${published.version} is not MAJOR.MINOR.PATCH`,
		);
	}
	return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function catalogPackage(
	template: CatalogTemplate,
	catalog: Catalog,
	version: string,
): CatalogPackageJson {
	const { name, private: _, ...metadata } = template;
	return { name, version, ...metadata, getyCatalog: catalog };
}

/**
 * Writes the package to a new directory: package.json, the catalog README and
 * the repository LICENSE (`npm publish` does not add the workspace one).
 */
export async function writeCatalogPackage(
	dir: string,
	pkg: CatalogPackageJson,
): Promise<void> {
	try {
		await Deno.mkdir(dir);
	} catch (error) {
		if (error instanceof Deno.errors.AlreadyExists) {
			throw new Error(`${dir} already exists; pass a new directory`);
		}
		throw error;
	}
	await Deno.writeTextFile(`${dir}/package.json`, formatJson(pkg));
	await Deno.copyFile(new URL('README.md', catalogDir), `${dir}/README.md`);
	await Deno.copyFile(new URL('LICENSE', repoRoot), `${dir}/LICENSE`);
}

/** `@scope/name` as the registry's URL path segment `@scope%2Fname`. */
function registryPath(packageName: string): string {
	return packageName.replace('/', '%2F');
}

/** GET a registry document; undefined when the registry answers 404. */
async function registryJson(
	options: RegistryOptions,
	path: string,
): Promise<unknown> {
	const base = options.registry.endsWith('/')
		? options.registry
		: `${options.registry}/`;
	const url = new URL(path, base);
	const response = await (options.fetch ?? fetch)(url, {
		headers: { accept: 'application/json' },
	});
	if (response.status === 404) {
		await response.body?.cancel();
		return undefined;
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
	}
	return await response.json();
}

async function catalogEntry(
	connector: Connector,
): Promise<Omit<CatalogEntry, keyof Release>> {
	const manifest = await readJson<Manifest>(
		new URL('manifest.json', connector.dir),
	);
	if (!manifest.icon) {
		throw new Error(`${connector.packageName}: manifest.json has no icon`);
	}
	const icon = new URL(manifest.icon, connector.dir);
	return {
		package: connector.packageName,
		name: manifest.name,
		description: oneLine(manifest.description),
		icon: iconDataUrl(icon.pathname, await Deno.readFile(icon)),
	};
}

/** npm's rule for new package names (validate-npm-package-name). */
const npmPackageName =
	/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
/** An exact version as npm stores it: no range, no tag. */
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** The characters GitHub allows in a user or organization name. */
const githubLogin = /^[A-Za-z0-9-]{1,39}$/;

/**
 * One entry per community registration, sorted by name (case-insensitive).
 * Every registration is read and checked; when any fails, the error names
 * each failing file and what failed, and there is no catalog. This is also the
 * pull request check, `deno task community:check` (scripts/community.ts).
 */
export async function communityCatalog(
	options: CatalogOptions,
): Promise<CatalogEntry[]> {
	const dir = options.communityDir;
	const files = (await Array.fromAsync(Deno.readDir(dir)))
		.filter((file) => file.name !== 'README.md')
		.sort((a, b) => (a.name < b.name ? -1 : 1));
	const results = await Promise.all(
		files.map(async (file): Promise<CatalogEntry | string> => {
			try {
				if (!file.isFile || !file.name.endsWith('.json')) {
					throw new Error(
						'not a registration; community/ holds <manifest id>.json files and README.md',
					);
				}
				const id = file.name.slice(0, -'.json'.length);
				return await communityEntry(new URL(file.name, dir), id, options);
			} catch (error) {
				const reason = error instanceof Error ? error.message : error;
				return `community/${file.name}: ${reason}`;
			}
		}),
	);
	const problems = results.filter((result) => typeof result === 'string');
	if (problems.length > 0) {
		throw new Error(
			`invalid community registrations:\n  ${problems.join('\n  ')}`,
		);
	}
	return results
		.filter((result) => typeof result !== 'string')
		.sort((a, b) => {
			const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
			return x < y ? -1 : x > y ? 1 : 0;
		});
}

/**
 * The catalog entry of the registration `file`, whose name says the manifest
 * id is `id`. The registered version must be on npm with a `gety` manifest of
 * that id and version, a tarball matching its integrity that holds the icon,
 * and the author must be a GitHub user.
 */
async function communityEntry(
	file: URL,
	id: string,
	options: CatalogOptions,
): Promise<CatalogEntry> {
	const registration = parseRegistration(await Deno.readTextFile(file));
	const { package: packageName, version, author } = registration;
	const spec = `${packageName}@${version}`;
	const packument = await registryJson(options, registryPath(packageName));
	if (packument === undefined) {
		throw new Error(`${packageName} is not on npm`);
	}
	const document = property(property(packument, 'versions'), version);
	if (document === undefined) {
		throw new Error(`${spec} is not on npm`);
	}
	const gety = property(document, 'gety');
	if (!isObject(gety)) {
		throw new Error(`${spec} has no gety manifest in its package.json`);
	}
	if (gety.id !== id) {
		throw new Error(
			`gety.id of ${spec} is ${
				JSON.stringify(gety.id)
			}; the file name must be the manifest id`,
		);
	}
	if (gety.version !== version) {
		throw new Error(
			`gety.version of ${spec} is ${
				JSON.stringify(gety.version)
			}, not the registered version`,
		);
	}
	if (typeof gety.name !== 'string' || gety.name === '') {
		throw new Error(`gety of ${spec} has no name`);
	}
	if (typeof gety.icon !== 'string' || gety.icon === '') {
		throw new Error(`gety of ${spec} has no icon`);
	}
	const time = property(property(packument, 'time'), version);
	if (typeof time !== 'string' || Number.isNaN(Date.parse(time))) {
		throw new Error(`the packument has no publish time for ${spec}`);
	}
	const icon = packagePath(gety.icon);
	const iconBytes = await tarballFile(
		await verifiedTarball(spec, document, options),
		icon,
	);
	if (!iconBytes) {
		throw new Error(
			`the icon ${icon} (gety.icon) was not found in the package ${spec}; its file name must fit a plain tar header (at most 100 bytes)`,
		);
	}
	return {
		package: packageName,
		name: gety.name,
		description: oneLine(
			typeof gety.description === 'string' ? gety.description : undefined,
		),
		icon: iconDataUrl(icon, iconBytes),
		version,
		publishedAt: new Date(time).toISOString(),
		author: {
			github: author.github,
			githubId: await githubUserId(author.github, options),
		},
	};
}

/** The registration in `text`, which may hold its three fields only. */
function parseRegistration(text: string): Registration {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(
			`not valid JSON (${error instanceof Error ? error.message : error})`,
		);
	}
	if (!isObject(value)) {
		throw new Error('must be a JSON object with package, version and author');
	}
	const unknown = Object.keys(value).find((key) =>
		key !== 'package' && key !== 'version' && key !== 'author'
	);
	if (unknown !== undefined) {
		throw new Error(
			`unknown field "${unknown}"; a registration has only package, version and author`,
		);
	}
	const { package: packageName, version, author } = value;
	if (
		typeof packageName !== 'string' || packageName.length > 214 ||
		!npmPackageName.test(packageName)
	) {
		throw new Error('package must be an npm package name');
	}
	if (typeof version !== 'string' || !exactVersion.test(version)) {
		throw new Error('version must be an exact version, such as 1.2.0');
	}
	if (!isObject(author)) {
		throw new Error('author must be an object with github');
	}
	const unknownAuthor = Object.keys(author).find((key) => key !== 'github');
	if (unknownAuthor !== undefined) {
		throw new Error(
			`unknown field "author.${unknownAuthor}"; author has only github`,
		);
	}
	if (typeof author.github !== 'string' || !githubLogin.test(author.github)) {
		throw new Error('author.github must be a GitHub user name');
	}
	return { package: packageName, version, author: { github: author.github } };
}

/**
 * The tarball (`dist.tarball`) of a version document, which must match the
 * sha512 hash in its `dist.integrity`.
 */
async function verifiedTarball(
	spec: string,
	document: unknown,
	options: RegistryOptions,
): Promise<Uint8Array<ArrayBuffer>> {
	const dist = property(document, 'dist');
	const tarball = property(dist, 'tarball');
	const integrity = property(dist, 'integrity');
	const hashes = typeof integrity === 'string'
		? integrity.split(/\s+/)
			.filter((hash) => hash.startsWith('sha512-'))
			.map((hash) => hash.slice('sha512-'.length))
		: [];
	if (typeof tarball !== 'string' || hashes.length === 0) {
		throw new Error(`${spec} has no dist.tarball with a sha512 integrity`);
	}
	const url = new URL(tarball);
	const response = await (options.fetch ?? fetch)(url, {});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`GET ${url}: ${response.status} ${response.statusText}`);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	const digest = encodeBase64(await crypto.subtle.digest('SHA-512', bytes));
	if (!hashes.includes(digest)) {
		throw new Error(
			`the tarball of ${spec} does not match its dist.integrity`,
		);
	}
	return bytes;
}

/**
 * The content of the regular file `path` in the gzipped tarball, if any.
 * Reading stops at that file.
 */
async function tarballFile(
	tarball: Uint8Array<ArrayBuffer>,
	path: string,
): Promise<Uint8Array | undefined> {
	// DecompressionStream inflates each input chunk into one output chunk, so
	// the whole tarball as one chunk could inflate to gigabytes before the
	// first entry is read. 1 KiB inputs keep every output chunk near 1 MiB at
	// most (deflate expands at most about 1032 times), and the stream is only
	// read, and so inflated, up to the icon.
	const slices = function* () {
		for (let start = 0; start < tarball.length; start += 1024) {
			yield tarball.subarray(start, start + 1024);
		}
	};
	const entries = ReadableStream.from(slices())
		.pipeThrough(new DecompressionStream('gzip'))
		.pipeThrough(new UntarStream());
	for await (const entry of entries) {
		const type = entry.header.typeflag;
		if (entry.path === path && (type === '0' || type === '\0' || type === '')) {
			return new Uint8Array(await new Response(entry.readable).arrayBuffer());
		}
		await entry.readable?.cancel();
	}
	return undefined;
}

/**
 * Where an npm tarball holds a manifest icon: `package/` and the icon path,
 * which is relative to the package root.
 */
function packagePath(icon: string): string {
	const segments = icon.split('/')
		.filter((segment) => segment !== '' && segment !== '.');
	if (
		icon.startsWith('/') || segments.length === 0 || segments.includes('..')
	) {
		throw new Error(
			`gety.icon ${JSON.stringify(icon)} is not a path inside the package`,
		);
	}
	return `package/${segments.join('/')}`;
}

/**
 * The numeric id of the GitHub user or organization `login`, which Gety turns
 * into the author's avatar.
 */
async function githubUserId(
	login: string,
	options: CatalogOptions,
): Promise<number> {
	const url = new URL(`users/${encodeURIComponent(login)}`, githubApi);
	const headers: Record<string, string> = {
		accept: 'application/vnd.github+json',
		'x-github-api-version': '2022-11-28',
	};
	if (options.githubToken) {
		headers.authorization = `Bearer ${options.githubToken}`;
	}
	const response = await (options.fetch ?? fetch)(url, { headers });
	if (response.status === 404) {
		await response.body?.cancel();
		throw new Error(`GitHub user ${login} does not exist`);
	}
	if (!response.ok) {
		const message = property(
			await response.json().catch(() => undefined),
			'message',
		);
		throw new Error(
			`GET ${url}: ${response.status} ${response.statusText}${
				typeof message === 'string' ? ` (${message})` : ''
			}`,
		);
	}
	const id = property(await response.json(), 'id');
	if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
		throw new Error(`GET ${url}: the user has no numeric id`);
	}
	return id;
}

const iconMimeTypes: Record<string, string> = {
	svg: 'image/svg+xml',
	png: 'image/png',
	webp: 'image/webp',
};

/**
 * The catalog's `data:` URL for the icon file `file` (its path, which gives
 * the type and names it in errors) with the content `bytes`.
 */
function iconDataUrl(file: string, bytes: Uint8Array): string {
	const extension = file.split('.').pop()?.toLowerCase() ?? '';
	const mimeType = iconMimeTypes[extension];
	if (!mimeType) {
		throw new Error(`${file}: icon must be SVG, PNG or WebP`);
	}
	if (mimeType === 'image/png') {
		// Decoding allocates every pixel, so the IHDR size is checked first.
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
		if (bytes.length < 24 || view.getUint32(12) !== 0x49484452) {
			throw new Error(`${file}: not a readable PNG (no IHDR chunk)`);
		}
		const [width, height] = [view.getUint32(16), view.getUint32(20)];
		if (width > maxPngIconSize || height > maxPngIconSize) {
			throw new Error(
				`${file}: PNG icon is ${width}x${height}; PNG icons must be at most ${maxPngIconSize}x${maxPngIconSize}`,
			);
		}
		let image: DecodedPng;
		try {
			image = decode(bytes);
		} catch (error) {
			const reason = error instanceof Error ? error.message : error;
			throw new Error(`${file}: not a readable PNG (${reason})`);
		}
		if (image.width > catalogIconSize || image.height > catalogIconSize) {
			bytes = encode(downscale(file, image), { zlib: { level: 9 } });
		}
	} else if (mimeType === 'image/webp') {
		// There is no WebP encoder here to downscale with; authors pre-size them.
		const { width, height } = webpDimensions(file, bytes);
		if (width > catalogIconSize || height > catalogIconSize) {
			throw new Error(
				`${file}: WebP icon is ${width}x${height}; WebP icons must be at most ${catalogIconSize}x${catalogIconSize} (larger PNGs are downscaled)`,
			);
		}
	}
	if (bytes.length > maxIconBytes) {
		throw new Error(
			`${file}: icon is ${bytes.length} bytes in the catalog, more than ${maxIconBytes}; use an SVG or a smaller image`,
		);
	}
	return `data:${mimeType};base64,${encodeBase64(bytes)}`;
}

/**
 * Canvas size from a WebP file header: the VP8X extended header, a VP8L
 * lossless header or a VP8 lossy key frame header
 * (https://developers.google.com/speed/webp/docs/riff_container).
 */
export function webpDimensions(
	file: string,
	bytes: Uint8Array,
): { width: number; height: number } {
	const ascii = (start: number, end: number) =>
		String.fromCharCode(...bytes.subarray(start, end));
	const uint24 = (offset: number) =>
		bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
	const chunk = bytes.length >= 20 && ascii(0, 4) === 'RIFF' &&
			ascii(8, 12) === 'WEBP'
		? ascii(12, 16)
		: undefined;
	if (chunk === 'VP8X' && bytes.length >= 30) {
		return { width: uint24(24) + 1, height: uint24(27) + 1 };
	}
	if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
		const bits = (uint24(21) | (bytes[24] << 24)) >>> 0;
		return {
			width: (bits & 0x3fff) + 1,
			height: ((bits >>> 14) & 0x3fff) + 1,
		};
	}
	if (
		chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d &&
		bytes[24] === 0x01 && bytes[25] === 0x2a
	) {
		return {
			width: uint24(26) & 0x3fff,
			height: uint24(28) & 0x3fff,
		};
	}
	throw new Error(`${file}: not a WebP file with a readable size`);
}

/**
 * Box-filter downscale (premultiplied alpha) of an 8-bit RGB/RGBA PNG to fit
 * catalogIconSize. Integer pixel arithmetic and a pure-JS encoder keep the
 * output byte-identical on every machine, so an unchanged catalog compares
 * equal to the published one and is not republished.
 */
function downscale(file: string, source: DecodedPng): ImageData {
	const channels = source.channels;
	if (source.depth !== 8 || (channels !== 3 && channels !== 4)) {
		throw new Error(
			`${file}: icons larger than ${catalogIconSize}px must be 8-bit RGB or RGBA PNGs`,
		);
	}
	const scale = catalogIconSize / Math.max(source.width, source.height);
	const width = Math.max(1, Math.round(source.width * scale));
	const height = Math.max(1, Math.round(source.height * scale));
	const from = source.data;
	const to = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		const y0 = Math.floor((y * source.height) / height);
		const y1 = Math.max(
			y0 + 1,
			Math.floor(((y + 1) * source.height) / height),
		);
		for (let x = 0; x < width; x++) {
			const x0 = Math.floor((x * source.width) / width);
			const x1 = Math.max(
				x0 + 1,
				Math.floor(((x + 1) * source.width) / width),
			);
			let r = 0, g = 0, b = 0, a = 0;
			for (let sy = y0; sy < y1; sy++) {
				for (let sx = x0; sx < x1; sx++) {
					const i = (sy * source.width + sx) * channels;
					const alpha = channels === 4 ? from[i + 3] : 255;
					r += from[i] * alpha;
					g += from[i + 1] * alpha;
					b += from[i + 2] * alpha;
					a += alpha;
				}
			}
			const o = (y * width + x) * 4;
			if (a > 0) {
				to[o] = Math.round(r / a);
				to[o + 1] = Math.round(g / a);
				to[o + 2] = Math.round(b / a);
			}
			to[o + 3] = Math.round(a / ((x1 - x0) * (y1 - y0)));
		}
	}
	return { width, height, data: to, channels: 4, depth: 8 };
}

if (import.meta.main) {
	let out: string | undefined;
	let registry = defaultRegistry;
	const args = Deno.args.filter((arg) => arg !== '--');
	for (let i = 0; i < args.length; i += 2) {
		const [flag, value] = [args[i], args[i + 1]];
		if ((flag !== '--out' && flag !== '--registry') || value === undefined) {
			console.error(
				'usage: deno task catalog [--out <new directory>] [--registry <url>]',
			);
			Deno.exit(2);
		}
		if (flag === '--out') {
			out = value;
		} else {
			registry = value;
		}
	}
	const build = await buildCatalogPackage({
		registry,
		githubToken: Deno.env.get('GITHUB_TOKEN'),
		communityDir,
	});
	if (!build.changed) {
		console.log(
			`the published catalog ${build.published.version} is up to date; nothing to publish`,
		);
	} else if (out === undefined) {
		console.log(formatJson(build.pkg).trimEnd());
	} else {
		await writeCatalogPackage(out, build.pkg);
		console.log(`wrote ${build.pkg.name}@${build.pkg.version} to ${out}`);
	}
}
