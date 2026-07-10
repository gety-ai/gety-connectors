import {
	Connector,
	del,
	type DocUpdate,
	type PollResult,
	upsert,
	type WireDoc,
} from '@gety-ai/connector-sdk';
import type { ManifestConfig } from './gen/manifest.d.ts';
import { cleanupDocMarkdown } from './doc_markdown.ts';
import {
	buildDocUrl,
	type ChatMessage,
	type ChatSummary,
	isoFromLarkTime,
	LarkCliClient,
	LarkCliError,
	type SearchEntity,
} from './lark_cli.ts';

export type ChatGrouping = 'day' | 'week' | 'chat';

export type FeishuState = {
	/** RFC 3339 edit time of the newest cloud document indexed so far. */
	docs_high_water?: string;
	/** token -> fetch URL of the cloud documents currently in the index. */
	docs?: Record<string, string>;
	/** chat_id -> local date (YYYY-MM-DD) from which the chat is refetched. */
	chat_cursors?: Record<string, string>;
	/** ids of the chat transcript docs currently in the index. */
	chat_doc_ids?: string[];
	/** grouping the indexed chat docs were built with. */
	chat_grouping?: ChatGrouping;
};

const DEFAULT_CHAT_LOOKBACK_DAYS = 30;
/**
 * doc_types values whose content lark-cli can export as markdown. Sheets,
 * bitables, slides, shortcuts, and legacy "doc" documents (rejected by the
 * v2 fetch API) are enumerated by search but not indexed.
 */
const INDEXABLE_DOC_TYPES = new Set(['docx']);
/** Stays below Gety's ~10 MB per-document limit with headroom for metadata. */
const MAX_CONTENT_BYTES = 8_000_000;
const TRUNCATION_NOTICE = '\n\n…(内容超长,已被连接器截断)';
const DELETE_BATCH_SIZE = 200;

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

export function clampContent(
	text: string,
): { content: string; bytes: number } {
	const encoder = new TextEncoder();
	const originalBytes = encoder.encode(text).length;
	if (originalBytes <= MAX_CONTENT_BYTES) {
		return { content: text, bytes: originalBytes };
	}

	const noticeBytes = encoder.encode(TRUNCATION_NOTICE).length;
	const budget = MAX_CONTENT_BYTES - noticeBytes;
	let low = 0;
	let high = text.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (encoder.encode(text.slice(0, middle)).length <= budget) {
			low = middle;
		} else {
			high = middle - 1;
		}
	}
	let prefix = text.slice(0, low);
	if (/[\uD800-\uDBFF]$/.test(prefix)) {
		prefix = prefix.slice(0, -1);
	}
	const content = prefix + TRUNCATION_NOTICE;
	return { content, bytes: encoder.encode(content).length };
}

