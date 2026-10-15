import React, { useEffect, useState, useRef } from 'react';
import { Icon } from '@iconify/react';
import ReactECharts from 'echarts-for-react';
import * as echarts from 'echarts';
import type { ComponentMetadata } from '../../types';
import { COLORS } from '../../design-system/tokens';
import usaGeoJson from './usa.json';

interface ExternalTool {
  toolId: string;
  toolName: string;
  parameters: Record<string, any>;
}

interface QueryConfig {
  sql: string;
  params?: Record<string, any>;
}

interface DynamicMapChartProps {
  query?: string | QueryConfig | null;
  title?: string;
  description?: string;
  externalTool?: ExternalTool | null;
  config?: {
    // Data field mappings
    valueField?: string;              // Column name for numeric value
    labelField?: string;              // Column name for location label/name
    latField?: string;                // Column name for latitude
    lngField?: string;                // Column name for longitude
    // Display options
    showLegend?: boolean;             // Show color legend
    roam?: boolean;                   // Allow zoom and pan
    // Data (for direct data passing)
    data?: any[];
  };
  SA_RUNTIME?: any;
}


// Helper function to get case-insensitive key from object
const getCaseInsensitiveValue = (obj: any, key: string): any => {
  if (!obj || !key) return undefined;
  const actualKey = Object.keys(obj).find(k => k?.toLowerCase() === key?.toLowerCase());
  return actualKey ? obj[actualKey] : undefined;
};

// Format number for display
const formatNumber = (value: any): string => {
  if (value === null || value === undefined) return 'N/A';
  const numVal = typeof value === 'number' ? value : parseFloat(value);
  if (isNaN(numVal)) return String(value);
  if (numVal >= 1000000) {
    return (numVal / 1000000).toFixed(1) + 'M';
  } else if (numVal >= 1000) {
    return (numVal / 1000).toFixed(1) + 'k';
  }
  return numVal.toLocaleString();
};

// ============================================
// METADATA
// ============================================

const METADATA: ComponentMetadata = {
  id: 'dynamic-emap-chart',
  name: 'DynamicEMapChart',
  displayName: 'Show store locations on USA map',
  isDisplayComp: false,
  type: 'MapChart',
  description: 'Geographic USA map visualization showing location markers with values. Use for any "where" questions - store locations, warehouse distribution, regional performance, etc. Markers are clustered when zoomed out and expand when zoomed in. Color intensity indicates value magnitude. IMPORTANT: Use EITHER query OR externalTool as data source, NEVER BOTH. For database queries use query and set externalTool to null. For external tools set query to null and provide externalTool object.',
  category: 'Map',
  keywords: ['map', 'usa', 'geographic', 'locations', 'stores', 'warehouses', 'latitude', 'longitude', 'distribution', 'where', 'regional'],
  props: {
    query: {
      sql: 'SQL query string returning: name/label column, latitude column, longitude column, and a numeric value column. Example: SELECT location_name as name, lat as latitude, lng as longitude, SUM(revenue) as value FROM locations GROUP BY location_id',
      params: 'Default parameter values object, eg. { startDate: "2025-01-01" }. Keys must match $paramName placeholders. FilterDropdown params override these.'
    },
    externalTool: 'Set to null if using query. Otherwise provide: { toolId: "registered-tool-id", toolName: "Display Name", parameters: { param1: value1 } }',
    title: 'Title for the map, eg. "Store Locations", "Revenue by Location", "Warehouse Distribution"',
    description: 'Brief description of what the map shows',
    config: {
      valueField: 'Column name for the numeric value to display and color by (default: "value")',
      labelField: 'Column name for location name/label shown in tooltip (default: "name")',
      latField: 'Column name for latitude coordinates (default: "latitude")',
      lngField: 'Column name for longitude coordinates (default: "longitude")',
      showLegend: 'boolean - Show color value legend on right side (default: true)',
      roam: 'boolean - Allow user to zoom and pan the map (default: true)',
    }
  }
};

// Default query - shows revenue by store location
const DEFAULT_QUERY = `SELECT
  l.location_name as name,
  l.geocodedgpslat as latitude,
  l.geocodedgpslon as longitude,
  COALESCE(SUM(o.total_amount), 0) as value
FROM locations l
LEFT JOIN orders o ON l.location_id = o.store_id
GROUP BY l.location_id, l.location_name, l.geocodedgpslat, l.geocodedgpslon
ORDER BY value DESC`;

