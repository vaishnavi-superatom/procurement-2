/**
 * PostgreSQL connector for fetching knowledge base data from kb_nodes table
 */

import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { KnowledgeBaseEntry } from './types';

// Load .env from chromadb directory
dotenv.config({ path: path.resolve(__dirname, '../.env'), quiet: true });

// Configuration with validation
const config = {
  DATABASE_URL: process.env.PROJECT_DATABASE_URL || process.env.DATABASE_URL,
  KB_TABLE_NAME: process.env.KB_TABLE_NAME || 'kb_nodes',
};

// Validate required configuration
function validateConfig(): void {
  if (!config.DATABASE_URL) {
    console.error('✗ Missing required environment variable: PROJECT_DATABASE_URL or DATABASE_URL');
    console.error('  Please copy .env.example to .env and configure your database connection.');
    process.exit(1);
  }
}

export class PostgresConnector {
  private pool: Pool;
  private tableName: string;

  constructor(connectionString?: string, tableName?: string) {
    validateConfig();

    const connString = connectionString || config.DATABASE_URL;
    this.tableName = tableName || config.KB_TABLE_NAME;

    this.pool = new Pool({
      connectionString: connString,
    });
  }

  /**
   * Test database connection
   */
  async connect(): Promise<void> {
    try {
      const client = await this.pool.connect();
      console.log('✓ Connected to PostgreSQL database');
      client.release();
    } catch (error) {
      console.error('✗ Error connecting to database:', error);
      throw error;
    }
  }

  /**
   * Fetch all knowledge base entries from kb_nodes table
   */
  async fetchAllKnowledgeBase(): Promise<KnowledgeBaseEntry[]> {
    const query = `
      SELECT id, title, content, category, tags, created_at, created_by, updated_at, updated_by
      FROM ${this.tableName}
      ORDER BY id;
    `;

    try {
      const result = await this.pool.query(query);
      console.log(`✓ Fetched ${result.rows.length} knowledge base entries from ${this.tableName}`);
      return result.rows;
    } catch (error) {
      console.error('✗ Error fetching data:', error);
      throw error;
    }
  }

  /**
   * Fetch a single knowledge base entry by ID
   */
  async fetchKnowledgeBaseById(id: number): Promise<KnowledgeBaseEntry | null> {
    const query = `
      SELECT id, title, content, category, tags, created_at, created_by, updated_at, updated_by
      FROM ${this.tableName}
      WHERE id = $1;
    `;

    try {
      const result = await this.pool.query(query, [id]);
      return result.rows[0] || null;
    } catch (error) {
      console.error('✗ Error fetching data:', error);
      throw error;
    }
  }

  /**
   * Get total count of knowledge base entries
   */
  async getCount(): Promise<number> {
    const query = `SELECT COUNT(*) FROM ${this.tableName};`;

    try {
      const result = await this.pool.query(query);
      return parseInt(result.rows[0].count);
    } catch (error) {
      console.error('✗ Error getting count:', error);
      throw error;
    }
  }

  /**
   * Close database connection pool
   */
  async disconnect(): Promise<void> {
    await this.pool.end();
    console.log('✓ Disconnected from PostgreSQL database');
  }
}

// Test function
async function test() {
  const connector = new PostgresConnector();

  try {
    await connector.connect();

    const count = await connector.getCount();
    console.log(`\nTotal entries in database: ${count}`);

    const entries = await connector.fetchAllKnowledgeBase();

    if (entries.length > 0) {
      console.log('\nSample entry:');
      console.log(`ID: ${entries[0].id}`);
      console.log(`Title: ${entries[0].title}`);
      console.log(`Category: ${entries[0].category || 'N/A'}`);
      console.log(`Tags: ${entries[0].tags?.join(', ') || 'N/A'}`);
      console.log(`Content: ${entries[0].content.substring(0, 100)}...`);
      console.log(`Created: ${entries[0].created_at}`);
    }
  } finally {
    await connector.disconnect();
  }
}

// Run test if executed directly
if (require.main === module) {
  test().catch(console.error);
}
