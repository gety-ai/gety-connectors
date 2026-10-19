// Deletions from a diff of known ids against one poll's enumeration.

export interface Enumeration {
	seen: ReadonlySet<string>;
	/**
	 * True only when the enumeration covered the whole source: no abort, no
	 * skipped subtree or page, no unreadable entry. A partial enumeration
	 * cannot tell "deleted" from "not reached", so it yields no deletions.
	 */
	complete: boolean;
}

/**
 * Ids in `known` that `enumeration` did not see, in `known`'s iteration
 * order; `[]` when the enumeration is incomplete.
 */
export function staleIds(
	known: Iterable<string>,
	enumeration: Enumeration,
): string[] {
	if (!enumeration.complete) {
		return [];
	}
	const stale: string[] = [];
	for (const id of known) {
		if (!enumeration.seen.has(id)) {
			stale.push(id);
		}
	}
	return stale;
}