// Fixed styling constants (not configurable via props - keeps consistent look)
const CARD_HEIGHT = 550;
const CHART_HEIGHT = 420;
const DOT_SIZE = 32;
const CLUSTER_DOT_MAX_SIZE = 70;
const SHOW_DOT_LABELS = true;
const COLOR_RANGE = ['#bfdbfe', '#3b82f6', '#1e40af'];  // Light blue -> Blue -> Dark blue
const MAP_AREA_COLOR = '#e2e8f0';
const MAP_BORDER_COLOR = '#94a3b8';
const MAP_HOVER_COLOR = '#cbd5e1';

const DEFAULT_CONFIG = {
  valueField: 'value',
  labelField: 'name',
  latField: 'latitude',
  lngField: 'longitude',
  showLegend: true,
  roam: true,
};

// ============================================
// COMPONENT
// ============================================

interface DynamicEMapChartComponent extends React.FC<DynamicMapChartProps> {
  Metadata: ComponentMetadata;
}

const DynamicEMapChart: React.FC<DynamicMapChartProps> = ({
  query: queryProp = null,
  title = 'Geographic Distribution',
  description = 'Location-based performance metrics across the region',
  externalTool = null,
  config = {},
  SA_RUNTIME = {}
}) => {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  // Use default scatter query if no query provided
  const query = queryProp || DEFAULT_QUERY;

  const hasExternalTool = externalTool && externalTool.toolId;
  const hasConfigData = !!config.data;

  const [data, setData] = useState<any[]>(config.data || []);
  const [loading, setLoading] = useState<boolean>(!hasConfigData);
  const [error, setError] = useState<string | null>(null);
  const [mapRegistered, setMapRegistered] = useState(false);
  const [currentZoom, setCurrentZoom] = useState<number>(1);

  const chartRef = useRef<any>(null);

  // Fullscreen state
  const [isHovered, setIsHovered] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const chartContainerRef = React.useRef<HTMLDivElement>(null);

  const toolId = externalTool?.toolId;
  const toolParamsStr = externalTool?.parameters ? JSON.stringify(externalTool.parameters) : '';
  const queryStr = typeof query === 'string' ? query : JSON.stringify(query);

  // ============================================
  // REGISTER USA MAP
  // ============================================

  useEffect(() => {
    try {
      if ((echarts as any).getMap && (echarts as any).getMap('USA')) {
        setMapRegistered(true);
        return;
      }

      echarts.registerMap('USA', usaGeoJson as any, {
        Alaska: { left: -131, top: 25, width: 15 },
        Hawaii: { left: -110, top: 28, width: 5 },
        'Puerto Rico': { left: -76, top: 26, width: 2 }
      });

      setMapRegistered(true);
    } catch (err) {
      console.error('[DynamicUSAMapChart] Error registering map:', err);
      setError('Failed to register map');
    }
  }, []);

  // ============================================
  // DATA FETCHING
  // ============================================

  const fetchData = async () => {
    setLoading(true);
    setError(null);

    try {
      const queryExecutor = (window as any).SA?.QueryExecutor;
      if (!queryExecutor) throw new Error('QueryExecutor not available');

      let finalQuery: string;
      if (typeof query === 'object' && query !== null && 'sql' in query) {
        finalQuery = JSON.stringify({ sql: query.sql, values: query.params || {} });
      } else {
        finalQuery = query as string;
      }

      const result = await queryExecutor.executeQuery({ query: finalQuery, SA_RUNTIME });

      if (result && result.length > 0) {
        setData(result);
      } else {
        setData([]);
      }
    } catch (err) {
      console.error('[DynamicUSAMapChart] Error fetching data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
    }
  };

  const fetchExternalToolData = async () => {
    if (!externalTool) return;

    setLoading(true);
    setError(null);

    try {
      const toolExecutor = (window as any).SA?.ToolExecutor;
      if (!toolExecutor) throw new Error('ToolExecutor not available');

      const result = await toolExecutor.executeTool({
        externalTool: externalTool,
        formData: {},
        SA_RUNTIME
      });

      let chartData: any[] = [];

      if (result?.data) {
        if (Array.isArray(result.data)) {
          chartData = result.data;
        } else if (result.data.data && Array.isArray(result.data.data)) {
          chartData = result.data.data;
        } else if (result.data.records && Array.isArray(result.data.records)) {
          chartData = result.data.records;
        } else if (result.data.items && Array.isArray(result.data.items)) {
          chartData = result.data.items;
        }
      } else if (Array.isArray(result)) {
        chartData = result;
      }

      if (chartData.length > 0) {
        setData(chartData);
      } else {
        setData([]);
      }
    } catch (err) {
      console.error('[DynamicUSAMapChart] Error fetching external tool data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data from external tool');
    } finally {
      setLoading(false);
    }
  };

  // Initial data fetch
  useEffect(() => {
    if (hasConfigData) {
      // Data provided via config, no need to fetch
      setLoading(false);
    } else if (hasExternalTool) {
      fetchExternalToolData();
    } else {
      // Always fetch using query (default or provided)
      fetchData();
    }
  }, [queryStr, toolId, toolParamsStr, hasConfigData]);

  // Track fullscreen state changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isCurrentlyFullscreen = !!(
        document.fullscreenElement ||
        (document as any).webkitFullscreenElement ||
        (document as any).mozFullScreenElement ||
        (document as any).msFullscreenElement
      );
      setIsFullscreen(isCurrentlyFullscreen);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
    };
  }, []);

  // Enter fullscreen using browser API
  const enterFullscreen = async () => {
    if (!chartContainerRef.current) return;

    try {
      if (chartContainerRef.current.requestFullscreen) {
        await chartContainerRef.current.requestFullscreen();
      } else if ((chartContainerRef.current as any).webkitRequestFullscreen) {
        await (chartContainerRef.current as any).webkitRequestFullscreen();
      } else if ((chartContainerRef.current as any).mozRequestFullScreen) {
        await (chartContainerRef.current as any).mozRequestFullScreen();
      } else if ((chartContainerRef.current as any).msRequestFullscreen) {
        await (chartContainerRef.current as any).msRequestFullscreen();
      }
    } catch (err) {
      console.error('Error entering fullscreen:', err);
    }
  };

  // ============================================
  // BUILD SCATTER DATA (Location bubbles)
  // ============================================

  const buildScatterData = () => {
    if (data.length === 0) return [];

    return data.map(item => {
      const lat = getCaseInsensitiveValue(item, mergedConfig.latField);
      const lng = getCaseInsensitiveValue(item, mergedConfig.lngField);
      const value = getCaseInsensitiveValue(item, mergedConfig.valueField);
      const label = getCaseInsensitiveValue(item, mergedConfig.labelField);

      const numValue = typeof value === 'number' ? value : parseFloat(value) || 0;

      return {
        name: label || 'Location',
        value: [parseFloat(lng), parseFloat(lat), numValue],
        originalData: item,
      };
    }).filter(item => !isNaN(item.value[0]) && !isNaN(item.value[1]));
  };


  // CLUSTER SCATTER DATA
  const clusterScatterData = (
  points: any[],
  zoom = 1
) => {
  const gridSize =
    zoom < 3 ? 5 :
    zoom < 5 ? 2 :
    zoom < 7 ? 0.8 :
    0.3;

  const grid: Record<string, any> = {};

  points.forEach(p => {
    const [lng, lat, value] = p.value;

    const key =
      Math.floor(lng / gridSize) +
      '_' +
      Math.floor(lat / gridSize);

    if (!grid[key]) {
      grid[key] = {
        lng,
        lat,
        count: 0,
        totalValue: 0,
        points: []
      };
    }

    grid[key].count++;
    grid[key].totalValue += value;
    grid[key].points.push(p);
  });

  return Object.values(grid).map((c: any) => {
    // single marker → return original
    if (c.count === 1) {
      return c.points[0];
    }

    // cluster marker
    return {
      name: `${c.count} locations`,
      value: [c.lng, c.lat, c.totalValue],
      isCluster: true,
      count: c.count,
      children: c.points
    };
  });
};


  // ============================================
  // BUILD CHART OPTION
  // ============================================

  const buildChartOption = () => {
    // SCATTER MODE - Location dots with color intensity based on value
      const rawScatterData = buildScatterData();

      // Use current zoom level for clustering (updates when user zooms)
      const scatterData = clusterScatterData(rawScatterData, currentZoom);
      const values = scatterData.map(d => d.value[2]).filter(v => !isNaN(v));
      const minValue = values.length > 0 ? Math.min(...values) : 0;
      const maxValue = values.length > 0 ? Math.max(...values) : 100;

      // Fixed dot size for all markers
      const getDotSize = (val: any, params: any) => {
        const d = params?.data;
        if (d?.isCluster) {
          return Math.min(DOT_SIZE + d.count * 4, CLUSTER_DOT_MAX_SIZE);
        }
        return DOT_SIZE;
      };

      return {
        animation: false,  // Disable animation to prevent re-animation on zoom
        tooltip: {
          show: true,
          trigger: 'item',
          backgroundColor: 'rgba(255, 255, 255, 0.96)',
          borderColor: 'rgba(0, 0, 0, 0.1)',
          borderWidth: 1,
          borderRadius: 8,
          padding: [12, 16],
          textStyle: {
            color: '#1e293b',
            fontSize: 13,
          },
          extraCssText: 'box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);',
          formatter: (params: any) => {
            const d = params.data;
            if (!d) return '';

            let html = `<div style="font-weight: 600; font-size: 14px; margin-bottom: 8px; color: #1e293b;">${d.name}</div>`;
            html += `<div style="font-size: 20px; font-weight: 700; color: #3b82f6; margin-bottom: 8px;">${formatNumber(d.value[2])}</div>`;

            if (d.isCluster) {
              html += `<div style="font-size: 12px; color: #64748b; display: flex; align-items: center; gap: 6px;">
                <span style="display: inline-block; width: 8px; height: 8px; background: #3b82f6; border-radius: 50%;"></span>
                ${d.count} locations combined
              </div>`;
            } else if (d.originalData) {
              const extraFields = Object.keys(d.originalData).filter(key => {
                const lowerKey = key?.toLowerCase();
                return lowerKey !== mergedConfig.latField?.toLowerCase() &&
                       lowerKey !== mergedConfig.lngField?.toLowerCase() &&
                       lowerKey !== mergedConfig.valueField?.toLowerCase() &&
                       lowerKey !== mergedConfig.labelField?.toLowerCase();
              });

              if (extraFields.length > 0) {
                html += `<div style="border-top: 1px solid #e2e8f0; margin-top: 8px; padding-top: 8px;">`;
                extraFields.forEach(key => {
                  const val = d.originalData[key];
                  if (val !== null && val !== undefined) {
                    html += `<div style="display: flex; justify-content: space-between; gap: 16px; font-size: 12px; margin-bottom: 4px;">
                      <span style="color: #94a3b8;">${key}:</span>
                      <span style="color: #475569; font-weight: 500;">${typeof val === 'number' ? formatNumber(val) : val}</span>
                    </div>`;
                  }
                });
                html += `</div>`;
              }
            }

            return html;
          }
        },
        geo: {
          map: 'USA',
          roam: mergedConfig.roam,
          itemStyle: {
            areaColor: MAP_AREA_COLOR,
            borderColor: MAP_BORDER_COLOR,
            borderWidth: 1,
          },
          emphasis: {
            itemStyle: {
              areaColor: MAP_HOVER_COLOR,
            },
            label: { show: false }
          },
          label: { show: false },
        },
        visualMap: mergedConfig.showLegend ? {
          show: true,
          type: 'continuous',
          dimension: 2,  // Use the value (3rd element in data array) for color
          left: 'right',
          top: 'center',
          min: minValue,
          max: maxValue,
          inRange: {
            color: COLOR_RANGE
          },
          text: [formatNumber(maxValue), formatNumber(minValue)],
          textStyle: { color: COLORS.text.secondary, fontSize: 11 },
          calculable: true,
          itemWidth: 12,
          itemHeight: 120,
        } : { show: false },
        series: [
          {
            name: title,
            type: 'scatter',
            coordinateSystem: 'geo',
            data: scatterData,
            symbolSize: getDotSize,
            itemStyle: {
              borderColor: '#ffffff',
              borderWidth: 2,
            },
            emphasis: {
              scale: 1.2,
              itemStyle: {
                shadowBlur: 10,
                shadowColor: 'rgba(0,0,0,0.3)',
              }
            },
            label: {
              show: SHOW_DOT_LABELS,
              formatter: (params: any) => {
                const d = params.data;
                if (d?.isCluster) {
                  return d.count.toString();
                }
                return formatNumber(params.data.value[2]);
              },
              position: 'inside',
              fontSize: 10,
              fontWeight: 700,
              color: '#1e293b',
            },
          }
        ]
      };
  };

  // ============================================
  // CHART EVENTS
  // ============================================

  const onChartEvents = {
    georoam: () => {
      // When user zooms or pans, get new zoom level and recalculate clusters
      if (chartRef.current) {
        const chart = chartRef.current.getEchartsInstance();
        const geo = chart.getOption()?.geo?.[0];
        if (geo?.zoom) {
          setCurrentZoom(geo.zoom);
        }
      }
    },
  };

  // ============================================
  // RENDER
  // ============================================

  if (error) {
    return (
      <div
        className="card bg-base-100 shadow-sm border border-error overflow-hidden"
        style={{ height: `${CARD_HEIGHT}px` }}
      >
        <div className="absolute top-0 left-0 right-0 h-1 bg-error"></div>
        <div className="px-6 py-4">
          <div className="alert alert-error">
            <Icon icon="mdi:alert-circle" className="w-5 h-5" />
            <span>{error}</span>
          </div>
        </div>
      </div>
    );
  }

  if (loading || !mapRegistered) {
    return (
      <div
        ref={chartContainerRef}
        className="card bg-base-100 shadow-sm border border-base-300 overflow-hidden relative"
        style={{ height: `${CARD_HEIGHT}px` }}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <div
          className="absolute top-0 left-0 right-0 h-1"
          style={{ background: `linear-gradient(90deg, ${COLORS.primary}, ${COLORS.primary}80)` }}
        ></div>

        {/* Fullscreen icon - shows on hover when not in fullscreen */}
        {isHovered && !isFullscreen && (
          <button
            onClick={enterFullscreen}
            className="absolute top-2 right-1 z-10"
            title="Enter fullscreen (ESC to exit)"
          >
            <Icon icon="mdi:fullscreen" className="w-5 h-5" />
          </button>
        )}
        <div className="p-6">
          <div className="skeleton h-6 w-48 mb-2"></div>
          <div className="skeleton h-4 w-64 mb-4"></div>
          <div className="skeleton w-full" style={{ height: CHART_HEIGHT }}></div>
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div
        className="card bg-base-100 shadow-sm border border-base-300 overflow-hidden"
        style={{ height: `${CARD_HEIGHT}px` }}
      >
        <div
          className="absolute top-0 left-0 right-0 h-1"
          style={{ background: `linear-gradient(90deg, ${COLORS.primary}, ${COLORS.primary}80)` }}
        ></div>
        <div className="p-6 text-center py-8">
          <Icon icon="mdi:map-marker-off" className="w-12 h-12 opacity-40 mx-auto mb-3" />
          <p className="text-sm opacity-60">No location data available</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="card bg-base-100 shadow-sm hover:shadow-md transition-all duration-300 border border-base-300 overflow-hidden"
      style={{ height: `${CARD_HEIGHT}px` }}
    >
      {/* Gradient accent bar at top */}
      <div
        className="absolute top-0 left-0 right-0 h-1"
        style={{ background: `linear-gradient(90deg, ${COLORS.primary}, ${COLORS.primary}80)` }}
      ></div>

      {/* Header */}
      <div className="px-6 pt-5 pb-3">
        <div className="flex items-center gap-3 mb-1">
          <Icon icon="mdi:map-marker-multiple" className="w-6 h-6 text-primary" />
          <h3 className="text-xl font-semibold text-base-content">{title}</h3>
        </div>
        {description && (
          <p className="text-sm text-base-content/60 ml-9">{description}</p>
        )}
      </div>

      {/* Chart */}
      <div className="px-4 pb-4 flex-1">
        <ReactECharts
          ref={chartRef}
          option={buildChartOption()}
          style={{ height: CHART_HEIGHT, width: '100%' }}
          opts={{ renderer: 'svg' }}
          onEvents={onChartEvents}
        />
      </div>

    </div>
  );
};

// Attach metadata to component
(DynamicEMapChart as DynamicEMapChartComponent).Metadata = METADATA;

export default DynamicEMapChart;
