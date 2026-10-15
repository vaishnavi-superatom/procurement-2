import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, SHADOWS, BORDER_RADIUS, TYPOGRAPHY, SPACING } from '../../design-system/tokens';


const MAPBOX_CDN_JS = 'https://api.mapbox.com/mapbox-gl-js/v3.4.0/mapbox-gl.js';
const MAPBOX_CDN_CSS = 'https://api.mapbox.com/mapbox-gl-js/v3.4.0/mapbox-gl.css';
// Mapbox GL JS runs in the browser, so this must be a public "pk." token —
// never an "sk." secret token. Set VITE_MAPBOX_TOKEN in frontend/.env.local
// (gitignored; see frontend/.env.example).
const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;

// ============================================
// TYPES
// ============================================

interface ExternalTool {
  toolId: string;
  toolName: string;
  parameters: Record<string, any>;
}

interface QueryConfig {
  sql: string;
  params?: Record<string, any>;
}

interface MarkerConfig {
  color?: string;
  icon?: string;
}

interface PopupField {
  key: string;
  label: string;
  format?: 'text' | 'currency' | 'number' | 'date' | 'badge';
}

interface DynamicMapViewProps {
  query?: string | QueryConfig;
  title?: string;
  description?: string;
  externalTool?: ExternalTool | null;
  config?: {
    // Map configuration
    center?: [number, number]; // [longitude, latitude]
    zoom?: number;
    style?: 'light' | 'dark' | 'streets' | 'satellite';
    height?: number;

    // Data field mapping
    latitudeField?: string;
    longitudeField?: string;
    labelField?: string;
    categoryField?: string;
    valueField?: string; // Field to display as number on marker

    // Value formatting
    valueFormat?: 'number' | 'currency' | 'compact'; // How to format the value label
    valuePrefix?: string; // Prefix for value label (e.g., '$')
    valueSuffix?: string; // Suffix for value label (e.g., 'k')

    // Marker configuration
    marker?: MarkerConfig;
    categoryColors?: Record<string, string>;

    // Popup configuration
    popupFields?: PopupField[];
    showPopupOnHover?: boolean;

    // Static data
    data?: any[];
  };
  SA_RUNTIME?: any;
}

// ============================================
// DESIGN SYSTEM THEME
// ============================================

