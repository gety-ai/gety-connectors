import {
	LarkCliClient,
	LarkCliError,
	type SearchEntity,
	type WikiNode,
} from './lark_cli.ts';

export type SourceLocation = {
	space_name?: string;
	parent_name?: string;
	path?: string;
	ancestors?: { id: string; title: string }[];
	path_complete?: boolean;
};

/** Provider IDs identify objects and positions; they are not display labels. */
export type CloudPosition = {
	url?: string;
	location?: SourceLocation;
	feishu?: {
		node_token?: string;
		obj_token?: string;
		space_id?: string;
		parent_node_token?: string;
		origin_node_token?: string;
		origin_space_id?: string;
		folder_token?: string;
	};
};

/** Refresh position independently of document content on each poll. */
export class DocLocationResolver {
	private nodes = new Map<string, Promise<WikiNode>>();
	private spaces = new Map<string, Promise<string | undefined>>();
	private drive?: Promise<Map<string, CloudPosition>>;
	private wikiUnavailable = false;
	private warnings = new Set<string>();

	constructor(
		private client: LarkCliClient,
		private signal: AbortSignal,
	) {}

	async resolve(
		entity: SearchEntity,
		previous: CloudPosition = {},
	): Promise<CloudPosition> {
		this.signal.throwIfAborted();
		let node: WikiNode;
		try {
			if (this.wikiUnavailable) {
				return (await this.getDriveLocations()).get(entity.token) ?? previous;
			}
			const wikiToken = wikiTokenFromUrl(entity.url);
			node = await this.getNode(
				wikiToken ?? entity.token,
				wikiToken == null ? entity.type : 'wiki',
			);
		} catch (error) {
			this.signal.throwIfAborted();
			const notMounted = error instanceof LarkCliError &&
				error.code === '131014';
			if (!notMounted) {
				if (error instanceof LarkCliError && error.missingScopes.length > 0) {
					this.wikiUnavailable = true;
				}
				this.warn('wiki', error);
			}
			const drive = await this.getDriveLocations();
			// Absence from Drive does not establish absence of a shared folder.
			// A confirmed unmounted Wiki object, however, no longer has Wiki position.
			return drive.get(entity.token) ??
				(notMounted && previous.feishu?.node_token != null ? {} : previous);
		}

		let spaceName: string | undefined;
		if (node.space_id != null) {
			try {
				let pending = this.spaces.get(node.space_id);
				if (pending == null) {
					pending = this.client.getWikiSpaceName(node.space_id);
					this.spaces.set(node.space_id, pending);
				}
				spaceName = nonempty(await pending);
			} catch (error) {
				this.signal.throwIfAborted();
				this.warn('wiki space', error);
				if (previous.feishu?.space_id === node.space_id) {
					spaceName = previous.location?.space_name;
				}
			}
		}

		let parentToken = node.parent_node_token;
		const ancestors: { id: string; title: string }[] = [];
		const visited = new Set([node.node_token]);
		let complete = true;
		while (parentToken != null) {
			this.signal.throwIfAborted();
			if (visited.has(parentToken)) {
				complete = false;
				break;
			}
			visited.add(parentToken);
			try {
				const parent = await this.getNode(parentToken, 'wiki');
				const title = nonempty(parent.title);
				if (title == null) {
					complete = false;
					break;
				}
				ancestors.unshift({ id: parent.node_token, title });
				parentToken = parent.parent_node_token;
			} catch (error) {
				this.signal.throwIfAborted();
				this.warn('wiki ancestor', error);
				complete = false;
				break;
			}
		}

		if (
			!complete && ancestors.length === 0 &&
			previous.feishu?.parent_node_token === node.parent_node_token &&
			previous.feishu?.space_id === node.space_id
		) {
			ancestors.push(...(previous.location?.ancestors ?? []));
		}
		const location = makeLocation(ancestors, spaceName, complete);
		const feishu = {
			node_token: node.node_token,
			...(node.obj_token == null ? {} : { obj_token: node.obj_token }),
			...(node.space_id == null ? {} : { space_id: node.space_id }),
			...(node.parent_node_token == null
				? {}
				: { parent_node_token: node.parent_node_token }),
			...(node.origin_node_token == null
				? {}
				: { origin_node_token: node.origin_node_token }),
			...(node.origin_space_id == null
				? {}
				: { origin_space_id: node.origin_space_id }),
		};
		return { ...(location == null ? {} : { location }), feishu };
	}

	private getNode(token: string, objType?: string): Promise<WikiNode> {
		let pending = this.nodes.get(token);
		if (pending == null) {
			pending = this.client.getWikiNode(token, objType);
			this.nodes.set(token, pending);
		}
		return pending;
	}

	private getDriveLocations(): Promise<Map<string, CloudPosition>> {
		this.drive ??= this.scanDrive();
		return this.drive;
	}

	private async scanDrive(): Promise<Map<string, CloudPosition>> {
		const locations = new Map<string, CloudPosition>();
		const queue: {
			token?: string;
			ancestors: { id: string; title: string }[];
		}[] = [
			{ ancestors: [] },
		];
		const visited = new Set<string>();
		for (let index = 0; index < queue.length; index++) {
			const folder = queue[index];
			const key = folder.token ?? '';
			if (visited.has(key)) continue;
			visited.add(key);
			let pageToken: string | undefined;
			const pages = new Set<string>();
			try {
				while (true) {
					this.signal.throwIfAborted();
					const page = await this.client.listDriveFiles(
						folder.token,
						pageToken,
					);
					for (const file of page.files) {
						if (file.type === 'folder') {
							const title = nonempty(file.name);
							// A missing folder name cannot produce a truthful full path.
							if (title != null) {
								queue.push({
									token: file.token,
									ancestors: [...folder.ancestors, { id: file.token, title }],
								});
							}
						} else {
							const location = makeLocation(folder.ancestors);
							locations.set(file.token, {
								...(file.url == null ? {} : { url: file.url }),
								...(location == null ? {} : { location }),
								...(file.parent_token == null
									? {}
									: { feishu: { folder_token: file.parent_token } }),
							});
						}
					}
					if (!page.hasMore) break;
					if (page.pageToken == null || pages.has(page.pageToken)) {
						throw new Error('Drive pagination did not advance');
					}
					pages.add(page.pageToken);
					pageToken = page.pageToken;
				}
			} catch (error) {
				this.signal.throwIfAborted();
				this.warn('drive folders', error);
				if (error instanceof LarkCliError && error.missingScopes.length > 0) {
					break;
				}
			}
		}
		return locations;
	}

	private warn(source: string, error: unknown): void {
		if (this.warnings.has(source)) return;
		this.warnings.add(source);
		console.error(
			`[feishu] optional ${source} metadata unavailable: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function makeLocation(
	ancestors: { id: string; title: string }[],
	spaceName?: string,
	complete = true,
): SourceLocation | undefined {
	if (ancestors.length === 0 && spaceName == null) return undefined;
	return {
		...(spaceName == null ? {} : { space_name: spaceName }),
		...(ancestors.length === 0 ? {} : {
			parent_name: ancestors[ancestors.length - 1].title,
			path: ancestors.map((item) => item.title).join(' / '),
			ancestors,
		}),
		path_complete: complete,
	};
}

function nonempty(value: string | undefined): string | undefined {
	return value?.trim() || undefined;
}

function wikiTokenFromUrl(value: string | undefined): string | undefined {
	if (value == null) return undefined;
	try {
		const match = /^\/wiki\/([^/]+)/.exec(new URL(value).pathname);
		return match?.[1];
	} catch {
		return undefined;
	}
}
