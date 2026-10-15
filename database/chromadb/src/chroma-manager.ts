/**
 * ChromaDB manager for storing and querying knowledge base embeddings
 */

import { ChromaClient } from 'chromadb';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { KnowledgeBaseEntry, QueryResult } from './types';

// Load .env from chromadb directory
dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

// Configuration
const config = {
  CHROMA_SERVER_URL: process.env.CHROMA_SERVER_URL || 'http://localhost:8000',
  COLLECTION_NAME: process.env.COLLECTION_NAME || 'knowledge_base_collection',
  USER_CONVERSATIONS_COLLECTION_NAME: process.env.USER_CONVERSATIONS_COLLECTION_NAME || 'user_conversations_collection',
  COMPONENTS_COLLECTION_NAME: process.env.COMPONENTS_COLLECTION_NAME || 'components_collection',
  BOOKMARKS_COLLECTION_NAME: process.env.BOOKMARKS_COLLECTION_NAME || 'bookmarks_collection',
  SCHEMA_TABLES_COLLECTION_NAME: process.env.SCHEMA_TABLES_COLLECTION_NAME || 'schema_tables_collection',
  SOURCE_SUMMARIES_COLLECTION_NAME: process.env.SOURCE_SUMMARIES_COLLECTION_NAME || 'source_summaries_collection',
};

// Track which URLs we've already logged to avoid per-instance spam when
// multiple ChromaManager instances are created against the same server.
const loggedUrls = new Set<string>();

export class ChromaManager {
  private client: ChromaClient;
  private collectionName: string;
  private collection: any = null;

  /**
   * @param space Distance metric for the HNSW index. Chroma's default is 'l2'
   *   (SQUARED euclidean), whose scores are awkward to reason about: the usual
   *   `1/(1+distance)` conversion compresses the range and a "0.4 similarity"
   *   is really cosine ≈ 0.25, i.e. near-unrelated. Pass 'cosine' where
   *   thresholds need to be interpretable — `1 - distance` is then the true
   *   cosine similarity. Opt-in per collection: changing it for everything
   *   would silently shift retrieval behaviour on every existing index.
   *   NOTE the metric is fixed at creation — an existing collection must be
   *   deleted and rebuilt for a change here to take effect.
   */
  constructor(
    serverUrl?: string,
    collectionName?: string,
    private readonly space: 'l2' | 'cosine' | 'ip' = 'l2'
  ) {
    const url = serverUrl || config.CHROMA_SERVER_URL;
    this.collectionName = collectionName || config.COLLECTION_NAME;

    this.client = new ChromaClient({
      path: url,
    });

    if (!loggedUrls.has(url)) {
      console.log(`✓ ChromaDB client initialized at: ${url}`);
      loggedUrls.add(url);
    }
  }

  /**
   * Create or get the collection
   * Note: ChromaDB server handles embeddings automatically using default model
   */
  async createCollection(reset: boolean = false): Promise<void> {
    // Serialise concurrent callers. Without this, a Promise.all over sources
    // runs several createCollection()s at once and they interleave badly: two
    // can both pass rebuildIfSpaceChanged, and the second's delete can land
    // AFTER the first has recreated and started filling the collection —
    // silently throwing away rows that were just written.
    if (this.creating) return this.creating;
    this.creating = this.doCreateCollection(reset).finally(() => { this.creating = null; });
    return this.creating;
  }

  private creating: Promise<void> | null = null;

  private async doCreateCollection(reset: boolean): Promise<void> {
    try {
      if (reset) {
        try {
          await this.client.deleteCollection({ name: this.collectionName });
          console.log(`✓ Deleted existing collection: ${this.collectionName}`);
        } catch (error) {
          // Collection might not exist, ignore error
        }
      }

      // A collection's distance metric is FIXED at creation, and
      // getOrCreateCollection silently hands back an existing collection with its
      // ORIGINAL metric. So deploying a change to `space` onto an environment that
      // already has the collection would run the new scoring maths against the old
      // index — and fail silently, not loudly: measured here, cosine's
      // `1 - distance` applied to squared-L2 distances (0.92–1.21) yields 0.08 down
      // to −0.2, so every hit falls below the caller's thresholds and retrieval
      // quietly degrades to nothing. Detect and rebuild instead of relying on
      // someone remembering a deploy step.
      if (!reset) await this.rebuildIfSpaceChanged();

      // Get or create collection
      // Set embeddingFunction to undefined so server handles embeddings
      this.collection = await this.client.getOrCreateCollection({
        name: this.collectionName,
        metadata: {
          description: 'Knowledge base embeddings for semantic search',
          // Only emitted when non-default, so existing collections keep the
          // exact metadata they were created with and are not disturbed.
          ...(this.space !== 'l2' ? { 'hnsw:space': this.space } : {}),
        },
        embeddingFunction: undefined, // Let server handle embeddings
      });

      console.log(`✓ Collection ready: ${this.collectionName}`);
    } catch (error) {
      console.error('✗ Error creating collection:', error);
      throw error;
    }
  }

