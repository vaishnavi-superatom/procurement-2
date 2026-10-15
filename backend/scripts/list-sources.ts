/**
 * List all project sources with their IDs.
 *
 * Usage:
 *   cd backend && npx tsx scripts/list-sources.ts
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import { Pool } from 'pg';

dotenv.config({ path: resolve(__dirname, '../.env') });

async function main() {
    const projectId = process.env.SUPERATOM_PROJECT_ID;
    const dbUrl = process.env.PROJECT_DATABASE_URL;

    if (!projectId) {
        console.error('ERROR: SUPERATOM_PROJECT_ID not set in backend/.env');
        process.exit(1);
    }
    if (!dbUrl) {
        console.error('ERROR: PROJECT_DATABASE_URL not set in backend/.env');
        process.exit(1);
    }

    const pool = new Pool({ connectionString: dbUrl });

    try {
        const { rows } = await pool.query(
            `SELECT id, name, type, is_primary, is_active
             FROM project_sources
             WHERE project_id = $1
             ORDER BY is_primary DESC, type, name`,
            [projectId]
        );

        console.log(`\nProject: ${projectId}\n`);
        console.log('─'.repeat(90));
        console.log(
            'ID'.padEnd(30),
            'Name'.padEnd(25),
            'Type'.padEnd(10),
            'Primary'.padEnd(8),
            'Active'.padEnd(8),
        );
        console.log('─'.repeat(90));

        if (rows.length === 0) {
            console.log('  No sources found for this project.');
        } else {
            for (const s of rows) {
                console.log(
                    String(s.id).padEnd(30),
                    String(s.name).padEnd(25),
                    String(s.type).padEnd(10),
                    (s.is_primary ? 'YES' : '').padEnd(8),
                    (s.is_active ? 'YES' : 'NO').padEnd(8),
                );
            }
        }

        console.log('─'.repeat(90));
        console.log(`\nTotal: ${rows.length} source(s)\n`);
        console.log('Use the ID value in your direct tools config:');
        console.log('  export const sourceId = \'<id-from-above>\';  // in tools/direct/{project}/index.ts\n');
    } finally {
        await pool.end();
    }
}

main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
});
