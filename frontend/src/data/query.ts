// Get client from window (set by superatom.ts or runtime)
const getClient = () => {
  const client = (window as any).SA_WEB_SDK_CLIENT;
  if (!client) {
    throw new Error('SDK client not initialized');
  }
  return client;
};

// Wait for WebSocket connection
const waitForConnection = async (maxWaitTime = 10000): Promise<void> => {
  const client = getClient();
  const startTime = Date.now();

  while (!client.isConnected()) {
    if (Date.now() - startTime > maxWaitTime) {
      throw new Error('WebSocket connection timeout - SDK not connected after ' + maxWaitTime + 'ms');
    }
    // Wait 100ms before checking again
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};

interface QueryExecutorProps {
  query: string | { sql: string; params?: Record<string, any> };
  type?: 'query' | 'mutation';
  timeout?: number;
  SA_RUNTIME?: any;
}

class QueryExecutor {
  async executeQuery({ query, type = 'query', timeout = 120000, SA_RUNTIME }: QueryExecutorProps): Promise<any> {
    const isMutation = type === 'mutation';
    const operationType = isMutation ? 'mutation' : 'query';
    const startTime = performance.now();

    // Handle both string and object formats for query
    let sqlString: string;
    if (typeof query === 'object' && query !== null && 'sql' in query) {
      sqlString = query.sql;
    } else if (typeof query === 'string') {
      sqlString = query;
    } else {
      throw new Error(`${operationType} is required but received invalid format. Expected string or {sql: string}.`);
    }

    // Validate query before execution
    if (!sqlString) {
      throw new Error(`${operationType} is required but received null or undefined. If using externalTool, ensure it has a valid toolId.`);
    }

    // Extract a meaningful identifier from the query (first SELECT/FROM clause or first 80 chars)
    const queryPreview = sqlString
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 80) + (sqlString.length > 80 ? '...' : '');

    console.log(`[QueryExecutor] START ${operationType}: ${queryPreview}`);

    try {
      const client = getClient();

      // Wait for WebSocket connection before executing query
      await waitForConnection();

      // Choose collection and operation based on type
      const collection = 'database';
      const operation = isMutation ? 'mutation' : 'execute';

      // Use the SDK's requestData method with extended timeout
      const response = await client.requestData({
        collection: collection,
        operation: operation,
        params: {
          sql: sqlString  // Backend expects 'sql' parameter
        },
        timeout: timeout, // Always pass timeout (default 60s)
        ...(SA_RUNTIME && { SA_RUNTIME })
      });

      if (response.error) {
        throw new Error(response.error);
      }

      if (!response.data) {
        throw new Error('No data received in response');
      }

      // The SDK returns the data directly
      const data = response.data as any;

      if (!data.success) {
        throw new Error(isMutation ? 'Mutation execution failed' : 'Query execution failed');
      }

      const endTime = performance.now();
      const duration = (endTime - startTime).toFixed(2);

      // For mutations, return the full response (success, affectedRows, message)
      if (isMutation) {
        console.log(`[QueryExecutor] DONE ${operationType} in ${duration}ms | affected: ${data.affectedRows || 0} | ${queryPreview}`);
        return data;
      }

      // For queries, return just the data array
      if (!data.data) {
        throw new Error('No data returned from query');
      }

      console.log(`[QueryExecutor] DONE ${operationType} in ${duration}ms | rows: ${data.data.length} | ${queryPreview}`);
      return data.data;
    } catch (error) {
      const endTime = performance.now();
      const duration = (endTime - startTime).toFixed(2);
      console.error(`[QueryExecutor] FAILED ${operationType} in ${duration}ms | ${queryPreview}`, error);
      if (error instanceof Error) {
        if (error.message.includes('timeout')) {
          throw new Error(`${isMutation ? 'Mutation' : 'Query'} timeout - Database took too long to respond. Try again or check if the database is connected.`);
        }
      }
      throw error;
    }
  }
}
 
export default QueryExecutor;

// Initialize global QueryExecutor
(window as any).SA = (window as any).SA || {};
(window as any).SA.QueryExecutor = new QueryExecutor();