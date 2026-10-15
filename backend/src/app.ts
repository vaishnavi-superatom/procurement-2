import './temp-dir';
import { SASDK } from './sa';

async function startServer() {
  console.log('Initializing SuperAtom SDK...\n');
  try {
    await SASDK();
    console.log('✓ SuperAtom SDK initialized successfully!\n');
  } catch (error) {
    console.error('✗ Failed to initialize SuperAtom SDK:', error);
    process.exit(1);
  }
}

startServer();