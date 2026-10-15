/**
 * One date, in one box: search the dates that exist, type a date, or open a
 * calendar.
 *
 * Built for "as of" filters — a snapshot date, a reporting date — where the data
 * only has some dates. Clicking the box lists those, newest first, and typing
 * narrows the list ("02-09" finds 02-09-26). A whole date typed in and confirmed
 * with Enter ("02-09-26", "02/09/2026" or "2026-09-02") is taken as it stands, and
 * the calendar button opens the browser's date picker for a click instead. A date
 * the list does not hold is the resolver's to handle (take the nearest earlier
 * one), never this control's to refuse.
 *
 * One parameter, an ISO date (YYYY-MM-DD), or empty for "no date picked" — which
 * the dashboard reads as its default, usually the latest. The first list entry is
 * that empty choice, and `anyLabel` says what it means, ideally with the actual
 * date: "Latest (01-10-26)".
 *
 * Dates are shown day-month-year with a two-digit year. The browser's calendar
 * follows its own locale and cannot be told otherwise; everything this control
 * draws carries the format.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContractMeta } from '../../meta';
import type { Param } from '../../context';
import { T } from '../../theme';
import { PillLabel, bareInput, pillStyle, useAppliesWithBar } from './shared';

/** `2026-09-02` as `02-09-26`. Anything else comes back as it was. */
function formatShortDate(iso: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
	return match ? `${match[3]}-${match[2]}-${match[1].slice(2)}` : iso;
}

/**
 * A whole date typed by hand, as ISO — or null when the text is not one.
 *
 * Day first, as the control shows it: `02-09-26`, `2/9/2026`, `02.09.26`. A
 * two-digit year is 20xx. An ISO date passes through. An impossible one
 * (31-02-26) is refused rather than rolled into March.
 */
