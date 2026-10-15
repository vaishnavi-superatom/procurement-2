/**
 * List all knowledge base nodes for the project.
 *
 * Usage:
 *   pnpm tsx scripts/list-kb-nodes.ts
 *   pnpm tsx scripts/list-kb-nodes.ts --type global
 *   pnpm tsx scripts/list-kb-nodes.ts --type query
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import { Pool } from 'pg';

dotenv.config({ path: resolve(__dirname, '../.env') });

async function main() {
    const dbUrl = process.env.PROJECT_DATABASE_URL;

    if (!dbUrl) {
        console.error('ERROR: PROJECT_DATABASE_URL not set in backend/.env');
        process.exit(1);
    }

    // Optional --type filter
    const typeArg = process.argv.find(a => a.startsWith('--type'));
    const typeFilter = typeArg ? process.argv[process.argv.indexOf(typeArg) + 1] : null;

    const pool = new Pool({ connectionString: dbUrl });

    try {
        let query = `SELECT id, title, content, category, tags, type, created_by, created_at
             FROM kb_nodes`;
        const params: string[] = [];

        if (typeFilter) {
            query += ` WHERE type = $1`;
            params.push(typeFilter);
        }

        query += ` ORDER BY type, created_at DESC`;

        const { rows } = await pool.query(query, params);

        console.log(`\nKnowledge Base Nodes${typeFilter ? ` (type: ${typeFilter})` : ''}\n`);
        console.log('═'.repeat(100));

        if (rows.length === 0) {
            console.log('  No knowledge nodes found.');
        } else {
            for (const node of rows) {
                console.log(`\n  ID: ${node.id}`);
                console.log(`  Title: ${node.title}`);
                console.log(`  Type: ${node.type}`);
                if (node.category) console.log(`  Category: ${node.category}`);
                if (node.tags?.length) console.log(`  Tags: ${node.tags.join(', ')}`);
                console.log(`  Created by: ${node.created_by || 'unknown'} | ${node.created_at}`);
                console.log(`  Content:`);
                // Show content, indented, truncated to 500 chars
                const content = node.content.length > 500
                    ? node.content.substring(0, 500) + '...'
                    : node.content;
                content.split('\n').forEach((line: string) => console.log(`    ${line}`));
                console.log('─'.repeat(100));
            }
        }

        console.log(`\nTotal: ${rows.length} node(s)\n`);
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
});
