/**
 * Type definitions for knowledge base
 */

export interface KnowledgeBaseEntry {
  id: number;
  title: string;
  content: string;
  category: string | null;
  tags: string[] | null;
  created_at: Date;
  created_by: number | null;
  updated_at: Date | null;
  updated_by: number | null;
}

export interface ChromaDocument {
  id: string;
  content: string;
  metadata: {
    kb_id: number;
    title: string;
    category: string | null;
    tags: string | null; // JSON stringified array
    created_at: string;
  };
}

export interface QueryResult {
  ids: string[][];
  documents: string[][];
  metadatas: Array<Array<{
    kb_id: number;
    title: string;
    category?: string;
    tags?: string;
    created_at: string;
  }>>;
  distances: number[][];
}
