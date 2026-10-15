import type { AgentEvent } from '@superatomai/sdk-node';
import { createNarratorSession, costLine } from './pi-session';
import { toActivity, clip, render, withinCap, CMD_CAP, type ActivityItem } from './activity';
import { unsafeReason } from './filter';

export type { ActivityItem, QueryActivity } from './activity';

/**
 * Narrator — a separate, lightweight agent that tells the person what the
 * answer agent is doing while it works.
 *
 * The coding agent does the work; this translates its visible progress into a
 * plain story. It never touches the answer stream: each update is sent to the
 * client live on its own channel, and every call is returned with the answer so
 * the SDK saves it on the answer's own row.
 *
 * One instance per QUESTION. It starts with the run and is stopped the moment the
 * run returns, so nothing is ever narrated after the answer. A follow-up question
 * gets a fresh instance and a fresh pi session.
 *
 *   pi-session.ts  the model session       activity.ts  what the narrator is shown
 *   filter.ts      what it may not say      index.ts     when it speaks (this file)
 */

/** At most one update per this interval (NARRATOR_INTERVAL_MS). */
const INTERVAL_MS = Number(process.env.NARRATOR_INTERVAL_MS) || 5000;
/** One narration call may not hold up the next forever. */
const CALL_TIMEOUT_MS = 20_000;

/**
 * One narration call, as saved with the answer: what the narrator was given,
 * and what it wrote. Same shape as the SDK's NarrationUpdate — the provider
 * returns these as `data.narration` and the SDK saves them on the answer's row
 * as `response.narration`. A UI shows the `shown` ones; the rest are kept so the
 * narrator's quality can be judged against its input.
 */
export interface NarrationUpdate {
	/** When this call finished, ISO. */
	at: string;
	/** Since the question arrived. */
	elapsedMs: number;
	/**
	 * shown    written and passed the filter
	 * skipped  the narrator judged nothing worth saying
	 * dropped  written, but the output filter refused it (see `reason`)
	 * failed   the call errored or timed out (see `reason`)
	 */
	status: 'shown' | 'skipped' | 'dropped' | 'failed';
	text: string | null;
	reason?: string;
	activity: ActivityItem[];
}

export interface Narrator {
	/** Hand over one agent event. Cheap and synchronous. */
	feed(event: AgentEvent): void;
	/**
	 * Stop narrating and return every call, in order. Idempotent (a second call
	 * returns the same list); never throws; drops any call still in flight, so
	 * nothing lands after the answer.
	 */
	stop(): NarrationUpdate[];
}

export interface NarratorOptions {
	question: string;
	threadId?: string;
	/** The run's identity token — what the bridge filed this run's query results under. */
	contextToken?: string;
	/** Each shown update, live — the provider sends it to the client. */
	onUpdate?: (update: { elapsedMs: number; text: string }) => void;
}

const NOOP: Narrator = { feed() {}, stop: () => [] };

export function startNarrator(opts: NarratorOptions): Narrator {
	if (process.env.SA_NARRATOR === 'off') return NOOP;
	return new NarratorRun(opts);
}

/**
 * One question's narration, start to stop.
 *
 * The flow, in order:
 *   constructor   opens the pi session; once ready, writes the opening line
 *   feed()        an agent event becomes an activity item in `buffer`
 *   schedule()    decides WHEN to speak — see below
 *   call()        one model call: prompt, reply, filter, record, send
 *   stop()        the answer is in: stop, close the session, return every call
 *
 * **When it speaks**: a check every INTERVAL_MS for as long as the run lasts.
 * New activity since the last call is narrated — one call covering everything
 * that arrived meanwhile. With nothing new, the check still calls, telling the
 * narrator what is still running and for how long (a command, or the agent
 * thinking), so a stall is said out loud rather than shown as silence.
 */
class NarratorRun implements Narrator {
	private readonly startedAt = Date.now();
	private readonly tag: string;
	private readonly ready: Promise<void>;
	private session: any = null;
	private stopped = false;

	/** Activity not yet narrated. */
	private buffer: ActivityItem[] = [];
	/** Every call, for the saved answer. */
	private readonly collected: NarrationUpdate[] = [];
	/** Commands currently running, by event id → start time and command. */
	private readonly pending = new Map<string, { at: number; command: string }>();
	/** When the agent last did anything — what "thinking for N s" is measured from. */
	private lastActivityAt = Date.now();
	/** The last update shown, so a waiting update can be told not to repeat it. */
	private lastShownText = '';
	/** Every update shown so far, normalised — so a repeat is skipped, not sent. */
	private readonly shownKeys = new Set<string>();
	/** Event ids already recorded, so a re-emitted completion is not added twice. */
	private readonly seen = new Set<string>();