function parseTypedDate(text: string): string | null {
	const t = text.trim();
	let year: number;
	let month: number;
	let day: number;

	const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
	const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(t);
	if (iso) {
		[year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
	} else if (dmy) {
		day = Number(dmy[1]);
		month = Number(dmy[2]);
		year = dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
	} else {
		return null;
	}

	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
	return date.toISOString().slice(0, 10);
}

const PLACEHOLDER = 'Search or type a date';

const CalendarIcon = () => (
	<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
		<rect x="2" y="3" width="12" height="11" rx="1.5" />
		<path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" strokeLinecap="round" />
	</svg>
);

export function FilterDate({
	param,
	label,
	dates,
	anyLabel,
	min,
	max,
}: {
	param: Param;
	label?: string;
	dates?: string[];
	anyLabel?: string;
	min?: string;
	max?: string;
}) {
	useAppliesWithBar(param);

	const value = param.value == null ? '' : String(param.value);
	const active = value !== '';

	const [query, setQuery] = useState('');
	const [open, setOpen] = useState(false);
	const picker = useRef<HTMLInputElement>(null);
	const anchor = useRef<HTMLLabelElement>(null);
	const [box, setBox] = useState<DOMRect | null>(null);

	/* The picker's bounds follow the list when none are given: the oldest and
	 * newest date the data has. */
	const sorted = dates ? [...dates].sort() : [];
	const lowest = min ?? sorted[0];
	const highest = max ?? sorted[sorted.length - 1];

	/* The entries: the empty choice, then every date. A picked date the list does
	 * not hold is added, or the box would show another entry than the one in force. */
	const entries = useMemo(() => {
		const list = (dates ?? []).map((d) => ({ value: d, label: formatShortDate(d) }));
		if (active && !(dates ?? []).includes(value)) list.unshift({ value, label: formatShortDate(value) });
		return [{ value: '', label: anyLabel ?? 'Latest' }, ...list];
	}, [dates, active, value, anyLabel]);

	const matches = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return entries;
		return entries.filter((e) => e.label.toLowerCase().includes(needle));
	}, [entries, query]);

	const shown = open ? query : active ? formatShortDate(value) : (anyLabel ?? 'Latest');

	/* Where the list sits, in viewport coordinates — portalled to the body so a
	 * panel's clipping cannot cut it off, and re-measured while open. */
	useEffect(() => {
		if (!open) return;
		const measure = () => setBox(anchor.current?.getBoundingClientRect() ?? null);
		measure();
		window.addEventListener('scroll', measure, true);
		window.addEventListener('resize', measure);
		return () => {
			window.removeEventListener('scroll', measure, true);
			window.removeEventListener('resize', measure);
		};
	}, [open]);

	const choose = (next: string) => {
		param.set(next);
		setOpen(false);
		setQuery('');
	};

	const openCalendar = () => {
		const input = picker.current;
		if (!input) return;
		/* showPicker is the clean way; where it is missing the click still opens it. */
		if (typeof input.showPicker === 'function') {
			try {
				input.showPicker();
				return;
			} catch {
				/* Not allowed from here — fall through to the click. */
			}
		}
		input.click();
	};

	return (
		<div style={{ position: 'relative' }} role="listitem">
			<label ref={anchor} style={pillStyle(active)}>
				{label && <PillLabel>{label}</PillLabel>}

				<input
					value={shown}
					placeholder={PLACEHOLDER}
					aria-label={label ? `${label}: search or type a date` : 'Search or type a date'}
					onFocus={() => {
						setOpen(true);
						setQuery('');
					}}
					/* Closed on a timer: a click on a row is a blur first, and closing on
					 * blur would remove the row before the click reached it. */
					onBlur={() => window.setTimeout(() => setOpen(false), 120)}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Escape') {
							setOpen(false);
							(e.target as HTMLInputElement).blur();
						}
						if (e.key !== 'Enter') return;
						e.preventDefault();
						/* A whole date typed in is taken as it stands; otherwise Enter takes the
						 * first entry the typing has narrowed the list to. */
						const typed = parseTypedDate(query);
						if (typed) choose(typed);
						else if (matches[0] && query.trim()) choose(matches[0].value);
					}}
					/* As wide as the longest thing it has to show — the empty choice's label, the
					 * date in force, or the placeholder — so nothing is cut off, and it keeps that
					 * width when opened so the bar does not shift. */
					style={{
						...bareInput,
						width: `${Math.max((anyLabel ?? 'Latest').length, shown.length, PLACEHOLDER.length) + 1}ch`,
						color: active || open ? T.fg : T.muted,
						/* A pointer over the whole box, open or not: it is one control that opens a
						 * list, and an input's own text cursor would say it only takes typing. */
						cursor: 'pointer',
					}}
				/>

				<button
					type="button"
					onClick={openCalendar}
					title="Pick a date from a calendar"
					aria-label={label ? `${label}: open the calendar` : 'Open the calendar'}
					style={{
						...bareInput,
						display: 'inline-flex',
						alignItems: 'center',
						padding: 0,
						cursor: 'pointer',
						color: T.muted,
						borderLeft: `1px solid ${T.line}`,
						paddingLeft: 6,
					}}
				>
					<CalendarIcon />
				</button>

				{/* The browser's own date input, kept out of sight: the button above
				    opens it, and what it returns is an ISO date. */}
				<input
					ref={picker}
					type="date"
					value={value}
					min={lowest}
					max={highest}
					tabIndex={-1}
					aria-hidden="true"
					onChange={(e) => e.target.value && choose(e.target.value)}
					style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 0, height: 0, border: 'none', padding: 0 }}
				/>
			</label>

			{open && matches.length > 0 && box && createPortal(
				<div
					style={{
						position: 'fixed',
						top: box.bottom + 4,
						left: box.left,
						zIndex: 999999,
						minWidth: Math.max(200, box.width),
						maxWidth: 360,
						maxHeight: 240,
						overflowY: 'auto',
						background: T.surface,
						border: `1px solid ${T.line}`,
						borderRadius: 8,
						boxShadow: '0 6px 20px rgba(0,0,0,0.10)',
						fontFamily: T.font,
					}}
				>
					{matches.map((e) => (
						<button
							key={e.value || 'none'}
							type="button"
							/* mouseDown, not click — the input's blur fires first and would
							 * unmount this row before a click could reach it. */
							onMouseDown={() => choose(e.value)}
							style={{
								display: 'block',
								width: '100%',
								textAlign: 'left',
								padding: '7px 10px',
								border: 'none',
								background: e.value === value ? T.line : 'transparent',
								font: 'inherit',
								fontSize: 12,
								color: T.fg,
								cursor: 'pointer',
								whiteSpace: 'nowrap',
							}}
						>
							{e.label}
						</button>
					))}
				</div>,
				document.body,
			)}
		</div>
	);
}

FilterDate.Metadata = {
	kind: 'filter',
	purpose: 'One date, in one box: search the dates that exist, type a date, or open a calendar.',
	useWhen:
		'An "as of" date — a snapshot or reporting date — where the data holds some dates and not others. ' +
		'Pass the dates that exist; the reader can search them, type any date, or use the calendar.',
	props: {
		param: {
			description: 'The useParam handle this control writes to.',
			importance: 'required',
			caution:
				'Declare it as a string with default "". The resolver receives an ISO date (YYYY-MM-DD) or an ' +
				'empty string, and must treat empty as its default, usually the latest date.',
		},
		label: { description: 'Shown inside the box before the date.', importance: 'recommended' },
		dates: {
			description: 'The ISO dates that exist, as strings. They fill the list and set the calendar\'s bounds.',
			importance: 'recommended',
			caution:
				'Take them from a resolver, not a literal, so the list grows with the data. A date typed or picked ' +
				'can fall between them: have the resolver use the nearest earlier date.',
		},
		anyLabel: {
			description: 'What the empty choice is called, ideally with the date it means: "Latest (01-10-26)".',
		},
		min: { description: 'Earliest date the calendar allows. Defaults to the oldest in `dates`.' },
		max: { description: 'Latest date the calendar allows. Defaults to the newest in `dates`.' },
	},
	notes:
		'Shows dates as day-month-year with a two-digit year. A typed date is day first: 02-09-26, 02/09/2026 ' +
		'or 2026-09-02, confirmed with Enter. The calendar follows the browser\'s own locale. One parameter, ' +
		'not two, so a resolver reads it as `$date`.',
} satisfies ContractMeta;
