// Generates the `getyCatalog` field of packages/catalog/package.json from the
// connector manifests and icons. Gety reads the field from the registry's
// `<registry>/@gety-connectors%2Fcatalog/latest` document, so the whole
// package.json must stay small. Run directly to print the generated catalog.

import { encodeBase64 } from '@std/encoding/base64';
import { decode, type DecodedPng, encode, type ImageData } from 'fast-png';
import {
	catalogDir,
	type Connector,
	listConnectors,
	type Manifest,
	oneLine,
	readJson,
} from './connectors.ts';

export const catalogSchemaVersion = 1;
/** Raster icons larger than this (in either dimension) are downscaled. */
export const catalogIconSize = 128;
/** Upper bound for one icon's bytes after downscaling. */
const maxIconBytes = 24 * 1024;
/** Upper bound for the whole catalog package.json. */
export const maxCatalogPackageBytes = 64 * 1024;

export interface CatalogEntry {
	package: string;
	name: string;
	description: string;
	icon: string;
}

export interface Catalog {
	schemaVersion: number;
	connectors: CatalogEntry[];
}

export const catalogPackagePath = new URL('package.json', catalogDir);

export async function generateCatalog(): Promise<Catalog> {
	const connectors: CatalogEntry[] = [];
	for (const connector of await listConnectors()) {
		connectors.push(await catalogEntry(connector));
	}
	return { schemaVersion: catalogSchemaVersion, connectors };
}

async function catalogEntry(connector: Connector): Promise<CatalogEntry> {
	const manifest = await readJson<Manifest>(
		new URL('manifest.json', connector.dir),
	);
	if (!manifest.icon) {
		throw new Error(`${connector.packageName}: manifest.json has no icon`);
	}
	return {
		package: connector.packageName,
		name: manifest.name,
		description: oneLine(manifest.description),
		icon: await iconDataUrl(new URL(manifest.icon, connector.dir)),
	};
}

const iconMimeTypes: Record<string, string> = {
	svg: 'image/svg+xml',
	png: 'image/png',
	webp: 'image/webp',
};

async function iconDataUrl(path: URL): Promise<string> {
	const extension = path.pathname.split('.').pop()?.toLowerCase() ?? '';
	const mimeType = iconMimeTypes[extension];
	if (!mimeType) {
		throw new Error(`${path.pathname}: icon must be SVG, PNG or WebP`);
	}
	let bytes: Uint8Array = await Deno.readFile(path);
	if (mimeType === 'image/png') {
		const image = decode(bytes);
		if (image.width > catalogIconSize || image.height > catalogIconSize) {
			bytes = encode(downscale(path, image), { zlib: { level: 9 } });
		}
	}
	if (bytes.length > maxIconBytes) {
		throw new Error(
			`${path.pathname}: icon is ${bytes.length} bytes in the catalog, more than ${maxIconBytes}; use an SVG or a smaller image`,
		);
	}
	return `data:${mimeType};base64,${encodeBase64(bytes)}`;
}

/**
 * Box-filter downscale (premultiplied alpha) of an 8-bit RGB/RGBA PNG to fit
 * catalogIconSize. Integer pixel arithmetic and a pure-JS encoder keep the
 * output byte-identical on every machine, which the CI drift check relies on.
 */
function downscale(path: URL, source: DecodedPng): ImageData {
	const channels = source.channels;
	if (source.depth !== 8 || (channels !== 3 && channels !== 4)) {
		throw new Error(
			`${path.pathname}: icons larger than ${catalogIconSize}px must be 8-bit RGB or RGBA PNGs`,
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
	console.log(JSON.stringify(await generateCatalog(), null, '\t'));
}
