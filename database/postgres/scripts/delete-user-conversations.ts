/**
 * Script to delete user-conversations data for a specific user
 * - Deletes records from PostgreSQL user_conversations table for the given userId
 * - Deletes embeddings from ChromaDB user_conversations_collection for the given userId
 *
 * Usage (run from postgres folder):
 *   cd ~/superatom/Ikea-dataset/database/postgres
 *   tsx scripts/delete-user-conversations.ts <userId>
 *
 * Example:
 *   tsx scripts/delete-user-conversations.ts user123
 */

// Load environment variables FIRST before any other imports
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load env from postgres folder (run script from postgres folder)
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Also load chromadb env for collection names
dotenv.config({ path: path.resolve(__dirname, '../../chromadb/.env') });

// Now import modules that depend on env variables
import { db, schema } from '../src/project-data-db/drizzle-db';
import { ChromaManager } from '../../chromadb/src/chroma-manager';
import { eq } from 'drizzle-orm';

const { userConversations } = schema;

async function deleteUserConversationsData(userId: string) {
	console.log(`🗑️  Starting user-conversations cleanup for userId: ${userId}\n`);

	if (!userId || userId.trim() === '') {
		throw new Error('Valid userId is required');
	}

	try {
		// Step 1: Get conversation IDs from PostgreSQL first (for ChromaDB deletion)
		console.log('📊 Fetching user conversations from PostgreSQL...');
		const userConvos = await db
			.select()
			.from(userConversations)
			.where(eq(userConversations.userId, userId));

		console.log(`   Found ${userConvos.length} conversations for user ${userId}\n`);

		// Log UIBlock details according to new schema: { id, component, analysis, user_prompt }
		if (userConvos.length > 0) {
			console.log('📋 Conversations to be deleted:');
			console.log('─'.repeat(60));
			userConvos.forEach((convo, index) => {
				const uiblock = convo.response as any;
				// Support both old format (userQuestion/generatedComponentMetadata) and new format (user_prompt/component)
				const userPrompt = uiblock?.user_prompt || uiblock?.userQuestion || convo.userprompt || 'N/A';
				const componentName = uiblock?.component?.name || uiblock?.generatedComponentMetadata?.name || 'N/A';
				const uiblockId = uiblock?.id || 'N/A';
				const analysis = uiblock?.analysis || uiblock?.textResponse || 'N/A';

				console.log(`  ${index + 1}. ID: ${convo.id}`);
				console.log(`     UIBlock ID: ${uiblockId}`);
				console.log(`     User Prompt: "${userPrompt.substring(0, 50)}${userPrompt.length > 50 ? '...' : ''}"`);
				console.log(`     Component: ${componentName}`);
				console.log(`     Analysis: "${(analysis || '').substring(0, 50)}${(analysis || '').length > 50 ? '...' : ''}"`);
				console.log(`     Created: ${convo.createdAt}`);
				console.log('');
			});
			console.log('─'.repeat(60) + '\n');

			// Step 2: Delete from PostgreSQL
			console.log('📊 Deleting user-conversations from PostgreSQL...');
			const deletedRecords = await db
				.delete(userConversations)
				.where(eq(userConversations.userId, userId))
				.returning();

			console.log(`✓ Deleted ${deletedRecords.length} records from PostgreSQL\n`);
		} else {
			console.log('ℹ️  No conversations found in PostgreSQL for this user.\n');
		}

		// Step 3: Delete from ChromaDB
		// Use collection name from env or default
		const collectionName = process.env.USER_CONVERSATIONS_COLLECTION_NAME || 'user_conversations_collection';
		console.log(`🔍 Deleting user-conversation embeddings from ChromaDB (collection: ${collectionName})...`);
		const conversationChromaManager = new ChromaManager(
			undefined,
			collectionName
		);

		// Check if ChromaDB server is running
		const isHealthy = await conversationChromaManager.healthCheck();
		if (!isHealthy) {
			console.warn('⚠️  ChromaDB server is not reachable');
			console.warn('   Skipping ChromaDB cleanup');
			console.warn('   Please start ChromaDB server and run this script again\n');
		} else {
			try {
				// Initialize collection
				await conversationChromaManager.createCollection();

				// Delete embeddings for this user using metadata filter
				const collection = (conversationChromaManager as any).collection;

				if (collection) {
					// ChromaDB delete supports where clause with metadata
					await collection.delete({
						where: { user_id: userId }
					});
					console.log(`✓ Deleted embeddings for user ${userId} from ChromaDB\n`);
				} else {
					console.warn('⚠️  Could not access ChromaDB collection\n');
				}
			} catch (error: any) {
				if (error.message && error.message.includes('does not exist')) {
					console.log('✓ Collection does not exist (no embeddings to delete)\n');
				} else {
					console.error('⚠️  Error deleting from ChromaDB:', error.message);
					console.warn('   PostgreSQL data was deleted, but ChromaDB cleanup failed\n');
				}
			}
		}

		// Summary
		console.log('═'.repeat(60));
		console.log('✅ Cleanup completed successfully!');
		console.log('═'.repeat(60));
		console.log(`   User ID: ${userId}`);
		console.log(`   PostgreSQL records deleted: ${userConvos.length}`);
		console.log(`   ChromaDB embeddings: ${isHealthy ? 'Deleted' : 'Skipped (server not running)'}`);
		console.log('═'.repeat(60) + '\n');

	} catch (error) {
		console.error('❌ Error during cleanup:', error);
		process.exit(1);
	}
}

// Run the cleanup
if (require.main === module) {
	// Get userId from command line arguments
	const userIdArg = process.argv[2];

	if (!userIdArg) {
		console.error('❌ Error: userId is required');
		console.error('\nUsage (run from project root):');
		console.error('  tsx database/postgres/scripts/delete-user-conversations.ts <userId>');
		console.error('\nExample:');
		console.error('  tsx database/postgres/scripts/delete-user-conversations.ts user123\n');
		process.exit(1);
	}

	const userId = userIdArg.trim();

	if (userId === '') {
		console.error('❌ Error: userId must be a non-empty string\n');
		process.exit(1);
	}

	deleteUserConversationsData(userId)
		.then(() => {
			console.log('Done!');
			process.exit(0);
		})
		.catch((error) => {
			console.error('Fatal error:', error);
			process.exit(1);
		});
}

export { deleteUserConversationsData };
