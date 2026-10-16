import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, TYPOGRAPHY, SPACING, SHADOWS } from '../../design-system/tokens';
import LoadingState from '../../components/LoadingState';

interface InventoryCapitalProps {
  SA_RUNTIME?: any;
}

// Same palette as the rest of this product's procurement screens.
const TEAL = {
  base: '#3A59CD',
  dark: '#2E47A4',
  tint: '#EBEEFA',
  border: '#D8DEF5',
};

// ============================================================
// Real data shape — public.inventory, joined to material_master for a
// readable material name/group. No detail view exists for a single
// inventory record anywhere in this app, so rows are plain, not clickable.
// ============================================================

interface InventoryRow {
  material_id: string;
  plant_code: string;
  current_stock: number;
  reserved_stock: number;
  reorder_point: number;
  material_desc: string | null;
  material_group: string | null;
}

//local-tool id
const TOOL_ID = 'postgres-6a0f22831b3f_query';
//prod-tool id
//const TOOL_ID = 'postgres-0fc80d2496ff_query';
const TOOL_NAME = 'Query PostgreSQL Connection';

async function runTool<T = any>(sql: string, SA_RUNTIME: any, limit?: number): Promise<T[]> {
  const toolExecutor = (window as any).SA?.ToolExecutor;
  if (!toolExecutor) throw new Error('ToolExecutor not available');
  const res = await toolExecutor.executeTool({
    externalTool: { toolId: TOOL_ID, toolName: TOOL_NAME, parameters: { sql, ...(limit ? { limit } : {}) } },
    formData: {},
    SA_RUNTIME,
  });
  const payload = res?.data ?? res;
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.records) ? payload.records : [];
  return rows as T[];
}

// Lowest available stock first — surfaces what needs reordering soonest.
const INVENTORY_QUERY = `
SELECT i.material_id, i.plant_code, i.current_stock, i.reserved_stock, i.reorder_point,
       m.material_desc, m.material_group
FROM inventory i
LEFT JOIN material_master m ON m.material_id = i.material_id
ORDER BY (i.current_stock - i.reserved_stock) ASC
LIMIT 2500;
`;

const formatNum = (n: number | null | undefined): string => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Math.round(n).toLocaleString('en-IN');
};

const METADATA: ComponentMetadata = {
  id: 'inventory-capital-dashboard',
  name: 'InventoryCapital',
  displayName: 'Show inventory directory',
  isDisplayComp: true,
  type: 'InventoryCapital',
  description: 'Inventory directory — on-hand, reserved, and available stock by material and plant, sourced from the live inventory/material_master data',
  category: 'Dashboard',
  keywords: ['inventory', 'stock', 'reorder', 'materials', 'procurement'],
  dashboard: { label: 'Inventory & Capital', icon: 'mdi:package-variant-closed', order: 3 },
  props: {},
};

interface InventoryCapitalComponent extends React.FC<InventoryCapitalProps> {
  Metadata: ComponentMetadata;
}

const InventoryCapital: React.FC<InventoryCapitalProps> = ({ SA_RUNTIME }) => {
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await runTool<InventoryRow>(INVENTORY_QUERY, SA_RUNTIME, 2500);
        if (!cancelled) setRows(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load inventory');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [SA_RUNTIME]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.material_id.toLowerCase().includes(q) ||
        (r.material_desc || '').toLowerCase().includes(q) ||
        (r.material_group || '').toLowerCase().includes(q) ||
        r.plant_code.toLowerCase().includes(q)
    );
  }, [rows, search]);

  if (loading) {
    return <LoadingState height={520} message="Loading inventory…" variant="skeleton" size="lg" />;
  }

  if (error) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-[#F1F5F9] p-6">
        <div className="flex items-center gap-3">
          <Icon icon="mdi:alert-circle" className="w-5 h-5 text-[#475569] flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-[#475569]">Couldn't load inventory</p>
            <p className="text-xs mt-1" style={{ color: COLORS.text.secondary }}>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="w-full flex flex-col"
      style={{ fontFamily: TYPOGRAPHY.fontFamily.primary, paddingTop: SPACING.xl, height: 'calc(100vh - 160px)', minHeight: 480 }}
    >
      {/* Toolbar — fixed, never scrolls */}
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4 flex-shrink-0">
        <div>
          <h1 className="text-xl font-bold" style={{ color: COLORS.text.primary }}>Inventory</h1>
          <p className="text-xs mt-0.5" style={{ color: COLORS.text.secondary }}>
            {filtered.length.toLocaleString('en-IN')} of {rows.length.toLocaleString('en-IN')} inventory records
          </p>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ border: `1px solid ${COLORS.borderGray}`, backgroundColor: COLORS.white }}>
          <Icon icon="mdi:magnify" className="w-4 h-4" style={{ color: COLORS.text.tertiary }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search material, group, plant…"
            className="text-xs w-64"
            style={{ color: COLORS.text.primary, border: 'none', outline: 'none', boxShadow: 'none', background: 'transparent' }}
          />
        </div>
      </div>

      {/* Table — the only internally-scrolling region */}
      <div className="flex-1 min-h-0 rounded-xl overflow-auto" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
        <table className="w-full text-sm border-collapse" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col />
            <col style={{ width: '130px' }} />
            <col style={{ width: '90px' }} />
            <col style={{ width: '100px' }} />
            <col style={{ width: '100px' }} />
            <col style={{ width: '110px' }} />
            <col style={{ width: '110px' }} />
          </colgroup>
          <thead className="sticky top-0 z-10" style={{ backgroundColor: COLORS.lightBackground }}>
            <tr>
              {['Material', 'Plant', 'On Hand', 'Reserved', 'Available', 'Reorder Point', 'Stock Status'].map((h) => (
                <th
                  key={h}
                  className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide leading-tight"
                  style={{ color: COLORS.text.secondary, borderBottom: `1px solid ${TEAL.border}` }}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const available = r.current_stock - r.reserved_stock;
              const low = available <= r.reorder_point;
              return (
                <tr key={`${r.material_id}-${r.plant_code}`} style={{ borderBottom: `1px solid ${COLORS.lightGray}` }}>
                  <td className="px-3 py-1.5 font-semibold truncate" style={{ color: COLORS.text.primary }}>
                    {r.material_desc || r.material_id}
                    {r.material_group && (
                      <span className="ml-1.5 text-[11px] font-normal" style={{ color: COLORS.text.tertiary }}>{r.material_group}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 truncate" style={{ color: COLORS.text.secondary }}>{r.plant_code}</td>
                  <td className="px-3 py-1.5" style={{ color: COLORS.text.secondary }}>{formatNum(r.current_stock)}</td>
                  <td className="px-3 py-1.5" style={{ color: COLORS.text.secondary }}>{formatNum(r.reserved_stock)}</td>
                  <td className="px-3 py-1.5 font-medium" style={{ color: low ? '#EA580C' : COLORS.text.primary }}>{formatNum(available)}</td>
                  <td className="px-3 py-1.5" style={{ color: COLORS.text.secondary }}>{formatNum(r.reorder_point)}</td>
                  <td className="px-3 py-1.5">
                    <span
                      className="px-2 py-0.5 rounded-full text-[11px] font-semibold"
                      style={{ backgroundColor: low ? '#FFEDD5' : '#DCFCE7', color: low ? '#EA580C' : '#16A34A' }}
                    >
                      {low ? 'Low Stock' : 'In Stock'}
                    </span>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-12 text-center text-sm" style={{ color: COLORS.text.tertiary }}>
                  No inventory records match this search.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

(InventoryCapital as InventoryCapitalComponent).Metadata = METADATA;

export default InventoryCapital;