  /**
   * Add documents to ChromaDB collection
   * ChromaDB server will automatically generate embeddings
   */
  async addDocuments(
    documents: KnowledgeBaseEntry[],
    batchSize: number = 100
  ): Promise<void> {
    if (!this.collection) {
      throw new Error('Collection not initialized. Call createCollection() first.');
    }

    const total = documents.length;
    console.log(`\nAdding ${total} documents to ChromaDB...`);

    for (let i = 0; i < total; i += batchSize) {
      const batch = documents.slice(i, i + batchSize);

      // Prepare data for ChromaDB
      const ids = batch.map(doc => `kb_${doc.id}`);

      // Combine title, category, tags, and content for better embeddings
      const texts = batch.map(doc => {
        let text = doc.title;
        if (doc.category) text += `\nCategory: ${doc.category}`;
        if (doc.tags && doc.tags.length > 0) text += `\nTags: ${doc.tags.join(', ')}`;
        text += `\n\n${doc.content}`;
        return text;
      });

      // Prepare metadata (include category and tags for filtering)
      const metadatas = batch.map(doc => ({
        kb_id: doc.id,
        title: doc.title,
        category: doc.category || '',
        tags: doc.tags ? JSON.stringify(doc.tags) : '[]',
        created_at: doc.created_at instanceof Date
          ? doc.created_at.toISOString()
          : String(doc.created_at),
      }));

      try {
        // Add to collection - server will generate embeddings automatically
        await this.collection.add({
          ids: ids,
          documents: texts,
          metadatas: metadatas,
        });

        const progress = Math.min(i + batchSize, total);
        console.log(`  Progress: ${progress}/${total} documents added`);
      } catch (error) {
        console.error(`✗ Error adding batch starting at index ${i}:`, error);
        throw error;
      }
    }

    console.log(`✓ All ${total} documents added successfully`);
  }

  /**
   * Query the collection with semantic search
   */
  async query(
    queryText: string,
    nResults: number = 5
  ): Promise<QueryResult> {
    if (!this.collection) {
      throw new Error('Collection not initialized. Call createCollection() first.');
    }

    try {
      // Query collection - server will generate query embedding automatically
      const results = await this.collection.query({
        queryTexts: [queryText],
        nResults: nResults,
      });

      return results;
    } catch (error) {
      console.error('✗ Error querying collection:', error);
      throw error;
    }
  }

  /**
   * Query the collection with a metadata filter (ChromaDB `where` clause).
   * Used when multiple sources/projects share one collection and we need to
   * narrow results to a specific source or project.
   */
  async queryWithFilter(
    queryText: string,
    nResults: number = 5,
    where?: Record<string, any>
  ): Promise<QueryResult> {
    if (!this.collection) {
      throw new Error('Collection not initialized. Call createCollection() first.');
    }

    try {
      const args: any = {
        queryTexts: [queryText],
        nResults,
      };
      if (where && Object.keys(where).length > 0) {
        args.where = where;
      }
      const results = await this.collection.query(args);
      return results;
    } catch (error) {
      console.error('✗ Error querying collection with filter:', error);
      throw error;
    }
  }

  /**
   * Get documents by metadata filter, without running a semantic query.
   * Cheaper than queryWithFilter() because no query embedding is generated.
   * Used to inspect existing metadata (e.g., freshness checks).
   */
  async getByFilter(where: Record<string, any>, limit?: number): Promise<{
    ids: string[];
    metadatas: Record<string, any>[];
  }> {
    if (!this.collection) {
      throw new Error('Collection not initialized. Call createCollection() first.');
    }

    try {
      const args: any = { where };
      if (typeof limit === 'number') args.limit = limit;
      const result = await this.collection.get(args);
      return {
        ids: result?.ids || [],
        metadatas: (result?.metadatas || []) as Record<string, any>[],
      };
    } catch (error) {
      console.error('✗ Error getting by filter:', error);
      throw error;
    }
  }

