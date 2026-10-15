import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS } from '../../design-system/tokens';
import TruncationNote from '../../components/TruncationNote';

const LEAFLET_CDN_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
const LEAFLET_CDN_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';

interface ExternalTool {
  toolId: string;
  toolName: string;
  parameters: Record<string, any>;
}

interface QueryConfig {
  sql: string;
  params?: Record<string, any>;
}

interface DynamicLeafletMapViewProps {
  /** Stamped by the SDK when the payload is render-capped (§2.7). */
  _rowsRendered?: number;
  _rowsTotal?: number;
  query?: string | QueryConfig;
  title?: string;
  description?: string;
  externalTool?: ExternalTool | null;
  config?: {
    mode?: 'markers' | 'route';
    latitudeField?: string;
    longitudeField?: string;
    labelField?: string;
    orderField?: string;
    stageField?: string;
    data?: any[];
    zoom?: number;
  };
  SA_RUNTIME?: any;
}

const METADATA: ComponentMetadata = {
  id: 'dynamic-map-view',
  name: 'DynamicMapView',
  displayName: 'Interactive Map View',
  isDisplayComp: true,
  type: 'MapView',
  description: 'Interactive Leaflet map loaded from CDN. Supports markers and route mode.',
  category: 'chart',
  keywords: ['map', 'leaflet', 'location', 'route', 'coordinates', 'gps', 'consignment', 'shipment'],
  props: {
    externalTool: '(object) REQUIRED. { toolId, toolName, parameters: { sql: "..." } }',
    title: 'Map title',
    description: 'Map subtitle',
    config: {
      mode: '"markers" or "route". Default: "markers".',
      latitudeField: 'Latitude column name in SQL result.',
      longitudeField: 'Longitude column name in SQL result.',
      labelField: 'Label column name in SQL result.',
      orderField: 'Order column for route mode.',
      stageField: 'Optional stage column name. Used to group route points into origin, airport, and destination clusters.',
    },
  },
};

const DEFAULT_CONFIG = {
  mode: 'markers' as const,
  latitudeField: 'lat',
  longitudeField: 'lng',
  labelField: 'name',
  orderField: 'sequence',
  stageField: 'stage',
  zoom: 5,
};

const getFieldValue = (obj: any, field: string): any => {
  if (!obj || !field) return undefined;
  const target = field.toLowerCase();
  let key = Object.keys(obj).find((k) => k.toLowerCase() === target);
  
  if (!key) {
    if (target === 'lat' || target === 'latitude') {
       key = Object.keys(obj).find(k => {
           const kl = k.toLowerCase();
           return kl === 'lat' || kl === 'latitude';
       });
    } else if (target === 'lng' || target === 'longitude' || target === 'lon') {
       key = Object.keys(obj).find(k => {
           const kl = k.toLowerCase();
           return kl === 'lng' || kl === 'longitude' || kl === 'lon';
       });
    }
  }
  return key ? obj[key] : undefined;
};

type LatLngPoint = [number, number];
type RouteStage = 'origin' | 'airport' | 'destination';

interface ClusterPoint {
  stage: RouteStage;
  label: string;
  lat: number;
  lng: number;
  count: number;
  rows: any[];
}

const toRadians = (value: number): number => (value * Math.PI) / 180;
const toDegrees = (value: number): number => (value * 180) / Math.PI;
const normalizeLongitude = (lng: number): number => ((((lng + 180) % 360) + 360) % 360) - 180;

