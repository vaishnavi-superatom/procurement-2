export interface ComponentMetadata {
  id: string;
  name: string;
  displayName?: string;
  isDisplayComp?: boolean;
  type: string; // Can be any type - KPICard, BarChart, LineChart, PieChart, DonutChart, DataTable, Form, Workflow_*, etc.
  description: string;
  category: string; // Broad categories for filtering
  keywords: string[]; // Keywords for natural language matching
  /** Sidebar label used when this component is registered as the Home dashboard (defaults to "Home"). */
  homeLabel?: string;
  /**
   * When present, the runtime sidebar surfaces this component as a top-level
   * dashboard nav entry — discovered from the bundle so runtime-react never
   * hardcodes which dashboards exist. The component currently serving as Home
   * (SA.COMPONENTS.Home) is automatically excluded to avoid duplicates.
   * See frontend/src/modules/DASHBOARDS.md.
   */
  dashboard?: {
    label: string;     // sidebar label
    icon?: string;     // iconify icon (default "mdi:view-dashboard")
    order?: number;    // sort order among dashboards
  };
  props: {
    // Query prop - for database queries
    // Can be string, object with sql/params, or null (when using externalTool)
    query?: string | {
      sql: string;
      params?: string | Record<string, any>;
    } | null;
    // External tool prop - for external API calls
    // Set to null if using query, otherwise provide tool config
    externalTool?: string | {
      toolId: string;
      toolName: string;
      parameters: string | Record<string, any>;
    } | null;
    title?: string;
    description?: string;
    config?: {
      [key: string]: any;
    };
    [key: string]: any; // Allow any additional props
  };
}
