// ==================== DSL Types ====================
// Common DSL types used for dashboards and reports
// Synced with sdk-nodejs/src/dashboards/types.ts and sdk-nodejs/src/reports/types.ts

/**
 * Expression for dynamic values
 */
export interface Expression {
  $exp: string;
  $deps?: string[];
}

/**
 * Binding for data binding
 */
export interface Binding {
  $bind: string;
  $transform?: Array<{
    name: string;
    args?: any[];
  }>;
}

/**
 * For directive
 */
export interface ForDirective {
  in: Expression | Binding | string;
  as: string;
  key?: string;
  index?: string;
}

/**
 * Query specification
 */
export interface QuerySpec {
  graphql?: string;
  sql?: string;
  variables?: Record<string, any>;
  params?: Record<string, any>;
  key?: string;
  refetchPolicy?: 'cache-first' | 'network-only' | 'cache-and-network';
  dependencies?: string[];
}

/**
 * UI Element
 */
export interface UIElement {
  id: string;
  type: string;
  key?: string | Expression;
  props?: Record<string, any>;
  query?: QuerySpec;
  if?: Expression;
  elseIf?: Expression;
  for?: ForDirective;
  'link-to'?: string | Expression | Binding | {
    ui: string | Expression | Binding;
    params?: Record<string, any>;
  };
  _meta?: {
    id?: string;
    version?: string;
    created?: string;
    lastModified?: string;
  };
  children?: any;
  else?: UIElement;
  slots?: Record<string, UIElement | UIElement[]>;
  platform?: {
    web?: any;
    ios?: any;
    android?: any;
  };
}

/**
 * UI Component
 */
export interface UIComponent {
  id: string;
  name?: string;
  props?: Record<string, any>;
  states?: Record<string, any>;
  methods?: Record<string, {
    fn: string;
    params?: Record<string, any>;
  }>;
  effects?: Array<{
    fn: string;
    deps?: string[];
  }>;
  data?: Record<string, any>;
  render: UIElement;
  query?: QuerySpec;
}

/**
 * DSLRendererProps represents the DSL structure for dashboards and reports
 */
export interface DSLRendererProps {
  dsl: UIComponent;
  data?: Record<string, any>;
  context?: Record<string, any>;
}
