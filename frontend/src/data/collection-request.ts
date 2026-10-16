// Calls one of the backend's own collections (pr-comments, rfq-workflow, …)
// over the web SDK and unwraps the { success, data } envelope they return.

// The slice of the web SDK client this file uses.
interface SdkClient {
  isConnected(): boolean;
  requestData(request: {
    collection: string;
    operation: string;
    params: Record<string, unknown>;
    timeout?: number;
  }): Promise<{ error?: string; data?: unknown }>;
}

// Get client from window (set by superatom.ts or runtime)
const getClient = (): SdkClient => {
  const client = (window as unknown as { SA_WEB_SDK_CLIENT?: SdkClient }).SA_WEB_SDK_CLIENT;
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
    await new Promise(resolve => setTimeout(resolve, 100));
  }
};

export async function requestCollection<T>(
  collection: string,
  operation: string,
  params: Record<string, unknown>,
  timeout = 30000
): Promise<T> {
  const client = getClient();
  await waitForConnection();

  const response = await client.requestData({ collection, operation, params, timeout });

  if (response.error) {
    throw new Error(response.error);
  }

  const data = response.data as { success?: boolean; data?: T; message?: string; error?: string } | undefined;
  if (!data?.success) {
    throw new Error(data?.message || data?.error || `${collection} ${operation} failed`);
  }
  return data.data as T;
}
