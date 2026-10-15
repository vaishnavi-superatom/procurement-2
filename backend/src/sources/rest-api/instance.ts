/**
 * REST API Source Instance
 */

import {
  BaseSource,
  SourceSchema,
  QueryResult,
  SourceTool,
  SchemaEntity,
  SchemaField,
} from '../core';

interface RestApiConfig {
  baseUrl: string;
  authType: 'none' | 'api_key' | 'bearer' | 'basic';
  authConfig?: {
    apiKey?: string;
    apiKeyHeader?: string;
    bearerToken?: string;
    username?: string;
    password?: string;
  };
  endpoints: EndpointConfig[];
  defaultHeaders?: Record<string, string>;
  timeout?: number;
}

interface EndpointConfig {
  id: string;
  name: string;
  description?: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  queryParams?: Record<string, string>;
  bodySchema?: Record<string, any>;
  responseSchema?: {
    dataPath?: string;  // JSON path to data array (e.g., "results", "data.items")
    fields?: SchemaField[];
  };
}

export class RestApiInstance extends BaseSource {
  private headers: Record<string, string> = {};

  private getConnectionConfig(): RestApiConfig {
    return this.config.config as RestApiConfig;
  }

  /**
   * Initialize authentication headers
   */
  async connect(): Promise<void> {
    const cfg = this.getConnectionConfig();

    try {
      // Build auth headers
      this.headers = { ...cfg.defaultHeaders };

      switch (cfg.authType) {
        case 'api_key':
          if (cfg.authConfig?.apiKey) {
            const headerName = cfg.authConfig.apiKeyHeader || 'X-API-Key';
            this.headers[headerName] = cfg.authConfig.apiKey;
          }
          break;
        case 'bearer':
          if (cfg.authConfig?.bearerToken) {
            this.headers['Authorization'] = `Bearer ${cfg.authConfig.bearerToken}`;
          }
          break;
        case 'basic':
          if (cfg.authConfig?.username && cfg.authConfig?.password) {
            const credentials = Buffer.from(`${cfg.authConfig.username}:${cfg.authConfig.password}`).toString('base64');
            this.headers['Authorization'] = `Basic ${credentials}`;
          }
          break;
      }

      // Test connection with a simple request to base URL
      const testUrl = cfg.baseUrl.replace(/\/$/, '');
      const response = await this.fetchWithTimeout(testUrl, { method: 'HEAD', headers: this.headers });

      if (response.status === 401 || response.status === 403) {
        throw new Error(`Authentication failed (HTTP ${response.status}). Check your credentials.`);
      }

      this.setConnected(true);
      console.log(`[RestApiInstance] Connected to ${cfg.baseUrl}`);
    } catch (error) {
      this.setConnected(false);
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to connect to REST API: ${errorMsg}`);
    }
  }

  async disconnect(): Promise<void> {
    this.headers = {};
    this.setConnected(false);
  }

  async healthCheck(): Promise<boolean> {
    const cfg = this.getConnectionConfig();
    try {
      const response = await this.fetchWithTimeout(cfg.baseUrl, {
        method: 'HEAD',
        headers: this.headers,
      });
      return response.ok || response.status < 500;
    } catch {
      return false;
    }
  }

  /**
   * Extract schema from endpoint configurations
   */
  async extractSchema(): Promise<SourceSchema> {
    const cfg = this.getConnectionConfig();

    const entities: SchemaEntity[] = cfg.endpoints.map(endpoint => ({
      name: endpoint.id,
      fullName: `${endpoint.method} ${endpoint.path}`,
      description: endpoint.description || endpoint.name,
      fields: endpoint.responseSchema?.fields || [],
    }));

    const schema: SourceSchema = {
      entities,
      extractedAt: new Date().toISOString(),
    };

    this.setSchema(schema);
    return schema;
  }

  /**
   * Execute API call
   */
  async execute(params: {
    endpoint: string;
    pathParams?: Record<string, string>;
    queryParams?: Record<string, any>;
    body?: any;
    limit?: number;
  }): Promise<QueryResult> {
    const cfg = this.getConnectionConfig();
    const { endpoint: endpointId, pathParams, queryParams, body, limit } = params;
    const startTime = Date.now();

    console.log(`[RestApiInstance:${this.config.name}] execute() called with:`, JSON.stringify(params));

    // Find endpoint config
    const endpoint = cfg.endpoints.find(e => e.id === endpointId);
    if (!endpoint) {
      throw new Error(`Endpoint '${endpointId}' not found. Available: ${cfg.endpoints.map(e => e.id).join(', ')}`);
    }

    // Build URL
    let url = cfg.baseUrl.replace(/\/$/, '') + endpoint.path;

    // Replace path parameters
    if (pathParams) {
      for (const [key, value] of Object.entries(pathParams)) {
        url = url.replace(`{${key}}`, encodeURIComponent(value));
      }
    }

    // Add query parameters
    const allQueryParams = { ...endpoint.queryParams, ...queryParams };
    if (limit) {
      allQueryParams['limit'] = String(limit);
    }
    if (Object.keys(allQueryParams).length > 0) {
      const qs = new URLSearchParams(allQueryParams as Record<string, string>).toString();
      url += `?${qs}`;
    }

    try {
      const options: RequestInit = {
        method: endpoint.method,
        headers: {
          ...this.headers,
          'Content-Type': 'application/json',
        },
      };

      if (body && ['POST', 'PUT'].includes(endpoint.method)) {
        options.body = JSON.stringify(body);
      }

      console.log(`[RestApiInstance:${this.config.name}] Fetching URL: ${url}`);
      console.log(`[RestApiInstance:${this.config.name}] Method: ${endpoint.method}, Headers:`, this.headers);

      const response = await this.fetchWithTimeout(url, options);

      console.log(`[RestApiInstance:${this.config.name}] Response status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error ${response.status}: ${errorText}`);
      }

      const json = await response.json() as Record<string, unknown>;

      // Extract data from response
      let data: any[];
      if (endpoint.responseSchema?.dataPath) {
        data = this.getNestedValue(json, endpoint.responseSchema.dataPath);
        if (!Array.isArray(data)) data = [data];
      } else if (Array.isArray(json)) {
        data = json;
      } else if (json.data && Array.isArray(json.data)) {
        data = json.data as any[];
      } else if (json.results && Array.isArray(json.results)) {
        data = json.results as any[];
      } else {
        data = [json];
      }

      // Apply limit if not handled by API
      if (limit && data.length > limit) {
        data = data.slice(0, limit);
      }

      return {
        data,
        count: data.length,
        metadata: {
          executionTime: Date.now() - startTime,
          endpoint: endpointId,
          url,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : '';
      console.error(`[RestApiInstance:${this.config.name}] Fetch error:`, errorMsg);
      console.error(`[RestApiInstance:${this.config.name}] Error stack:`, errorStack);
      console.error(`[RestApiInstance:${this.config.name}] Error cause:`, (error as any)?.cause);
      throw new Error(`API call failed: ${errorMsg}`);
    }
  }

  /**
   * Fetch with timeout
   */
  private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    const cfg = this.getConnectionConfig();
    const timeout = cfg.timeout || 30000;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get nested value from object
   */
  private getNestedValue(obj: any, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }

  // ============================================
  // Tool Generation
  // ============================================

  protected getToolId(): string {
    return `${this.config.id}_call`;
  }

  protected getToolName(): string {
    return `Call ${this.config.name}`;
  }

  protected buildToolDescription(): string {
    const cfg = this.getConnectionConfig();

    // Build detailed endpoint descriptions including response fields
    const endpoints = cfg.endpoints.map(e => {
      let endpointDesc = `• ${e.id}: ${e.method} ${e.path} - ${e.description || e.name}`;

      // Add response fields if available
      if (e.responseSchema?.fields && e.responseSchema.fields.length > 0) {
        const fieldsList = e.responseSchema.fields
          .map(f => `${f.name} (${f.type})`)
          .join(', ');
        endpointDesc += `\n  Returns: ${fieldsList}`;
      }

      return endpointDesc;
    }).join('\n');

    return `Call ${this.config.name} REST API (${cfg.baseUrl}).

Available endpoints:
${endpoints}

Specify endpoint ID and any required parameters.`;
  }

  protected getToolParams(): Record<string, string> {
    const cfg = this.getConnectionConfig();
    const endpointIds = cfg.endpoints.map(e => e.id).join(', ');

    return {
      endpoint: `string - Endpoint ID to call. Available: ${endpointIds}`,
      pathParams: 'object (optional) - Path parameters { "id": "123" }',
      queryParams: 'object (optional) - Query parameters',
      body: 'object (optional) - Request body for POST/PUT',
      limit: 'number (optional) - Max results',
    };
  }

  protected getToolOutputSchema(): SourceTool['outputSchema'] {
    const cfg = this.getConnectionConfig();

    // Collect all unique response fields from all endpoints
    const allFields: Array<{ name: string; type: string; description: string }> = [];
    const seenFields = new Set<string>();

    for (const endpoint of cfg.endpoints) {
      if (endpoint.responseSchema?.fields) {
        for (const field of endpoint.responseSchema.fields) {
          if (!seenFields.has(field.name)) {
            seenFields.add(field.name);
            allFields.push({
              name: field.name,
              type: field.type || 'string',
              description: field.description || `${field.name} field from ${endpoint.id}`,
            });
          }
        }
      }
    }

    // If no response fields defined, use generic schema
    if (allFields.length === 0) {
      return {
        description: 'API response data',
        fields: [
          { name: 'data', type: 'array', description: 'Response data' },
          { name: 'count', type: 'number', description: 'Number of items' },
        ],
      };
    }

    // Build description listing fields per endpoint
    const endpointFieldsDesc = cfg.endpoints
      .filter(e => e.responseSchema?.fields?.length)
      .map(e => `${e.id}: ${e.responseSchema!.fields!.map(f => f.name).join(', ')}`)
      .join('; ');

    return {
      description: `API response data. Fields by endpoint: ${endpointFieldsDesc}`,
      fields: [
        ...allFields,
        { name: 'count', type: 'number', description: 'Number of items returned' },
      ],
    };
  }
}
