import {
	Connector,
	del,
	type DocUpdate,
	type PollResult,
	upsert,
	type WireDoc,
} from '@gety-ai/connector-sdk';
import { sha256Hex } from '@gety-connectors/utils/hash';
import { createLogger } from '@gety-connectors/utils/log';
import { paginate } from '@gety-connectors/utils/paginate';
import { type Enumeration, staleIds } from '@gety-connectors/utils/reconcile';
import {
	clampUtf8,
	httpUrl,
	markdownLink,
	MAX_CONTENT_BYTES,
} from '@gety-connectors/utils/text';
import type { ManifestConfig } from './gen/manifest.d.ts';
import { cleanupDocMarkdown } from './doc_markdown.ts';
import {
	type CloudPosition,
	DocLocationResolver,
	LOCATION_BUDGET_MS,
} from './doc_location.ts';
import {
	type ChatMessage,
	type ChatSummary,
	errorMessage,
	isConfirmedGone,
	isFatalError,
	isoFromLarkTime,
	LARK_CLI,
	LarkCliClient,
	LarkCliError,
	type SearchEntity,
} from './lark_cli.ts';
import { readPositionCache, writePositionCache } from './position_cache.ts';

export type ChatGrouping = 'day' | 'week' | 'chat';

export type LarkState = {
	/** token -> fetch ref (source URL, or document token) of indexed cloud docs. */
	docs?: Record<string, string>;
	/** token -> signature of the indexed version (metadata and source position). */
	doc_signatures?: Record<string, string>;
	/** Binds the position cache in the data directory to this state. */
	positions_epoch?: string;
	/** chat_id -> what is indexed of that chat. */
	chats?: Record<string, ChatRecord>;
	/** Grouping the chat records were built with. */
	chat_grouping?: ChatGrouping;
	/**
	 * Chat doc ids of an earlier grouping, deleted once a chat sync under the
	 * current grouping completes (until then they stay searchable).
	 */
	retired_chat_docs?: string[];
};

export type ChatRecord = {
	/**
	 * Newest indexed message: its local day (YYYY-MM-DD) for day and week
	 * docs, its "YYYY-MM-DD HH:mm" time for whole-chat docs.
	 */
	cursor: string;
	/** Whole-chat docs: message_id of the newest indexed message. */
	last_message_id?: string;
	/** Period keys of the chat's indexed docs ("all" for a whole-chat doc). */
	periods: string[];
	/** Signature of the newest period's doc as last upserted. */
	signature?: string;
};

const DEFAULT_CHAT_LOOKBACK_DAYS = 30;
/**
 * doc_types values whose content lark-cli can export as markdown. Sheets,
 * bitables, slides, shortcuts, and legacy "doc" documents (rejected by the
 * v2 fetch API) are enumerated by search but not indexed.
 */
const INDEXABLE_DOC_TYPES: Record<string, true> = { docx: true };
const TRUNCATION_NOTICE = '\n\n…(内容超长,已被连接器截断)';

