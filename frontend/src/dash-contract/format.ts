/**
 * Formatting.
 *
 * Provided by the contract rather than left to each program so that a number
 * means the same thing in a KPI, a table cell, an axis tick and a PDF. A view
 * that formats its own values drifts from every other view the moment someone
 * picks a different number of decimals.
 *
 * The rule that matters most here: **null is not zero.** A missing value and a
 * measured zero are different claims, and only this layer knows how to say so —
 * which is why every formatter takes the raw value and decides, rather than
 * receiving something a caller has already coerced with `?? 0`.
 */
import type { ColumnMeta, ScalarValue, ValueFormat } from './types';
import type { ContractMeta } from './meta';

/** One locale for every formatter, so grouping and dates agree across a dashboard. */
export const LOCALE = 'en-US';

const DEFAULT_NULL = '—';

const isMissing = (v: unknown): boolean =>
	v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));

/** `1.2M`, `840K`, `1.3B`. Below 10,000 it is not worth the loss of precision. */
export function formatCompact(value: number): string {
	const abs = Math.abs(value);
	if (abs < 10_000) return formatNumber(value);
	const units: [number, string][] = [
		[1e12, 'T'],
		[1e9, 'B'],
		[1e6, 'M'],
		[1e3, 'K'],
	];
	for (let i = 0; i < units.length; i++) {
		const [size, suffix] = units[i];
		if (abs < size) continue;
		const scaled = value / size;
		const decimals = Math.abs(scaled) < 10 ? 1 : 0;
		/* Rounding can carry into the next unit: 99.96L rounds to "100L", which is
		 * 1Cr and should read as such. Compare the rounded figure with how many of
		 * this unit make one of the next, and step up when it reaches it. */
		const larger = units[i - 1];
		const factor = Math.pow(10, decimals);
		const rounded = Math.round(Math.abs(scaled) * factor) / factor;
		if (larger && rounded >= larger[0] / size) {
			const up = value / larger[0];
			return `${trim(up, Math.abs(up) < 10 ? 1 : 0)}${larger[1]}`;
		}
		return `${trim(scaled, decimals)}${suffix}`;
	}
	return formatNumber(value);
}

const trim = (n: number, decimals: number): string =>
	n.toLocaleString(LOCALE, { minimumFractionDigits: 0, maximumFractionDigits: decimals });

export function formatNumber(value: number, decimals?: number): string {
	return value.toLocaleString(LOCALE, {
		minimumFractionDigits: decimals ?? 0,
		maximumFractionDigits: decimals ?? 0,
	});
}

export function formatCurrency(value: number, currency = 'USD', decimals = 0): string {
	return value.toLocaleString(LOCALE, {
		style: 'currency',
		currency,
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	});
}

export function formatPercent(value: number, decimals = 1): string {
	return `${trim(value * 100, decimals)}%`;
}

