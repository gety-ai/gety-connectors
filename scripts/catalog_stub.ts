// Test doubles for the catalog tests: a `fetch` that answers the npm registry,
// its tarballs and the GitHub API from a table of documents by URL, and
// helpers that publish community packages to that table and write
// registration files.

import { encodeBase64 } from '@std/encoding/base64';
import { TarStream } from '@std/tar/tar-stream';
import type { CatalogOptions } from './catalog.ts';
import { formatJson } from './connectors.ts';

export const registry = 'https://registry.test/';

/**
 * Responses by URL: bytes are served as they are (tarballs), anything else as
 * JSON; a URL that is not in the table answers 404.
 */
export type Documents = Record<string, unknown>;

export type StubOptions = CatalogOptions & {
	/** Every URL requested, in order. */
	requested: string[];
	/** The URLs requested with an authorization header. */
	authorized: string[];
};

/**
 * Options that read `current` and the registrations in `options.communityDir`,
 * which every test gives so that none reads the repository's community/.
 */
export function stubRegistry(
	current: Documents | (() => Documents),
	options: Partial<CatalogOptions> & Pick<CatalogOptions, 'communityDir'>,
): StubOptions {
	const requested: string[] = [];
	const authorized: string[] = [];
	return {
		registry,
		attempts: 1,
		retryDelayMs: 0,
		...options,
		requested,
		authorized,
		fetch: (url, init) => {
			requested.push(url.href);
			if (new Headers(init.headers).has('authorization')) {
				authorized.push(url.href);
			}
			const body = (typeof current === 'function' ? current() : current)[
				url.href
			];
			return Promise.resolve(
				body === undefined
					? Response.json({ message: 'Not Found' }, { status: 404 })
					: body instanceof Response
					? body
					: body instanceof Uint8Array
					? new Response(body.slice())
					: Response.json(body),
			);
		},
	};
}

/** Runs `body` with a new, empty registration directory. */
export async function withCommunityDir(
	body: (dir: URL) => Promise<void>,
): Promise<void> {
	const path = await Deno.makeTempDir();
	try {
		await body(new URL(`file://${path}/`));
	} finally {
		await Deno.remove(path, { recursive: true });
	}
}

export function packumentUrl(packageName: string): string {
	return `${registry}${packageName.replace('/', '%2F')}`;
}

export function tarballUrl(packageName: string, version: string): string {
	return `${registry}${packageName}/-/${
		packageName.split('/').pop()
	}-${version}.tgz`;
}

export function githubUserUrl(login: string): string {
	return `https://api.github.com/users/${login}`;
}

/** Adds a GitHub user to the documents. */
export function addGithubUser(documents: Documents, login: string, id: number) {
	documents[githubUserUrl(login)] = { login, id, type: 'User' };
}

export interface CommunityPackage {
	package: string;
	version: string;
	/** package.json `gety`; omitted from the package when null. */
	gety: Record<string, unknown> | null;
	/** Files of the tarball besides package.json, by path under package/. */
	files: Record<string, Uint8Array | string>;
	publishedAt?: string;
}

export const sampleSvg =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';

/** `@acme/gety-<id>` 1.2.0, a connector with the SVG icon icon.svg. */
export function sampleConnector(id: string, name: string): CommunityPackage {
	return {
		package: `@acme/gety-${id}`,
		version: '1.2.0',
		gety: {
			id,
			name,
			version: '1.2.0',
			entry: 'dist/main.js',
			icon: 'icon.svg',
			description: `Indexes ${name} items.`,
		},
		files: { 'icon.svg': sampleSvg, 'dist/main.js': '' },
	};
}

/** The registration of `pkg` at its version by the GitHub user acme. */
export function registrationOf(
	pkg: CommunityPackage,
): { package: string; version: string; author: { github: string } } {
	return {
		package: pkg.package,
		version: pkg.version,
		author: { github: 'acme' },
	};
}

/**
 * Publishes a package with one version to the documents: its packument, with
 * the version's `gety`, tarball URL, sha512 integrity and publish time, and
 * the tarball. `damage` may alter the tar archive before it is compressed.
 */
export async function publish(
	documents: Documents,
	pkg: CommunityPackage,
	damage?: (tar: Uint8Array) => void,
): Promise<void> {
	const { package: name, version, gety } = pkg;
	const manifest = { name, version, ...(gety ? { gety } : {}) };
	const files = { 'package.json': formatJson(manifest), ...pkg.files };
	const tarball = await tgz(
		Object.fromEntries(
			Object.entries(files).map(([path, content]) => [
				`package/${path}`,
				typeof content === 'string'
					? new TextEncoder().encode(content)
					: content,
			]),
		),
		damage,
	);
	const integrity = `sha512-${
		encodeBase64(await crypto.subtle.digest('SHA-512', tarball))
	}`;
	documents[packumentUrl(name)] = {
		name,
		'dist-tags': { latest: version },
		versions: {
			[version]: {
				...manifest,
				dist: { tarball: tarballUrl(name, version), integrity },
			},
		},
		time: {
			created: '2026-01-01T00:00:00.000Z',
			[version]: pkg.publishedAt ?? '2026-10-20T03:00:00.000Z',
		},
	};
	documents[tarballUrl(name, version)] = tarball;
}

/**
 * A gzipped tarball of the files, by path; `damage` may alter the tar archive
 * before it is compressed.
 */
export async function tgz(
	files: Record<string, Uint8Array>,
	damage?: (tar: Uint8Array) => void,
): Promise<Uint8Array<ArrayBuffer>> {
	const archive = ReadableStream.from(
		Object.entries(files).map(([path, bytes]) => ({
			type: 'file' as const,
			path,
			size: bytes.length,
			readable: ReadableStream.from([bytes]),
		})),
	)
		.pipeThrough(new TarStream());
	const tar = new Uint8Array(await new Response(archive).arrayBuffer());
	damage?.(tar);
	const stream = new Blob([tar]).stream()
		.pipeThrough(new CompressionStream('gzip'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Writes `community/<file>` with `registration` as JSON (or as text). */
export async function register(
	dir: URL,
	file: string,
	registration: unknown,
): Promise<void> {
	await Deno.writeTextFile(
		new URL(file, dir),
		typeof registration === 'string' ? registration : formatJson(registration),
	);
}
