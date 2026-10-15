/**
 * Undo/redo for an arrange session.
 *
 * Ported from dashboard-pi's `frontend/src/shell/layout/useHistory.ts`.
 *
 * Editors are only safe to explore in when mistakes are cheap. Every committed
 * change — a drop, a resize, a keyboard nudge — is one entry, so Ctrl/⌘Z steps
 * back through gestures rather than through animation frames.
 *
 * The returned object is **referentially stable for the life of the component**,
 * and the hook holds no state. That matters more than it looks: an effect that
 * depends on this object (the drag gesture does) would otherwise be torn down
 * and re-created on every render, cancelling the gesture mid-flight.
 *
 * The stack lives only as long as the session; leaving Arrange mode resets it,
 * and nothing is written to disk until Save.
 */
import { useMemo, useRef } from 'react';

export interface History<T> {
	/** Records the state *before* a gesture. Clears the redo stack, as editors do. */
	commit: (value: T) => void;
	/** Returns the state to restore, or undefined when there is nothing to undo. */
	undo: (present: T) => T | undefined;
	redo: (present: T) => T | undefined;
	/** Starts a fresh session, discarding both stacks. */
	reset: () => void;
}

export function useHistory<T>(): History<T> {
	const stacks = useRef<{ past: T[]; future: T[] }>({ past: [], future: [] });

	return useMemo<History<T>>(
		() => ({
			commit: (value) => {
				stacks.current.past.push(value);
				stacks.current.future = [];
			},
			undo: (present) => {
				const previous = stacks.current.past.pop();
				if (previous === undefined) return undefined;
				stacks.current.future.push(present);
				return previous;
			},
			redo: (present) => {
				const next = stacks.current.future.pop();
				if (next === undefined) return undefined;
				stacks.current.past.push(present);
				return next;
			},
			reset: () => {
				stacks.current = { past: [], future: [] };
			},
		}),
		[],
	);
}