export function localDateString(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

export function dayStartISO(day: string): string {
	return new Date(`${day}T00:00:00`).toISOString();
}

/** Monday of the ISO week containing the given local date. */
export function weekStartDay(day: string): string {
	const date = new Date(`${day}T00:00:00`);
	const weekday = (date.getDay() + 6) % 7;
	date.setDate(date.getDate() - weekday);
	return localDateString(date);
}

export function addDays(day: string, count: number): string {
	const date = new Date(`${day}T00:00:00`);
	date.setDate(date.getDate() + count);
	return localDateString(date);
}

/**
 * Stable per-period doc key: the day itself, the week's Monday, or a single
 * constant bucket when the whole chat is one document.
 */
export function periodKey(day: string, grouping: ChatGrouping): string {
	if (grouping === 'chat') {
		return 'all';
	}
	return grouping === 'week' ? weekStartDay(day) : day;
}

/** Human-readable period: "2026-07-10" or "2026-07-06 ~ 2026-07-12". */
export function periodLabel(key: string, grouping: ChatGrouping): string {
	return grouping === 'week' ? `${key} ~ ${addDays(key, 6)}` : key;
}

/** Document id of a cloud document; never changes once published. */
export function cloudDocId(token: string): string {
	return `feishu:doc:${token}`;
}

/** Document id of a chat period doc; never changes once published. */
export function chatDocId(chatId: string, key: string): string {
	return key === 'all'
		? `feishu:chat:${chatId}`
		: `feishu:chat:${chatId}:${key}`;
}

export function buildCloudDoc(
	entity: SearchEntity,
	raw: string,
	position: CloudPosition = {},
): WireDoc {
	const url = entity.url ?? position.url;
	const lines: string[] = [];
	const location = position.location;
	const pathAncestors = location?.ancestors;
	const path = pathAncestors?.length &&
			pathAncestors.map((item) => item.title).join(' / ') === location?.path
		? pathAncestors.map((item) => markdownLink(item.title, item.url)).join(
			' / ',
		)
		: markdownLink(location?.path ?? '', undefined);
	for (
		const [label, text] of [
			[
				'知识库',
				markdownLink(location?.space_name ?? '', location?.space_url),
			],
			[
				'父节点',
				markdownLink(location?.parent_name ?? '', location?.parent_url),
			],
			['目录路径', path],
		]
	) {
		if (text) {
			const prefix = label === '目录路径' && location?.path_complete === false
				? '… / '
				: '';
			lines.push(`> **${label}：** ${prefix}${text}`);
		}
	}
	if (httpUrl(url) != null) {
		lines.push(`> **原链接：** ${markdownLink('打开原文', url)}`);
	}
	const markdown = lines.length > 0
		? `${lines.join('\n>\n')}\n\n---\n\n${raw}`
		: raw;
	const { content, bytes } = clampUtf8(
		markdown,
		MAX_CONTENT_BYTES,
		TRUNCATION_NOTICE,
	);
	return {
		id: cloudDocId(entity.token),
		title: entity.title,
		content,
		content_format: 'markdown',
		doc_type: `feishu:${entity.type}`,
		doc_updated_at: entity.editedAt,
		original_file_size: bytes,
		metadata: {
			...(url == null ? {} : { url }),
			token: entity.token,
			source_type: entity.type,
			...(entity.createdAt == null ? {} : { created_at: entity.createdAt }),
			...(entity.owner == null ? {} : { owner: entity.owner }),
		},
	};
}

export function senderLabel(message: ChatMessage): string {
	const sender = message.sender;
	if (sender == null) {
		return '未知';
	}
	if (sender.name != null && sender.name !== '') {
		return sender.name;
	}
	if (sender.sender_type != null && sender.sender_type !== 'user') {
		return `bot(${sender.id ?? sender.sender_type})`;
	}
	return sender.id ?? '未知';
}

export function groupMessagesByDay(
	messages: ChatMessage[],
): Map<string, ChatMessage[]> {
	const byDay = new Map<string, ChatMessage[]>();
	for (const message of messages) {
		if (message.deleted === true) {
			continue;
		}
		const day = message.create_time?.slice(0, 10);
		if (day == null || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
			continue;
		}
		const bucket = byDay.get(day);
		if (bucket == null) {
			byDay.set(day, [message]);
		} else {
			bucket.push(message);
		}
	}
	return byDay;
}

/** Groups per-day buckets into period buckets keyed by `periodKey`. */
export function groupDaysByPeriod(
	byDay: Map<string, ChatMessage[]>,
	grouping: ChatGrouping,
): Map<string, Map<string, ChatMessage[]>> {
	const periods = new Map<string, Map<string, ChatMessage[]>>();
	for (const [day, messages] of byDay) {
		const key = periodKey(day, grouping);
		const days = periods.get(key);
		if (days == null) {
			periods.set(key, new Map([[day, messages]]));
		} else {
			days.set(day, messages);
		}
	}
	return periods;
}

export function chatTitle(chat: ChatSummary): string {
	const name = chat.name?.trim();
	if (name != null && name !== '') {
		return name;
	}
	return chat.chat_mode === 'p2p' ? '私聊' : '群聊';
}

function renderMessages(lines: string[], messages: ChatMessage[]): void {
	for (const message of messages) {
		const time = message.create_time?.slice(11, 16) ?? '';
		const body = message.content?.trim() ||
			`(${message.msg_type ?? 'message'})`;
		const label = `**[${time}] ${senderLabel(message)}:**`;
		lines.push(body.includes('\n') ? `${label}\n${body}` : `${label} ${body}`);
		lines.push('');
	}
}

/**
 * Day docs are a flat transcript; week and whole-chat docs add a `##`
 * section per day so long transcripts stay readable.
 */
export function renderChatPeriod(
	title: string,
	label: string,
	days: Map<string, ChatMessage[]>,
	grouping: ChatGrouping,
): string {
	const lines = [`# ${title} — ${label}`, ''];
	const sortedDays = [...days.keys()].sort();
	for (const day of sortedDays) {
		if (grouping !== 'day') {
			lines.push(`## ${day}`, '');
		}
		renderMessages(lines, days.get(day) ?? []);
	}
	return lines.join('\n').trimEnd();
}

export function buildChatPeriodDoc(
	chat: ChatSummary,
	grouping: ChatGrouping,
	key: string,
	days: Map<string, ChatMessage[]>,
): WireDoc {
	const title = chatTitle(chat);
	const sortedDays = [...days.keys()].sort();
	const firstDay = sortedDays[0];
	const lastDay = sortedDays[sortedDays.length - 1];
	const label = grouping === 'chat'
		? (firstDay === lastDay ? firstDay : `${firstDay} ~ ${lastDay}`)
		: periodLabel(key, grouping);
	const lastMessages = days.get(lastDay) ?? [];
	const lastMessage = lastMessages[lastMessages.length - 1];
	const messageCount = sortedDays.reduce(
		(count, day) => count + (days.get(day)?.length ?? 0),
		0,
	);
	// A whole-chat doc can outgrow the content cap; drop the oldest days
	// first so the recent history survives instead of the tail being cut.
	let renderDays = days;
	let rendered = renderChatPeriod(title, label, renderDays, grouping);
	if (grouping === 'chat') {
		const encoder = new TextEncoder();
		let dropFrom = 0;
		while (
			encoder.encode(rendered).length > MAX_CONTENT_BYTES &&
			dropFrom < sortedDays.length - 1
		) {
			dropFrom += 1;
			renderDays = new Map(
				sortedDays.slice(dropFrom).map((day) => [day, days.get(day) ?? []]),
			);
			rendered = `${
				renderChatPeriod(title, label, renderDays, grouping)
			}\n\n…(更早的消息因长度限制被省略)`;
		}
	}
	const { content, bytes } = clampUtf8(
		rendered,
		MAX_CONTENT_BYTES,
		TRUNCATION_NOTICE,
	);
	return {
		id: chatDocId(chat.chat_id, key),
		title: grouping === 'chat' ? title : `${title} · ${label}`,
		content,
		content_format: 'markdown',
		doc_type: 'feishu:chat',
		doc_updated_at: isoFromLarkTime(lastMessage?.create_time),
		original_file_size: bytes,
		metadata: {
			// lark-cli builds the AppLink for the user's tenant (Feishu or
			// Lark); older versions omit it, and Feishu's is the fallback.
			url: httpUrl(chat.app_link) ??
				`https://applink.feishu.cn/client/chat/open?openChatId=${chat.chat_id}`,
			chat_id: chat.chat_id,
			chat_name: title,
			date: label,
			grouping,
			message_count: messageCount,
		},
	};
}

/**
 * A document is skipped only when it is already indexed AND its signature
 * matches the one committed with its last successful upsert. The signature
 * covers the edit time and the source position, so a match means this exact
 * version is indexed. A doc missing from the index (never fetched, fetch
 * failed last poll, or deleted-then-restored) or without an edit time is
 * always refetched.
 */
export function isUnchangedDoc(
	entity: Pick<SearchEntity, 'token' | 'editedAt'>,
	indexedTokens: ReadonlySet<string>,
	previousSignature: string | undefined,
	signature: string,
): boolean {
	return indexedTokens.has(entity.token) && entity.editedAt != null &&
		previousSignature === signature;
}

export default class LarkConnector extends Connector<
	ManifestConfig,
	LarkState
> {
	protected locationBudgetMs = LOCATION_BUDGET_MS;
	protected logger = createLogger('lark');

	protected createClient(): LarkCliClient {
		return new LarkCliClient(LARK_CLI, this.signal, { logger: this.logger });
	}

	/**
	 * Intermediate batches carry upserts only. Deletes go in the last batch
	 * with the state, once every phase succeeded: a poll that fails midway
	 * then applies no delete its uncommitted state would not know about.
	 * (The host still applies that last batch before it commits the state;
	 * closing that gap is the host's job.)
	 */
	async *poll(): AsyncGenerator<PollResult, void, unknown> {
		const client = this.createClient();
		const grouping: ChatGrouping = this.config.chat_grouping === 'day'
			? 'day'
			: this.config.chat_grouping === 'chat'
			? 'chat'
			: 'week';
		const state: LarkState = {
			docs: { ...(this.lastState?.docs ?? {}) },
			doc_signatures: { ...(this.lastState?.doc_signatures ?? {}) },
			positions_epoch: this.lastState?.positions_epoch ??
				crypto.randomUUID(),
			chats: { ...(this.lastState?.chats ?? {}) },
			chat_grouping: this.lastState?.chat_grouping,
			retired_chat_docs: [...(this.lastState?.retired_chat_docs ?? [])],
		};

		const deletes = yield* this.pollDocs(client, state);

		const recordedChatIds = Object.entries(state.chats ?? {}).flatMap((
			[chatId, record],
		) => record.periods.map((key) => chatDocId(chatId, key)));
		if (!this.config.index_chat_history) {
			// Turned off in the settings: remove the chat index now.
			deletes.push(...recordedChatIds, ...state.retired_chat_docs!);
			state.chats = {};
			state.chat_grouping = undefined;
			state.retired_chat_docs = [];
		} else {
			if (state.chat_grouping != null && state.chat_grouping !== grouping) {
				// The doc ids are keyed by grouping: rebuild under the new one,
				// and retire the old docs once that rebuild is complete.
				state.retired_chat_docs!.push(...recordedChatIds);
				state.chats = {};
			}
			state.chat_grouping = grouping;
			const complete = yield* this.pollChats(client, state, grouping);
			if (complete && state.retired_chat_docs!.length > 0) {
				const current = new Set(
					Object.entries(state.chats ?? {}).flatMap(([chatId, record]) =>
						record.periods.map((key) => chatDocId(chatId, key))
					),
				);
				deletes.push(
					...state.retired_chat_docs!.filter((id) => !current.has(id)),
				);
				state.retired_chat_docs = [];
			}
		}

		yield { updates: [...new Set(deletes)].map((id) => del(id)), state };
	}

	/**
	 * Enumerates every visible document's metadata through the two
	 * complementary Search v2 passes (see LarkCliClient.searchDocs). A
	 * document is refetched when content or source metadata changes, or
	 * when it is not in the index yet — so a failed fetch is retried on the
	 * next poll. Returns the doc ids to delete, decided in
	 * `reconcileDocDeletions`.
	 */
	private async *pollDocs(
		client: LarkCliClient,
		state: LarkState,
	): AsyncGenerator<PollResult, string[]> {
		const known = state.docs ?? {};
		const knownTokens = new Set(Object.keys(known));
		const epoch = state.positions_epoch!;
		const enumerated = new Set<string>();
		const fetchedRefs = new Map<string, string>();
		const processed = new Set<string>();
		const locations = new DocLocationResolver(
			client,
			this.signal,
			this.locationBudgetMs,
			this.logger,
		);
		const signatures = { ...(state.doc_signatures ?? {}) };
		const cache = await readPositionCache(this.dataDir, epoch, this.logger);
		const positions = cache.positions;
		let positionsChanged = !cache.matched;
		let complete = true;

		passes: for (const sortByEditTime of [false, true]) {
			const pages = paginate(
				async (pageToken) => {
					const page = await client.searchDocs({ sortByEditTime, pageToken });
					return {
						items: page.entities,
						hasMore: page.hasMore,
						nextCursor: page.pageToken,
					};
				},
				{ signal: this.signal, context: 'lark-cli drive +search' },
			);
			while (true) {
				let entities: SearchEntity[];
				try {
					const next = await pages.next();
					if (next.done) break;
					entities = next.value.items;
				} catch (error) {
					if (
						error instanceof LarkCliError && error.missingScopes.length > 0
					) {
						this.logger.warn(
							`skipping cloud documents (${error.message}). Grant access with: lark-cli auth login --scope "${
								error.missingScopes.join(' ')
							}"`,
						);
						complete = false;
						break passes;
					}
					throw error;
				}

				const updates: DocUpdate[] = [];
				for (const entity of entities) {
					this.signal.throwIfAborted();
					if (processed.has(entity.token)) {
						continue;
					}
					processed.add(entity.token);
					if (!Object.hasOwn(INDEXABLE_DOC_TYPES, entity.type)) {
						continue;
					}
					enumerated.add(entity.token);
					const position = await locations.resolve(
						entity,
						positions[entity.token],
					);
					const signature = await sha256Hex(JSON.stringify([
						'markdown-source-v2',
						entity.token,
						entity.type,
						entity.title,
						entity.editedAt,
						entity.createdAt,
						entity.url,
						entity.owner,
						position,
					]));
					if (
						isUnchangedDoc(
							entity,
							knownTokens,
							signatures[entity.token],
							signature,
						)
					) {
						continue;
					}
					// lark-cli fetches by source URL (it unwraps wiki URLs), else by
					// the underlying docx token. No URL is guessed, so the tenant
					// domain never has to be.
					const ref = entity.url ?? position.url ??
						position.feishu?.obj_token ?? entity.token;
					const doc = await this.fetchCloudDoc(client, entity, ref, position);
					if (doc == null) {
						continue;
					}
					updates.push(upsert(doc));
					signatures[entity.token] = signature;
					positions[entity.token] = position;
					positionsChanged = true;
					fetchedRefs.set(entity.token, ref);
				}
				// One batch per page, also when empty: it is the heartbeat that
				// keeps the host from treating a long unchanged pass as hung.
				yield { updates };
			}
		}

		const deleted = new Set(
			await this.reconcileDocDeletions(client, known, {
				seen: enumerated,
				complete,
			}),
		);
		const next: Record<string, string> = {};
		for (const token of enumerated) {
			const ref = fetchedRefs.get(token) ?? known[token];
			if (ref != null) {
				next[token] = ref;
			}
		}
		for (const [token, ref] of Object.entries(known)) {
			if (!enumerated.has(token) && !deleted.has(token)) {
				next[token] = ref;
			}
		}

		state.docs = next;
		state.doc_signatures = Object.fromEntries(
			Object.entries(signatures).filter(([token]) => token in next),
		);
		const keptPositions = Object.fromEntries(
			Object.entries(positions).filter(([token]) => token in next),
		);
		if (
			positionsChanged ||
			Object.keys(keptPositions).length !== Object.keys(positions).length
		) {
			await writePositionCache(
				this.dataDir,
				epoch,
				keptPositions,
				this.logger,
			);
		}
		return [...deleted].map((token) => cloudDocId(token));
	}

	/**
	 * The one place indexed cloud documents are deleted; returns the tokens
	 * to delete. Search recall is unstable between polls (indexed docs
	 * routinely drop out of one enumeration and reappear in the next), so a
	 * document a complete enumeration missed is deleted only when a direct
	 * fetch confirms it is gone or no longer accessible (`isConfirmedGone`).
	 * An incomplete or empty enumeration deletes nothing.
	 */
	private async reconcileDocDeletions(
		client: LarkCliClient,
		known: Record<string, string>,
		enumeration: Enumeration,
	): Promise<string[]> {
		const stale = staleIds(Object.keys(known), enumeration);
		if (stale.length > 0 && enumeration.seen.size === 0) {
			// An empty enumeration is a source-side recall glitch, not mass
			// deletion: keep the index untouched.
			this.logger.warn(
				'document enumeration returned nothing; skipping deletion pass',
			);
			return [];
		}
		const deleted: string[] = [];
		for (const token of stale) {
			this.signal.throwIfAborted();
			try {
				await client.fetchDocMarkdown(known[token]);
			} catch (error) {
				if (isFatalError(error, this.signal)) throw error;
				if (isConfirmedGone(error)) {
					this.logger.info('deleting a document that is gone at the source', {
						token,
						reason: errorMessage(error),
					});
					deleted.push(token);
				} else {
					this.logger.warn(
						'keeping a document missing from enumeration: cannot confirm it is gone',
						{ token, reason: errorMessage(error) },
					);
				}
			}
		}
		return deleted;
	}

	private async fetchCloudDoc(
		client: LarkCliClient,
		entity: SearchEntity,
		ref: string,
		position: CloudPosition,
	): Promise<WireDoc | null> {
		try {
			const content = await client.fetchDocMarkdown(ref);
			if (content == null) {
				this.logger.warn('document has no content; skipped', {
					type: entity.type,
					token: entity.token,
				});
				return null;
			}
			return buildCloudDoc(entity, cleanupDocMarkdown(content), position);
		} catch (error) {
			if (isFatalError(error, this.signal)) throw error;
			this.logger.warn('failed to fetch a document; retrying next poll', {
				type: entity.type,
				token: entity.token,
				reason: errorMessage(error),
			});
			return null;
		}
	}

	/**
	 * Chat history is indexed as one document per chat per period (day, ISO
	 * week, or the whole chat within the lookback window). Chats are listed
	 * most recently active first; a failure to list them skips the rest of
	 * the chats for this poll instead of failing it (documents and the chats
	 * already synced still commit). Returns whether every chat was listed
	 * and synced.
	 */
	private async *pollChats(
		client: LarkCliClient,
		state: LarkState,
		grouping: ChatGrouping,
	): AsyncGenerator<PollResult, boolean> {
		// `chat_history_days` is optional (`required: false`). `undefined > 0` is
		// false, so the assertions only hold where the value is a positive number.
		const lookbackDays = this.config.chat_history_days! > 0
			? this.config.chat_history_days!
			: DEFAULT_CHAT_LOOKBACK_DAYS;
		const defaultStartDay = localDateString(
			new Date(Date.now() - lookbackDays * 86_400_000),
		);
		const records = state.chats ?? {};
		state.chats = records;

		const pages = paginate(
			async (pageToken) => {
				const page = await client.listChats(pageToken);
				return {
					items: page.chats,
					hasMore: page.hasMore,
					nextCursor: page.pageToken,
				};
			},
			{ signal: this.signal, context: 'lark-cli im +chat-list' },
		);
		let complete = true;
		while (true) {
			let chats: ChatSummary[];
			try {
				const next = await pages.next();
				if (next.done) return complete;
				chats = next.value.items;
			} catch (error) {
				if (isFatalError(error, this.signal)) throw error;
				const scopes = error instanceof LarkCliError &&
						error.missingScopes.length > 0
					? ` Grant access with: lark-cli auth login --scope "${
						error.missingScopes.join(' ')
					}"`
					: '';
				this.logger.warn(
					`skipping chats this poll: ${errorMessage(error)}.${scopes}`,
				);
				return false;
			}
			for (const chat of chats) {
				this.signal.throwIfAborted();
				const updates = await this.syncChat(
					client,
					chat,
					records,
					grouping,
					defaultStartDay,
				);
				if (updates == null) {
					complete = false;
				} else if (updates.length > 0) {
					yield { updates };
				}
			}
			yield { updates: [] };
		}
	}

	/**
	 * Refetches one chat from the start of the period holding its newest
	 * indexed message, so the still-open period is rebuilt complete, and
	 * returns upserts for the docs whose content changed, or null when the
	 * chat's messages could not be listed. The reopened period's doc is
	 * skipped when its signature matches the last upsert. Whole-chat docs
	 * first probe for a new message (`hasNewMessages`) before refetching the
	 * lookback window.
	 */
	private async syncChat(
		client: LarkCliClient,
		chat: ChatSummary,
		records: Record<string, ChatRecord>,
		grouping: ChatGrouping,
		defaultStartDay: string,
	): Promise<DocUpdate[] | null> {
		const record = records[chat.chat_id];
		let messages: ChatMessage[];
		try {
			if (
				grouping === 'chat' && record != null &&
				!(await this.hasNewMessages(client, chat.chat_id, record))
			) {
				return [];
			}
			const fromDay = grouping === 'chat'
				? defaultStartDay
				: grouping === 'week'
				? weekStartDay(record?.cursor ?? defaultStartDay)
				: record?.cursor ?? defaultStartDay;
			messages = await this.listMessages(client, chat.chat_id, fromDay);
		} catch (error) {
			if (isFatalError(error, this.signal)) throw error;
			this.logger.warn('failed to list the messages of a chat', {
				chat_id: chat.chat_id,
				reason: errorMessage(error),
			});
			return null;
		}

		const periods = [
			...groupDaysByPeriod(groupMessagesByDay(messages), grouping),
		].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		if (periods.length === 0) {
			return [];
		}

		const reopenedKey = record == null
			? undefined
			: periodKey(record.cursor.slice(0, 10), grouping);
		const keys = new Set(record?.periods ?? []);
		const updates: DocUpdate[] = [];
		let cursor = record?.cursor ?? '';
		let lastMessageId = record?.last_message_id;
		let signature: string | undefined;
		for (const [key, days] of periods) {
			const doc = buildChatPeriodDoc(chat, grouping, key, days);
			signature = await sha256Hex(
				JSON.stringify([
					doc.title,
					doc.content,
					doc.doc_updated_at,
					doc.metadata,
				]),
			);
			if (key !== reopenedKey || signature !== record?.signature) {
				updates.push(upsert(doc));
			}
			keys.add(key);
			for (const [day, dayMessages] of days) {
				if (grouping !== 'chat') {
					if (day > cursor) cursor = day;
					continue;
				}
				const last = dayMessages[dayMessages.length - 1];
				if (last?.create_time != null && last.create_time >= cursor) {
					cursor = last.create_time;
					lastMessageId = last.message_id;
				}
			}
		}
		records[chat.chat_id] = {
			cursor,
			...(lastMessageId == null ? {} : { last_message_id: lastMessageId }),
			periods: [...keys].sort(),
			signature,
		};
		return updates;
	}

	/**
	 * Cheap probe for whole-chat docs: pages forward from the day of the
	 * newest indexed message and stops at the first newer one. A message is
	 * newer when the ascending listing has it after `last_message_id`, or —
	 * when that message is no longer listed (recalled) — when its minute is
	 * later than the cursor. Quiet chats usually cost one page.
	 */
	private async hasNewMessages(
		client: LarkCliClient,
		chatId: string,
		record: ChatRecord,
	): Promise<boolean> {
		const startISO = dayStartISO(record.cursor.slice(0, 10));
		let passedLast = false;
		for await (const page of this.messagePages(client, chatId, startISO)) {
			for (const message of page.items) {
				if (
					record.last_message_id != null &&
					message.message_id === record.last_message_id
				) {
					passedLast = true;
					continue;
				}
				if (message.deleted === true) {
					continue;
				}
				if (
					passedLast ||
					(message.create_time != null && message.create_time > record.cursor)
				) {
					return true;
				}
			}
		}
		return false;
	}

	private async listMessages(
		client: LarkCliClient,
		chatId: string,
		sinceDay: string,
	): Promise<ChatMessage[]> {
		const messages: ChatMessage[] = [];
		for await (
			const page of this.messagePages(client, chatId, dayStartISO(sinceDay))
		) {
			messages.push(...page.items);
		}
		return messages;
	}

	/** A chat's messages from `startISO` on, oldest first, page by page. */
	private messagePages(
		client: LarkCliClient,
		chatId: string,
		startISO: string,
	) {
		return paginate(
			async (pageToken) => {
				const page = await client.listMessages(chatId, startISO, pageToken);
				return {
					items: page.messages,
					hasMore: page.hasMore,
					nextCursor: page.pageToken,
				};
			},
			{ signal: this.signal, context: 'lark-cli im +chat-messages-list' },
		);
	}
}
