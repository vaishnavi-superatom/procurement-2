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

interface ExternalTool {
  toolId: string;
  toolName: string;
  parameters: Record<string, any>;
}

interface ToolExecutorProps {
  externalTool: ExternalTool;
  formData: Record<string, any>;
  timeout?: number;
  SA_RUNTIME?: any;
}

interface QueryIdExecutorProps {
  toolId: string;
  queryId: string;
  params?: Record<string, any>;
  filterParams?: Record<string, any>;
  timeout?: number;
  SA_RUNTIME?: any;
}

class ToolExecutor {
  async executeTool({ externalTool, formData, timeout = 120000, SA_RUNTIME }: ToolExecutorProps): Promise<any> {
    const startTime = performance.now();
    const toolName = externalTool.toolName || externalTool.toolId || 'unknown';

    // Create a preview of the parameters for logging
    const paramsPreview = JSON.stringify(externalTool.parameters || {})
      .substring(0, 60) + (JSON.stringify(externalTool.parameters || {}).length > 60 ? '...' : '');

    console.log(`[ToolExecutor] START tool: ${toolName} | params: ${paramsPreview}`);

    try {
      const client = getClient();

      // Wait for WebSocket connection before executing
      await waitForConnection();

      // Use the SDK's requestData method to call the external tool
      // The backend will route this to the appropriate tool handler
      const response = await client.requestData({
        collection: 'external-tools',
        operation: 'execute',
        params: {
          toolId: externalTool.toolId,
          toolName: externalTool.toolName,
          // Merge tool parameters with form data
          // Form data becomes the 'data' field for create/update operations
          ...externalTool.parameters,
          data: formData
        },
        timeout: timeout,
        ...(SA_RUNTIME && { SA_RUNTIME })
      });

      if (response.error) {
        throw new Error(response.error);
      }

      if (!response.data) {
        throw new Error('No data received in response');
      }

      const data = response.data as any;

      if (!data.success) {
        const errorMsg = data.message || data.error;
        if (!errorMsg) {
          console.error(`[ToolExecutor] Tool returned failure without error details:`, JSON.stringify(data).substring(0, 500));
        }
        throw new Error(errorMsg || `Tool '${toolName}' execution failed`);
      }

      const endTime = performance.now();
      const duration = (endTime - startTime).toFixed(2);
      const resultCount = Array.isArray(data.data) ? data.data.length : (data.data ? 1 : 0);

      console.log(`[ToolExecutor] DONE tool: ${toolName} in ${duration}ms | results: ${resultCount} | params: ${paramsPreview}`);

      return data;
    } catch (error) {
      const endTime = performance.now();
      const duration = (endTime - startTime).toFixed(2);
      console.error(`[ToolExecutor] FAILED tool: ${toolName} in ${duration}ms | params: ${paramsPreview}`, error);
      if (error instanceof Error) {
        if (error.message.includes('timeout')) {
          throw new Error(`Tool execution timeout - External service took too long to respond. Try again later.`);
        }
      }
      throw error;
    }
  }

  /**
   * Execute a tool using a server-stored queryId (SQL never leaves the backend)
   * Used when externalTool.parameters contains queryId instead of sql
   */
  async executeByQueryId({ toolId, queryId, params, filterParams, timeout = 120000, SA_RUNTIME }: QueryIdExecutorProps): Promise<any> {
    const startTime = performance.now();

    console.log(`[ToolExecutor] START executeByQueryId: tool=${toolId}, queryId=${queryId}`);

    try {
      const client = getClient();
      await waitForConnection();

      const response = await client.requestData({
        collection: 'external-tools',
        operation: 'executeByQueryId',
        params: {
          toolId,
          queryId,
          ...(params && { params }),
          ...(filterParams && { filterParams }),
        },
        timeout: timeout,
        ...(SA_RUNTIME && { SA_RUNTIME })
      });

      if (response.error) {
        throw new Error(response.error);
      }

      if (!response.data) {
        throw new Error('No data received in response');
      }

      const data = response.data as any;

      if (!data.success) {
        const errorMsg = data.message || data.error;
        if (!errorMsg) {
          console.error(`[ToolExecutor] executeByQueryId returned failure without error details:`, JSON.stringify(data).substring(0, 500));
        }
        throw new Error(errorMsg || `Tool execution failed (queryId: ${queryId})`);
      }

      const endTime = performance.now();
      const duration = (endTime - startTime).toFixed(2);
      const resultCount = Array.isArray(data.data) ? data.data.length : (data.data ? 1 : 0);

      console.log(`[ToolExecutor] DONE executeByQueryId in ${duration}ms | results: ${resultCount} | queryId: ${queryId}`);

      return data;
    } catch (error) {
      const endTime = performance.now();
      const duration = (endTime - startTime).toFixed(2);
      console.error(`[ToolExecutor] FAILED executeByQueryId in ${duration}ms | queryId: ${queryId}`, error);
      if (error instanceof Error) {
        if (error.message.includes('timeout')) {
          throw new Error(`Tool execution timeout - External service took too long to respond. Try again later.`);
        }
      }
      throw error;
    }
  }
}

export default ToolExecutor;

// Initialize global ToolExecutor
(window as any).SA = (window as any).SA || {};
(window as any).SA.ToolExecutor = new ToolExecutor();
