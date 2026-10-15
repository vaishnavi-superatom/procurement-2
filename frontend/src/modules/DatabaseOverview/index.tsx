import React, { useEffect, useState } from 'react';
import { Icon } from '@iconify/react';
import ActionContainer from '../../shared-modules/ActionContainer';
import type { Action } from '../../shared-modules/ActionContainer';
import LoadingState from '../../components/LoadingState';
import type { ComponentMetadata } from '../../types';
import { COLORS, SHADOWS, BORDER_RADIUS, TYPOGRAPHY, SPACING } from '../../design-system/tokens';

interface TableInfo {
  table_name: string;
  row_count: number;
  column_count: number;
}

interface ColumnTypeInfo {
  data_type: string;
  type_count: number;
}

interface DatabaseOverviewProps {
  query?: string;
  title?: string;
  description?: string;
  actions?: Action[];
  config?: {
    showKPIs?: boolean;
    showCharts?: boolean;
    showTable?: boolean;
    data?: any;
  };
  SA_RUNTIME?: any;
}

/**
* ============================================
* DESIGN SYSTEM THEME - Using design-system/tokens.ts
* ============================================
*/
const THEME = {
  card: {
    background: COLORS.white,
    borderRadius: BORDER_RADIUS.large,
    padding: SPACING.xl,
    boxShadow: SHADOWS.card,
  },
  title: {
    fontSize: parseInt(TYPOGRAPHY.fontSize.subsection),
    fontWeight: TYPOGRAPHY.fontWeight.semibold,
    color: COLORS.text.primary,
  },
  subtitle: {
    fontSize: parseInt(TYPOGRAPHY.fontSize.body),
    color: COLORS.text.secondary,
  },
  colors: [
    COLORS.primary,
    COLORS.success,
    COLORS.warning,
    COLORS.chart.secondary,
    COLORS.chart.tertiary,
    COLORS.error,
    COLORS.info
  ],
  loadingColor: COLORS.primary,
  errorColor: COLORS.error,
};

// Query to get table statistics
const TABLE_STATS_QUERY = `
SELECT
  t.table_name,
  COALESCE(
    (SELECT COUNT(*)
     FROM information_schema.columns
     WHERE table_schema = t.table_schema
     AND table_name = t.table_name), 0
  ) as column_count
FROM information_schema.tables t
WHERE t.table_schema = 'public'
  AND t.table_type = 'BASE TABLE'
ORDER BY t.table_name;
`;

// Query to get row counts for each table
const ROW_COUNT_QUERIES = [
  "SELECT 'addresses' as table_name, COUNT(*) as row_count FROM addresses",
  "SELECT 'categories' as table_name, COUNT(*) as row_count FROM categories",
  "SELECT 'customers' as table_name, COUNT(*) as row_count FROM customers",
  "SELECT 'inventory' as table_name, COUNT(*) as row_count FROM inventory",
  "SELECT 'locations' as table_name, COUNT(*) as row_count FROM locations",
  "SELECT 'order_items' as table_name, COUNT(*) as row_count FROM order_items",
  "SELECT 'orders' as table_name, COUNT(*) as row_count FROM orders",
  "SELECT 'product_variants' as table_name, COUNT(*) as row_count FROM product_variants",
  "SELECT 'products' as table_name, COUNT(*) as row_count FROM products",
  "SELECT 'reviews' as table_name, COUNT(*) as row_count FROM reviews"
].join(' UNION ALL ');

// Query to get column type distribution
const COLUMN_TYPE_QUERY = `
SELECT
  UPPER(data_type) as data_type,
  COUNT(*) as type_count
FROM information_schema.columns
WHERE table_schema = 'public'
GROUP BY data_type
ORDER BY type_count DESC;
`;

// Query to count relationships (foreign keys)
const RELATIONSHIP_COUNT_QUERY = `
SELECT COUNT(*) as relationship_count
FROM information_schema.table_constraints
WHERE constraint_type = 'FOREIGN KEY'
  AND table_schema = 'public';
`;

