/**
 * Lays out a one-line SQL statement for display.
 *
 * Whitespace only: tokens are never changed, and the contents of quoted strings
 * and identifiers are copied as they are. SQL that already has line breaks is
 * returned untouched — someone laid it out on purpose.
 */

type Token = { kind: 'word' | 'string' | 'open' | 'close' | 'comma' | 'space' | 'other'; text: string };

function tokenize(sql: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < sql.length) {
		const ch = sql[i];
		if (/\s/.test(ch)) {
			let j = i;
			while (j < sql.length && /\s/.test(sql[j])) j++;
			tokens.push({ kind: 'space', text: ' ' });
			i = j;
		} else if (ch === "'" || ch === '"') {
			let j = i + 1;
			while (j < sql.length) {
				if (sql[j] === ch && sql[j + 1] === ch) j += 2;
				else if (sql[j] === ch) break;
				else j++;
			}
			tokens.push({ kind: 'string', text: sql.slice(i, j + 1) });
			i = j + 1;
		} else if (/[A-Za-z0-9_$.]/.test(ch)) {
			let j = i;
			while (j < sql.length && /[A-Za-z0-9_$.]/.test(sql[j])) j++;
			tokens.push({ kind: 'word', text: sql.slice(i, j) });
			i = j;
		} else if (ch === '(') {
			tokens.push({ kind: 'open', text: ch });
			i++;
		} else if (ch === ')') {
			tokens.push({ kind: 'close', text: ch });
			i++;
		} else if (ch === ',') {
			tokens.push({ kind: 'comma', text: ch });
			i++;
		} else {
			tokens.push({ kind: 'other', text: ch });
			i++;
		}
	}
	return tokens;
}

/** Keywords that open a clause, longest first so "GROUP BY" wins over nothing. */
const CLAUSES: string[][] = [
	['LEFT', 'OUTER', 'JOIN'],
	['RIGHT', 'OUTER', 'JOIN'],
	['FULL', 'OUTER', 'JOIN'],
	['UNION', 'ALL'],
	['GROUP', 'BY'],
	['ORDER', 'BY'],
	['LEFT', 'JOIN'],
	['RIGHT', 'JOIN'],
	['FULL', 'JOIN'],
	['INNER', 'JOIN'],
	['CROSS', 'JOIN'],
	['WITH'],
	['SELECT'],
	['FROM'],
	['WHERE'],
	['HAVING'],
	['JOIN'],
	['UNION'],
	['INTERSECT'],
	['EXCEPT'],
	['MINUS'],
	['FETCH'],
	['LIMIT'],
];

const INDENT = '  ';

export function formatSql(sql: string): string {
	if (!sql || sql.includes('\n')) return sql;

	const tokens = tokenize(sql.trim());
	const words = (from: number, count: number): { upper: string[]; end: number } | null => {
		const upper: string[] = [];
		let i = from;
		while (i < tokens.length && upper.length < count) {
			if (tokens[i].kind === 'space') {
				i++;
				continue;
			}
			if (tokens[i].kind !== 'word') return null;
			upper.push(tokens[i].text.toUpperCase());
			i++;
		}
		return upper.length === count ? { upper, end: i } : null;
	};
	const nextWord = (from: number): string => {
		for (let i = from; i < tokens.length; i++) {
			if (tokens[i].kind === 'space') continue;
			return tokens[i].kind === 'word' ? tokens[i].text.toUpperCase() : '';
		}
		return '';
	};

	const lines: string[] = [];
	let line = '';
	/* Parentheses that hold a query (subquery, CTE body) indent; the rest are
	 * function calls and expressions, and stay on the line. */
	const parens: boolean[] = [];
	let depth = 0;
	let clause = '';
	let between = false;

	const inline = () => parens.length > 0 && !parens[parens.length - 1];
	const pad = (extra = 0) => INDENT.repeat(depth + extra);
	const newline = (extra = 0) => {
		if (line.trim()) lines.push(line.replace(/\s+$/, ''));
		line = pad(extra);
	};
	const write = (text: string) => {
		if (text === ' ' && (!line.trim() || line.endsWith(' ') || line.endsWith('('))) return;
		line += text;
	};

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];

		if (token.kind === 'word' && !inline()) {
			const match = CLAUSES.find((c) => words(i, c.length)?.upper.join(' ') === c.join(' '));
			if (match) {
				const { end } = words(i, match.length)!;
				newline();
				line += tokens
					.slice(i, end)
					.filter((t) => t.kind === 'word')
					.map((t) => t.text)
					.join(' ');
				clause = match.join(' ');
				i = end - 1;
				continue;
			}
			const upper = token.text.toUpperCase();
			if (upper === 'BETWEEN') between = true;
			if ((upper === 'AND' || upper === 'OR') && !(upper === 'AND' && between)) {
				newline(1);
				line += token.text;
				continue;
			}
			if (upper === 'AND' && between) between = false;
		}

		if (token.kind === 'open') {
			const holdsQuery = ['SELECT', 'WITH'].includes(nextWord(i + 1));
			parens.push(holdsQuery);
			write('(');
			if (holdsQuery) depth++;
			continue;
		}

		if (token.kind === 'close') {
			const heldQuery = parens.pop();
			if (heldQuery) {
				depth--;
				newline();
			}
			line += ')';
			continue;
		}

		if (token.kind === 'comma' && !inline()) {
			line += ',';
			if (clause === 'SELECT') newline(1);
			else if (clause === 'WITH' || tokens[i - 1]?.kind === 'close') newline();
			continue;
		}

		write(token.text);
	}

	newline();
	return lines.join('\n');
}
