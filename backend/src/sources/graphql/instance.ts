/**
 * GraphQL Source Instance
 */

import {
  BaseSource,
  SourceSchema,
  QueryResult,
  SourceTool,
  SchemaEntity,
  SchemaField,
} from '../core';

interface GraphQLConfig {
  endpoint: string;
  authType: 'none' | 'api_key' | 'bearer' | 'basic';
  authConfig?: {
    apiKey?: string;
    apiKeyHeader?: string;
    bearerToken?: string;
    username?: string;
    password?: string;
  };
  operations: OperationConfig[];
  defaultHeaders?: Record<string, string>;
  timeout?: number;
}

interface OperationConfig {
  id: string;
  name: string;
  description?: string;
  type: 'query' | 'mutation';
  query: string;
  variables?: Record<string, string>; // Variable name -> type description
  dataPath?: string; // Path to data in response (e.g., "users", "data.allUsers")
  responseFields?: SchemaField[];
}

export class GraphQLInstance extends BaseSource {
  private headers: Record<string, string> = {};

  private getConnectionConfig(): GraphQLConfig {
    return this.config.config as GraphQLConfig;
  }

  /**
   * Initialize authentication headers
   */
  async connect(): Promise<void> {
    const cfg = this.getConnectionConfig();

    try {
      // Build auth headers
      this.headers = {
        'Content-Type': 'application/json',
        ...cfg.defaultHeaders,
      };

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

      // Test connection with introspection query
      const introspectionQuery = '{ __typename }';
      await this.executeGraphQL(introspectionQuery, {});

      this.setConnected(true);
      console.log(`[GraphQLInstance] Connected to ${cfg.endpoint}`);
    } catch (error) {
      this.setConnected(false);
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to connect to GraphQL endpoint: ${errorMsg}`);
    }
  }

  async disconnect(): Promise<void> {
    this.headers = {};
    this.setConnected(false);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const introspectionQuery = '{ __typename }';
      const result = await this.executeGraphQL(introspectionQuery, {});
      return result !== null;
    } catch {
      return false;
    }
  }

  /**
   * Extract schema from operation configurations
   */
  async extractSchema(): Promise<SourceSchema> {
    const cfg = this.getConnectionConfig();

    const entities: SchemaEntity[] = cfg.operations.map(operation => ({
      name: operation.id,
      fullName: `${operation.type}: ${operation.name}`,
      description: operation.description || operation.name,
      fields: operation.responseFields || [],
    }));

    const schema: SourceSchema = {
      entities,
      extractedAt: new Date().toISOString(),
    };

    this.setSchema(schema);
    return schema;
  }

  /**
   * Execute GraphQL operation
   */
  async execute(params: {
    operation: string;
    variables?: Record<string, any>;
    limit?: number;
  }): Promise<QueryResult> {
    const cfg = this.getConnectionConfig();
    const { operation: operationId, variables, limit } = params;
    const startTime = Date.now();

    console.log(`[GraphQLInstance:${this.config.name}] execute() called with:`, JSON.stringify(params));

    // Find operation config
    const operation = cfg.operations.find(o => o.id === operationId);
    if (!operation) {
      throw new Error(`Operation '${operationId}' not found. Available: ${cfg.operations.map(o => o.id).join(', ')}`);
    }

    try {
      const result = await this.executeGraphQL(operation.query, variables || {});

      // Extract data from response
      let data: any[];
      if (operation.dataPath) {
        data = this.getNestedValue(result, operation.dataPath);
        if (!Array.isArray(data)) data = data ? [data] : [];
      } else {
        // Try to find the data automatically
        const keys = Object.keys(result || {});
        if (keys.length === 1) {
          const value = result[keys[0]];
          data = Array.isArray(value) ? value : [value];
        } else {
          data = [result];
        }
      }

      // Apply limit if specified
      if (limit && data.length > limit) {
        data = data.slice(0, limit);
      }

      return {
        data,
        count: data.length,
        metadata: {
          executionTime: Date.now() - startTime,
          operation: operationId,
          operationType: operation.type,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[GraphQLInstance:${this.config.name}] Execute error:`, errorMsg);
      throw new Error(`GraphQL operation failed: ${errorMsg}`);
    }
  }

  /**
   * Execute raw GraphQL query
   */
  private async executeGraphQL(query: string, variables: Record<string, any>): Promise<any> {
    const cfg = this.getConnectionConfig();
    const timeout = cfg.timeout || 30000;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      console.log(`[GraphQLInstance:${this.config.name}] Executing query at ${cfg.endpoint}`);

      const response = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      console.log(`[GraphQLInstance:${this.config.name}] Response status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GraphQL HTTP error ${response.status}: ${errorText}`);
      }

      const json = await response.json() as { data?: any; errors?: any[] };

      // Check for GraphQL errors
      if (json.errors && json.errors.length > 0) {
        const errorMessages = json.errors.map((e: any) => e.message).join('; ');
        throw new Error(`GraphQL errors: ${errorMessages}`);
      }

      return json.data;
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
    return `${this.config.id}_graphql`;
  }

  protected getToolName(): string {
    return `Query ${this.config.name}`;
  }

  protected buildToolDescription(): string {
    const cfg = this.getConnectionConfig();

    // Build detailed operation descriptions including response fields
    const operations = cfg.operations.map(o => {
      let opDesc = `• ${o.id} (${o.type}): ${o.description || o.name}`;

      // Add variable info if available
      if (o.variables && Object.keys(o.variables).length > 0) {
        const varsList = Object.entries(o.variables)
          .map(([name, type]) => `${name}: ${type}`)
          .join(', ');
        opDesc += `\n  Variables: ${varsList}`;
      }

      // Add response fields if available
      if (o.responseFields && o.responseFields.length > 0) {
        const fieldsList = o.responseFields
          .map(f => `${f.name} (${f.type})`)
          .join(', ');
        opDesc += `\n  Returns: ${fieldsList}`;
      }

      return opDesc;
    }).join('\n');

    const sourceContext = this.getSourceContext();

    return `Execute GraphQL operations on ${this.config.name} (${cfg.endpoint}).${sourceContext}

Available operations:
${operations}

Specify operation ID and any required variables.`;
  }

  protected getToolParams(): Record<string, string> {
    const cfg = this.getConnectionConfig();
    const operationIds = cfg.operations.map(o => o.id).join(', ');

    // Collect all variable definitions
    const allVariables: string[] = [];
    for (const op of cfg.operations) {
      if (op.variables) {
        for (const [name, type] of Object.entries(op.variables)) {
          allVariables.push(`${name} (${type})`);
        }
      }
    }

    const variablesDesc = allVariables.length > 0
      ? `object (optional) - Variables for the operation. Known variables: ${Array.from(new Set(allVariables)).join(', ')}`
      : 'object (optional) - Variables for the operation';

    return {
      operation: `string - Operation ID to execute. Available: ${operationIds}`,
      variables: variablesDesc,
      limit: 'number (optional) - Max results to return',
    };
  }

  protected getToolOutputSchema(): SourceTool['outputSchema'] {
    const cfg = this.getConnectionConfig();

    // Collect all unique response fields from all operations
    const allFields: Array<{ name: string; type: string; description: string }> = [];
    const seenFields = new Set<string>();

    for (const operation of cfg.operations) {
      if (operation.responseFields) {
        for (const field of operation.responseFields) {
          if (!seenFields.has(field.name)) {
            seenFields.add(field.name);
            allFields.push({
              name: field.name,
              type: field.type || 'string',
              description: field.description || `${field.name} field from ${operation.id}`,
            });
          }
        }
      }
    }

    // If no response fields defined, use generic schema
    if (allFields.length === 0) {
      return {
        description: 'GraphQL response data',
        fields: [
          { name: 'data', type: 'array', description: 'Response data' },
          { name: 'count', type: 'number', description: 'Number of items' },
        ],
      };
    }

    // Build description listing fields per operation
    const operationFieldsDesc = cfg.operations
      .filter(o => o.responseFields?.length)
      .map(o => `${o.id}: ${o.responseFields!.map(f => f.name).join(', ')}`)
      .join('; ');

    return {
      description: `GraphQL response data. Fields by operation: ${operationFieldsDesc}`,
      fields: [
        ...allFields,
        { name: 'count', type: 'number', description: 'Number of items returned' },
      ],
    };
  }
}