  /**
   * Delete documents matching a metadata filter.
   * Example: deleteWhere({ sourceId: 'mssql-abc123' })
   */
  async deleteWhere(where: Record<string, any>): Promise<void> {
    if (!this.collection) {
      throw new Error('Collection not initialized. Call createCollection() first.');
    }

    try {
      await this.collection.delete({ where });
    } catch (error) {
      console.error('✗ Error deleting by filter:', error);
      throw error;
    }
  }

  /** Distance metric this collection was created with — callers need it to turn a distance into a similarity. */
  getSpace(): 'l2' | 'cosine' | 'ip' {
    return this.space;
  }

  /**
   * Drop the collection when its stored metric no longer matches the requested
   * one, so it gets recreated with the right metric and re-embedded by the
   * caller's normal sync path (which treats an empty collection as stale).
   *
   * Deliberately CONSERVATIVE: this deletes data, so it acts only on a metric it
   * positively read and can positively compare. If the collection is absent, or
   * its metadata cannot be read, or the metric is absent from that metadata,
   * nothing is touched — an unreadable collection must never be destroyed on a
   * guess.
   */
  private async rebuildIfSpaceChanged(): Promise<void> {
    let stored: string | undefined;
    try {
      const existing: any = await this.client.getCollection({ name: this.collectionName } as any);
      const md = existing?.metadata;
      if (!md || typeof md !== 'object') return;          // nothing readable to compare
      // An ABSENT hnsw:space is not unknown — Chroma defaults to l2, and every
      // collection built before this option existed is in exactly that state.
      // Treating it as unknown would skip the rebuild in the one case that
      // actually matters: upgrading an existing deployment.
      stored = typeof md['hnsw:space'] === 'string' ? md['hnsw:space'] : 'l2';
    } catch {
      return;                                             // absent, or unreadable — nothing to do
    }

    if (stored === this.space) return;

    console.warn(
      `⚠ Collection ${this.collectionName} was built with hnsw:space="${stored}" but "${this.space}" is now requested — ` +
      `recreating it. Distances from the old metric would be scored with the new formula and silently mis-rank. ` +
      `Contents will be re-embedded on the next sync.`
    );
    try {
      await this.client.deleteCollection({ name: this.collectionName });
    } catch (error) {
      // "Not found" is SUCCESS, not failure: the goal is for the collection to
      // be absent, and it is. Two callers racing to rebuild (a Promise.all over
      // sources both hitting ensureCollection) both decide to delete; the loser
      // lands here. Reporting that as an error printed a full stack for a
      // no-op and made a benign race look fatal.
      const msg = error instanceof Error ? error.message : String(error);
      if (/not\s*found/i.test(msg) || (error as any)?.name === 'ChromaNotFoundError') return;
      console.error(`✗ Could not delete ${this.collectionName} for metric change:`, error);
    }
  }

  /**
   * Fetch documents by exact id — no semantic query involved.
   *
   * Used where the caller already KNOWS which records it wants and embedding
   * rank would only add noise (e.g. schema tables named outright in an intent).
   * Unknown ids are simply absent from the result, so this doubles as an
   * existence check.
   */
  async getByIds(ids: string[]): Promise<{
    ids: string[];
    documents: string[];
    metadatas: Record<string, any>[];
  }> {
    if (!this.collection) {
      throw new Error('Collection not initialized. Call createCollection() first.');
    }
    if (!ids || ids.length === 0) return { ids: [], documents: [], metadatas: [] };

    try {
      const result = await this.collection.get({ ids, include: ['documents', 'metadatas'] as any });
      return {
        ids: result?.ids || [],
        documents: (result?.documents || []) as string[],
        metadatas: (result?.metadatas || []) as Record<string, any>[],
      };
    } catch (error) {
      console.error('✗ Error fetching documents by id:', error);
      return { ids: [], documents: [], metadatas: [] };
    }
  }

  /**
   * Add a single document to the collection
   */
  async add(params: {
    ids: string[];
    documents: string[];
    metadatas: Record<string, any>[];
  }): Promise<void> {
    if (!this.collection) {
      throw new Error('Collection not initialized. Call createCollection() first.');
    }

    try {
      await this.collection.add(params);
    } catch (error) {
      console.error('✗ Error adding document to collection:', error);
      throw error;
    }
  }

