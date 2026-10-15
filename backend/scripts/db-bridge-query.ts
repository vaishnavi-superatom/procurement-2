/**
 * Query the remote database via the db-bridge WebSocket.
 *
 * Usage:
 *   cd backend && npx tsx scripts/db-bridge-query.ts "SELECT TOP 10 * FROM your_table"
 *   cd backend && npx tsx scripts/db-bridge-query.ts --tables          # list all tables
 *   cd backend && npx tsx scripts/db-bridge-query.ts --schema TableName # get column info
 */

import dotenv from 'dotenv';
import { resolve } from 'path';
import WebSocket from 'ws';
import { randomUUID } from 'crypto';

dotenv.config({ path: resolve(__dirname, '../.env') });

const WS_URL = process.env.SA_WEBSOCKET_URL || 'wss://ws.superatom.ai/websocket';
const PROJECT_ID = process.env.SUPERATOM_PROJECT_ID || process.env.PROJECT_ID;

if (!PROJECT_ID) {
  console.error('ERROR: SA_BRIDGE_PROJECT_ID (or PROJECT_ID) not set in backend/.env');
  console.error('       This MUST match the PROJECT_ID configured in the db-bridge process.');
  process.exit(1);
}

console.log(`[smoke-test] WS_URL=${WS_URL}`);
console.log(`[smoke-test] PROJECT_ID=${PROJECT_ID}`);

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage:');
  console.error('  npx tsx scripts/db-bridge-query.ts "SELECT TOP 10 * FROM table"');
  console.error('  npx tsx scripts/db-bridge-query.ts --tables');
  console.error('  npx tsx scripts/db-bridge-query.ts --schema TableName');
  process.exit(1);
}

interface BroadcastMessage {
  id: string;
  type: string;
  from: { type?: string; id?: string };
  payload: any;
  to?: { type?: string; id?: string };
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const url = `${WS_URL}?projectId=${PROJECT_ID}&type=runtime`;
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(err));
  });
}

function sendAndWait(ws: WebSocket, msg: BroadcastMessage, timeoutMs = 300000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for response (${timeoutMs}ms)`));
    }, timeoutMs);

    const handler = (raw: WebSocket.RawData) => {
      const data = JSON.parse(raw.toString());
      if (data.id === msg.id) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(data);
      }
    };

    ws.on('message', handler);
    ws.send(JSON.stringify(msg));
  });
}

async function main() {
  const ws = await connect();
  console.log('Connected to DO WebSocket\n');

  try {
    let message: BroadcastMessage;

    if (args[0] === '--tables') {
      message = {
        id: randomUUID(),
        type: 'list-tables',
        from: { type: 'runtime' },
        to: { type: 'db-bridge' },
        payload: {},
      };
    } else if (args[0] === '--schema') {
      if (!args[1]) {
        console.error('Usage: npx tsx scripts/db-bridge-query.ts --schema TableName');
        process.exit(1);
      }
      message = {
        id: randomUUID(),
        type: 'get-schema',
        from: { type: 'runtime' },
        to: { type: 'db-bridge' },
        payload: { table: args[1] },
      };
    } else {
      message = {
        id: randomUUID(),
        type: 'query',
        from: { type: 'runtime' },
        to: { type: 'db-bridge' },
        payload: { sql: args.join(' ') },
      };
    }

    const response = await sendAndWait(ws, message);

    if (response.type === 'query-error') {
      console.error('Query error:', response.payload.error);
    } else {
      console.table(response.payload.rows || response.payload.tables || response.payload.columns);
      if (response.payload.rowCount !== undefined) {
        console.log(`\n${response.payload.rowCount} rows`);
      }
    }
  } finally {
    ws.close();
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