const THEME = {
  card: {
    background: COLORS.white,
    borderRadius: BORDER_RADIUS.large,
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
  markerColors: [
    COLORS.primary,
    COLORS.success,
    COLORS.warning,
    COLORS.error,
    COLORS.info,
    COLORS.chart.secondary,
    COLORS.chart.tertiary,
  ],
};

// Map style URLs
const MAP_STYLES: Record<string, string> = {
  light: 'mapbox://styles/mapbox/light-v11',
  dark: 'mapbox://styles/mapbox/dark-v11',
  streets: 'mapbox://styles/mapbox/streets-v12',
  satellite: 'mapbox://styles/mapbox/satellite-streets-v12',
};

// ============================================
// HELPER FUNCTIONS
// ============================================

const formatCurrency = (value: any): string => {
  if (value === null || value === undefined) return 'N/A';
  const numVal = typeof value === 'number' ? value : parseFloat(value);
  if (isNaN(numVal)) return String(value);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(numVal);
};

const formatNumber = (value: any): string => {
  if (value === null || value === undefined) return 'N/A';
  const numVal = typeof value === 'number' ? value : parseFloat(value);
  if (isNaN(numVal)) return String(value);
  return new Intl.NumberFormat('en-US').format(numVal);
};

const formatCompact = (value: any): string => {
  if (value === null || value === undefined) return '';
  const numVal = typeof value === 'number' ? value : parseFloat(value);
  if (isNaN(numVal)) return String(value);

  if (numVal >= 1000000) {
    return (numVal / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  } else if (numVal >= 1000) {
    return (numVal / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  }
  return Math.round(numVal).toString();
};

const formatDate = (value: any): string => {
  if (!value) return 'N/A';
  try {
    const date = new Date(value);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return String(value);
  }
};

const formatValue = (value: any, format?: string): string => {
  if (value === null || value === undefined) return 'N/A';

  switch (format) {
    case 'currency':
      return formatCurrency(value);
    case 'number':
      return formatNumber(value);
    case 'date':
      return formatDate(value);
    default:
      return String(value);
  }
};

// Case-insensitive field accessor
const getFieldValue = (obj: any, field: string): any => {
  if (!obj || !field) return undefined;
  const actualKey = Object.keys(obj).find(k => k?.toLowerCase() === field?.toLowerCase());
  return actualKey ? obj[actualKey] : undefined;
};

// ============================================
// METADATA
// ============================================

const METADATA: ComponentMetadata = {
  id: 'dynamic-map-view',
  name: 'DynamicMapView',
  displayName: 'Interactive Map View',
  isDisplayComp: true,
  type: 'MapView',
  description: 'Interactive map visualization for location data. Always use externalTool with SQL in parameters.sql returning latitude/longitude coordinates.',
  category: 'chart',
  keywords: ['map', 'location', 'mapbox', 'geographic', 'coordinates', 'markers', 'spatial'],
  props: {
    query: null,
    externalTool: '(object) REQUIRED. Object with toolId, toolName, parameters. Put SQL query returning lat/lng data in parameters.sql.',
    title: 'Map title',
    description: 'Map description',
    config: {
      center: 'Map center as [longitude, latitude]',
      zoom: 'Initial zoom level (1-20)',
      style: 'Map style: light, dark, streets, satellite',
      height: 'Map height in pixels',
      latitudeField: 'Field name for latitude',
      longitudeField: 'Field name for longitude',
      labelField: 'Field name for marker label (shown above bubble)',
      categoryField: 'Field for categorizing markers with different colors',
      valueField: 'Field to display as value inside bubble (affects bubble size)',
      valueFormat: 'Value format: number, currency, compact',
      valuePrefix: 'Prefix for value label',
      valueSuffix: 'Suffix for value label',
      marker: {
        color: 'Marker color',
        minSize: 'Minimum bubble size for lowest value',
        maxSize: 'Maximum bubble size for highest value',
      },
      categoryColors: 'Object mapping category values to colors',
      popupFields: 'Array of fields to show in popup: [{key, label, format}]',
      showPopupOnHover: 'Show popup on hover',
    }
  }
};

const DEFAULT_QUERY = `SELECT
  l.location_id,
  l.location_name,
  l.location_type,
  l.city,
  l.state,
  l.country,
  l.geocodedgpslat,
  l.geocodedgpslon,
  COALESCE(last_order.last_invoice_value, 0) as last_invoice_value,
  last_order.last_invoice_date,
  last_order.last_order_id
FROM locations l
LEFT JOIN LATERAL (
  SELECT
    o.total_amount as last_invoice_value,
    o.order_date as last_invoice_date,
    o.order_id as last_order_id
  FROM orders o
  WHERE o.store_id = l.location_id
    AND o.status NOT IN ('Cancelled', 'Failed')
  ORDER BY o.order_date DESC
  LIMIT 1
) last_order ON true
ORDER BY last_invoice_value DESC NULLS LAST`;

const DEFAULT_CONFIG = {
  center: [-98.5795, 39.8283] as [number, number],
  zoom: 4,
  style: 'light' as const,
  height: 500,
  latitudeField: 'geocodedgpslat',
  longitudeField: 'geocodedgpslon',
  labelField: 'location_name',
  categoryField: 'location_type',
  valueField: 'last_invoice_value',
  valueFormat: 'currency' as const,
  valuePrefix: '',  // Let LLM provide, or show in description
  valueSuffix: '',
  marker: {
    color: COLORS.primary,
  },
  popupFields: [
    { key: 'location_name', label: 'Store' },
    { key: 'city', label: 'City' },
    { key: 'state', label: 'State' },
    { key: 'location_type', label: 'Type', format: 'badge' as const },
    { key: 'last_invoice_value', label: 'Last Invoice', format: 'currency' as const },
    { key: 'last_invoice_date', label: 'Invoice Date', format: 'date' as const },
  ],
  showPopupOnHover: true,
};

// ============================================
// COMPONENT
// ============================================

interface DynamicMapViewComponent extends React.FC<DynamicMapViewProps> {
  Metadata: ComponentMetadata;
}

const DynamicMapView: React.FC<DynamicMapViewProps> = ({
  query = DEFAULT_QUERY,
  title = 'Last Invoice by Location',
  description = 'Showing last invoice value (in $) generated by each store location',
  externalTool = null,
  config = {},
  SA_RUNTIME = {}
}) => {
  // Merge config with defaults
  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    marker: { ...DEFAULT_CONFIG.marker, ...config.marker },
  };

  const hasExternalTool = externalTool && externalTool.toolId;
  const hasConfigData = !!config.data;

  const [data, setData] = useState<any[]>(config.data || []);
  const [loading, setLoading] = useState<boolean>(!(config.data && config.data.length > 0) && (hasExternalTool ? true : !hasConfigData));
  const [error, setError] = useState<string | null>(null);
  const [mapboxLoaded, setMapboxLoaded] = useState(false);

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapWrapperRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const popupRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  // Extract primitive values for stable useEffect dependencies
  const toolId = externalTool?.toolId;
  const toolParamsStr = externalTool?.parameters ? JSON.stringify(externalTool.parameters) : '';
  const queryStr = typeof query === 'string' ? query : JSON.stringify(query);

  // ============================================
  // DATA FETCHING
  // ============================================

  const fetchData = async () => {
    setLoading(true);
    setError(null);

    try {
      const queryExecutor = (window as any).SA?.QueryExecutor;

      if (!queryExecutor) {
        throw new Error('QueryExecutor not available');
      }

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
      console.error('[DynamicMapView] Error fetching data:', err);
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

      if (!toolExecutor) {
        throw new Error('ToolExecutor not available');
      }

      console.log(`[DynamicMapView] Fetching data from external tool: ${externalTool.toolName}`);

      const result = await toolExecutor.executeTool({
        externalTool: externalTool,
        formData: {},
        SA_RUNTIME
      });

      let mapData: any[] = [];

      if (result?.data) {
        if (Array.isArray(result.data)) {
          mapData = result.data;
        } else if (result.data.data && Array.isArray(result.data.data)) {
          mapData = result.data.data;
        } else if (result.data.records && Array.isArray(result.data.records)) {
          mapData = result.data.records;
        } else if (result.data.items && Array.isArray(result.data.items)) {
          mapData = result.data.items;
        }
      } else if (Array.isArray(result)) {
        mapData = result;
      }

      if (mapData.length > 0) {
        setData(mapData);
      } else {
        setData([]);
      }
    } catch (err) {
      console.error('[DynamicMapView] Error fetching external tool data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data from external tool');
    } finally {
      setLoading(false);
    }
  };

  // Initial data fetch
  useEffect(() => {
    // Priority: config.data (prefetched) > externalTool > query
    if (config.data && config.data.length > 0) return;
    if (hasExternalTool) {
      fetchExternalToolData();
    } else {
      fetchData();
    }
  }, [queryStr, toolId, toolParamsStr, hasConfigData]);

  // ============================================
  // MAPBOX LOADING
  // ============================================

  useEffect(() => {
    if ((window as any).mapboxgl) {
      setMapboxLoaded(true);
      return;
    }

    // Load CSS
    if (!document.querySelector(`link[href="${MAPBOX_CDN_CSS}"]`)) {
      const cssLink = document.createElement('link');
      cssLink.rel = 'stylesheet';
      cssLink.href = MAPBOX_CDN_CSS;
      document.head.appendChild(cssLink);
    }

    // Add custom CSS for popup z-index and panel animation
    const styleId = 'dynamic-map-view-styles';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        .mapboxgl-popup {
          z-index: 50 !important;
        }
        .mapboxgl-popup-content {
          border-radius: 12px;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
        }
        @keyframes slideInRight {
          from {
            opacity: 0;
            transform: translateX(20px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }
        @keyframes slideOutRight {
          from {
            opacity: 1;
            transform: translateX(0);
          }
          to {
            opacity: 0;
            transform: translateX(20px);
          }
        }
        .map-panel-enter {
          animation: slideInRight 0.25s ease-out forwards;
        }
      `;
      document.head.appendChild(style);
    }

    // Load JS
    const script = document.createElement('script');
    script.src = MAPBOX_CDN_JS;
    script.async = true;
    script.onload = () => setMapboxLoaded(true);
    script.onerror = () => setError('Failed to load map library');
    document.head.appendChild(script);

    return () => {
      if (popupRef.current) popupRef.current.remove();
      if (mapRef.current) mapRef.current.remove();
    };
  }, []);

  // ============================================
  // BUILD POPUP HTML (Full details on hover)
  // ============================================

  const buildPopupHtml = useCallback((item: any) => {
    const label = getFieldValue(item, mergedConfig.labelField) || 'Location';

    // Get category/type for badge (if configured)
    const categoryValue = mergedConfig.categoryField
      ? getFieldValue(item, mergedConfig.categoryField)
      : null;

    // Build badge HTML
    let badgeHtml = '';
    if (categoryValue) {
      const isFullSize = String(categoryValue).toLowerCase().includes('full');
      badgeHtml = `
        <span style="display: inline-block; padding: 2px 8px; background: ${isFullSize ? '#dbeafe' : '#fef3c7'}; border-radius: 4px; font-size: 10px; font-weight: 500; color: ${isFullSize ? '#1d4ed8' : '#92400e'};">
          ${categoryValue}
        </span>
      `;
    }

    // Build all popup fields
    const popupFields = mergedConfig.popupFields || DEFAULT_CONFIG.popupFields;
    const fieldsHtml = popupFields
      .filter((f: PopupField) => f.key !== mergedConfig.labelField && f.format !== 'badge')
      .map((field: PopupField) => {
        const value = getFieldValue(item, field.key);
        const formattedValue = formatValue(value, field.format);
        return `
          <div style="display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px solid #f3f4f6;">
            <span style="font-size: 11px; color: #6b7280;">${field.label}</span>
            <span style="font-size: 11px; font-weight: 500; color: #1f2937;">${formattedValue}</span>
          </div>
        `;
      })
      .join('');

    return `
      <div style="padding: 12px 14px; font-family: system-ui, -apple-system, sans-serif; min-width: 200px; max-width: 280px;">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 2px solid #e5e7eb;">
          <h4 style="margin: 0; font-size: 14px; font-weight: 600; color: #1f2937; flex: 1;">${label}</h4>
          ${badgeHtml}
        </div>
        ${fieldsHtml}
      </div>
    `;
  }, [mergedConfig]);

  // ============================================
  // GET MARKER COLOR
  // ============================================

  const getMarkerColor = useCallback((item: any, index: number): string => {
    if (mergedConfig.categoryField && mergedConfig.categoryColors) {
      const category = getFieldValue(item, mergedConfig.categoryField);
      if (category && mergedConfig.categoryColors[category]) {
        return mergedConfig.categoryColors[category];
      }
    }

    if (mergedConfig.categoryField) {
      const category = getFieldValue(item, mergedConfig.categoryField);
      if (category) {
        // Generate consistent color based on category
        const categories = [...new Set(data.map(d => getFieldValue(d, mergedConfig.categoryField)))];
        const categoryIndex = categories.indexOf(category);
        return THEME.markerColors[categoryIndex % THEME.markerColors.length];
      }
    }

    return mergedConfig.marker?.color || COLORS.primary;
  }, [data, mergedConfig]);

  // ============================================
  // FORMAT VALUE LABEL FOR MARKER
  // ============================================

  const getValueLabel = useCallback((item: any): string => {
    const valueField = mergedConfig.valueField || config.valueField;
    if (!valueField) return '';

    const value = getFieldValue(item, valueField);
    if (value === null || value === undefined) return '';

    const valueFormat = mergedConfig.valueFormat || config.valueFormat || 'compact';
    const prefix = mergedConfig.valuePrefix || config.valuePrefix || '';
    const suffix = mergedConfig.valueSuffix || config.valueSuffix || '';

    let formattedValue: string;
    switch (valueFormat) {
      case 'currency':
        formattedValue = formatCompact(value);
        break;
      case 'number':
        formattedValue = formatNumber(value);
        break;
      case 'compact':
      default:
        formattedValue = formatCompact(value);
    }

    return `${prefix}${formattedValue}${suffix}`;
  }, [mergedConfig, config]);

  // ============================================
  // MAP INITIALIZATION
  // ============================================

  useEffect(() => {
    if (!mapboxLoaded || !mapContainerRef.current || loading || data.length === 0) return;
    if (mapRef.current) return; // Already initialized

    if (!MAPBOX_TOKEN) {
      setError('Mapbox access token is not configured. Set VITE_MAPBOX_TOKEN in frontend/.env.local.');
      return;
    }

    const mapboxgl = (window as any).mapboxgl;
    mapboxgl.accessToken = MAPBOX_TOKEN;

    try {
      const map = new mapboxgl.Map({
        container: mapContainerRef.current,
        style: MAP_STYLES[mergedConfig.style] || MAP_STYLES.light,
        center: mergedConfig.center,
        zoom: mergedConfig.zoom,
      });

      map.addControl(new mapboxgl.NavigationControl(), 'top-right');
      map.addControl(new mapboxgl.FullscreenControl(), 'top-right');

      mapRef.current = map;

      map.on('load', () => {
        // Filter valid data points
        const validData = data.filter(item => {
          const lat = getFieldValue(item, mergedConfig.latitudeField);
          const lon = getFieldValue(item, mergedConfig.longitudeField);
          return lat != null && lon != null && !isNaN(Number(lat)) && !isNaN(Number(lon));
        });

        if (validData.length === 0) {
          console.warn('[DynamicMapView] No valid location data found');
          return;
        }

        // Calculate max value for proportional bubble sizing
        const valueField = mergedConfig.valueField;
        let maxValue = 0;
        if (valueField) {
          validData.forEach(item => {
            const val = getFieldValue(item, valueField);
            const numVal = typeof val === 'number' ? val : parseFloat(val) || 0;
            if (numVal > maxValue) maxValue = numVal;
          });
        }

        // Hardcoded bubble sizes
        const minSize = 12;
        const maxSize = 25;

        // Build GeoJSON with calculated properties
        const geojson = {
          type: 'FeatureCollection' as const,
          features: validData.map((item, index) => {
            const val = valueField ? getFieldValue(item, valueField) : 0;
            const numVal = typeof val === 'number' ? val : parseFloat(val) || 0;
            const ratio = maxValue > 0 ? numVal / maxValue : 1;
            const bubbleSize = minSize + ratio * (maxSize - minSize);

            // Separate labels: store name above, value inside dot
            const storeName = getFieldValue(item, mergedConfig.labelField) || '';
            const valueLabel = getValueLabel(item);

            return {
              type: 'Feature' as const,
              properties: {
                ...item,
                _index: index,
                _color: getMarkerColor(item, index),
                _bubbleSize: bubbleSize,
                _storeLabel: storeName,
                _valueLabel: valueLabel,
              },
              geometry: {
                type: 'Point' as const,
                coordinates: [
                  Number(getFieldValue(item, mergedConfig.longitudeField)),
                  Number(getFieldValue(item, mergedConfig.latitudeField)),
                ],
              },
            };
          }),
        };

        map.addSource('locations', {
          type: 'geojson',
          data: geojson,
        });

        // Circle layer for bubbles (sized by value)
        map.addLayer({
          id: 'locations-circles',
          type: 'circle',
          source: 'locations',
          paint: {
            'circle-radius': ['get', '_bubbleSize'],
            'circle-color': ['get', '_color'],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff',
          },
        });

        // Hide default Mapbox labels (city names, street names, etc.)
        const layersToHide = map.getStyle().layers.filter((layer: any) =>
          layer.type === 'symbol' && layer.id.includes('label')
        );
        layersToHide.forEach((layer: any) => {
          map.setLayoutProperty(layer.id, 'visibility', 'none');
        });

        // Symbol layer for store name above dots
        map.addLayer({
          id: 'locations-names',
          type: 'symbol',
          source: 'locations',
          layout: {
            'text-field': ['get', '_storeLabel'],
            'text-font': ['DIN Pro Medium', 'Arial Unicode MS Bold'],
            'text-size': 10,
            'text-offset': [0, -1.8],
            'text-anchor': 'bottom',
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': '#1f2937',
            'text-halo-color': '#ffffff',
            'text-halo-width': 2,
          },
        });

        // Symbol layer for value inside dots (centered)
        map.addLayer({
          id: 'locations-values',
          type: 'symbol',
          source: 'locations',
          layout: {
            'text-field': ['get', '_valueLabel'],
            'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'],
            'text-size': 9,
            'text-offset': [0, 0],
            'text-anchor': 'center',
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': '#ffffff',
          },
        });

        // Mouse enter - show popup
        map.on('mouseenter', 'locations-circles', (e: any) => {
          map.getCanvas().style.cursor = 'pointer';

          if (!e.features?.length) return;

          const feature = e.features[0];
          const coords = feature.geometry.coordinates.slice() as [number, number];
          const props = feature.properties;

          // Parse properties (they get stringified in GeoJSON)
          const item = { ...props };
          Object.keys(item).forEach(key => {
            try {
              item[key] = JSON.parse(item[key]);
            } catch {
              // Keep original value
            }
          });

          if (mergedConfig.showPopupOnHover) {
            if (popupRef.current) popupRef.current.remove();

            const popup = new mapboxgl.Popup({
              closeButton: false,
              closeOnClick: false,
              maxWidth: '320px',
              offset: 25,
            })
              .setLngLat(coords)
              .setHTML(buildPopupHtml(item))
              .addTo(map);

            popupRef.current = popup;
          }
        });

        // Mouse leave - hide popup
        map.on('mouseleave', 'locations-circles', () => {
          map.getCanvas().style.cursor = '';

          if (popupRef.current && mergedConfig.showPopupOnHover) {
            popupRef.current.remove();
            popupRef.current = null;
          }
        });

        // Auto-fit bounds to show all markers
        if (validData.length > 1) {
          const bounds = new mapboxgl.LngLatBounds();
          validData.forEach(item => {
            bounds.extend([
              Number(getFieldValue(item, mergedConfig.longitudeField)),
              Number(getFieldValue(item, mergedConfig.latitudeField)),
            ]);
          });
          map.fitBounds(bounds, { padding: 50, maxZoom: 12 });
        }
      });
    } catch (err) {
      console.error('[DynamicMapView] Error initializing map:', err);
      setError('Failed to initialize map');
    }
  }, [mapboxLoaded, loading, data, buildPopupHtml, getMarkerColor, getValueLabel, mergedConfig]);

  // ============================================
  // RESIZE OBSERVER - Handle container resize
  // ============================================

  useEffect(() => {
    if (!mapWrapperRef.current || !mapRef.current) return;

    // Create ResizeObserver to detect container size changes
    resizeObserverRef.current = new ResizeObserver(() => {
      if (mapRef.current) {
        // Delay resize slightly to ensure DOM has updated
        setTimeout(() => {
          mapRef.current?.resize();
        }, 100);
      }
    });

    resizeObserverRef.current.observe(mapWrapperRef.current);

    return () => {
      resizeObserverRef.current?.disconnect();
    };
  }, [mapboxLoaded, mapRef.current]);

  // ============================================
  // LEGEND BUILDER
  // ============================================

  const buildLegend = useCallback(() => {
    if (!mergedConfig.categoryField || data.length === 0) return null;

    const categories = [...new Set(data.map(d => getFieldValue(d, mergedConfig.categoryField)))].filter(Boolean);
    if (categories.length <= 1) return null;

    return (
      <div className="bg-base-100 rounded-lg shadow-lg p-3 text-xs">
        <div className="font-semibold mb-2 text-base-content">Legend</div>
        <div className="flex flex-col gap-1.5">
          {categories.map((category, index) => {
            const color = mergedConfig.categoryColors?.[category as string] ||
                          THEME.markerColors[index % THEME.markerColors.length];
            return (
              <div key={String(category)} className="flex items-center gap-2">
                <div
                  className="w-3 h-3 rounded-full border-2 border-white shadow"
                  style={{ backgroundColor: color }}
                ></div>
                <span className="text-base-content/70">{String(category)}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }, [data, mergedConfig]);

  // ============================================
  // RENDER
  // ============================================

  if (error) {
    return (
      <div className="card bg-base-100 shadow-sm hover:shadow-md transition-all duration-300 border border-error overflow-hidden relative">
        {/* Error accent bar at top */}
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

  if (loading) {
    return (
      <div className="card bg-base-100 shadow-sm hover:shadow-md transition-all duration-300 border border-base-300 overflow-hidden relative">
        {/* Gradient accent bar at top */}
        <div
          className="absolute top-0 left-0 right-0 h-1"
          style={{
            background: `linear-gradient(90deg, ${COLORS.primary}, ${COLORS.primary}80)`
          }}
        ></div>

        <div className="p-6">
          <div className="skeleton h-6 w-48 mb-2"></div>
          <div className="skeleton h-4 w-64 mb-4"></div>
          <div className="skeleton w-full" style={{ height: mergedConfig.height }}></div>
        </div>
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="card bg-base-100 shadow-sm hover:shadow-md transition-all duration-300 border border-base-300 overflow-hidden relative">
        {/* Gradient accent bar at top */}
        <div
          className="absolute top-0 left-0 right-0 h-1"
          style={{
            background: `linear-gradient(90deg, ${COLORS.primary}, ${COLORS.primary}80)`
          }}
        ></div>

        <div className="p-6 text-center py-8">
          <Icon icon="mdi:map-marker-off" className="w-12 h-12 opacity-40 mx-auto mb-3" />
          <p className="text-sm opacity-60">No location data available</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card bg-base-100 shadow-sm hover:shadow-md transition-all duration-300 border border-base-300 overflow-hidden relative">
      {/* Gradient accent bar at top */}
      <div
        className="absolute top-0 left-0 right-0 h-1 z-20"
        style={{
          background: `linear-gradient(90deg, ${COLORS.primary}, ${COLORS.primary}80)`
        }}
      ></div>

      {/* Header */}
      <div className="px-6 py-4 border-b border-base-300 bg-primary/5">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <Icon icon="mdi:map-marker-multiple" className="w-6 h-6 text-primary" />
              <h3 className="text-xl font-semibold text-base-content">{title}</h3>
            </div>
            {description && (
              <p className="text-sm text-base-content/60 ml-9">{description}</p>
            )}
          </div>
          <div className="text-sm opacity-60">
            {data.length} {data.length === 1 ? 'location' : 'locations'}
          </div>
        </div>
      </div>

      {/* Map Container */}
      <div ref={mapWrapperRef} className="relative" style={{ height: mergedConfig.height }}>
        <div
          ref={mapContainerRef}
          className="w-full h-full"
        />

        {/* Legend - lower z-index */}
        <div className="absolute bottom-4 left-4 z-10">
          {buildLegend()}
        </div>
      </div>

    </div>
  );
};

// Attach metadata to component
(DynamicMapView as DynamicMapViewComponent).Metadata = METADATA;

export default DynamicMapView;