  /**
   * Upsert (update or insert) documents in the collection
   */
  async upsert(params: {
    ids: string[];
    documents: string[];
    metadatas: Record<string, any>[];
  }): Promise<void> {
    if (!this.collection) {
      throw new Error('Collection not initialized. Call createCollection() first.');
    }

    try {
      await this.collection.upsert(params);
    } catch (error) {
      console.error('✗ Error upserting document to collection:', error);
      throw error;
    }
  }

  /**
   * Delete documents from the collection by IDs
   */
  async delete(ids: string[]): Promise<void> {
    if (!this.collection) {
      throw new Error('Collection not initialized. Call createCollection() first.');
    }

    try {
      await this.collection.delete({ ids });
    } catch (error) {
      console.error('✗ Error deleting documents from collection:', error);
      throw error;
    }
  }

  /**
   * Get the number of documents in the collection
   */
  async getCollectionCount(): Promise<number> {
    if (!this.collection) {
      throw new Error('Collection not initialized. Call createCollection() first.');
    }

    try {
      const count = await this.collection.count();
      return count;
    } catch (error) {
      console.error('✗ Error getting collection count:', error);
      throw error;
    }
  }

  /**
   * Delete the collection
   */
  async deleteCollection(): Promise<void> {
    try {
      await this.client.deleteCollection({ name: this.collectionName });
      console.log(`✓ Collection deleted: ${this.collectionName}`);
    } catch (error) {
      console.error('✗ Error deleting collection:', error);
      throw error;
    }
  }

  /**
   * Check if ChromaDB server is running
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.client.heartbeat();
      console.log('✓ ChromaDB server is running');
      return true;
    } catch (error) {
      console.error('✗ ChromaDB server is not reachable');
      console.error('  Make sure to start the server: npm run start:chroma');
      return false;
    }
  }
}

// Test function
async function test() {
  const manager = new ChromaManager();

  try {
    // Check if server is running
    const isHealthy = await manager.healthCheck();
    if (!isHealthy) {
      console.error('\nPlease start ChromaDB server first:');
      console.error('  pip install chromadb');
      console.error('  chroma run --host localhost --port 8000');
      process.exit(1);
    }

    // Create collection
    await manager.createCollection(true);

    // Test with sample data matching kb_nodes schema
    const sampleDocs: KnowledgeBaseEntry[] = [
      {
        id: 1,
        title: 'Python Programming',
        content: 'Python is a versatile programming language used for web development, data science, and automation.',
        category: 'Programming',
        tags: ['python', 'web', 'automation'],
        created_at: new Date('2024-01-01'),
        created_by: 1,
        updated_at: null,
        updated_by: null,
      },
      {
        id: 2,
        title: 'Machine Learning Basics',
        content: 'Machine learning algorithms learn patterns from data to make predictions and decisions.',
        category: 'AI/ML',
        tags: ['machine-learning', 'ai', 'data-science'],
        created_at: new Date('2024-01-02'),
        created_by: 1,
        updated_at: null,
        updated_by: null,
      },
    ];

    // Add documents
    await manager.addDocuments(sampleDocs);

    // Query
    console.log('\n' + '='.repeat(60));
    console.log('Testing semantic search query...');
    console.log('='.repeat(60));
    const results = await manager.query('What is Python used for?', 2);

    console.log(`\nFound ${results.ids[0].length} results:`);
    for (let i = 0; i < results.ids[0].length; i++) {
      const metadata = results.metadatas[0][i];
      const document = results.documents[0][i];
      const distance = results.distances[0][i];
      const similarity = 1 - distance;

      console.log(`\n${i + 1}. ${metadata.title}`);
      console.log(`   Category: ${metadata.category || 'N/A'}`);
      console.log(`   Similarity score: ${similarity.toFixed(4)}`);
      console.log(`   Content: ${document.substring(0, 100)}...`);
    }

    // Get count
    const count = await manager.getCollectionCount();
    console.log(`\nTotal documents in collection: ${count}`);
  } catch (error) {
    console.error('Error during test:', error);
    process.exit(1);
  }
}

// Export config for external use
export { config as chromaConfig };

// Run test if executed directly
if (require.main === module) {
  test().catch(console.error);
}
