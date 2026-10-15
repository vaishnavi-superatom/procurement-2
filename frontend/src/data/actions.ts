// Get client from window (set by superatom.ts or runtime)
const getClient = () => {
  const client = (window as any).SA_WEB_SDK_CLIENT;
  if (!client) {
    throw new Error('SDK client not initialized');
  }
  return client;
};
 
interface ActionsRequestProps {
  threadId: string;
  uiBlockId: string;
  timeout?: number;
}
 
interface ActionsData {
  actions: any[];
  questions?: any[];
  [key: string]: any;
}
 
interface ActionsResponse {
  data: ActionsData;
}
 
class ActionsRequestExecutor {
  async getActions({ threadId, uiBlockId, timeout }: ActionsRequestProps): Promise<ActionsResponse> {
    // console.log('Requesting actions for:', { threadId, uiBlockId });
 
    try {
      const client = getClient();
 
      // Use the SDK's getActions method
      const response = await client.getActions({
        SA_RUNTIME: {
          userId : localStorage.getItem('sa_logged_in_user_id') || 'anonymous',
          threadId,
          uiBlockId,
        },
        timeout
      });
 
      if (!response.success) {
        throw new Error(response.error || 'Failed to get actions');
      }
 
      if (!response.data) {
        throw new Error('No data received in response');
      }
 
      // Return in the expected format with data wrapper
      return { data: response.data as ActionsData };
    } catch (error) {
      console.error('Actions request error:', error);
      throw error;
    }
  }
}
 
export default ActionsRequestExecutor;

(window as any).SA = (window as any).SA || {};
(window as any).SA.ActionsRequestExecutor = new  ActionsRequestExecutor();