	/** The model call in progress, if any — never more than one at a time. */
	private inFlight: Promise<void> | null = null;
	/** Whether the question has been put to the model yet. */
	private questionSent = false;
	/** When the last activity call started; 0 = never, so the first is immediate. */
	private lastCallAt = 0;
	/** When the last update was shown. */
	private lastUpdateAt: number;
	/** Holds activity that arrived too soon after the last call. */
	private holdTimer: ReturnType<typeof setTimeout> | null = null;
	/** The 5-second check when there is nothing new: fires the "still waiting" update. */
	private waitTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(private readonly opts: NarratorOptions) {
		this.tag = `[narrator ${(opts.threadId || 'no-thread').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 12)}]`;
		this.lastUpdateAt = this.startedAt;
		this.ready = createNarratorSession()
			.then((s) => {
				if (this.stopped) { s.session.dispose(); return; }
				this.session = s.session;
				console.log(`${this.tag} started — ${s.model}, ready in ${this.seconds()}s`);
				this.openingLine();
			})
			.catch((err: any) => {
				// Narration is a nicety. If it cannot start, the answer still runs.
				console.warn(`${this.tag} disabled for this question: ${err?.message ?? err}`);
				this.stopped = true;
			});
	}

	// ── Input ──────────────────────────────────────────────────────────────────

	feed = (ev: AgentEvent): void => {
		if (this.stopped || !ev) return;
		try {
			this.lastActivityAt = Date.now();
			if (ev.kind === 'command') {
				const cmd = String(ev.command ?? '');
				const id = ev.id ?? cmd;
				// Started: only remembered, so a long command can be waited on. What it
				// produced arrives with its completion.
				if (ev.status === 'in_progress') {
					if (!this.pending.has(id)) {
						this.pending.set(id, { at: Date.now(), command: clip(cmd, CMD_CAP) });
					}
				} else if (ev.status === 'completed' || ev.status === 'failed') {
					this.pending.delete(id);
					this.add(ev);
				}
			} else if (ev.done) {
				// Everything else is recorded once, finished.
				this.add(ev);
			}
		} catch { /* feeding must never break the run */ }
		this.schedule();
	};

	private add(ev: AgentEvent): void {
		const key = `${ev.kind}:${ev.id ?? ''}`;
		if (this.seen.has(key)) return;
		this.seen.add(key);
		const item = toActivity(ev, this.opts.contextToken);
		if (item) this.buffer.push(item);
	}

	// ── When to speak ──────────────────────────────────────────────────────────

	private schedule(): void {
		// Called again when these change: the session readying, a call finishing.
		if (this.stopped || !this.session || this.inFlight) return;
		if (!this.buffer.length) { this.armWait(); return; }

		const tooSoonBy = this.lastCallAt + INTERVAL_MS - Date.now();
		if (tooSoonBy > 0) {
			this.holdTimer ??= setTimeout(() => { this.holdTimer = null; this.schedule(); }, tooSoonBy);
			return;
		}

		this.clearTimer('holdTimer');
		const { kept, omitted } = withinCap(this.buffer);
		this.buffer = [];
		this.lastCallAt = Date.now();
		this.run(this.updatePrompt(kept, omitted, false), kept, 'narration call');
	}

	private oldestPending(): { at: number; command: string } | null {
		let oldest: { at: number; command: string } | null = null;
		for (const p of this.pending.values()) if (!oldest || p.at < oldest.at) oldest = p;
		return oldest;
	}

	/** The 5-second check, armed whenever there is nothing new to narrate. */
	private armWait(): void {
		if (this.waitTimer) return;
		this.waitTimer = setTimeout(() => {
			this.waitTimer = null;
			this.waitingUpdate();
		}, Math.max(0, this.lastCallAt + INTERVAL_MS - Date.now()));
	}

	/** Nothing new since the last call: say what is still running, and for how long. */
	private waitingUpdate(): void {
		if (this.stopped || !this.session || this.inFlight || this.buffer.length) { this.schedule(); return; }
		if (Date.now() < this.lastCallAt + INTERVAL_MS) { this.armWait(); return; }

		const oldest = this.oldestPending();
		const item: ActivityItem = oldest
			? { kind: 'waiting', command: oldest.command, forSeconds: Math.round((Date.now() - oldest.at) / 1000) }
			: { kind: 'waiting', forSeconds: Math.round((Date.now() - this.lastActivityAt) / 1000) };
		this.lastCallAt = Date.now();
		this.run(this.updatePrompt([item], 0, true), [item], 'narration call');
	}

	// ── Prompts ────────────────────────────────────────────────────────────────

	/** The first thing the person sees: written from the question alone. */
	private openingLine(): void {
		this.questionSent = true;
		// Counts as a call, so the first 5-second check comes 5 s after it.
		this.lastCallAt = Date.now();
		this.run(`The person asked: "${this.opts.question}"\n\nWrite your opening line now.`, [], 'opening line');
	}