const METADATA: ComponentMetadata = {
  id: 'database-overview',
  name: 'DatabaseOverview',
  displayName: 'Show database schema overview',
  isDisplayComp: true,
  type: 'DatabaseOverview',
  description: 'Comprehensive database schema dashboard with tables, columns, and statistics',
  category: 'Data',
  keywords: ['database', 'schema', 'tables', 'overview', 'metadata', 'dashboard'],
  props: {
    query: TABLE_STATS_QUERY,
    title: 'Database Schema Overview',
    description: 'Comprehensive overview of database structure, tables, and statistics',
    config: {
      showKPIs: true,
      showCharts: true,
      showTable: true,
    }
  }
}

const DEFAULT_PROPS = {
  query: METADATA.props.query as string,
  title: METADATA.props.title as string,
  description: METADATA.props.description as string,
  config: METADATA.props.config as any
}

interface DatabaseOverviewComponent extends React.FC<DatabaseOverviewProps> {
  Metadata: ComponentMetadata;
}

const DatabaseOverview: React.FC<DatabaseOverviewProps> = ({
  query = DEFAULT_PROPS.query,
  title = DEFAULT_PROPS.title,
  description = DEFAULT_PROPS.description,
  actions = [],
  config = DEFAULT_PROPS.config,
  SA_RUNTIME = {}
}) => {
  const [tableStats, setTableStats] = useState<TableInfo[]>([]);
  const [rowCounts, setRowCounts] = useState<any[]>([]);
  const [columnTypes, setColumnTypes] = useState<ColumnTypeInfo[]>([]);
  const [relationshipCount, setRelationshipCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(!config.data);
  const [error, setError] = useState<string | null>(null);
  const [receivedActions, setReceivedActions] = useState<Action[]>([]);

  const defaultConfig = DEFAULT_PROPS.config;
  const showKPIs = config.showKPIs !== undefined ? config.showKPIs : defaultConfig.showKPIs;
  const showCharts = config.showCharts !== undefined ? config.showCharts : defaultConfig.showCharts;
  const showTable = config.showTable !== undefined ? config.showTable : defaultConfig.showTable;

  useEffect(() => {
    if (!config.data) {
      fetchData();
    }
  }, [config.data]);

  const handleActionClick = (action: any) => {
    try {
      const actionHandler = (window as any).SA?.onActionClick;

      if (typeof actionHandler === 'function') {
        actionHandler({
          question: action.question,
          actionId: action.id,
          actionName: action.name,
          threadId: SA_RUNTIME?.threadId,
          uiBlockId: SA_RUNTIME?.uiBlockId,
          componentId: SA_RUNTIME?.componentId,
        });
      } else {
        console.warn('No action handler registered in runtime');
      }
    } catch (err) {
      console.error('Error handling action click:', err);
    }
  };

  const requestActions = async () => {
    try {
      const actionsRequestExecutor = (window as any).SA?.ActionsRequestExecutor;

      if (!actionsRequestExecutor) {
        console.warn('ActionsRequestExecutor not available');
        return;
      }

      if (!SA_RUNTIME?.threadId || !SA_RUNTIME?.uiBlockId) {
        console.warn('Missing threadId or uiBlockId in SA_RUNTIME, skipping actions request');
        return;
      }

      const response = await actionsRequestExecutor.getActions({
        threadId: SA_RUNTIME.threadId,
        uiBlockId: SA_RUNTIME.uiBlockId,
      });

      if (response.data?.actions && Array.isArray(response.data.actions)) {
        const transformedActions: Action[] = response.data.actions.map((apiAction: any) => ({
          id: apiAction.id,
          label: apiAction.name,
          variant: 'secondary' as const,
          onClick: () => {
            console.log('Action clicked:', apiAction.question);
            handleActionClick(apiAction);
          },
        }));

        setReceivedActions(transformedActions);
      }
    } catch (err) {
      console.error('Error requesting actions:', err);
    }
  };

  const fetchData = async () => {
    setLoading(true);
    setError(null);

    try {
      const queryExecutor = (window as any).SA?.QueryExecutor;

      if (!queryExecutor) {
        throw new Error('QueryExecutor not available');
      }

      // Execute all queries in parallel
      const [tableStatsResult, rowCountsResult, columnTypesResult, relationshipResult] = await Promise.all([
        queryExecutor.executeQuery({ query: TABLE_STATS_QUERY, SA_RUNTIME }),
        queryExecutor.executeQuery({ query: ROW_COUNT_QUERIES, SA_RUNTIME }),
        queryExecutor.executeQuery({ query: COLUMN_TYPE_QUERY, SA_RUNTIME }),
        queryExecutor.executeQuery({ query: RELATIONSHIP_COUNT_QUERY, SA_RUNTIME })
      ]);

      if (tableStatsResult && tableStatsResult.length > 0) {
        setTableStats(tableStatsResult);
      }

      if (rowCountsResult && rowCountsResult.length > 0) {
        setRowCounts(rowCountsResult);
      }

      if (columnTypesResult && columnTypesResult.length > 0) {
        setColumnTypes(columnTypesResult);
      }

      if (relationshipResult && relationshipResult.length > 0) {
        setRelationshipCount(relationshipResult[0].relationship_count || 0);
      }

      await requestActions();
    } catch (err) {
      console.error('Error fetching data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch database overview data');
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return <LoadingState height={600} message="Loading database schema..." variant="skeleton" size="lg" />;
  }

  if (error) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-[#FEE2E2] p-6">
        <div className="flex items-center gap-3">
          <Icon icon="mdi:alert-circle" className="w-5 h-5 text-[#DC2626] flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-[#DC2626]">Error loading schema</p>
            <p className="text-xs text-[#64748B] mt-1">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (tableStats.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-[#E2E8F0] p-6">
        <div className="text-center py-8">
          <Icon icon="mdi:database-off" className="w-12 h-12 text-[#94A3B8] mx-auto mb-3" />
          <p className="text-sm text-[#64748B]">No database data available</p>
        </div>
      </div>
    );
  }

  const allActions = [...actions, ...receivedActions];

  // Merge table stats with row counts
  const tablesWithRowCounts = tableStats.map(table => {
    const rowCountData = rowCounts.find(rc => rc.table_name === table.table_name);
    return {
      ...table,
      row_count: rowCountData ? Number(rowCountData.row_count) : 0
    };
  });

  // Calculate metrics
  const totalTables = tablesWithRowCounts.length;
  const totalColumns = tablesWithRowCounts.reduce((sum, t) => sum + Number(t.column_count || 0), 0);
  const totalRows = tablesWithRowCounts.reduce((sum, t) => sum + Number(t.row_count || 0), 0);

  // Prepare chart data for top tables by row count
  const topTables = [...tablesWithRowCounts]
    .sort((a, b) => b.row_count - a.row_count)
    .slice(0, 10)
    .map(t => ({
      name: t.table_name,
      value: t.row_count
    }));

  // Prepare pie chart data for column types
  const typeDistribution = columnTypes
    .slice(0, 6)
    .map(ct => ({
      name: ct.data_type,
      value: Number(ct.type_count)
    }));

  return (
    <div className="w-full space-y-6">
      {/* Header */}
      <div className="bg-white rounded-xl shadow-sm border border-[#E2E8F0] p-6">
        <div className="flex items-start gap-4">
          <div
            className="w-14 h-14 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{
              backgroundColor: `${COLORS.primary}15`,
              border: `2px solid ${COLORS.primary}30`
            }}
          >
            <Icon icon="mdi:database" className="w-8 h-8" style={{ color: COLORS.primary }} />
          </div>
          <div className="flex-1">
            <h2 className="text-2xl font-bold mb-1" style={{ color: COLORS.text.primary }}>
              {title}
            </h2>
            <p className="text-sm" style={{ color: COLORS.text.secondary }}>
              {description}
            </p>
            <div className="flex items-center gap-2 mt-3">
              <span
                className="px-3 py-1 rounded-full text-xs font-semibold"
                style={{
                  backgroundColor: `${COLORS.primary}20`,
                  color: COLORS.primary
                }}
              >
                IKEA Database
              </span>
              <span
                className="px-3 py-1 rounded-full text-xs font-semibold"
                style={{
                  backgroundColor: `${COLORS.success}20`,
                  color: COLORS.success
                }}
              >
                public schema
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      {showKPIs && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {/* Total Tables KPI */}
          <div className="bg-white rounded-xl shadow-sm border border-[#E2E8F0] hover:shadow-md transition-all duration-200 overflow-hidden">
            <div
              className="h-1"
              style={{
                background: `linear-gradient(90deg, ${COLORS.primary}, ${COLORS.primary}80)`
              }}
            />
            <div className="p-6">
              <div className="flex items-start justify-between mb-4">
                <div className="flex-1">
                  <p className="text-xs font-medium uppercase tracking-wide mb-1" style={{ color: COLORS.text.secondary }}>
                    Total Tables
                  </p>
                </div>
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center"
                  style={{
                    backgroundColor: `${COLORS.primary}15`,
                    border: `2px solid ${COLORS.primary}30`
                  }}
                >
                  <Icon icon="mdi:table" className="w-6 h-6" style={{ color: COLORS.primary }} />
                </div>
              </div>
              <p className="text-4xl font-bold" style={{ color: COLORS.text.primary }}>
                {totalTables}
              </p>
            </div>
          </div>

          {/* Total Columns KPI */}
          <div className="bg-white rounded-xl shadow-sm border border-[#E2E8F0] hover:shadow-md transition-all duration-200 overflow-hidden">
            <div
              className="h-1"
              style={{
                background: `linear-gradient(90deg, ${COLORS.success}, ${COLORS.success}80)`
              }}
            />
            <div className="p-6">
              <div className="flex items-start justify-between mb-4">
                <div className="flex-1">
                  <p className="text-xs font-medium uppercase tracking-wide mb-1" style={{ color: COLORS.text.secondary }}>
                    Total Columns
                  </p>
                </div>
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center"
                  style={{
                    backgroundColor: `${COLORS.success}15`,
                    border: `2px solid ${COLORS.success}30`
                  }}
                >
                  <Icon icon="mdi:table-column" className="w-6 h-6" style={{ color: COLORS.success }} />
                </div>
              </div>
              <p className="text-4xl font-bold" style={{ color: COLORS.text.primary }}>
                {totalColumns}
              </p>
            </div>
          </div>

          {/* Total Rows KPI */}
          <div className="bg-white rounded-xl shadow-sm border border-[#E2E8F0] hover:shadow-md transition-all duration-200 overflow-hidden">
            <div
              className="h-1"
              style={{
                background: `linear-gradient(90deg, ${COLORS.warning}, ${COLORS.warning}80)`
              }}
            />
            <div className="p-6">
              <div className="flex items-start justify-between mb-4">
                <div className="flex-1">
                  <p className="text-xs font-medium uppercase tracking-wide mb-1" style={{ color: COLORS.text.secondary }}>
                    Total Rows
                  </p>
                </div>
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center"
                  style={{
                    backgroundColor: `${COLORS.warning}15`,
                    border: `2px solid ${COLORS.warning}30`
                  }}
                >
                  <Icon icon="mdi:table-row" className="w-6 h-6" style={{ color: COLORS.warning }} />
                </div>
              </div>
              <p className="text-4xl font-bold" style={{ color: COLORS.text.primary }}>
                {totalRows.toLocaleString()}
              </p>
            </div>
          </div>

          {/* Total Relationships KPI */}
          <div className="bg-white rounded-xl shadow-sm border border-[#E2E8F0] hover:shadow-md transition-all duration-200 overflow-hidden">
            <div
              className="h-1"
              style={{
                background: `linear-gradient(90deg, ${COLORS.chart.secondary}, ${COLORS.chart.secondary}80)`
              }}
            />
            <div className="p-6">
              <div className="flex items-start justify-between mb-4">
                <div className="flex-1">
                  <p className="text-xs font-medium uppercase tracking-wide mb-1" style={{ color: COLORS.text.secondary }}>
                    Relationships
                  </p>
                </div>
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center"
                  style={{
                    backgroundColor: `${COLORS.chart.secondary}15`,
                    border: `2px solid ${COLORS.chart.secondary}30`
                  }}
                >
                  <Icon icon="mdi:link-variant" className="w-6 h-6" style={{ color: COLORS.chart.secondary }} />
                </div>
              </div>
              <p className="text-4xl font-bold" style={{ color: COLORS.text.primary }}>
                {relationshipCount}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Charts Section */}
      {showCharts && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Top Tables by Row Count - Bar Chart */}
          <div className="bg-white rounded-xl shadow-sm border border-[#E2E8F0] p-6">
            <h3 className="text-lg font-semibold mb-4" style={{ color: COLORS.text.primary }}>
              Top Tables by Row Count
            </h3>
            <div className="space-y-3">
              {topTables.map((table, idx) => {
                const maxValue = topTables[0]?.value || 1;
                const percentage = (table.value / maxValue) * 100;
                return (
                  <div key={idx}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium" style={{ color: COLORS.text.primary }}>
                        {table.name}
                      </span>
                      <span className="text-sm font-bold" style={{ color: COLORS.text.secondary }}>
                        {table.value.toLocaleString()}
                      </span>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-2">
                      <div
                        className="h-2 rounded-full transition-all duration-500"
                        style={{
                          width: `${percentage}%`,
                          backgroundColor: THEME.colors[idx % THEME.colors.length]
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Column Type Distribution - Pie Chart */}
          <div className="bg-white rounded-xl shadow-sm border border-[#E2E8F0] p-6">
            <h3 className="text-lg font-semibold mb-4" style={{ color: COLORS.text.primary }}>
              Column Type Distribution
            </h3>
            <div className="space-y-3">
              {typeDistribution.map((type, idx) => {
                const percentage = ((type.value / totalColumns) * 100).toFixed(1);
                return (
                  <div key={idx} className="flex items-center justify-between">
                    <div className="flex items-center gap-3 flex-1">
                      <div
                        className="w-4 h-4 rounded"
                        style={{
                          backgroundColor: THEME.colors[idx % THEME.colors.length]
                        }}
                      />
                      <span className="text-sm font-medium" style={{ color: COLORS.text.primary }}>
                        {type.name}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className="text-sm font-bold" style={{ color: COLORS.text.primary }}>
                        {type.value}
                      </span>
                      <span className="text-xs ml-2" style={{ color: COLORS.text.secondary }}>
                        ({percentage}%)
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Tables List */}
      {showTable && (
        <div className="bg-white rounded-xl shadow-sm border border-[#E2E8F0]">
          <div className="p-6 border-b" style={{ borderColor: COLORS.borderGray }}>
            <h3 className="text-lg font-semibold" style={{ color: COLORS.text.primary }}>
              All Tables
            </h3>
            <p className="text-sm mt-1" style={{ color: COLORS.text.secondary }}>
              Complete list of tables with column and row counts
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr style={{ backgroundColor: COLORS.lightBackground }}>
                  <th className="text-left px-6 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>
                    Table Name
                  </th>
                  <th className="text-right px-6 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>
                    Columns
                  </th>
                  <th className="text-right px-6 py-3 text-xs font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>
                    Rows
                  </th>
                </tr>
              </thead>
              <tbody>
                {tablesWithRowCounts.map((table, idx) => {
                  return (
                    <tr
                      key={idx}
                      className="border-t hover:bg-[#F8FAFC] transition-colors"
                      style={{ borderColor: COLORS.borderGray }}
                    >
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2">
                          <Icon icon="mdi:table" className="w-5 h-5" style={{ color: COLORS.primary }} />
                          <span className="font-semibold text-sm" style={{ color: COLORS.text.primary }}>
                            {table.table_name}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <span
                          className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold"
                          style={{
                            backgroundColor: `${COLORS.success}20`,
                            color: COLORS.success
                          }}
                        >
                          {table.column_count}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right font-medium text-sm" style={{ color: COLORS.text.primary }}>
                        {table.row_count.toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Actions */}
      {allActions && allActions.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-[#E2E8F0] p-6">
          <ActionContainer
            actions={allActions}
            direction="column"
            gap="8px"
            justifyContent="flex-start"
          />
        </div>
      )}
    </div>
  );
};

// Attach metadata to component
(DatabaseOverview as DatabaseOverviewComponent).Metadata = METADATA;

export default DatabaseOverview;
