import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Icon } from '@iconify/react';
import ReactECharts from 'echarts-for-react';
import type { ComponentMetadata } from '../../types';
import { COLORS, SHADOWS, TYPOGRAPHY, BORDER_RADIUS } from '../../design-system/tokens';
import DynamicLeafletMapView from '../../shared-modules/DynamicLeafletMapView';

// ============================================================
// TYPES
// ============================================================

interface ConsignmentOption {
  consignment_id: string;
}

interface ShelfLifeRow {
  sequence: number;
  timestampIsoUtc: string;
  timestampEpochSeconds: number;
  temperatureC: number;
  remainingShelfLifeDays: number;
  cumulativeDegradation: number;
  spoilageRisk: 'fresh' | 'warning' | 'critical' | 'spoiled';
  intervalDegradation: number;
  elapsedHours: number;
}

interface ShelfLifeResult {
  status: string;
  consignmentId?: string;
  remainingShelfLifeDays?: number;
  averageTemperature?: number;
  totalDegradation?: number;
  minTemperature?: number;
  maxTemperature?: number;
  consumedShelfLifePercent?: number;
  finalRiskStatus?: string;
  totalProcessedPings?: number;
  rows?: ShelfLifeRow[];
}

interface ShelfLifeMonitoringProps {
  title?: string;
  subtitle?: string;
  SA_RUNTIME?: any;
}

// ============================================================
// METADATA
// ============================================================

const METADATA: ComponentMetadata = {
  id: 'shelf-life-monitoring',
  name: 'ShelfLifeMonitoring',
  displayName: 'Shelf Life Monitoring',
  isDisplayComp: true,
  type: 'Workflow_ShelfLifeMonitoring',
  description:
    'Cold-chain telemetry dashboard. Selects a consignment, calls the shelf-life analysis engine, and displays remaining shelf life, average temperature, lost life per day, a dual-axis temperature/shelf-life trend chart, and a GPS route map with cluster overlays.',
  category: 'monitoring',
  keywords: [
    'shelf life',
    'cold chain',
    'temperature',
    'consignment',
    'telemetry',
    'spoilage',
    'degradation',
    'fleet',
    'monitoring',
    'map',
    'route',
  ],
  props: {
    title: 'Shelf Life Monitoring',
    subtitle: 'Cold Chain Telemetry & Degradation Analysis',
  },
};

interface ShelfLifeMonitoringComponent extends React.FC<ShelfLifeMonitoringProps> {
  Metadata: ComponentMetadata;
}

const SOURCE_QUERY_TOOL_ID = 'postgres-c6b133dea157_query';
const SOURCE_QUERY_TOOL_NAME = 'Query PostgreSQL';

// ============================================================
// HELPERS
// ============================================================

const fmt = (n: number | undefined | null, decimals = 1): string => {
  if (n === undefined || n === null || isNaN(n)) return '—';
  return n.toFixed(decimals);
};

const riskColor = (risk?: string): string => {
  switch (risk) {
    case 'fresh': return COLORS.success;
    case 'warning': return COLORS.warning;
    case 'critical': return '#EF4444';
    case 'spoiled': return COLORS.error;
    default: return COLORS.text.tertiary;
  }
};

const riskLabel = (risk?: string): string => {
  switch (risk) {
    case 'fresh': return 'Fresh';
    case 'warning': return 'Warning';
    case 'critical': return 'Critical';
    case 'spoiled': return 'Spoiled';
    default: return 'Unknown';
  }
};

// ============================================================
// COMPONENT
// ============================================================

