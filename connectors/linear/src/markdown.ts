import { fromMarkdown } from 'mdast-util-from-markdown';
import { toMarkdown } from 'mdast-util-to-markdown';
import type { Image, Link, Nodes } from 'mdast';

interface MarkdownParent {
	children: Nodes[];
}

interface Replacement {
	start: number;
	end: number;
	value: string;
}

const stringifyOptions = {
	bullet: '-',
	emphasis: '_',
	fences: true,
	listItemIndent: 'one',
	rule: '-',
} as const;

export function markdownImagesToLinks(markdown: string): string {
	const replacements: Replacement[] = [];
	collectImageReplacements(fromMarkdown(markdown), replacements);
	return applyReplacements(markdown, replacements);
}

function collectImageReplacements(
	node: Nodes,
	replacements: Replacement[],
): void {
	if (node.type === 'image') {
		const start = node.position?.start.offset;
		const end = node.position?.end.offset;
		if (start != null && end != null) {
			replacements.push({
				start,
				end,
				value: imageToLinkMarkdown(node),
			});
		}
		return;
	}

	if (!isMarkdownParent(node)) {
		return;
	}

	for (const child of node.children) {
		collectImageReplacements(child, replacements);
	}
}

function imageToLinkMarkdown(image: Image): string {
	const link: Link = {
		type: 'link',
		url: image.url,
		title: image.title ?? null,
		children: [{
			type: 'text',
			value: image.alt?.trim() || 'Image',
		}],
	};
	return toMarkdown({
		type: 'paragraph',
		children: [link],
	}, stringifyOptions).trim();
}

function applyReplacements(
	markdown: string,
	replacements: Replacement[],
): string {
	let result = markdown;
	for (
		const replacement of replacements.sort((a, b) => b.start - a.start)
	) {
		result = result.slice(0, replacement.start) + replacement.value +
			result.slice(replacement.end);
	}
	return result;
}

function isMarkdownParent(node: Nodes): node is Nodes & MarkdownParent {
	return 'children' in node &&
		Array.isArray((node as { children?: unknown }).children);
}
