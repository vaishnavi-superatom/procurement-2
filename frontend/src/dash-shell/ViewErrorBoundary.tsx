/**
 * Catches a crash inside a dashboard so it fails in place.
 *
 * Without it, an error thrown while rendering a view unmounts the whole app.
 * `resetKey` clears the error when it changes — a republished view gets a fresh try.
 */
import { Component, type ReactNode } from 'react';

interface Props {
	resetKey: string;
	fallback: (error: Error, retry: () => void) => ReactNode;
	children: ReactNode;
}

interface State {
	error: Error | null;
	key: string;
}

export class ViewErrorBoundary extends Component<Props, State> {
	state: State = { error: null, key: this.props.resetKey };

	static getDerivedStateFromError(error: unknown): Partial<State> {
		return { error: error instanceof Error ? error : new Error(String(error)) };
	}

	static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
		return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
	}

	componentDidCatch(error: unknown) {
		console.error('[dashboard] view crashed:', error);
	}

	private retry = () => this.setState({ error: null });

	render() {
		return this.state.error ? this.props.fallback(this.state.error, this.retry) : this.props.children;
	}
}
