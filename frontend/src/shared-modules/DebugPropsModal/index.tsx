import React, { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";

interface DebugPropsModalProps {
	componentName: string;
	componentId: string;
	props: Record<string, any>;
	// Forwarded to QueryExecutor/ToolExecutor when the Response tab runs the
	// query itself — same context (threadId/uiBlockId) the host component
	// would normally pass.
	SA_RUNTIME?: any;
	isOpen: boolean;
	onClose: () => void;
}

const DebugPropsModal: React.FC<DebugPropsModalProps> = ({
	componentName,
	componentId,
	props,
	SA_RUNTIME,
	isOpen,
	onClose,
}) => {
	const [copied, setCopied] = useState(false);
	const [activeTab, setActiveTab] = useState<"props" | "query" | "config" | "response">("props");
	const [queryLookup, setQueryLookup] = useState<{ queryId: string; query: string; loading: boolean; error?: string } | null>(null);
	// Response tab: runs the SAME query/externalTool the host component uses,
	// via the same global executors every Dynamic* component already calls —
	// no need to thread live data/loading/error through every component's
	// own state. Also means this reflects the CURRENTLY selected filters even
	// if the host widget itself hasn't re-fetched yet (e.g. an Apply button
	// is holding it back) — it's what you'd get if you hit Apply right now.
	const [response, setResponse] = useState<{ data: any; loading: boolean; error: string | null } | null>(null);

	const hasExternalTool = !!props?.externalTool?.toolId;
	const hasRunnableQuery = typeof props?.query === "string" && props.query.trim().length > 0;

	const runQuery = useCallback(async () => {
		setResponse({ data: null, loading: true, error: null });
		try {
			let result: any;
			if (hasExternalTool) {
				const toolExecutor = (window as any).SA?.ToolExecutor;
				if (!toolExecutor) throw new Error("ToolExecutor not available on window.SA");
				result = await toolExecutor.executeTool({
					externalTool: props.externalTool,
					formData: {},
					SA_RUNTIME,
				});
			} else if (hasRunnableQuery) {
				const queryExecutor = (window as any).SA?.QueryExecutor;
				if (!queryExecutor) throw new Error("QueryExecutor not available on window.SA");
				result = await queryExecutor.executeQuery({ query: props.query, SA_RUNTIME });
			} else {
				throw new Error("No query or externalTool on this component to run");
			}
			setResponse({ data: result, loading: false, error: null });
		} catch (err: any) {
			setResponse({ data: null, loading: false, error: err?.message || "Query failed" });
		}
	}, [hasExternalTool, hasRunnableQuery, props?.externalTool, props?.query, SA_RUNTIME]);

	// Auto-run once the first time the Response tab is opened; re-runs are
	// via the explicit Run/Refresh button so we never fire extra queries
	// just from re-rendering or switching tabs back and forth.
	useEffect(() => {
		if (activeTab === "response" && response === null) {
			runQuery();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeTab]);

	// Fetch the SQL behind a queryId from the backend
	const fetchQueryById = useCallback(async (queryId: string) => {
		setQueryLookup({ queryId, query: '', loading: true });
		try {
			const client = (window as any).SA_WEB_SDK_CLIENT;
			if (!client) {
				setQueryLookup({ queryId, query: '', loading: false, error: 'SDK client not available' });
				return;
			}
			const response = await client.requestData({
				collection: 'external-tools',
				operation: 'getQuery',
				params: { queryId },
				timeout: 10000,
			});
			const data = response?.data;
			const rawQuery = data?.query;
			if (rawQuery && typeof rawQuery === 'string') {
				setQueryLookup({ queryId, query: rawQuery, loading: false });
			} else if (rawQuery && typeof rawQuery === 'object') {
				setQueryLookup({ queryId, query: JSON.stringify(rawQuery, null, 2), loading: false });
			} else {
				setQueryLookup({ queryId, query: '', loading: false, error: data?.error || response?.error || 'Query not found or expired' });
			}
		} catch (err: any) {
			setQueryLookup({ queryId, query: '', loading: false, error: err?.message || 'Failed to fetch query' });
		}
	}, []);

	// Close on Escape key
	useEffect(() => {
		if (!isOpen) return;

		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose();
			}
		};

		document.addEventListener("keydown", handleEscape);
		return () => document.removeEventListener("keydown", handleEscape);
	}, [isOpen, onClose]);

	if (!isOpen) return null;

	// Use portal to render to document.body to escape any containing blocks
	const modalRoot = document.body;

	const handleCopyJSON = () => {
		const dataToCopy = activeTab === "props"
			? props
			: activeTab === "query"
				? { query: props?.query }
				: activeTab === "response"
					? response?.data
					: { config: props?.config };

		navigator.clipboard.writeText(JSON.stringify(dataToCopy, null, 2));
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	const handleBackdropClick = (e: React.MouseEvent) => {
		if (e.target === e.currentTarget) {
			onClose();
		}
	};

	const formatJSON = (data: any): string => {
		try {
			return JSON.stringify(data, null, 2);
		} catch {
			return String(data);
		}
	};

	// Render JSON text with clickable queryId spans
	const renderJSONWithQueryIds = (jsonStr: string) => {
		// Match qry_ prefixed IDs or encrypted tokens (base64.base64.base64, min 50 chars)
		const queryIdRegex = /(qry_[a-z0-9_]+|[A-Za-z0-9+/]{8,}={0,2}\.[A-Za-z0-9+/]{8,}={0,2}\.[A-Za-z0-9+/=]{32,})/g;
		const parts = jsonStr.split(queryIdRegex);
		if (parts.length === 1) return jsonStr; // no queryIds found

		return parts.map((part, i) => {
			if (queryIdRegex.test(part)) {
				// Reset lastIndex since we reuse the regex
				queryIdRegex.lastIndex = 0;
				return (
					<span
						key={i}
						className="text-amber-400 cursor-pointer hover:text-amber-300"
						title={`${navigator.platform.includes('Mac') ? 'Cmd' : 'Ctrl'}+Click to view SQL query`}
						onClick={(e) => {
							if (e.ctrlKey || e.metaKey) {
								e.preventDefault();
								e.stopPropagation();
								fetchQueryById(part);
							}
						}}
					>
						{part}
					</span>
				);
			}
			return part;
		});
	};

	// Format SQL query with syntax highlighting and proper indentation
	const formatQuery = (query: string) => {
		if (!query || typeof query !== "string") return query;

		// SQL keywords to highlight
		const keywords = [
			"SELECT", "FROM", "WHERE", "AND", "OR", "ORDER BY", "GROUP BY",
			"HAVING", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "OUTER JOIN",
			"ON", "AS", "IN", "NOT", "NULL", "IS", "LIKE", "BETWEEN", "LIMIT",
			"OFFSET", "UNION", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP",
			"ALTER", "TABLE", "INDEX", "VIEW", "DISTINCT", "COUNT", "SUM", "AVG",
			"MIN", "MAX", "CASE", "WHEN", "THEN", "ELSE", "END", "ASC", "DESC",
			"WITH", "CTE", "OVER", "PARTITION BY", "ROW_NUMBER", "RANK"
		];

		// Format: add line breaks before major clauses
		let formatted = query
			.replace(/\s+/g, " ") // normalize whitespace
			.replace(/\bSELECT\b/gi, "\nSELECT")
			.replace(/\bFROM\b/gi, "\nFROM")
			.replace(/\bWHERE\b/gi, "\nWHERE")
			.replace(/\bAND\b/gi, "\n  AND")
			.replace(/\bOR\b/gi, "\n  OR")
			.replace(/\bORDER BY\b/gi, "\nORDER BY")
			.replace(/\bGROUP BY\b/gi, "\nGROUP BY")
			.replace(/\bHAVING\b/gi, "\nHAVING")
			.replace(/\bLEFT JOIN\b/gi, "\nLEFT JOIN")
			.replace(/\bRIGHT JOIN\b/gi, "\nRIGHT JOIN")
			.replace(/\bINNER JOIN\b/gi, "\nINNER JOIN")
			.replace(/\bJOIN\b/gi, "\nJOIN")
			.replace(/\bLIMIT\b/gi, "\nLIMIT")
			.replace(/\bUNION\b/gi, "\nUNION")
			.trim();

		return formatted;
	};

	const hasQuery = props?.query !== undefined;
	const hasConfig = props?.config !== undefined;
	const hasResponse = hasExternalTool || hasRunnableQuery;
	const responseRowCount = Array.isArray(response?.data) ? response!.data.length : undefined;

	return createPortal(
		<>
			<style>{`
				.debug-json-content {
					font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', 'Consolas', monospace;
					font-size: 12px;
					line-height: 1.6;
					tab-size: 2;
				}

				.debug-json-content::-webkit-scrollbar {
					width: 8px;
					height: 8px;
				}

				.debug-json-content::-webkit-scrollbar-track {
					background: #1e293b;
					border-radius: 4px;
				}

				.debug-json-content::-webkit-scrollbar-thumb {
					background: #475569;
					border-radius: 4px;
				}

				.debug-json-content::-webkit-scrollbar-thumb:hover {
					background: #64748b;
				}

				.debug-json-content::-webkit-scrollbar-corner {
					background: #1e293b;
				}
			`}</style>

			{/* Backdrop + Modal container */}
			<div
				className="fixed inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm"
				style={{ zIndex: 9999 }}
				onClick={handleBackdropClick}
			>
			{/* Modal */}
			<div
				className="bg-base-100 rounded-xl shadow-2xl w-11/12 max-w-2xl h-[80vh]
					flex flex-col overflow-hidden border border-base-300 animate-in fade-in zoom-in-95 duration-200"
			>
				{/* Header */}
				<div className="flex items-center justify-between px-4 py-3 border-b border-base-300 bg-base-200">
					<div className="flex items-center gap-3">
						<div className="w-8 h-8 rounded-lg bg-teal-600 flex items-center justify-center">
							<Icon icon="mdi:bug-check-outline" className="w-5 h-5 text-white" />
						</div>
						<div>
							<h2 className="font-semibold text-base-content text-sm">
								{componentName}
							</h2>
							<p className="text-xs text-base-content/60 font-mono">
								{componentId}
							</p>
						</div>
					</div>
					<button
						onClick={onClose}
						className="btn btn-ghost btn-sm btn-square hover:bg-base-300"
						title="Close (Esc)"
					>
						<Icon icon="mdi:close" className="w-5 h-5" />
					</button>
				</div>

				{/* Tabs */}
				<div className="flex border-b border-base-300 bg-base-100">
					<button
						onClick={() => setActiveTab("props")}
						className={`px-4 py-2 text-sm font-medium transition-colors ${
							activeTab === "props"
								? "text-teal-600 border-b-2 border-teal-600"
								: "text-base-content/60 hover:text-base-content"
						}`}
					>
						All Props
					</button>
					{hasQuery && (
						<button
							onClick={() => setActiveTab("query")}
							className={`px-4 py-2 text-sm font-medium transition-colors ${
								activeTab === "query"
									? "text-teal-600 border-b-2 border-teal-600"
									: "text-base-content/60 hover:text-base-content"
							}`}
						>
							Query
						</button>
					)}
					{hasConfig && (
						<button
							onClick={() => setActiveTab("config")}
							className={`px-4 py-2 text-sm font-medium transition-colors ${
								activeTab === "config"
									? "text-teal-600 border-b-2 border-teal-600"
									: "text-base-content/60 hover:text-base-content"
							}`}
						>
							Config
						</button>
					)}
					{hasResponse && (
						<button
							onClick={() => setActiveTab("response")}
							className={`px-4 py-2 text-sm font-medium transition-colors ${
								activeTab === "response"
									? "text-teal-600 border-b-2 border-teal-600"
									: "text-base-content/60 hover:text-base-content"
							}`}
						>
							Response{responseRowCount !== undefined ? ` (${responseRowCount})` : ""}
						</button>
					)}
				</div>

				{/* Content */}
				<div className="flex-1 min-h-0 p-4 bg-base-50 flex flex-col relative">
					{activeTab === "query" ? (
						<pre className="debug-json-content flex-1 p-4 rounded-lg bg-slate-900 border border-slate-700 overflow-auto text-emerald-400 whitespace-pre-wrap">
							{formatQuery(props?.query)}
						</pre>
					) : activeTab === "response" ? (
						<>
							<div className="flex items-center justify-between mb-2 flex-shrink-0">
								<span className="text-xs text-base-content/60">
									Runs the query/tool above live, with whatever filters are currently selected.
								</span>
								<button
									onClick={runQuery}
									disabled={response?.loading}
									className="btn btn-xs btn-outline gap-1 flex-shrink-0"
								>
									<Icon icon={response?.loading ? "mdi:loading" : "mdi:play"} className={`w-3.5 h-3.5 ${response?.loading ? "animate-spin" : ""}`} />
									{response === null ? "Run" : "Refresh"}
								</button>
							</div>
							<pre className="debug-json-content flex-1 p-4 rounded-lg bg-slate-900 border border-slate-700 overflow-auto text-slate-300">
								{response === null || response.loading ? (
									<span className="text-slate-400">Loading…</span>
								) : response.error ? (
									<span className="text-red-400">{response.error}</span>
								) : (
									renderJSONWithQueryIds(formatJSON(response.data))
								)}
							</pre>
						</>
					) : (
						<pre className="debug-json-content flex-1 p-4 rounded-lg bg-slate-900 border border-slate-700 overflow-auto text-slate-300">
							{activeTab === "props" && renderJSONWithQueryIds(formatJSON(props))}
							{activeTab === "config" && renderJSONWithQueryIds(formatJSON(props?.config))}
						</pre>
					)}

					{/* Query lookup popup */}
					{queryLookup && (
						<div className="absolute inset-x-4 bottom-4 rounded-lg bg-slate-800 border border-teal-600 shadow-xl flex flex-col"
							style={{ maxHeight: '60%', overflow: 'hidden' }}
						>
							<div className="flex items-center justify-between px-3 py-2 bg-teal-900/50 border-b border-teal-700 flex-shrink-0">
								<span className="text-xs font-mono text-teal-300">
									{queryLookup.queryId}
								</span>
								<button
									onClick={() => setQueryLookup(null)}
									className="text-slate-400 hover:text-white"
								>
									<Icon icon="mdi:close" className="w-4 h-4" />
								</button>
							</div>
							<pre className="p-3 overflow-auto text-xs font-mono whitespace-pre-wrap flex-1 min-h-0">
								{queryLookup.loading ? (
									<span className="text-slate-400">Loading query...</span>
								) : queryLookup.error ? (
									<span className="text-red-400">{queryLookup.error}</span>
								) : (
									<span className="text-emerald-400">{formatQuery(queryLookup.query)}</span>
								)}
							</pre>
						</div>
					)}
				</div>

				{/* Footer */}
				<div className="flex items-center justify-between px-4 py-3 border-t border-base-300 bg-base-200">
					<p className="text-xs text-base-content/60">
						<kbd className="kbd kbd-xs">Alt/Option</kbd> + <kbd className="kbd kbd-xs">Click</kbd> to inspect
						{' | '}
						<kbd className="kbd kbd-xs">Ctrl/Cmd</kbd> + <kbd className="kbd kbd-xs">Click</kbd> on queryId to view SQL
					</p>
					<button
						onClick={handleCopyJSON}
						className={`btn btn-sm gap-2 ${
							copied ? "btn-success" : "btn-primary"
						}`}
					>
						<Icon
							icon={copied ? "mdi:check" : "mdi:content-copy"}
							className="w-4 h-4"
						/>
						{copied ? "Copied!" : "Copy JSON"}
					</button>
				</div>
			</div>
			</div>
		</>,
		modalRoot
	);
};

export default DebugPropsModal;