const interpolateGreatCircle = (
  start: LatLngPoint,
  end: LatLngPoint,
  segments = 64
): LatLngPoint[] => {
  const [startLat, startLng] = start;
  const [endLat, endLng] = end;

  const phi1 = toRadians(startLat);
  const lambda1 = toRadians(startLng);
  const phi2 = toRadians(endLat);
  const lambda2 = toRadians(endLng);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const sinPhi2 = Math.sin(phi2);
  const cosPhi2 = Math.cos(phi2);
  const deltaLambda = lambda2 - lambda1;

  const angularDistance = Math.acos(
    Math.min(
      1,
      Math.max(-1, sinPhi1 * sinPhi2 + cosPhi1 * cosPhi2 * Math.cos(deltaLambda))
    )
  );

  if (!Number.isFinite(angularDistance) || angularDistance === 0) {
    return [start, end];
  }

  const result: LatLngPoint[] = [];
  const sinAngularDistance = Math.sin(angularDistance);

  for (let step = 0; step <= segments; step += 1) {
    const fraction = step / segments;
    const weightStart = Math.sin((1 - fraction) * angularDistance) / sinAngularDistance;
    const weightEnd = Math.sin(fraction * angularDistance) / sinAngularDistance;

    const x =
      weightStart * cosPhi1 * Math.cos(lambda1) +
      weightEnd * cosPhi2 * Math.cos(lambda2);
    const y =
      weightStart * cosPhi1 * Math.sin(lambda1) +
      weightEnd * cosPhi2 * Math.sin(lambda2);
    const z = weightStart * sinPhi1 + weightEnd * sinPhi2;

    const lat = toDegrees(Math.atan2(z, Math.sqrt(x * x + y * y)));
    const lng = normalizeLongitude(toDegrees(Math.atan2(y, x)));
    result.push([lat, lng]);
  }

  return result;
};

const unwrapLongitudes = (points: LatLngPoint[]): LatLngPoint[] => {
  if (points.length === 0) return [];
  const [firstLat, firstLng] = points[0];
  const unwrapped: LatLngPoint[] = [[firstLat, firstLng]];

  for (let index = 1; index < points.length; index += 1) {
    const [lat, rawLng] = points[index];
    const prevLng = unwrapped[index - 1][1];
    const normalized = normalizeLongitude(rawLng);
    const candidates = [normalized, normalized + 360, normalized - 360];
    const bestLng = candidates.reduce((best, candidate) =>
      Math.abs(candidate - prevLng) < Math.abs(best - prevLng) ? candidate : best
    );
    unwrapped.push([lat, bestLng]);
  }

  return unwrapped;
};

const shiftLongitudesToMinimalSpan = (points: LatLngPoint[]): LatLngPoint[] => {
  if (points.length <= 1) return points;

  const normalizedLongitudes = points.map(([, lng]) => normalizeLongitude(lng)).sort((a, b) => a - b);
  let largestGap = -1;
  let gapIndex = 0;

  for (let index = 0; index < normalizedLongitudes.length; index += 1) {
    const current = normalizedLongitudes[index];
    const next =
      index === normalizedLongitudes.length - 1
        ? normalizedLongitudes[0] + 360
        : normalizedLongitudes[index + 1];
    const gap = next - current;
    if (gap > largestGap) {
      largestGap = gap;
      gapIndex = index;
    }
  }

  const intervalStart = normalizedLongitudes[(gapIndex + 1) % normalizedLongitudes.length];
  return points.map(([lat, lng]) => {
    const normalizedLng = normalizeLongitude(lng);
    return [lat, normalizedLng < intervalStart ? normalizedLng + 360 : normalizedLng];
  });
};

const shiftPointsNearReferenceLongitude = (
  points: LatLngPoint[],
  referenceLongitude: number
): LatLngPoint[] => {
  if (points.length === 0) return [];

  const longitudes = points.map(([, lng]) => lng);
  const minLongitude = Math.min(...longitudes);
  const maxLongitude = Math.max(...longitudes);
  const midLongitude = (minLongitude + maxLongitude) / 2;
  const worldOffset = Math.round((referenceLongitude - midLongitude) / 360) * 360;

  return points.map(([lat, lng]) => [lat, lng + worldOffset]);
};

const STAGE_FIELD_CANDIDATES = [
  'stage',
  'stage_name',
  'stage_type',
  'milestone',
  'milestone_type',
  'checkpoint',
  'checkpoint_type',
  'location_type',
  'point_type',
  'stop_type',
  'node_type',
  'event_type',
  'leg_type',
  'type',
];