	private updatePrompt(items: ActivityItem[], omitted: number, waiting: boolean): string {
		const withQuestion = !this.questionSent;
		this.questionSent = true;
		return (withQuestion ? `The person asked: "${this.opts.question}"\n\n` : '') +
			(waiting
				? 'No new activity.' + (this.lastShownText ? ` Your last update was: "${this.lastShownText}".` : '') +
					' Only if what is still running has gone on long enough to be worth telling the person, say so in' +
					' different words from your last update; otherwise reply SKIP.\n\n'
				: 'New activity:\n\n') +
			(omitted ? `(${omitted} earlier item(s) omitted for length)\n\n` : '') +
			`${items.map(render).join('\n\n---\n\n')}\n\n` +
			'Write the next update, or SKIP.';
	}

	// ── One model call ─────────────────────────────────────────────────────────

	/** Start a call as THE call in flight; when it settles, decide what is next. */
	private run(prompt: string, activity: ActivityItem[], what: string): void {
		this.inFlight = this.call(prompt, activity)
			.catch((err: any) => {
				if (this.stopped) return;
				const reason = String(err?.message ?? err);
				console.warn(`${this.tag} ${what} failed: ${reason}`);
				this.record({ status: 'failed', text: null, reason, activity });
			})
			.finally(() => {
				this.inFlight = null;
				this.schedule();
			});
	}

	private async call(prompt: string, activity: ActivityItem[]): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = Symbol('timed out');
		let outcome: unknown;
		try {
			outcome = await Promise.race([
				this.session.prompt(prompt),
				new Promise((resolve) => { timer = setTimeout(() => resolve(timedOut), CALL_TIMEOUT_MS); }),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
		if (outcome === timedOut) {
			// Wait for pi to actually stop before this call counts as over: the next
			// call starts as soon as it does, and pi refuses a prompt while it is
			// still processing the last one.
			await this.session?.abort().catch(() => {});
			throw new Error('narration call timed out');
		}
		// Stopped while this call was out: the answer is already there, so an
		// update now would arrive after it. Drop it.
		if (this.stopped) return;

		const text = String(this.session.getLastAssistantText() ?? '').trim();
		if (!text || /^SKIP\b/i.test(text)) {
			this.record({ status: 'skipped', text: null, activity });
			return;
		}

		// Never the same update twice. Measured: the opening line came back
		// word for word on the next two calls, whose activity was only the agent
		// planning and reading its instructions.
		const key = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
		if (this.shownKeys.has(key)) {
			this.record({ status: 'skipped', text: null, reason: 'repeat of an earlier update', activity });
			return;
		}

		const why = unsafeReason(text);
		if (why) {
			console.warn(`${this.tag} dropped an update (${why}): ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
			this.record({ status: 'dropped', text, reason: why, activity });
			return;
		}

		if (!this.lastShownText) console.log(`${this.tag} ${new Date().toISOString()} first update sent (+${this.seconds()}s): ${text.slice(0, 80)}`);
		this.lastUpdateAt = Date.now();
		this.lastShownText = text;
		this.shownKeys.add(key);
		this.record({ status: 'shown', text, activity });
		try { this.opts.onUpdate?.({ elapsedMs: this.lastUpdateAt - this.startedAt, text }); } catch { /* a send must never break narration */ }
	}

	private record(entry: Omit<NarrationUpdate, 'at' | 'elapsedMs'>): void {
		this.collected.push({ at: new Date().toISOString(), elapsedMs: Date.now() - this.startedAt, ...entry });
	}

	// ── End ────────────────────────────────────────────────────────────────────

	stop = (): NarrationUpdate[] => {
		// Final at this point: a call still in flight is discarded by the `stopped`
		// check, so nothing can be added after this list is returned.
		const result = [...this.collected];
		if (this.stopped && !this.session) return result;
		this.stopped = true;
		this.clearTimer('holdTimer');
		this.clearTimer('waitTimer');
		void this.ready.then(() => {
			if (!this.session) return;
			const s = this.session;
			this.session = null;
			// Read before dispose, which may take the stats with it.
			const shown = this.collected.filter((c) => c.status === 'shown').length;
			console.log(`${this.tag} done: ${shown} update(s) in ${this.seconds()}s — narration cost ${costLine(s)}`);
			if (this.inFlight) {
				// Let the in-flight call unwind before disposing; its result is
				// already being discarded by the `stopped` check.
				s.abort().catch(() => {});
				void this.inFlight.finally(() => s.dispose());
			} else {
				s.dispose();
			}
		});
		return result;
	};

	private clearTimer(which: 'holdTimer' | 'waitTimer'): void {
		const t = this[which];
		if (t) clearTimeout(t);
		this[which] = null;
	}

	private seconds(): string {
		return ((Date.now() - this.startedAt) / 1000).toFixed(1);
	}
}
