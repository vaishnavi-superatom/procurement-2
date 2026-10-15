import { Icon } from '@iconify/react';
import type { FC } from 'react';
import type { ComponentMetadata } from '../types';

interface TimePeriodProps {
	/** A single ISO date or an ISO range such as "2026-03-01 - 2026-08-31". */
	value?: string;
	/** Shown after the dates, e.g. that a default window was applied. */
	note?: string;
}

const METADATA: ComponentMetadata = {
	id: 'time-period',
	name: 'TimePeriod',
	displayName: 'Display answer time period',
	isDisplayComp: false,
	type: 'TimePeriod',
	description: 'Shows the date or date range an answer covers.',
	category: 'display',
	keywords: ['time', 'period', 'date', 'range'],
	props: { value: 'ISO date or date range for the answer', note: 'optional note, e.g. a default window was applied' },
};

function formatDate(value: string): string | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
	const date = new Date(`${value}T00:00:00Z`);
	if (Number.isNaN(date.getTime())) return null;
	return new Intl.DateTimeFormat('en-GB', {
		day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
	}).format(date);
}

function displayValue(value: string): string {
	// "-", "–", "—" or "to" between the dates: all mean the same range.
	const range = value.trim().match(/^(\d{4}-\d{2}-\d{2})\s*(?:-|–|—|to)\s*(\d{4}-\d{2}-\d{2})$/i);
	if (range) return `${formatDate(range[1]) ?? range[1]} to ${formatDate(range[2]) ?? range[2]}`;
	return formatDate(value.trim()) ?? value.trim();
}

interface TimePeriodComponent extends FC<TimePeriodProps> {
	Metadata: ComponentMetadata;
}

const TimePeriod: TimePeriodComponent = ({ value = '', note }) => {
	const text = displayValue(value);
	if (!text) return null;
	return (
		<div className="px-4 md:px-5">
			<div className="inline-flex items-center gap-2 rounded-lg border border-base-300 bg-base-200/50 px-3 py-2 text-sm text-base-content/75">
				<Icon icon="mdi:calendar-range" className="h-4 w-4 text-base-content/50" />
				<span className="font-medium text-base-content/60">Time period</span>
				<span>{text}</span>
				{note && <span className="text-base-content/50">· {note}</span>}
			</div>
		</div>
	);
};

TimePeriod.Metadata = METADATA;

export default TimePeriod;
