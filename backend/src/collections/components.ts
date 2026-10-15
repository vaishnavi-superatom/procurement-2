import type { CollectionContext } from './types';

// Track embedded components hash to avoid re-embedding unchanged components
let lastComponentsHash: string | null = null;
let isEmbedding = false; // Mutex to prevent concurrent embedding

// Cache for ChromaDB health status
let chromaHealthy: boolean | null = null;
let lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL = 30000; // Re-check health every 30 seconds

/**
 * Register components embedding and search collections
 */
export async function registerComponentsCollections({ sdk, chromaManagers }: CollectionContext): Promise<void> {
	const componentsChromaManager = chromaManagers.components;

	const checkChromaHealth = async (): Promise<boolean> => {
		const now = Date.now();
		if (chromaHealthy !== null && (now - lastHealthCheck) < HEALTH_CHECK_INTERVAL) {
			return chromaHealthy;
		}

		try {
			chromaHealthy = await Promise.race([
				componentsChromaManager.healthCheck(),
				new Promise<boolean>((_, reject) =>
					setTimeout(() => reject(new Error('timeout')), 1000)
				)
			]);
			lastHealthCheck = now;
			return chromaHealthy;
		} catch {
			chromaHealthy = false;
			lastHealthCheck = now;
			return false;
		}
	};

	/**
	 * Embed display components into ChromaDB for semantic search
	 * Only embeds components with isDisplayComp: true
	 * Skips embedding if components haven't changed since last embed
	 */
	sdk.addCollection('components', 'embed', async (params: any) => {
		const { components, forceUpdate = false } = params;

		if (!components || !Array.isArray(components)) {
			throw new Error('components array is required');
		}

		// Prevent concurrent embedding
		if (isEmbedding) {
			console.log('[COMPONENTS-EMBED] Embedding already in progress, skipping');
			return {
				success: true,
				message: 'Embedding already in progress',
				skipped: true
			};
		}

		try {
			// Filter only display components
			const displayComponents = components.filter((c: any) => c.isDisplayComp === true);

			if (displayComponents.length === 0) {
				console.log('[COMPONENTS-EMBED] No display components to embed');
				return {
					success: true,
					message: 'No display components to embed',
					count: 0
				};
			}

			// Create a hash of component IDs to detect changes
			const componentIds = displayComponents.map((c: any) => c.id).sort().join(',');
			const currentHash = Buffer.from(componentIds).toString('base64');

			// Skip if components haven't changed (unless forceUpdate is true)
			if (!forceUpdate && lastComponentsHash === currentHash) {
				console.log('[COMPONENTS-EMBED] Components unchanged, skipping embedding');
				return {
					success: true,
					message: 'Components already embedded (unchanged)',
					count: displayComponents.length,
					skipped: true
				};
			}

			// Set mutex
			isEmbedding = true;

			// Check if ChromaDB is healthy
			const isHealthy = await componentsChromaManager.healthCheck();
			if (!isHealthy) {
				console.warn('[COMPONENTS-EMBED] ChromaDB server is not running, skipping embedding');
				isEmbedding = false; // Release mutex
				return {
					success: false,
					error: 'ChromaDB server is not available'
				};
			}

			// Reset collection to update with new components
			try {
				await componentsChromaManager.deleteCollection();
				console.log('[COMPONENTS-EMBED] Deleted existing collection');
			} catch {
				// Collection might not exist
				console.log('[COMPONENTS-EMBED] No existing collection to delete');
			}

			// Create fresh collection
			await componentsChromaManager.createCollection(false);

			console.log(`[COMPONENTS-EMBED] Embedding ${displayComponents.length} display components`);

			// Prepare data for ChromaDB
			const ids = displayComponents.map((c: any) => `component_${c.id}`);

			// Combine component metadata for better embeddings (including props)
			const documents = displayComponents.map((c: any) => {
				let text = c.displayName || c.name;
				if (c.description) text += `\n${c.description}`;
				if (c.category) text += `\nCategory: ${c.category}`;
				if (c.keywords && c.keywords.length > 0) text += `\nKeywords: ${c.keywords.join(', ')}`;

				// Include props for better semantic understanding
				if (c.props) {
					const propsText = Object.entries(c.props)
						.map(([key, value]) => {
							if (typeof value === 'string') {
								return `${key}: ${value}`;
							} else if (typeof value === 'object' && value !== null) {
								// For nested objects like config, flatten the description
								const nestedText = Object.entries(value as object)
									.map(([k, v]) => typeof v === 'string' ? `${k}: ${v}` : '')
									.filter(Boolean)
									.join(', ');
								return nestedText ? `${key}: ${nestedText}` : '';
							}
							return '';
						})
						.filter(Boolean)
						.join('\n');
					if (propsText) text += `\nProps: ${propsText}`;
				}

				return text;
			});

			// Prepare metadata (include props for retrieval)
			const metadatas = displayComponents.map((c: any) => ({
				component_id: c.id,
				name: c.name,
				displayName: c.displayName || c.name,
				type: c.type || '',
				category: c.category || '',
				keywords: c.keywords ? JSON.stringify(c.keywords) : '[]',
				props: c.props ? JSON.stringify(c.props) : '{}',
				component: JSON.stringify(c) // Store full component for retrieval
			}));

			// Add to collection
			await componentsChromaManager.add({
				ids,
				documents,
				metadatas
			});

			console.log(`[COMPONENTS-EMBED] Successfully embedded ${displayComponents.length} components`);

			// Update hash after successful embedding
			lastComponentsHash = currentHash;
			isEmbedding = false; // Release mutex

			return {
				success: true,
				message: `Embedded ${displayComponents.length} display components`,
				count: displayComponents.length
			};
		} catch (error: any) {
			isEmbedding = false; // Release mutex on error
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[COMPONENTS-EMBED] Failed to embed components:', errorMsg);
			throw new Error(`Failed to embed components: ${errorMsg}`);
		}
	});

	/**
	 * Search components by semantic similarity
	 * Returns matching display components sorted by relevance
	 */
	sdk.addCollection('components', 'search', async (params: any) => {
		const { prompt, limit = 5 } = params;

		if (!prompt || prompt.trim().length === 0) {
			throw new Error('prompt is required');
		}

		try {
			// Quick health check with caching
			const isHealthy = await checkChromaHealth();
			if (!isHealthy) {
				return {
					success: false,
					suggestions: [],
					error: 'ChromaDB server is not available'
				};
			}

			// Query directly - collection should already exist from embedding
			console.log(`[COMPONENTS-SEARCH] Searching for: "${prompt.substring(0, 50)}..."`);

			let results;
			try {
				results = await componentsChromaManager.query(prompt, limit);
			} catch (queryError: any) {
				// Handle collection not found error gracefully
				if (queryError.message?.includes('does not exist') || queryError.message?.includes('not found')) {
					console.log('[COMPONENTS-SEARCH] Collection not found, returning empty results');
					return {
						success: true,
						suggestions: [],
						message: 'No components embedded yet'
					};
				}
				throw queryError;
			}

			// Handle empty results
			if (!results.ids[0] || results.ids[0].length === 0) {
				return {
					success: true,
					suggestions: [],
					message: 'No components available'
				};
			}

			// Format results
			const suggestions = [];
			for (let i = 0; i < results.ids[0].length; i++) {
				const metadata = results.metadatas[0][i] as any;
				const distance = results.distances[0][i];
				// Use 1/(1+distance) for proper 0-1 normalization (L2 distance can be > 1)
				const similarity = 1 / (1 + distance);

				// Parse stored component
				const component = JSON.parse(metadata.component);

				suggestions.push({
					...component,
					similarity: parseFloat(similarity.toFixed(4))
				});
			}

			console.log(`[COMPONENTS-SEARCH] Found ${suggestions.length} matching components`);

			return {
				success: true,
				suggestions,
				count: suggestions.length
			};
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : JSON.stringify(error);
			console.error('[COMPONENTS-SEARCH] Search failed:', errorMsg);
			// Reset health cache on error
			chromaHealthy = null;
			return {
				success: false,
				suggestions: [],
				error: errorMsg
			};
		}
	});

}