export function formatDate(value: string): string {
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return value;
	return d.toLocaleDateString(LOCALE, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The general entry point. Takes a raw value plus either a format or the column
 * it came from, and never guesses past what it was told.
 */
export function formatValue(
	value: unknown,
	spec?: ValueFormat | ColumnMeta,
): string {
	const format: ValueFormat | undefined =
		spec && 'dataType' in (spec as ColumnMeta)
			? (spec as ColumnMeta).format
			: (spec as ValueFormat | undefined);

	if (isMissing(value)) return format?.nullDisplay ?? DEFAULT_NULL;

	if (typeof value === 'boolean') return value ? 'Yes' : 'No';

	const style = format?.style;

	if (typeof value === 'number' || (style && style !== 'text' && !Number.isNaN(Number(value)))) {
		let n = Number(value);
		if (format?.scale) n *= format.scale;

		let body: string;
		switch (style) {
			case 'currency':
				body = format?.compact
					? `${currencySymbol(format.currency)}${formatCompact(n)}`
					: formatCurrency(n, format?.currency ?? 'USD', format?.decimals ?? 0);
				break;
			case 'percent':
				body = formatPercent(n, format?.decimals ?? 1);
				break;
			case 'number':
			default:
				body = format?.compact ? formatCompact(n) : formatNumber(n, format?.decimals);
		}
		return `${format?.prefix ?? ''}${body}${format?.suffix ?? ''}`;
	}

	if (style === 'date') return formatDate(String(value));

	return `${format?.prefix ?? ''}${String(value)}${format?.suffix ?? ''}`;
}

/**
 * The exact figure, for a hover — or undefined when hovering would add nothing.
 *
 * Only numbers have a "raw" worth showing, and only when the display shortened
 * or rounded them: a cell that already reads `1,06,139` gains nothing from a
 * tooltip saying `1,06,139`, and one on every cell is noise a reader learns to
 * ignore.
 */
export function formatRaw(value: unknown, spec?: ValueFormat | ColumnMeta): string | undefined {
	if (isMissing(value) || typeof value === 'boolean') return undefined;
	const format: ValueFormat | undefined =
		spec && 'dataType' in (spec as ColumnMeta)
			? (spec as ColumnMeta).format
			: (spec as ValueFormat | undefined);
	const style = format?.style;
	if (style === 'text' || style === 'date') return undefined;
	if (typeof value !== 'number' && (value === '' || Number.isNaN(Number(value)))) return undefined;

	let n = Number(value);
	if (format?.scale) n *= format.scale;

	let body: string;
	switch (style) {
		case 'currency':
			body = n.toLocaleString(LOCALE, {
				style: 'currency',
				currency: format?.currency ?? 'USD',
				minimumFractionDigits: 0,
				maximumFractionDigits: 2,
			});
			break;
		case 'percent':
			body = `${(n * 100).toLocaleString(LOCALE, { maximumFractionDigits: 4 })}%`;
			break;
		default:
			body = n.toLocaleString(LOCALE, { maximumFractionDigits: 6 });
	}
	const full = `${format?.prefix ?? ''}${body}${format?.suffix ?? ''}`;
	return full === formatValue(value, spec) ? undefined : full;
}

/**
 * Compact currency needs the symbol separately, because `Intl` will not give
 * "$1.2M" — it insists on either full precision or its own notation.
 */
function currencySymbol(currency = 'USD'): string {
	try {
		const parts = (0)
			.toLocaleString(LOCALE, { style: 'currency', currency, minimumFractionDigits: 0 })
			.match(/^[^\d]+/);
		return parts?.[0] ?? '';
	} catch {
		return '';
	}
}

/** Column label, falling back to a humanised name. */
export function columnLabel(column: ColumnMeta): string {
	if (column.label) return column.label;
	return column.name
		.replace(/[_-]+/g, ' ')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/^\w/, (c) => c.toUpperCase());
}

/** Right-align numbers, left-align everything else, unless told otherwise. */
export function alignFor(column: ColumnMeta | undefined, value: ScalarValue): 'left' | 'right' {
	if (column?.format?.align && column.format.align !== 'center') return column.format.align;
	if (column && (column.dataType === 'number' || column.dataType === 'integer')) return 'right';
	return typeof value === 'number' ? 'right' : 'left';
}

/* -------------------------------- metadata --------------------------------- */

/** See `meta.ts`. An assignment for a name that no longer exists fails to compile. */

formatValue.Metadata = {
	kind: 'format',
	purpose: "Format by the column's own type and semantics.",
	useWhen:
		'The default choice — it reads the resolver’s column metadata and the viewer’s locale, so ' +
		'a currency stays a currency on an axis, in a tooltip and in a table cell.',
	props: {
		value: { description: 'The raw value, which may be null.', importance: 'required' },
		spec: {
			description: 'Either a ValueFormat or the ColumnMeta it came from — pass the column and it reads the format off it.',
			importance: 'recommended',
			caution: 'Without it a currency renders as a bare number and the reader supplies the wrong unit.',
		},
	},
	notes:
		'Renders null as "—" rather than 0. That distinction is the point: declare the format once on ' +
		'the resolver’s columns and every panel reads the same way.',
} satisfies ContractMeta;

formatNumber.Metadata = {
	kind: 'format',
	purpose: 'A number, grouped by locale.',
	props: {
		value: { description: 'The number.', importance: 'required' },
		decimals: { description: 'Decimal places.', default: 0 },
	},
} satisfies ContractMeta;

formatCurrency.Metadata = {
	kind: 'format',
	purpose: "An amount in the viewer's currency.",
	props: {
		value: { description: 'The amount.', importance: 'required' },
		currency: { description: 'ISO 4217 code — "USD", "EUR", "INR".', default: 'USD' },
		decimals: { description: 'Decimal places.', default: 0 },
	},
} satisfies ContractMeta;

formatPercent.Metadata = {
	kind: 'format',
	purpose: 'A ratio as a percentage.',
	props: {
		value: {
			description: 'The ratio.',
			importance: 'required',
			caution: 'A ratio, not a percentage — 0.42 renders as 42%, and 42 renders as 4,200%.',
		},
		decimals: { description: 'Decimal places.', default: 1 },
	},
} satisfies ContractMeta;

formatCompact.Metadata = {
	kind: 'format',
	purpose: 'A short form for tight space — 1.2L, 3.4Cr.',
	useWhen: 'Axis ticks and Metric values, where the full figure will not fit.',
	props: {
		value: {
			description: 'The number.',
			importance: 'required',
			caution:
				'Not for a table column someone might add up — a column of rounded figures does not ' +
				'sum to its own total.',
		},
	},
} satisfies ContractMeta;

formatDate.Metadata = {
	kind: 'format',
	purpose: "A date, by the viewer's locale.",
	props: {
		value: {
			description: 'An ISO date string.',
			importance: 'required',
			caution: 'A string, not a Date. An unparseable string is returned unchanged rather than shown as "Invalid Date".',
		},
	},
} satisfies ContractMeta;
