export function dateToIso(
	value: Date | string | null | undefined,
): string | null {
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : value.toISOString();
	}
	if (typeof value === 'string') {
		return Number.isNaN(new Date(value).getTime()) ? null : value;
	}
	return null;
}

export function formatLinearTime(
	value: Date | string | null | undefined,
): string | null {
	const iso = dateToIso(value);
	if (iso == null) {
		return null;
	}
	// Rendered in UTC; say so, since readers assume their local time.
	return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

export function dateToTime(
	value: Date | string | null | undefined,
): number | null {
	const iso = dateToIso(value);
	if (iso == null) {
		return null;
	}
	const time = new Date(iso).getTime();
	return Number.isNaN(time) ? null : time;
}

export function maxIsoDate(
	a: string | null | undefined,
	b: string | null | undefined,
): string | undefined {
	if (a == null) {
		return b ?? undefined;
	}
	if (b == null) {
		return a;
	}
	return new Date(b).getTime() > new Date(a).getTime() ? b : a;
}