const getFirstFieldValue = (obj: any, fields: string[]): any => {
  for (const field of fields) {
    const value = getFieldValue(obj, field);
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};

const inferRouteStage = (
  row: any,
  index: number,
  total: number,
  labelField: string,
  explicitStageField?: string
): RouteStage => {
  const stageValue = String(
    explicitStageField
      ? getFieldValue(row, explicitStageField) ?? ''
      : getFirstFieldValue(row, STAGE_FIELD_CANDIDATES) ?? ''
  ).toLowerCase();
  const labelValue = String(getFieldValue(row, labelField) ?? '').toLowerCase();
  const searchableText = `${stageValue} ${labelValue}`;

  if (/(origin|pickup|source|shipper|start)/.test(searchableText)) return 'origin';
  if (/(destination|delivery|drop|consignee|end)/.test(searchableText)) return 'destination';
  if (/(airport|hub|transit|port|terminal)/.test(searchableText)) return 'airport';

  if (index === 0) return 'origin';
  if (index === total - 1) return 'destination';
  return 'airport';
};

const getClusterLabel = (stage: RouteStage): string => {
  if (stage === 'origin') return 'Origin';
  if (stage === 'destination') return 'Destination';
  return 'Airport';
};

const buildStageClusters = (
  sortedRows: any[],
  latitudeField: string,
  longitudeField: string,
  labelField: string,
  explicitStageField?: string
): ClusterPoint[] => {
  const grouped = new Map<RouteStage, any[]>();

  sortedRows.forEach((row, index) => {
    const stage = inferRouteStage(row, index, sortedRows.length, labelField, explicitStageField);
    const items = grouped.get(stage) ?? [];
    items.push(row);
    grouped.set(stage, items);
  });

  const stageOrder: RouteStage[] = ['origin', 'airport', 'destination'];
  return stageOrder
    .map((stage) => {
      const rows = grouped.get(stage);
      if (!rows || rows.length === 0) return null;

      const points = rows
        .map((row) => [
          Number(getFieldValue(row, latitudeField)),
          normalizeLongitude(Number(getFieldValue(row, longitudeField))),
        ] as LatLngPoint)
        .filter(([lat, lng]) => Number.isFinite(lat) && Number.isFinite(lng));

      if (points.length === 0) return null;

      const shiftedPoints = shiftLongitudesToMinimalSpan(points);
      const lat = shiftedPoints.reduce((sum, [pointLat]) => sum + pointLat, 0) / shiftedPoints.length;
      const lng = shiftedPoints.reduce((sum, [, pointLng]) => sum + pointLng, 0) / shiftedPoints.length;

      return {
        stage,
        label: getClusterLabel(stage),
        lat,
        lng,
        count: rows.length,
        rows,
      } satisfies ClusterPoint;
    })
    .filter((cluster): cluster is ClusterPoint => cluster !== null);
};

const buildPopupHtml = (item: any, label: string) => {
  const rows = Object.entries(item)
    .filter(([k, v]) => k.toLowerCase() !== label.toLowerCase() && v !== null && v !== undefined && v !== '')
    .map(
      ([k, v]) =>
        `<div style="display:flex;justify-content:space-between;gap:10px;border-bottom:1px solid #f1f5f9;padding:4px 0;">
           <span style="font-size:11px;color:#64748b;">${k}</span>
           <span style="font-size:11px;color:#0f172a;font-weight:500;">${String(v)}</span>
         </div>`
    )
    .join('');

  return `<div style="min-width:180px;max-width:280px;">
    <div style="font-size:13px;font-weight:600;color:#0f172a;margin-bottom:6px;">${String(item[label] ?? 'Location')}</div>
    ${rows}
  </div>`;
};

const buildClusterPopupHtml = (cluster: ClusterPoint, labelField: string) => {
  const previewItems = cluster.rows.slice(0, 5).map((row) => {
    const label = String(getFieldValue(row, labelField) ?? getClusterLabel(cluster.stage));
    return `<div style="font-size:11px;color:#0f172a;padding:3px 0;border-bottom:1px solid #f1f5f9;">${label}</div>`;
  });
  const moreCount = cluster.rows.length - previewItems.length;

  return `<div style="min-width:180px;max-width:280px;">
    <div style="font-size:13px;font-weight:600;color:#0f172a;margin-bottom:4px;">${cluster.label}</div>
    <div style="font-size:11px;color:#64748b;margin-bottom:8px;">${cluster.count} point${cluster.count === 1 ? '' : 's'} in this cluster</div>
    ${previewItems.join('')}
    ${moreCount > 0 ? `<div style="font-size:11px;color:#64748b;padding-top:6px;">+${moreCount} more</div>` : ''}
  </div>`;
};

interface DynamicLeafletMapViewComponent extends React.FC<DynamicLeafletMapViewProps> {
  Metadata: ComponentMetadata;
}

const DynamicLeafletMapView: React.FC<DynamicLeafletMapViewProps> = ({
  query = '',
  title = 'Map View',
  description = '',
  externalTool = null,
  config = {},
  _rowsRendered,
  _rowsTotal,
  SA_RUNTIME = {},
}) => {
  const mergedConfig = useMemo(() => ({ ...DEFAULT_CONFIG, ...config }), [config]);
  const [loading, setLoading] = useState<boolean>(!(config.data && config.data.length > 0));
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<any[]>(config.data || []);
  const [leafletReady, setLeafletReady] = useState<boolean>(false);
  const [isMaximized, setIsMaximized] = useState<boolean>(false);

  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapFrameRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);

  const loadLeaflet = async () => {
    if ((window as any).L) {
      setLeafletReady(true);
      return;
    }

    if (!document.querySelector(`link[href="${LEAFLET_CDN_CSS}"]`)) {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = LEAFLET_CDN_CSS;
      document.head.appendChild(css);
    }

    await new Promise<void>((resolve, reject) => {
      const existingScript = document.querySelector(`script[src="${LEAFLET_CDN_JS}"]`) as HTMLScriptElement | null;
      if (existingScript) {
        if ((window as any).L) resolve();
        else {
          existingScript.addEventListener('load', () => resolve(), { once: true });
          existingScript.addEventListener('error', () => reject(new Error('Failed to load Leaflet JS')), { once: true });
        }
        return;
      }

      const script = document.createElement('script');
      script.src = LEAFLET_CDN_JS;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Leaflet JS'));
      document.head.appendChild(script);
    });

    setLeafletReady(true);
  };

  const fetchData = async () => {
    if (config.data && config.data.length > 0) {
      setData(config.data);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      if (externalTool?.toolId) {
        const toolExecutor = (window as any).SA?.ToolExecutor;
        if (!toolExecutor) throw new Error('ToolExecutor not available');
        let result: any;
        if (externalTool.parameters?.queryId) {
          result = await toolExecutor.executeByQueryId({
            toolId: externalTool.toolId,
            queryId: externalTool.parameters.queryId,
            params: externalTool.parameters.params,
            SA_RUNTIME,
          });
        } else {
          result = await toolExecutor.executeTool({
            externalTool,
            formData: {},
            SA_RUNTIME,
          });
        }
        const payload = result?.data;
        if (Array.isArray(payload)) setData(payload);
        else if (Array.isArray(payload?.data)) setData(payload.data);
        else if (Array.isArray(payload?.records)) setData(payload.records);
        else if (Array.isArray(payload?.items)) setData(payload.items);
        else setData([]);
      } else {
        const queryExecutor = (window as any).SA?.QueryExecutor;
        if (!queryExecutor) throw new Error('QueryExecutor not available');
        const finalQuery =
          typeof query === 'object' && query !== null && 'sql' in query
            ? JSON.stringify({ sql: query.sql, values: query.params || {} })
            : (query as string);
        const result = await queryExecutor.executeQuery({ query: finalQuery, SA_RUNTIME });
        setData(Array.isArray(result) ? result : []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch map data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLeaflet().catch((err) => setError(err instanceof Error ? err.message : 'Failed to load map library'));
  }, []);

  useEffect(() => {
    fetchData();
  }, [externalTool?.toolId, JSON.stringify(externalTool?.parameters || {}), typeof query === 'string' ? query : JSON.stringify(query)]);

  useEffect(() => {
    if (!leafletReady || !mapContainerRef.current) return;

    const L = (window as any).L;
    if (!L) return;

    if (!mapRef.current) {
      mapRef.current = L.map(mapContainerRef.current, {
        worldCopyJump: false,
        maxBounds: [[-90, -180], [90, 180]],
        maxBoundsViscosity: 1.0,
      }).setView([20.5937, 78.9629], mergedConfig.zoom);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
        noWrap: true,
        bounds: [[-90, -180], [90, 180]],
      }).addTo(mapRef.current);
      layerRef.current = L.layerGroup().addTo(mapRef.current);
    }

    const valid = data.filter((row) => {
      const latVal = getFieldValue(row, mergedConfig.latitudeField);
      const lngVal = getFieldValue(row, mergedConfig.longitudeField);
      if (latVal === null || latVal === undefined || latVal === '') return false;
      if (lngVal === null || lngVal === undefined || lngVal === '') return false;
      const lat = Number(latVal);
      const lng = Number(lngVal);
      if (lat === 0 && lng === 0) return false;
      return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90;
    });

    layerRef.current?.clearLayers();

    if (valid.length === 0) return;

    let animationFrameId: number | null = null;
    let hasAutoFitted = false;

    const drawOverlay = (fitToBounds: boolean) => {
      layerRef.current?.clearLayers();

      const bounds: any[] = [];
      if (mergedConfig.mode === 'route') {
        const sorted = [...valid].sort(
          (a, b) =>
            Number(getFieldValue(a, mergedConfig.orderField) || 0) -
            Number(getFieldValue(b, mergedConfig.orderField) || 0)
        );

        const stageClusters = buildStageClusters(
          sorted,
          mergedConfig.latitudeField,
          mergedConfig.longitudeField,
          mergedConfig.labelField,
          mergedConfig.stageField
        );

        const waypointPoints: LatLngPoint[] = stageClusters.map((cluster) => [
          cluster.lat,
          normalizeLongitude(cluster.lng),
        ]);

        const geodesicRoute: LatLngPoint[] = [];
        for (let index = 0; index < waypointPoints.length - 1; index += 1) {
          const segmentPoints = interpolateGreatCircle(
            waypointPoints[index],
            waypointPoints[index + 1]
          );
          if (geodesicRoute.length > 0) segmentPoints.shift();
          geodesicRoute.push(...segmentPoints);
        }

        const minimalSpanRoutePoints = shiftLongitudesToMinimalSpan(
          unwrapLongitudes(geodesicRoute.length > 0 ? geodesicRoute : waypointPoints)
        );
        const minimalSpanWaypoints = shiftLongitudesToMinimalSpan(waypointPoints);
        const referenceLongitude = mapRef.current?.getCenter().lng ?? minimalSpanRoutePoints[0]?.[1] ?? 0;
        const routeDisplayPoints = shiftPointsNearReferenceLongitude(
          minimalSpanRoutePoints,
          referenceLongitude
        );
        const displayWaypoints = shiftPointsNearReferenceLongitude(
          minimalSpanWaypoints,
          referenceLongitude
        );

        routeDisplayPoints.forEach((point) => bounds.push(point));

        const line = L.polyline(routeDisplayPoints, {
          color: COLORS.primary,
          weight: 2,
          opacity: 0.9,
          dashArray: '3 8',
          lineCap: 'round',
          noClip: true,
        });
        line.addTo(layerRef.current);

        stageClusters.forEach((cluster, idx) => {
          const [lat, lng] = displayWaypoints[idx];
          const fillColor =
            cluster.stage === 'origin'
              ? '#22c55e'
              : cluster.stage === 'destination'
                ? '#ef4444'
                : COLORS.primary;
          const icon = L.divIcon({
            className: '',
            html: `
              <div style="
                width: 28px;
                height: 28px;
                border-radius: 9999px;
                background: ${fillColor};
                border: 2px solid #ffffff;
                box-shadow: 0 8px 18px rgba(15, 23, 42, 0.18);
                display: flex;
                align-items: center;
                justify-content: center;
                color: #ffffff;
                font-size: 11px;
                font-weight: 700;
              ">
                ${cluster.count}
              </div>
            `,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          });
          const marker = L.marker([lat, lng], { icon });
          marker.bindPopup(buildClusterPopupHtml(cluster, mergedConfig.labelField));
          marker.bindTooltip(cluster.label, {
            direction: 'top',
            offset: [0, -14],
          });
          marker.addTo(layerRef.current);
        });
      } else {
        valid.forEach((row) => {
          const lat = Number(getFieldValue(row, mergedConfig.latitudeField));
          const lng = Number(getFieldValue(row, mergedConfig.longitudeField));
          bounds.push([lat, lng]);
          const marker = L.circleMarker([lat, lng], {
            radius: 7,
            color: '#fff',
            weight: 2,
            fillColor: COLORS.primary,
            fillOpacity: 1,
          });
          marker.bindPopup(buildPopupHtml(row, mergedConfig.labelField));
          marker.addTo(layerRef.current);
        });
      }

      if (fitToBounds) {
        if (bounds.length > 1) mapRef.current.fitBounds(bounds, { padding: [30, 30] });
        else if (bounds.length === 1) mapRef.current.setView(bounds[0], Math.max(mergedConfig.zoom, 11));
      }
    };

    const scheduleRedraw = () => {
      if (mergedConfig.mode !== 'route') return;
      if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
      animationFrameId = requestAnimationFrame(() => {
        drawOverlay(false);
        animationFrameId = null;
      });
    };

    drawOverlay(true);
    hasAutoFitted = true;

    const map = mapRef.current;
    map.on('move', scheduleRedraw);

    requestAnimationFrame(() => {
      mapRef.current?.invalidateSize();
    });
    window.setTimeout(() => {
      mapRef.current?.invalidateSize();
    }, 180);

    return () => {
      map.off('move', scheduleRedraw);
      if (animationFrameId !== null) cancelAnimationFrame(animationFrameId);
      if (!hasAutoFitted) layerRef.current?.clearLayers();
    };
  }, [leafletReady, data, mergedConfig]);

  useEffect(() => {
    if (!leafletReady || !mapRef.current || !mapFrameRef.current) return;

    const map = mapRef.current;
    const frame = mapFrameRef.current;
    const invalidate = () => map.invalidateSize();
    const handleFullscreenChange = () => {
      setIsMaximized(document.fullscreenElement === frame);
      invalidate();
    };
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(invalidate);
    });

    resizeObserver.observe(frame);
    window.addEventListener('resize', invalidate);
    document.addEventListener('fullscreenchange', handleFullscreenChange);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', invalidate);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, [leafletReady]);

  const toggleMaximize = async () => {
    const frame = mapFrameRef.current;
    if (!frame) return;

    try {
      if (!document.fullscreenElement) {
        await frame.requestFullscreen();
        setIsMaximized(true);
      } else {
        await document.exitFullscreen();
        setIsMaximized(false);
      }
    } catch {
      setIsMaximized(false);
    } finally {
      window.setTimeout(() => {
        mapRef.current?.invalidateSize();
      }, 160);
    }
  };

  useEffect(() => {
    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  if (error) {
    return (
      <div className="card bg-base-100 border border-error shadow-sm">
        <div className="card-body">
          <div className="alert alert-error">
            <Icon icon="mdi:alert-circle" className="w-5 h-5" />
            <span>{error}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card bg-base-100 border border-base-300 shadow-sm overflow-hidden isolate z-0 mb-6 flex flex-col h-full">
      <div
        className="h-1"
        style={{
          background: `linear-gradient(90deg, ${COLORS.primary}, ${COLORS.primary}80)`,
        }}
      />
      <div className="card-body p-5">
        <h3 className="text-base font-semibold">{title}</h3>
        {description ? <p className="text-xs text-base-content/60 -mt-1">{description}</p> : null}
        <TruncationNote rendered={_rowsRendered} total={_rowsTotal} />
        <div ref={mapFrameRef} className="relative w-full h-[480px] rounded-lg border border-base-300 overflow-hidden bg-base-200 isolate z-0">
          <button
            type="button"
            onClick={toggleMaximize}
            className="absolute top-2 right-2 z-[500] btn btn-xs bg-base-100/90 hover:bg-base-100 border border-base-300"
            title={isMaximized ? 'Exit full screen' : 'Maximize map'}
          >
            <Icon icon={isMaximized ? 'mdi:fullscreen-exit' : 'mdi:fullscreen'} className="w-4 h-4" />
          </button>
          <div ref={mapContainerRef} className="w-full h-full" />
          {loading && (
            <div className="absolute inset-0 bg-white/70 flex items-center justify-center">
              <span className="loading loading-spinner loading-md text-primary" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

(DynamicLeafletMapView as DynamicLeafletMapViewComponent).Metadata = METADATA;

export default DynamicLeafletMapView;