const ShelfLifeMonitoring: React.FC<ShelfLifeMonitoringProps> = ({
  title = 'Shelf Life Monitoring',
  subtitle = 'Cold Chain Telemetry & Degradation Analysis',
  SA_RUNTIME = {},
}) => {
  // ── State ──────────────────────────────────────────────────
  const [consignments, setConsignments] = useState<ConsignmentOption[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const [loadingConsignments, setLoadingConsignments] = useState(true);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [result, setResult] = useState<ShelfLifeResult | null>(null);

  // ── Map config (re-created when selectedId changes) ───────
  const [mapKey, setMapKey] = useState(0);

  // ── Fetch consignment list ─────────────────────────────────
  useEffect(() => {
    const run = async () => {
      setLoadingConsignments(true);
      try {
        const te = (window as any).SA?.ToolExecutor;
        if (!te) throw new Error('ToolExecutor not available');
        const sql = `
          SELECT DISTINCT
            REGEXP_REPLACE(consignment_id, '^.*?(SO-?[0-9]+).*$', '\\1') AS consignment_id
          FROM consignments
          WHERE consignment_id IS NOT NULL
            AND consignment_id ~* 'SO-?[0-9]+'
          ORDER BY consignment_id
          LIMIT 200
        `;
        const res = await te.executeTool({
          externalTool: {
            toolId: SOURCE_QUERY_TOOL_ID,
            toolName: SOURCE_QUERY_TOOL_NAME,
            parameters: { sql },
          },
          formData: {},
          SA_RUNTIME,
        });
        const payload = res?.data ?? res;
        const rows = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.data)
            ? payload.data
            : Array.isArray(payload?.records)
              ? payload.records
              : [];
        if (Array.isArray(rows) && rows.length > 0) {
          setConsignments(rows);
          setSelectedId(rows[0].consignment_id);
        }
      } catch (e) {
        console.error('[ShelfLifeMonitoring] fetchConsignments:', e);
      } finally {
        setLoadingConsignments(false);
      }
    };
    run();
  }, []);

  // ── Fetch shelf-life data when consignment changes ─────────
  const fetchShelfLife = useCallback(async (id: string) => {
    if (!id) return;
    setLoadingData(true);
    setError(null);
    setResult(null);
    try {
      const te = (window as any).SA?.ToolExecutor;
      if (!te) throw new Error('ToolExecutor not available');
      const res = await te.executeTool({
        externalTool: {
          toolId: 'calculate-shelf-life',
          toolName: 'Calculate Shelf Life',
          parameters: { consignmentId: id, limit: 5000 },
        },
        formData: {},
        SA_RUNTIME,
      });
      const payload = res?.data ?? res;
      if (payload?.status === 'error') {
        setError(payload.message ?? 'Tool returned an error');
      } else {
        setResult(payload);
      }
    } catch (e: any) {
      setError(e?.message ?? 'Failed to fetch shelf life data');
    } finally {
      setLoadingData(false);
    }
  }, [SA_RUNTIME]);

  useEffect(() => {
    if (selectedId) {
      fetchShelfLife(selectedId);
      setMapKey(k => k + 1); // remount map for new consignment
    }
  }, [selectedId]);

  // ── Close dropdown on outside click ───────────────────────
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    if (isDropdownOpen) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isDropdownOpen]);

  // ── Derived KPI values ─────────────────────────────────────
  const remaining = result?.remainingShelfLifeDays;
  const avgTemp = result?.averageTemperature;
  const degradation = result?.totalDegradation;
  const pings = result?.totalProcessedPings ?? 0;
  const riskStatus = result?.finalRiskStatus;
  const consumed = result?.consumedShelfLifePercent ?? 0;

  // Lost life per day = total degradation / number of telemetry days
  const rows = result?.rows ?? [];
  const telemetryDays =
    rows.length >= 2
      ? (rows[rows.length - 1].timestampEpochSeconds - rows[0].timestampEpochSeconds) / 86400
      : null;
  const lostPerDay =
    degradation !== undefined && degradation !== null && telemetryDays && telemetryDays > 0
      ? degradation / telemetryDays
      : undefined;

  // ── ECharts option for dual-axis trend ────────────────────
  const chartOption = React.useMemo(() => {
    if (!rows.length) return {};

    const labels = rows.map(r => {
      const d = new Date(r.timestampIsoUtc);
      return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
    });
    const temps = rows.map(r => +(r.temperatureC ?? 0).toFixed(2));
    const shelf = rows.map(r => +(r.remainingShelfLifeDays ?? 0).toFixed(2));

    // Rolling average (window = 10)
    const rollAvg = temps.map((_, i, arr) => {
      const w = arr.slice(Math.max(0, i - 9), i + 1);
      return +(w.reduce((s, v) => s + v, 0) / w.length).toFixed(2);
    });

    return {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', crossStyle: { color: COLORS.text.tertiary } },
        backgroundColor: '#1E293B',
        borderColor: '#334155',
        textStyle: { color: '#F1F5F9', fontSize: 12 },
        formatter: (params: any[]) => {
          const label = params[0]?.axisValueLabel ?? '';
          const lines = params
            .map(p => `<div style="display:flex;align-items:center;gap:6px;margin-top:2px;">
              <span style="width:8px;height:8px;border-radius:50%;background:${p.color};flex-shrink:0;"></span>
              <span style="color:#94A3B8;font-size:11px;">${p.seriesName}</span>
              <span style="color:#F1F5F9;font-size:11px;font-weight:600;margin-left:auto;">${p.value}</span>
            </div>`)
            .join('');
          return `<div style="min-width:180px;">
            <div style="color:#64748B;font-size:11px;margin-bottom:4px;">${label}</div>
            ${lines}
          </div>`;
        },
      },
      legend: {
        data: ['Temperature (°C)', 'Rolling Avg (°C)', 'Shelf Life (days)'],
        bottom: 0,
        textStyle: { color: COLORS.text.secondary, fontSize: 11 },
        icon: 'circle',
        itemWidth: 8,
        itemHeight: 8,
      },
      grid: { left: 60, right: 60, top: 20, bottom: 50 },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: {
          color: COLORS.text.tertiary,
          fontSize: 10,
          rotate: 30,
          interval: Math.max(0, Math.floor(labels.length / 12) - 1),
        },
        axisLine: { lineStyle: { color: COLORS.borderGray } },
        splitLine: { show: false },
      },
      yAxis: [
        {
          type: 'value',
          name: 'Temp (°C)',
          nameTextStyle: { color: COLORS.text.tertiary, fontSize: 10 },
          axisLabel: { color: COLORS.text.tertiary, fontSize: 10, formatter: (v: number) => `${v}°` },
          axisLine: { lineStyle: { color: COLORS.borderGray } },
          splitLine: { lineStyle: { color: COLORS.borderGray, type: 'dashed' } },
        },
        {
          type: 'value',
          name: 'Shelf Life (d)',
          nameTextStyle: { color: COLORS.text.tertiary, fontSize: 10 },
          axisLabel: { color: COLORS.text.tertiary, fontSize: 10 },
          axisLine: { lineStyle: { color: COLORS.borderGray } },
          splitLine: { show: false },
          min: 0,
        },
      ],
      series: [
        {
          name: 'Temperature (°C)',
          type: 'line',
          yAxisIndex: 0,
          data: temps,
          showSymbol: false,
          lineStyle: { color: COLORS.warning, width: 1.5, opacity: 0.5 },
          itemStyle: { color: COLORS.warning },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: `${COLORS.warning}40` },
                { offset: 1, color: `${COLORS.warning}00` },
              ],
            },
          },
          smooth: true,
          z: 1,
        },
        {
          name: 'Rolling Avg (°C)',
          type: 'line',
          yAxisIndex: 0,
          data: rollAvg,
          showSymbol: false,
          lineStyle: { color: COLORS.error, width: 2 },
          itemStyle: { color: COLORS.error },
          smooth: true,
          z: 2,
        },
        {
          name: 'Shelf Life (days)',
          type: 'line',
          yAxisIndex: 1,
          data: shelf,
          showSymbol: false,
          lineStyle: { color: COLORS.primary, width: 2.5 },
          itemStyle: { color: COLORS.primary },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: `${COLORS.primary}50` },
                { offset: 1, color: `${COLORS.primary}00` },
              ],
            },
          },
          smooth: true,
          z: 3,
        },
      ],
    };
  }, [rows]);

  // ── Map external tool config ───────────────────────────────
  const mapExternalTool = React.useMemo(() => {
    if (!selectedId) return null;
    const safeSelectedId = selectedId.replace(/'/g, "''");
    return {
      toolId: SOURCE_QUERY_TOOL_ID,
      toolName: SOURCE_QUERY_TOOL_NAME,
      parameters: {
        sql: `
          SELECT
            dp.latitude,
            dp.longitude,
            dp.timestamp,
            d.device_id AS label,
            CASE
              WHEN ROW_NUMBER() OVER (PARTITION BY dp.device_uid ORDER BY dp.timestamp) = 1 THEN 'origin'
              WHEN ROW_NUMBER() OVER (PARTITION BY dp.device_uid ORDER BY dp.timestamp DESC) = 1 THEN 'destination'
              ELSE 'airport'
            END AS stage
          FROM device_pings dp
          JOIN devices d ON dp.device_uid = d.device_uid
          JOIN consignment_devices cd ON cd.device_uid = dp.device_uid
          JOIN consignments c ON c.consignment_uid = cd.consignment_uid
          WHERE REGEXP_REPLACE(c.consignment_id, '^.*?(SO-?[0-9]+).*$', '\\1') = '${safeSelectedId}'
            AND dp.latitude IS NOT NULL
            AND dp.longitude IS NOT NULL
            AND dp.latitude <> 0
            AND dp.longitude <> 0
          ORDER BY dp.timestamp
          LIMIT 2000
        `,
      },
    };
  }, [selectedId]);

  // ── Styles ─────────────────────────────────────────────────
  const s = {
    container: {
      display: 'flex',
      flexDirection: 'column' as const,
      gap: '20px',
      fontFamily: TYPOGRAPHY.fontFamily.primary,
    },
    card: {
      background: '#FFFFFF',
      borderRadius: BORDER_RADIUS.large,
      border: `1px solid ${COLORS.borderGray}`,
      boxShadow: SHADOWS.card,
      overflow: 'hidden' as const,
    },
    kpiCard: (accent: string) => ({
      background: '#FFFFFF',
      borderRadius: BORDER_RADIUS.large,
      border: `1px solid ${COLORS.borderGray}`,
      boxShadow: SHADOWS.card,
      overflow: 'hidden' as const,
      flex: '1 1 220px',
      minWidth: '180px',
      position: 'relative' as const,
    }),
    kpiAccent: (color: string) => ({
      height: '4px',
      background: `linear-gradient(90deg, ${color}, ${color}80)`,
    }),
    kpiBody: {
      padding: '20px',
      display: 'flex',
      flexDirection: 'column' as const,
      gap: '4px',
    },
    kpiIcon: (bg: string) => ({
      width: '40px',
      height: '40px',
      borderRadius: '10px',
      background: bg,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: '12px',
    }),
    skeleton: {
      background: `linear-gradient(90deg, #F1F5F9 25%, #E2E8F0 50%, #F1F5F9 75%)`,
      backgroundSize: '200% 100%',
      animation: 'shimmer 1.5s infinite',
      borderRadius: '6px',
    },
  };

  // ── Render KPI card ────────────────────────────────────────
  const KPICard = ({
    accent,
    icon,
    iconBg,
    label,
    value,
    unit,
    sub,
  }: {
    accent: string;
    icon: string;
    iconBg: string;
    label: string;
    value: string;
    unit?: string;
    sub?: React.ReactNode;
  }) => (
    <div style={s.kpiCard(accent)}>
      <div style={s.kpiAccent(accent)} />
      <div style={s.kpiBody}>
        <div style={s.kpiIcon(iconBg)}>
          <Icon icon={icon} style={{ width: '20px', height: '20px', color: accent }} />
        </div>
        <p style={{ fontSize: TYPOGRAPHY.fontSize.tiny, fontWeight: '600', color: COLORS.text.secondary, textTransform: 'uppercase', letterSpacing: '0.6px', margin: 0 }}>
          {label}
        </p>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '4px', marginTop: '2px' }}>
          {loadingData ? (
            <div style={{ ...s.skeleton, width: '100px', height: '32px' }} />
          ) : (
            <>
              <span style={{ fontSize: '28px', fontWeight: '700', color: COLORS.text.primary, lineHeight: '1.1' }}>{value}</span>
              {unit && <span style={{ fontSize: TYPOGRAPHY.fontSize.body, color: COLORS.text.secondary, fontWeight: '500' }}>{unit}</span>}
            </>
          )}
        </div>
        {sub && <div style={{ marginTop: '4px', fontSize: TYPOGRAPHY.fontSize.small, color: COLORS.text.tertiary }}>{sub}</div>}
      </div>
    </div>
  );

  // ── Render ─────────────────────────────────────────────────
  return (
    <div style={s.container}>
      {/* Shimmer keyframe */}
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        .slf-dropdown-option:hover {
          background: #F1F5F9 !important;
        }
        .slf-refresh-btn:hover {
          background: ${COLORS.primary}18 !important;
          color: ${COLORS.primary} !important;
        }
      `}</style>

      {/* ── Header ─────────────────────────────────────────── */}
      <div style={s.card}>
        <div style={{
          padding: '20px 24px',
          background: `linear-gradient(135deg, ${COLORS.primary}12 0%, ${COLORS.chart.secondary}08 100%)`,
          borderBottom: `1px solid ${COLORS.borderGray}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '12px',
        }}>
          {/* Title */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{
              width: '42px',
              height: '42px',
              borderRadius: '12px',
              background: `linear-gradient(135deg, ${COLORS.primary}, ${COLORS.chart.secondary})`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 4px 12px rgba(74,127,255,0.3)',
            }}>
              <Icon icon="mdi:thermometer-lines" style={{ width: '22px', height: '22px', color: '#fff' }} />
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: TYPOGRAPHY.fontSize.subsection, fontWeight: '700', color: COLORS.text.primary }}>{title}</h2>
              <p style={{ margin: 0, fontSize: TYPOGRAPHY.fontSize.small, color: COLORS.text.secondary }}>{subtitle}</p>
            </div>
          </div>

          {/* Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            {/* Consignment dropdown */}
            <div ref={dropdownRef} style={{ position: 'relative' }}>
              <button
                onClick={() => setIsDropdownOpen(o => !o)}
                disabled={loadingConsignments}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '8px 14px',
                  borderRadius: BORDER_RADIUS.medium,
                  border: `1px solid ${COLORS.borderGray}`,
                  background: '#FFFFFF',
                  cursor: loadingConsignments ? 'not-allowed' : 'pointer',
                  fontSize: TYPOGRAPHY.fontSize.body,
                  fontWeight: '500',
                  color: COLORS.text.primary,
                  minWidth: '180px',
                  justifyContent: 'space-between',
                  boxShadow: SHADOWS.subtle,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <Icon icon="mdi:package-variant-closed" style={{ width: '15px', height: '15px', color: COLORS.primary, flexShrink: 0 }} />
                  <span style={{ fontSize: TYPOGRAPHY.fontSize.small, color: COLORS.text.secondary }}>Consignment:</span>
                  <span style={{ maxWidth: '100px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {loadingConsignments ? 'Loading…' : (selectedId || 'Select')}
                  </span>
                </span>
                <Icon
                  icon={isDropdownOpen ? 'mdi:chevron-up' : 'mdi:chevron-down'}
                  style={{ width: '16px', height: '16px', color: COLORS.text.secondary, flexShrink: 0 }}
                />
              </button>

              {isDropdownOpen && (
                <div style={{
                  position: 'absolute',
                  top: 'calc(100% + 4px)',
                  left: 0,
                  zIndex: 9999,
                  background: '#FFFFFF',
                  border: `1px solid ${COLORS.borderGray}`,
                  borderRadius: BORDER_RADIUS.large,
                  boxShadow: SHADOWS.overlay,
                  maxHeight: '280px',
                  overflowY: 'auto',
                  minWidth: '200px',
                }}>
                  {consignments.length === 0 ? (
                    <div style={{ padding: '12px 16px', fontSize: TYPOGRAPHY.fontSize.small, color: COLORS.text.secondary }}>
                      No consignments found
                    </div>
                  ) : (
                    <ul style={{ margin: 0, padding: '4px', listStyle: 'none' }}>
                      {consignments.map(c => (
                        <li key={c.consignment_id}>
                          <button
                            className="slf-dropdown-option"
                            onClick={() => { setSelectedId(c.consignment_id); setIsDropdownOpen(false); }}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              width: '100%',
                              padding: '9px 12px',
                              border: 'none',
                              background: c.consignment_id === selectedId ? `${COLORS.primary}12` : 'transparent',
                              cursor: 'pointer',
                              borderRadius: '6px',
                              fontSize: TYPOGRAPHY.fontSize.body,
                              color: c.consignment_id === selectedId ? COLORS.primary : COLORS.text.primary,
                              fontWeight: c.consignment_id === selectedId ? '600' : '400',
                              textAlign: 'left',
                            }}
                          >
                            <Icon icon="mdi:identifier" style={{ width: '14px', height: '14px', flexShrink: 0 }} />
                            {c.consignment_id}
                            {c.consignment_id === selectedId && (
                              <Icon icon="mdi:check" style={{ width: '14px', height: '14px', color: COLORS.primary, marginLeft: 'auto' }} />
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            {/* Refresh */}
            <button
              className="slf-refresh-btn"
              onClick={() => selectedId && fetchShelfLife(selectedId)}
              disabled={loadingData}
              title="Refresh data"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '8px 12px',
                borderRadius: BORDER_RADIUS.medium,
                border: `1px solid ${COLORS.borderGray}`,
                background: '#FFFFFF',
                cursor: loadingData ? 'not-allowed' : 'pointer',
                fontSize: TYPOGRAPHY.fontSize.small,
                color: COLORS.text.secondary,
                transition: 'all 0.15s',
              }}
            >
              <Icon icon={loadingData ? 'mdi:loading' : 'mdi:refresh'} style={{ width: '16px', height: '16px', animation: loadingData ? 'spin 1s linear infinite' : 'none' }} />
            </button>

            {/* Risk badge */}
            {riskStatus && !loadingData && (
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                padding: '5px 10px',
                borderRadius: BORDER_RADIUS.full,
                background: `${riskColor(riskStatus)}18`,
                border: `1px solid ${riskColor(riskStatus)}40`,
                fontSize: TYPOGRAPHY.fontSize.small,
                fontWeight: '600',
                color: riskColor(riskStatus),
              }}>
                <Icon icon={
                  riskStatus === 'fresh' ? 'mdi:check-circle' :
                  riskStatus === 'warning' ? 'mdi:alert' :
                  riskStatus === 'critical' ? 'mdi:alert-circle' :
                  'mdi:skull-crossbones-outline'
                } style={{ width: '14px', height: '14px' }} />
                {riskLabel(riskStatus)}
              </span>
            )}
          </div>
        </div>

        {/* Status bar */}
        {result && !loadingData && (
          <div style={{ padding: '10px 24px', display: 'flex', alignItems: 'center', gap: '20px', background: COLORS.lightBackground, borderTop: `1px solid ${COLORS.borderGray}`, flexWrap: 'wrap' }}>
            <span style={{ fontSize: TYPOGRAPHY.fontSize.small, color: COLORS.text.secondary }}>
              <Icon icon="mdi:chart-timeline-variant" style={{ width: '13px', height: '13px', verticalAlign: 'middle', marginRight: '4px' }} />
              {pings.toLocaleString()} telemetry pings analysed
            </span>
            {result.minTemperature !== undefined && (
              <span style={{ fontSize: TYPOGRAPHY.fontSize.small, color: COLORS.text.secondary }}>
                <Icon icon="mdi:thermometer-low" style={{ width: '13px', height: '13px', verticalAlign: 'middle', marginRight: '4px', color: COLORS.primary }} />
                Min {fmt(result.minTemperature)}°C
              </span>
            )}
            {result.maxTemperature !== undefined && (
              <span style={{ fontSize: TYPOGRAPHY.fontSize.small, color: COLORS.text.secondary }}>
                <Icon icon="mdi:thermometer-high" style={{ width: '13px', height: '13px', verticalAlign: 'middle', marginRight: '4px', color: COLORS.error }} />
                Max {fmt(result.maxTemperature)}°C
              </span>
            )}
            {consumed !== undefined && (
              <span style={{ fontSize: TYPOGRAPHY.fontSize.small, color: COLORS.text.secondary }}>
                <Icon icon="mdi:battery-charging" style={{ width: '13px', height: '13px', verticalAlign: 'middle', marginRight: '4px', color: COLORS.warning }} />
                {fmt(consumed, 1)}% shelf life consumed
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── Error banner ──────────────────────────────────── */}
      {error && (
        <div style={{
          ...s.card,
          padding: '16px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          borderColor: `${COLORS.error}50`,
          background: `${COLORS.error}08`,
        }}>
          <Icon icon="mdi:alert-circle" style={{ width: '20px', height: '20px', color: COLORS.error, flexShrink: 0 }} />
          <div>
            <p style={{ margin: 0, fontWeight: '600', color: COLORS.error, fontSize: TYPOGRAPHY.fontSize.body }}>Analysis Error</p>
            <p style={{ margin: 0, color: COLORS.text.secondary, fontSize: TYPOGRAPHY.fontSize.small }}>{error}</p>
          </div>
        </div>
      )}

      {/* ── KPI Cards ─────────────────────────────────────── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px' }}>
        <KPICard
          accent={COLORS.primary}
          icon="mdi:clock-time-four-outline"
          iconBg={`${COLORS.primary}15`}
          label="Remaining Shelf Life"
          value={fmt(remaining, 2)}
          unit="days"
          sub={
            remaining !== undefined && !loadingData ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
                <div style={{ flex: 1, height: '5px', background: COLORS.borderGray, borderRadius: '3px', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: `${Math.min(100, 100 - consumed)}%`,
                    background: consumed > 80 ? COLORS.error : consumed > 60 ? COLORS.warning : COLORS.success,
                    borderRadius: '3px',
                    transition: 'width 0.5s ease',
                  }} />
                </div>
                <span style={{ fontSize: '10px', color: COLORS.text.tertiary, whiteSpace: 'nowrap' }}>{(100 - consumed).toFixed(0)}% left</span>
              </div>
            ) : null
          }
        />

        <KPICard
          accent={COLORS.warning}
          icon="mdi:thermometer"
          iconBg={`${COLORS.warning}15`}
          label="Average Temperature"
          value={fmt(avgTemp, 2)}
          unit="°C"
          sub={
            result && !loadingData ? (
              <span>Range: {fmt(result.minTemperature)}°C → {fmt(result.maxTemperature)}°C</span>
            ) : null
          }
        />

        <KPICard
          accent={COLORS.error}
          icon="mdi:trending-down"
          iconBg={`${COLORS.error}15`}
          label="Lost Life / Day"
          value={fmt(lostPerDay, 3)}
          unit="days/day"
          sub={
            degradation !== undefined && !loadingData ? (
              <span>Total degradation: {fmt(degradation, 2)} days</span>
            ) : null
          }
        />
      </div>

      {/* ── Trend Chart ───────────────────────────────────── */}
      <div style={s.card}>
        <div style={{ padding: '18px 24px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: TYPOGRAPHY.fontSize.bodyLarge, fontWeight: '600', color: COLORS.text.primary }}>
              Temperature & Shelf Life Trend
            </h3>
            <p style={{ margin: '2px 0 0', fontSize: TYPOGRAPHY.fontSize.small, color: COLORS.text.secondary }}>
              Per-ping telemetry analysis — {rows.length} data points
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ width: '24px', height: '3px', background: COLORS.warning, opacity: 0.5, borderRadius: '2px', display: 'inline-block' }} />
              <span style={{ fontSize: '11px', color: COLORS.text.secondary }}>Temp</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ width: '24px', height: '3px', background: COLORS.error, borderRadius: '2px', display: 'inline-block' }} />
              <span style={{ fontSize: '11px', color: COLORS.text.secondary }}>Rolling avg</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span style={{ width: '24px', height: '3px', background: COLORS.primary, borderRadius: '2px', display: 'inline-block' }} />
              <span style={{ fontSize: '11px', color: COLORS.text.secondary }}>Shelf life</span>
            </div>
          </div>
        </div>

        <div style={{ padding: '16px 8px 8px' }}>
          {loadingData ? (
            <div style={{ height: '320px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '12px' }}>
              <Icon icon="mdi:loading" style={{ width: '32px', height: '32px', color: COLORS.primary, animation: 'spin 1s linear infinite' }} />
              <span style={{ fontSize: TYPOGRAPHY.fontSize.small, color: COLORS.text.secondary }}>Analysing telemetry…</span>
            </div>
          ) : rows.length === 0 ? (
            <div style={{ height: '320px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '8px' }}>
              <Icon icon="mdi:chart-line-variant" style={{ width: '40px', height: '40px', color: COLORS.text.tertiary }} />
              <span style={{ color: COLORS.text.secondary, fontSize: TYPOGRAPHY.fontSize.body }}>No telemetry data available</span>
            </div>
          ) : (
            <ReactECharts
              option={chartOption}
              style={{ height: '320px', width: '100%' }}
              notMerge
              lazyUpdate
            />
          )}
        </div>
      </div>

      {/* ── Map & Route ───────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '16px' }}>
        <div key={mapKey}>
          {mapExternalTool ? (
            <DynamicLeafletMapView
              title="Shipment Route Map"
              description={`GPS telemetry for ${selectedId} — clustered by origin, transit and destination`}
              externalTool={mapExternalTool}
              config={{
                mode: 'route',
                latitudeField: 'latitude',
                longitudeField: 'longitude',
                labelField: 'label',
                orderField: 'timestamp',
                stageField: 'stage',
                zoom: 4,
              }}
              SA_RUNTIME={SA_RUNTIME}
            />
          ) : null}
        </div>
      </div>

      {/* spin keyframe */}
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
};

(ShelfLifeMonitoring as ShelfLifeMonitoringComponent).Metadata = METADATA;

export default ShelfLifeMonitoring;