export function buildCloudDoc(entity: SearchEntity, raw: string): WireDoc {
	const { content, bytes } = clampContent(raw);
	return {
		id: `feishu:doc:${entity.token}`,
		title: entity.title,
		content,
		content_format: 'markdown',
		doc_type: `feishu:${entity.type}`,
		doc_updated_at: entity.editedAt,
		original_file_size: bytes,
		metadata: {
			url: entity.url,
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

/** Groups per-day buckets into period buckets ("2026-07-10" or "2026-W28"). */
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
	const { content, bytes } = clampContent(rendered);
	return {
		id: grouping === 'chat'
			? `feishu:chat:${chat.chat_id}`
			: `feishu:chat:${chat.chat_id}:${key}`,
		title: grouping === 'chat' ? title : `${title} · ${label}`,
		content,
		content_format: 'markdown',
		doc_type: 'feishu:chat',
		doc_updated_at: isoFromLarkTime(lastMessage?.create_time),
		original_file_size: bytes,
		metadata: {
			url:
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
 * A document is skipped only when it is already indexed AND not edited past
 * the high-water mark. A doc missing from the index (never fetched, fetch
 * failed last poll, or deleted-then-restored) is always refetched.
 */
export function isUnchangedDoc(
	entity: Pick<SearchEntity, 'token' | 'editedAt'>,
	indexedTokens: ReadonlySet<string>,
	previousMark: string | undefined,
): boolean {
	return indexedTokens.has(entity.token) &&
		entity.editedAt != null && previousMark != null &&
		entity.editedAt <= previousMark;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function chunks<T>(values: T[], size: number): T[][] {
	const result: T[][] = [];
	for (let index = 0; index < values.length; index += size) {
		result.push(values.slice(index, index + size));
	}
	return result;
}

export default class FeishuConnector extends Connector<
	ManifestConfig,
	FeishuState
> {
	protected createClient(): LarkCliClient {
		const bin = this.config.lark_cli_path?.trim() || 'lark-cli';
		return new LarkCliClient(bin, this.signal);
	}

	async *poll(): AsyncGenerator<PollResult, void, unknown> {
		const client = this.createClient();
		const grouping: ChatGrouping = this.config.chat_grouping === 'day'
			? 'day'
			: this.config.chat_grouping === 'chat'
			? 'chat'
			: 'week';
		const state: FeishuState = {
			docs_high_water: this.lastState?.docs_high_water,
			docs: { ...(this.lastState?.docs ?? {}) },
			chat_cursors: { ...(this.lastState?.chat_cursors ?? {}) },
			chat_doc_ids: [...(this.lastState?.chat_doc_ids ?? [])],
			chat_grouping: this.lastState?.chat_grouping,
		};

		if (!this.config.index_chat_history) {
			// Chat indexing was turned off: remove previously indexed chats.
			yield* this.purgeChatIndex(state);
		} else if (
			state.chat_grouping != null && state.chat_grouping !== grouping
		) {
			// Grouping changed: doc ids are keyed differently, so drop and
			// rebuild the whole chat index from the lookback window.
			yield* this.purgeChatIndex(state);
		} else if (
			(state.chat_doc_ids ?? []).some((id) => /:\d{4}-W\d{2}$/.test(id))
		) {
			// One-time migration off the retired "2026-W28" week-key format.
			yield* this.purgeChatIndex(state);
		}

		yield* this.pollDocs(client, state);

		if (this.config.index_chat_history) {
			state.chat_grouping = grouping;
			yield* this.pollChats(client, state, grouping);
		}
	}

	private *purgeChatIndex(state: FeishuState): Generator<PollResult> {
		const ids = state.chat_doc_ids ?? [];
		state.chat_cursors = {};
		state.chat_grouping = undefined;
		if (ids.length === 0) {
			state.chat_doc_ids = [];
			return;
		}
		const remaining = new Set(ids);
		for (const batch of chunks(ids, DELETE_BATCH_SIZE)) {
			for (const id of batch) {
				remaining.delete(id);
			}
			state.chat_doc_ids = [...remaining];
			yield {
				updates: batch.map((id) => del(id)),
				state: structuredClone(state),
			};
		}
	}

	/**
	 * Enumerates every visible document's metadata through the two
	 * complementary Search v2 passes (see LarkCliClient.searchDocs). A
	 * document is refetched when it was edited past the high-water mark or
	 * when it is not in the index yet — so a failed fetch is retried on the
	 * next poll instead of being lost behind the advancing mark.
	 *
	 * Enumeration recall is unstable between polls (indexed docs routinely
	 * drop out of one enumeration and reappear in the next), so a document
	 * missing from a completed enumeration is deleted only after a direct
	 * fetch of its stored URL confirms it is no longer accessible. The mark
	 * and the token->url index are committed in one final state.
	 */
	private async *pollDocs(
		client: LarkCliClient,
		state: FeishuState,
	): AsyncGenerator<PollResult> {
		const previousMark = state.docs_high_water;
		let newMark = previousMark;
		const known = { ...(state.docs ?? {}) };
		const knownTokens = new Set(Object.keys(known));
		const enumerated = new Set<string>();
		const succeededUrls = new Map<string, string>();
		const processed = new Set<string>();

		for (const sortByEditTime of [false, true]) {
			let pageToken: string | undefined;

			while (!this.signal.aborted) {
				let page;
				try {
					page = await client.searchDocs({ sortByEditTime, pageToken });
				} catch (error) {
					if (
						error instanceof LarkCliError && error.missingScopes.length > 0
					) {
						console.error(
							`[feishu] skipping cloud documents (${error.message}). ` +
								`Grant access with: lark-cli auth login --scope "${
									error.missingScopes.join(' ')
								}"`,
						);
						return;
					}
					throw error;
				}

				const updates: DocUpdate[] = [];
				for (const entity of page.entities) {
					if (this.signal.aborted) {
						return;
					}
					if (processed.has(entity.token)) {
						continue;
					}
					processed.add(entity.token);
					if (!INDEXABLE_DOC_TYPES.has(entity.type)) {
						continue;
					}
					enumerated.add(entity.token);
					if (isUnchangedDoc(entity, knownTokens, previousMark)) {
						continue;
					}
					const doc = await this.fetchCloudDoc(client, entity);
					if (doc == null) {
						continue;
					}
					updates.push(upsert(doc));
					succeededUrls.set(
						entity.token,
						entity.url ?? buildDocUrl(entity.type, entity.token),
					);
					if (
						entity.editedAt != null &&
						(newMark == null || entity.editedAt > newMark)
					) {
						newMark = entity.editedAt;
					}
				}

				if (updates.length > 0) {
					yield { updates };
				}

				if (
					!page.hasMore || page.pageToken == null ||
					page.pageToken === pageToken
				) {
					break;
				}
				pageToken = page.pageToken;
			}
		}

		if (this.signal.aborted) {
			return;
		}

		const next: Record<string, string> = {};
		for (const token of enumerated) {
			const url = succeededUrls.get(token) ?? known[token];
			if (url != null) {
				next[token] = url;
			}
		}

		const deletes: DocUpdate[] = [];
		if (enumerated.size > 0) {
			for (const token of knownTokens) {
				if (enumerated.has(token)) {
					continue;
				}
				if (this.signal.aborted) {
					return;
				}
				if (await this.isStillFetchable(client, known[token])) {
					next[token] = known[token];
				} else {
					deletes.push(del(`feishu:doc:${token}`));
				}
			}
		} else if (knownTokens.size > 0) {
			// An empty enumeration is a source-side recall glitch, not mass
			// deletion: keep the index untouched.
			console.error(
				'[feishu] document enumeration returned nothing; skipping deletion pass',
			);
			Object.assign(next, known);
		}

		state.docs_high_water = newMark;
		state.docs = next;
		yield { updates: deletes, state: structuredClone(state) };
	}

	/**
	 * True when a document missing from the enumeration can still be fetched
	 * directly — a search recall gap rather than a deletion or lost access.
	 */
	private async isStillFetchable(
		client: LarkCliClient,
		url: string,
	): Promise<boolean> {
		try {
			await client.fetchDocMarkdown(url);
			return true;
		} catch (error) {
			this.signal.throwIfAborted();
			console.error(
				`[feishu] ${url} disappeared from enumeration and cannot be fetched ` +
					`(${errorMessage(error)}); deleting from index`,
			);
			return false;
		}
	}

	private async fetchCloudDoc(
		client: LarkCliClient,
		entity: SearchEntity,
	): Promise<WireDoc | null> {
		try {
			const content = await client.fetchDocMarkdown(
				entity.url ?? entity.token,
			);
			if (content == null) {
				console.error(
					`[feishu] no content in ${entity.type} ${entity.token}; skipped`,
				);
				return null;
			}
			return buildCloudDoc(entity, cleanupDocMarkdown(content));
		} catch (error) {
			this.signal.throwIfAborted();
			console.error(
				`[feishu] failed to fetch ${entity.type} ${entity.token}: ${
					errorMessage(error)
				}`,
			);
			return null;
		}
	}

	/**
	 * Chat history is indexed as one document per chat per period (day, ISO
	 * week, or the whole chat). For day/week, each chat's cursor is the day
	 * of its newest indexed message and the poll refetches from the start of
	 * the period containing that day, so the still-open period is re-upserted
	 * complete. For whole-chat docs the cursor is the newest message's
	 * "YYYY-MM-DD HH:mm" timestamp: a cheap probe from that day decides
	 * whether anything is new before the full window is refetched to rebuild
	 * the single document.
	 */
	private async *pollChats(
		client: LarkCliClient,
		state: FeishuState,
		grouping: ChatGrouping,
	): AsyncGenerator<PollResult> {
		const lookbackDays = this.config.chat_history_days > 0
			? this.config.chat_history_days
			: DEFAULT_CHAT_LOOKBACK_DAYS;
		const defaultStartDay = localDateString(
			new Date(Date.now() - lookbackDays * 86_400_000),
		);
		const chatDocIds = new Set(state.chat_doc_ids ?? []);

		for await (const chat of this.listChats(client)) {
			if (this.signal.aborted) {
				return;
			}
			const cursor = state.chat_cursors?.[chat.chat_id];
			const fetchFromDay = grouping === 'chat'
				? defaultStartDay
				: grouping === 'week'
				? weekStartDay(cursor ?? defaultStartDay)
				: cursor ?? defaultStartDay;

			let messages: ChatMessage[];
			try {
				if (
					grouping === 'chat' && cursor != null &&
					!(await this.hasNewMessages(client, chat.chat_id, cursor))
				) {
					continue;
				}
				messages = await this.listMessages(client, chat.chat_id, fetchFromDay);
			} catch (error) {
				this.signal.throwIfAborted();
				console.error(
					`[feishu] failed to list messages of chat ${chat.chat_id}: ${
						errorMessage(error)
					}`,
				);
				continue;
			}

			const periods = groupDaysByPeriod(groupMessagesByDay(messages), grouping);
			if (periods.size === 0) {
				continue;
			}

			const updates: DocUpdate[] = [];
			let nextCursor = cursor ?? '';
			for (const [key, days] of periods) {
				const doc = buildChatPeriodDoc(chat, grouping, key, days);
				updates.push(upsert(doc));
				chatDocIds.add(doc.id);
				for (const [day, dayMessages] of days) {
					if (grouping === 'chat') {
						const lastTime = dayMessages[dayMessages.length - 1]?.create_time;
						if (lastTime != null && lastTime > nextCursor) {
							nextCursor = lastTime;
						}
					} else if (day > nextCursor) {
						nextCursor = day;
					}
				}
			}

			state.chat_cursors = {
				...(state.chat_cursors ?? {}),
				[chat.chat_id]: nextCursor,
			};
			state.chat_doc_ids = [...chatDocIds].sort();
			yield { updates, state: structuredClone(state) };
		}
	}

	/**
	 * Cheap probe for whole-chat docs: fetch from the cursor's day and check
	 * for any message strictly newer than the cursor ("YYYY-MM-DD HH:mm"
	 * strings compare chronologically). Quiet chats cost one small page
	 * instead of a full-window refetch.
	 */
	private async hasNewMessages(
		client: LarkCliClient,
		chatId: string,
		cursor: string,
	): Promise<boolean> {
		const probe = await this.listMessages(
			client,
			chatId,
			cursor.slice(0, 10),
		);
		return probe.some((message) =>
			message.deleted !== true && message.create_time != null &&
			message.create_time > cursor
		);
	}

	private async *listChats(
		client: LarkCliClient,
	): AsyncGenerator<ChatSummary> {
		let pageToken: string | undefined;

		while (!this.signal.aborted) {
			const page = await client.listChats(pageToken);
			yield* page.chats;

			if (
				!page.hasMore || page.pageToken == null ||
				page.pageToken === pageToken
			) {
				return;
			}
			pageToken = page.pageToken;
		}
	}

	private async listMessages(
		client: LarkCliClient,
		chatId: string,
		sinceDay: string,
	): Promise<ChatMessage[]> {
		const messages: ChatMessage[] = [];
		const startISO = dayStartISO(sinceDay);
		let pageToken: string | undefined;

		while (!this.signal.aborted) {
			const page = await client.listMessages(chatId, startISO, pageToken);
			messages.push(...page.messages);

			if (
				!page.hasMore || page.pageToken == null ||
				page.pageToken === pageToken
			) {
				break;
			}
			pageToken = page.pageToken;
		}

		return messages;
	}
}
