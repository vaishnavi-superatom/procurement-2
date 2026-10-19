import React, { useEffect, useMemo, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, TYPOGRAPHY, SPACING, SHADOWS, BORDER_RADIUS } from '../../design-system/tokens';
import LoadingState from '../../components/LoadingState';
import DynamicBarChart from '../../shared-modules/DynamicBarChart';

interface SpendCategoryProps {
  SA_RUNTIME?: any;
}

// Same palette as the rest of this product's procurement screens.
const TEAL = {
  base: '#0F6B64',
  dark: '#0B4F4A',
  tint: '#E6F5F3',
  border: '#D7E8E6',
};

// ============================================================
// Real data shapes — purchase_orders / material_master / vendor_master /
// contracts / contract_items, the live "PostgreSQL Connection" source
// registered for this project. All figures on
// this page are computed client-side from these rows — nothing here is a
// hardcoded example number.
// ============================================================

interface PORow {
  po_id: string;
  po_line_item: number;
  pr_id: string | null;
  material_id: string;
  vendor_id: string;
  ordered_qty: number;
  unit_price: number;
  total_value: number;
  po_date: string;
  delivery_date: string | null;
  actual_delivery_date: string | null;
  po_status: 'Delivered' | 'Open';
  contract_id: string | null;
  rfq_id: string | null;
  payment_status: 'Paid' | 'Pending';
}

interface MaterialRow {
  material_id: string;
  material_desc: string | null;
  material_group: string | null;
  material_subgroup: string | null;
  abc_class: string | null;
  unit_of_measure: string | null;
  standard_price: number | null;
}

interface VendorRow {
  vendor_id: string;
  vendor_name: string;
  vendor_type: string;
  category_specialization: string | null;
  city: string | null;
  state: string | null;
  is_active: boolean;
}

interface ContractRow {
  contract_id: string;
  vendor_id: string;
  contract_type: string;
  material_group: string;
  start_date: string;
  end_date: string;
  total_contract_value: number;
  price_escalation_clause: boolean;
  escalation_index: string | null;
}

interface ContractItemRow {
  contract_id: string;
  vendor_id: string;
  material_id: string;
  contract_unit_price: number;
}

interface EnrichedPO extends PORow {
  material?: MaterialRow;
  vendor?: VendorRow;
}

// ============================================================
// Query helpers — same ToolExecutor path as the other procurement modules.
// ============================================================

//const TOOL_ID = 'postgres-6a0f22831b3f_query';
const TOOL_ID = 'postgres-0fc80d2496ff_query';
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

const PO_QUERY = `
SELECT po_id, po_line_item, pr_id, material_id, vendor_id, ordered_qty, unit_price, total_value,
       po_date, delivery_date, actual_delivery_date, po_status, contract_id, rfq_id, payment_status
FROM purchase_orders
ORDER BY po_date DESC
LIMIT 5000;
`;

const MATERIAL_QUERY = `
SELECT material_id, material_desc, material_group, material_subgroup, abc_class, unit_of_measure,
       standard_price
FROM material_master
LIMIT 2500;
`;

const VENDOR_QUERY = `
SELECT vendor_id, vendor_name, vendor_type, category_specialization, city, state, is_active
FROM vendor_master
LIMIT 500;
`;

const CONTRACT_QUERY = `
SELECT contract_id, vendor_id, contract_type, material_group, start_date, end_date,
       total_contract_value, price_escalation_clause, escalation_index
FROM contracts
LIMIT 200;
`;

const CONTRACT_ITEMS_QUERY = `
SELECT contract_id, vendor_id, material_id, contract_unit_price
FROM contract_items
LIMIT 1500;
`;

// ============================================================
// Formatting helpers
// ============================================================

const formatINR = (n: number | null | undefined): string => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return '₹' + Math.round(n).toLocaleString('en-IN');
};

const formatINRCompact = (n: number | null | undefined): string => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_00_00_000) return sign + '₹' + (abs / 1_00_00_000).toFixed(2) + ' Cr';
  if (abs >= 1_00_000) return sign + '₹' + (abs / 1_00_000).toFixed(2) + ' L';
  if (abs >= 1_000) return sign + '₹' + (abs / 1_000).toFixed(1) + ' K';
  return formatINR(n);
};

const formatPct = (n: number | null | undefined, digits = 1): string => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return (n * 100).toFixed(digits) + '%';
};

const formatDate = (d: string | null | undefined): string => {
  if (!d) return '—';
  const date = new Date(d);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const formatMonthLabel = (key: string): string => {
  const [y, m] = key.split('-');
  return `${MONTH_NAMES[Number(m) - 1] || m} ${y}`;
};

// ============================================================
// Small shared bits
// ============================================================

const SectionCard: React.FC<{ title: string; subtitle?: string; right?: React.ReactNode; children: React.ReactNode }> = ({
  title,
  subtitle,
  right,
  children,
}) => (
  <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
    <div className="px-4 py-3 flex items-start justify-between gap-4" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
      <div>
        <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>{title}</h2>
        {subtitle && <p className="text-[11px] mt-0.5" style={{ color: COLORS.text.secondary }}>{subtitle}</p>}
      </div>
      {right}
    </div>
    <div className="px-4 py-3">{children}</div>
  </div>
);

const StatBlock: React.FC<{ label: string; value: string; tone?: 'default' | 'teal' }> = ({ label, value, tone = 'default' }) => (
  <div>
    <p className="text-[10px] uppercase tracking-wide" style={{ color: COLORS.text.tertiary }}>{label}</p>
    <p className="text-sm font-semibold" style={{ color: tone === 'teal' ? TEAL.base : COLORS.text.primary }}>{value}</p>
  </div>
);

// Generic PO-evidence table reused by every drilldown on this page (category,
// supplier, savings opportunity) — real purchase-order rows, never a summary
// standing in for them.
const PO_PAGE_SIZE = 50;
const PoEvidenceTable: React.FC<{
  pos: EnrichedPO[];
  extraColumn?: { label: string; render: (po: EnrichedPO) => React.ReactNode };
}> = ({ pos, extraColumn }) => {
  const [visibleCount, setVisibleCount] = useState(PO_PAGE_SIZE);
  useEffect(() => setVisibleCount(PO_PAGE_SIZE), [pos]);
  const visible = pos.slice(0, visibleCount);
  const hasMore = visibleCount < pos.length;
  const columnCount = extraColumn ? 8 : 7;

  if (pos.length === 0) {
    return <p className="text-xs py-3" style={{ color: COLORS.text.tertiary }}>No purchase orders match this.</p>;
  }

  return (
    <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${COLORS.borderGray}` }}>
      <div className="overflow-auto" style={{ maxHeight: 360 }}>
        <table className="w-full text-sm border-collapse" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: '90px' }} />
            <col />
            <col style={{ width: '150px' }} />
            <col style={{ width: '70px' }} />
            <col style={{ width: '100px' }} />
            <col style={{ width: '110px' }} />
            <col style={{ width: '90px' }} />
            {extraColumn && <col style={{ width: '110px' }} />}
          </colgroup>
          <thead className="sticky top-0" style={{ backgroundColor: COLORS.lightBackground }}>
            <tr>
              {['PO ID', 'Material', 'Vendor', 'Qty', 'Unit Price', 'Total Value', 'PO Date', ...(extraColumn ? [extraColumn.label] : [])].map((h) => (
                <th key={h} className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide truncate" style={{ color: COLORS.text.secondary, borderBottom: `1px solid ${TEAL.border}` }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((po) => (
              <tr key={`${po.po_id}-${po.po_line_item}`} style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                <td className="px-3 py-1.5 font-semibold truncate" style={{ color: COLORS.text.primary }}>{po.po_id}</td>
                <td className="px-3 py-1.5 truncate" style={{ color: COLORS.text.primary }}>{po.material?.material_desc || po.material_id}</td>
                <td className="px-3 py-1.5 truncate" style={{ color: COLORS.text.secondary }}>{po.vendor?.vendor_name || po.vendor_id}</td>
                <td className="px-3 py-1.5" style={{ color: COLORS.text.secondary }}>{po.ordered_qty}</td>
                <td className="px-3 py-1.5" style={{ color: COLORS.text.secondary }}>{formatINR(po.unit_price)}</td>
                <td className="px-3 py-1.5 font-medium" style={{ color: COLORS.text.primary }}>{formatINR(po.total_value)}</td>
                <td className="px-3 py-1.5" style={{ color: COLORS.text.secondary }}>{formatDate(po.po_date)}</td>
                {extraColumn && <td className="px-3 py-1.5 font-medium" style={{ color: TEAL.base }}>{extraColumn.render(po)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <div className="text-center py-2" style={{ backgroundColor: COLORS.lightBackground, borderTop: `1px solid ${COLORS.borderGray}` }}>
          <button
            onClick={() => setVisibleCount((c) => c + PO_PAGE_SIZE)}
            className="px-4 py-1 rounded-lg text-xs font-semibold"
            style={{ backgroundColor: TEAL.tint, color: TEAL.base }}
          >
            Load more ({(pos.length - visibleCount).toLocaleString('en-IN')} remaining)
          </button>
        </div>
      )}
      <div className="px-3 py-1.5 text-[11px]" style={{ backgroundColor: COLORS.lightBackground, borderTop: `1px solid ${COLORS.borderGray}`, color: COLORS.text.tertiary }}>
        {pos.length.toLocaleString('en-IN')} purchase order{pos.length === 1 ? '' : 's'} · {formatINR(pos.reduce((s, p) => s + Number(p.total_value || 0), 0))} total
      </div>
    </div>
  );
};

const METADATA: ComponentMetadata = {
  id: 'spend-category-dashboard',
  name: 'SpendCategory',
  displayName: 'Show spend & category dashboard',
  isDisplayComp: true,
  type: 'SpendCategory',
  description: 'Spend and category intelligence dashboard — category breakdown, supplier concentration, and savings opportunities, sourced from the live purchase_orders/contracts/material_master data',
  category: 'Dashboard',
  keywords: ['spend', 'category', 'contract', 'supplier concentration', 'savings', 'leakage', 'procurement'],
  dashboard: { label: 'Spend & Category', icon: 'mdi:chart-pie-outline', order: 6 },
  props: {},
};

interface SpendCategoryComponent extends React.FC<SpendCategoryProps> {
  Metadata: ComponentMetadata;
}

const SpendCategory: React.FC<SpendCategoryProps> = ({ SA_RUNTIME }) => {
  const [pos, setPos] = useState<PORow[]>([]);
  const [materials, setMaterials] = useState<MaterialRow[]>([]);
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [contracts, setContracts] = useState<ContractRow[]>([]);
  const [contractItems, setContractItems] = useState<ContractItemRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [poRows, materialRows, vendorRows, contractRows, contractItemRows] = await Promise.all([
          runTool<PORow>(PO_QUERY, SA_RUNTIME, 5000),
          runTool<MaterialRow>(MATERIAL_QUERY, SA_RUNTIME, 2500),
          runTool<VendorRow>(VENDOR_QUERY, SA_RUNTIME, 500),
          runTool<ContractRow>(CONTRACT_QUERY, SA_RUNTIME, 200),
          runTool<ContractItemRow>(CONTRACT_ITEMS_QUERY, SA_RUNTIME, 1500),
        ]);
        if (cancelled) return;
        setPos(poRows);
        setMaterials(materialRows);
        setVendors(vendorRows);
        setContracts(contractRows);
        setContractItems(contractItemRows);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load spend data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [SA_RUNTIME]);

  // ============================================================
  // Base lookups
  // ============================================================

  const materialById = useMemo(() => new Map(materials.map((m) => [m.material_id, m])), [materials]);
  const vendorById = useMemo(() => new Map(vendors.map((v) => [v.vendor_id, v])), [vendors]);

  const contractsByVendor = useMemo(() => {
    const map = new Map<string, ContractRow[]>();
    for (const c of contracts) {
      if (!map.has(c.vendor_id)) map.set(c.vendor_id, []);
      map.get(c.vendor_id)!.push(c);
    }
    return map;
  }, [contracts]);

  const contractsByMaterialGroup = useMemo(() => {
    const map = new Map<string, ContractRow[]>();
    for (const c of contracts) {
      if (!map.has(c.material_group)) map.set(c.material_group, []);
      map.get(c.material_group)!.push(c);
    }
    return map;
  }, [contracts]);

  const contractItemsByMaterial = useMemo(() => {
    const map = new Map<string, ContractItemRow[]>();
    for (const ci of contractItems) {
      if (!map.has(ci.material_id)) map.set(ci.material_id, []);
      map.get(ci.material_id)!.push(ci);
    }
    return map;
  }, [contractItems]);

  const enrichedPOs: EnrichedPO[] = useMemo(
    () => pos.map((po) => ({ ...po, material: materialById.get(po.material_id), vendor: vendorById.get(po.vendor_id) })),
    [pos, materialById, vendorById]
  );

  // ============================================================
  // 1. Summary cards
  // ============================================================

  const totalSpend = useMemo(() => enrichedPOs.reduce((s, p) => s + Number(p.total_value || 0), 0), [enrichedPOs]);
  const onContractSpend = useMemo(() => enrichedPOs.filter((p) => p.contract_id).reduce((s, p) => s + Number(p.total_value || 0), 0), [enrichedPOs]);
  const offContractSpend = totalSpend - onContractSpend;
  const suppliersWithSpend = useMemo(() => new Set(enrichedPOs.map((p) => p.vendor_id)).size, [enrichedPOs]);
  const activeVendorCount = useMemo(() => vendors.filter((v) => v.is_active).length, [vendors]);
  const vendorsWithContract = useMemo(() => new Set(contracts.map((c) => c.vendor_id)).size, [contracts]);
  const avgPOValue = enrichedPOs.length ? totalSpend / enrichedPOs.length : 0;

  // ============================================================
  // 2. Where Are We Spending? (category = material_group)
  // ============================================================

  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const categoryStats = useMemo(() => {
    const map = new Map<string, { spend: number; onContract: number; suppliers: Set<string>; materials: Set<string>; poCount: number }>();
    for (const po of enrichedPOs) {
      const cat = po.material?.material_group || 'Unclassified';
      if (!map.has(cat)) map.set(cat, { spend: 0, onContract: 0, suppliers: new Set(), materials: new Set(), poCount: 0 });
      const e = map.get(cat)!;
      const val = Number(po.total_value || 0);
      e.spend += val;
      if (po.contract_id) e.onContract += val;
      e.suppliers.add(po.vendor_id);
      e.materials.add(po.material_id);
      e.poCount += 1;
    }
    return Array.from(map.entries())
      .map(([category, e]) => ({
        category,
        spend: e.spend,
        share: totalSpend ? e.spend / totalSpend : 0,
        supplierCount: e.suppliers.size,
        materialCount: e.materials.size,
        onContractSpend: e.onContract,
        contractCoveragePct: e.spend ? e.onContract / e.spend : 0,
        poCount: e.poCount,
      }))
      .sort((a, b) => b.spend - a.spend);
  }, [enrichedPOs, totalSpend]);

  const categoryDrilldown = useMemo(() => {
    if (!selectedCategory) return null;
    const catPOs = enrichedPOs.filter((po) => (po.material?.material_group || 'Unclassified') === selectedCategory);
    const materialMap = new Map<string, { material: MaterialRow | undefined; spend: number; poCount: number }>();
    const vendorMap = new Map<string, { vendor: VendorRow | undefined; spend: number; poCount: number; onContract: number }>();
    for (const po of catPOs) {
      const val = Number(po.total_value || 0);
      if (!materialMap.has(po.material_id)) materialMap.set(po.material_id, { material: po.material, spend: 0, poCount: 0 });
      const me = materialMap.get(po.material_id)!;
      me.spend += val;
      me.poCount += 1;
      if (!vendorMap.has(po.vendor_id)) vendorMap.set(po.vendor_id, { vendor: po.vendor, spend: 0, poCount: 0, onContract: 0 });
      const ve = vendorMap.get(po.vendor_id)!;
      ve.spend += val;
      ve.poCount += 1;
      if (po.contract_id) ve.onContract += val;
    }
    return {
      pos: catPOs,
      materials: Array.from(materialMap.values()).sort((a, b) => b.spend - a.spend),
      suppliers: Array.from(vendorMap.values()).sort((a, b) => b.spend - a.spend),
      contracts: contractsByMaterialGroup.get(selectedCategory) || [],
    };
  }, [selectedCategory, enrichedPOs, contractsByMaterialGroup]);

  // ============================================================
  // 3. Spend Trend (monthly on-contract vs off-contract)
  // ============================================================

  const monthlyTrend = useMemo(() => {
    const map = new Map<string, { onContract: number; offContract: number }>();
    for (const po of enrichedPOs) {
      const d = new Date(po.po_date);
      if (isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!map.has(key)) map.set(key, { onContract: 0, offContract: 0 });
      const e = map.get(key)!;
      const val = Number(po.total_value || 0);
      if (po.contract_id) e.onContract += val;
      else e.offContract += val;
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ month: formatMonthLabel(month), onContract: Math.round(v.onContract), offContract: Math.round(v.offContract) }));
  }, [enrichedPOs]);

  // ============================================================
  // 4. Supplier Concentration
  // ============================================================

  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(null);

  const vendorSpendStats = useMemo(() => {
    const map = new Map<string, { vendor: VendorRow | undefined; spend: number; poCount: number; onContract: number }>();
    for (const po of enrichedPOs) {
      if (!map.has(po.vendor_id)) map.set(po.vendor_id, { vendor: po.vendor, spend: 0, poCount: 0, onContract: 0 });
      const e = map.get(po.vendor_id)!;
      const val = Number(po.total_value || 0);
      e.spend += val;
      e.poCount += 1;
      if (po.contract_id) e.onContract += val;
    }
    return Array.from(map.entries())
      .map(([vendor_id, e]) => ({ vendor_id, ...e }))
      .sort((a, b) => b.spend - a.spend);
  }, [enrichedPOs]);

  const concentration = useMemo(() => {
    if (vendorSpendStats.length === 0 || totalSpend === 0) return null;
    const topSupplierShare = vendorSpendStats[0].spend / totalSpend;
    const top10Share = vendorSpendStats.slice(0, 10).reduce((s, v) => s + v.spend, 0) / totalSpend;
    const hhi = vendorSpendStats.reduce((sum, v) => {
      const sharePct = (v.spend / totalSpend) * 100;
      return sum + sharePct * sharePct;
    }, 0);
    // Standard US DOJ/FTC HHI bands: <1500 unconcentrated, 1500–2500 moderate, >2500 highly concentrated.
    const hhiLabel = hhi >= 2500 ? 'Highly concentrated' : hhi >= 1500 ? 'Moderately concentrated' : 'Unconcentrated';
    return { topSupplierShare, top10Share, hhi, hhiLabel };
  }, [vendorSpendStats, totalSpend]);

  const selectedVendorDrilldown = useMemo(() => {
    if (!selectedVendorId) return null;
    const vendorPOs = enrichedPOs.filter((po) => po.vendor_id === selectedVendorId);
    return { pos: vendorPOs, contracts: contractsByVendor.get(selectedVendorId) || [], vendor: vendorById.get(selectedVendorId) };
  }, [selectedVendorId, enrichedPOs, contractsByVendor, vendorById]);

  // ============================================================
  // 5. Savings & Leakage Opportunities
  // ============================================================

  type OpportunityKey = 'offContract' | 'fragmentation' | 'tailSpend' | 'aboveStandard';
  const [selectedOpportunity, setSelectedOpportunity] = useState<OpportunityKey | null>(null);

  const offContractPOs = useMemo(() => enrichedPOs.filter((po) => !po.contract_id).sort((a, b) => Number(b.total_value) - Number(a.total_value)), [enrichedPOs]);

  const fragmentedMaterials = useMemo(() => {
    const map = new Map<string, { material: MaterialRow | undefined; vendorSpend: Map<string, number>; totalSpend: number }>();
    for (const po of enrichedPOs) {
      if (!map.has(po.material_id)) map.set(po.material_id, { material: po.material, vendorSpend: new Map(), totalSpend: 0 });
      const e = map.get(po.material_id)!;
      const val = Number(po.total_value || 0);
      e.vendorSpend.set(po.vendor_id, (e.vendorSpend.get(po.vendor_id) || 0) + val);
      e.totalSpend += val;
    }
    const flagged: { materialId: string; material: MaterialRow | undefined; vendorCount: number; totalSpend: number; maxShare: number }[] = [];
    for (const [materialId, e] of map.entries()) {
      const vendorCount = e.vendorSpend.size;
      if (vendorCount < 3 || e.totalSpend === 0) continue;
      const maxShare = Math.max(...Array.from(e.vendorSpend.values())) / e.totalSpend;
      if (maxShare > 0.6) continue; // one supplier already dominates — not fragmented
      flagged.push({ materialId, material: e.material, vendorCount, totalSpend: e.totalSpend, maxShare });
    }
    return flagged.sort((a, b) => b.totalSpend - a.totalSpend);
  }, [enrichedPOs]);
  const fragmentationTotal = useMemo(() => fragmentedMaterials.reduce((s, f) => s + f.totalSpend, 0), [fragmentedMaterials]);
  const fragmentedMaterialIds = useMemo(() => new Set(fragmentedMaterials.map((f) => f.materialId)), [fragmentedMaterials]);
  const fragmentationPOs = useMemo(() => enrichedPOs.filter((po) => fragmentedMaterialIds.has(po.material_id)).sort((a, b) => Number(b.total_value) - Number(a.total_value)), [enrichedPOs, fragmentedMaterialIds]);

  const tailSpend = useMemo(() => {
    let cumulative = 0;
    let cutoffIndex = vendorSpendStats.length;
    for (let i = 0; i < vendorSpendStats.length; i++) {
      cumulative += vendorSpendStats[i].spend;
      if (totalSpend > 0 && cumulative / totalSpend >= 0.8) {
        cutoffIndex = i + 1;
        break;
      }
    }
    const tailVendors = vendorSpendStats.slice(cutoffIndex);
    return { tailVendors, tailTotal: tailVendors.reduce((s, v) => s + v.spend, 0), tailVendorIds: new Set(tailVendors.map((v) => v.vendor_id)) };
  }, [vendorSpendStats, totalSpend]);
  const tailSpendPOs = useMemo(() => enrichedPOs.filter((po) => tailSpend.tailVendorIds.has(po.vendor_id)).sort((a, b) => Number(b.total_value) - Number(a.total_value)), [enrichedPOs, tailSpend]);

  const aboveStandardPOs = useMemo(() => {
    return enrichedPOs
      .filter((po) => po.material?.standard_price != null && Number(po.unit_price) > Number(po.material!.standard_price))
      .map((po) => ({ ...po, overspend: (Number(po.unit_price) - Number(po.material!.standard_price)) * Number(po.ordered_qty) }))
      .sort((a, b) => b.overspend - a.overspend);
  }, [enrichedPOs]);
  const aboveStandardTotal = useMemo(() => aboveStandardPOs.reduce((s, p) => s + p.overspend, 0), [aboveStandardPOs]);

  const opportunityPOs: Record<OpportunityKey, EnrichedPO[]> = {
    offContract: offContractPOs,
    fragmentation: fragmentationPOs,
    tailSpend: tailSpendPOs,
    aboveStandard: aboveStandardPOs,
  };

  // ============================================================
  // Render
  // ============================================================

  if (loading) {
    return <LoadingState height={600} message="Loading spend data…" variant="skeleton" size="lg" />;
  }

  if (error) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-[#F1F5F9] p-6">
        <div className="flex items-center gap-3">
          <Icon icon="mdi:alert-circle" className="w-5 h-5 text-[#475569] flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-[#475569]">Couldn't load spend data</p>
            <p className="text-xs mt-1" style={{ color: COLORS.text.secondary }}>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  const OPPORTUNITY_META: { key: OpportunityKey; icon: string; title: string; headline: string; description: string }[] = [
    {
      key: 'offContract',
      icon: 'mdi:file-cancel-outline',
      title: 'Off-Contract Buying',
      headline: formatINR(offContractSpend),
      description: `${offContractPOs.length.toLocaleString('en-IN')} purchase orders have no contract backing them — ${formatPct(totalSpend ? offContractSpend / totalSpend : 0)} of total spend.`,
    },
    {
      key: 'fragmentation',
      icon: 'mdi:source-branch',
      title: 'Supplier Fragmentation',
      headline: formatINR(fragmentationTotal),
      description: `${fragmentedMaterials.length.toLocaleString('en-IN')} materials are sourced from 3+ suppliers with no single supplier holding more than 60% share.`,
    },
    {
      key: 'tailSpend',
      icon: 'mdi:chart-timeline-variant',
      title: 'Tail-Spend Consolidation',
      headline: formatINR(tailSpend.tailTotal),
      description: `${tailSpend.tailVendors.length.toLocaleString('en-IN')} suppliers sit beyond the top 80% of cumulative spend — candidates to consolidate.`,
    },
    {
      key: 'aboveStandard',
      icon: 'mdi:trending-up',
      title: 'Buying Above Standard Cost',
      headline: formatINR(aboveStandardTotal),
      description: `${aboveStandardPOs.length.toLocaleString('en-IN')} purchase orders paid more per unit than the material's recorded standard price.`,
    },
  ];

  return (
    <div
      className="w-full max-w-[1200px] mx-auto space-y-6 px-6"
      style={{ fontFamily: TYPOGRAPHY.fontFamily.primary, paddingTop: SPACING.xl, paddingBottom: SPACING.xl }}
    >
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0" style={{ backgroundColor: TEAL.tint }}>
          <Icon icon="mdi:chart-pie-outline" className="w-5 h-5" style={{ color: TEAL.base }} />
        </div>
        <div>
          <h1 className="text-xl font-bold" style={{ color: COLORS.text.primary }}>Spend & Category</h1>
          <p className="text-xs mt-0.5" style={{ color: COLORS.text.secondary }}>
            {enrichedPOs.length.toLocaleString('en-IN')} purchase orders · {formatINR(totalSpend)} total spend
          </p>
        </div>
      </div>

      {/* 1. Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg p-4" style={{ backgroundColor: COLORS.white, border: `1px solid ${TEAL.border}`, boxShadow: SHADOWS.card }}>
          <p className="text-xs mb-1" style={{ color: COLORS.text.secondary }}>Total Spend</p>
          <p className="text-2xl font-bold mb-3" style={{ color: COLORS.text.primary }}>{formatINRCompact(totalSpend)}</p>
          <div className="flex items-center gap-6">
            <StatBlock label="Purchase Orders" value={enrichedPOs.length.toLocaleString('en-IN')} />
            <StatBlock label="Avg PO Value" value={formatINR(avgPOValue)} />
          </div>
        </div>
        <div className="rounded-lg p-4" style={{ backgroundColor: COLORS.white, border: `1px solid ${TEAL.border}`, boxShadow: SHADOWS.card }}>
          <p className="text-xs mb-1" style={{ color: COLORS.text.secondary }}>Suppliers</p>
          <p className="text-2xl font-bold mb-3" style={{ color: COLORS.text.primary }}>{suppliersWithSpend.toLocaleString('en-IN')}</p>
          <div className="flex items-center gap-6">
            <StatBlock label="Active in Master Data" value={activeVendorCount.toLocaleString('en-IN')} />
            <StatBlock label="With a Contract" value={vendorsWithContract.toLocaleString('en-IN')} />
          </div>
        </div>
        <div className="rounded-lg p-4" style={{ backgroundColor: COLORS.white, border: `1px solid ${TEAL.border}`, boxShadow: SHADOWS.card }}>
          <p className="text-xs mb-1" style={{ color: COLORS.text.secondary }}>On-Contract Spend</p>
          <p className="text-2xl font-bold mb-3" style={{ color: TEAL.base }}>{formatINRCompact(onContractSpend)}</p>
          <div className="flex items-center gap-6">
            <StatBlock label="% of Total Spend" value={formatPct(totalSpend ? onContractSpend / totalSpend : 0)} tone="teal" />
            <StatBlock label="Off-Contract Spend" value={formatINRCompact(offContractSpend)} />
          </div>
        </div>
      </div>

      {/* 2. Where Are We Spending? */}
      <SectionCard title="Where Are We Spending?" subtitle="Spend by material category — click a row for materials, suppliers, and contracts.">
        <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${COLORS.borderGray}` }}>
          <table className="w-full text-sm border-collapse" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col />
              <col style={{ width: '120px' }} />
              <col style={{ width: '90px' }} />
              <col style={{ width: '105px' }} />
              <col style={{ width: '105px' }} />
              <col style={{ width: '150px' }} />
            </colgroup>
            <thead>
              <tr style={{ backgroundColor: COLORS.lightBackground }}>
                {['Category', 'Spend', 'Share', 'Suppliers', 'Materials', 'Contract Coverage'].map((h) => (
                  <th key={h} className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide truncate" style={{ color: COLORS.text.secondary, borderBottom: `1px solid ${TEAL.border}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {categoryStats.map((c) => {
                const selected = selectedCategory === c.category;
                return (
                  <tr
                    key={c.category}
                    onClick={() => setSelectedCategory(selected ? null : c.category)}
                    className="cursor-pointer transition-colors duration-150"
                    style={{ borderTop: `1px solid ${COLORS.lightGray}`, backgroundColor: selected ? TEAL.tint : 'transparent' }}
                  >
                    <td className="px-3 py-2 font-semibold truncate" style={{ color: COLORS.text.primary }}>{c.category}</td>
                    <td className="px-3 py-2 font-medium" style={{ color: COLORS.text.primary }}>{formatINR(c.spend)}</td>
                    <td className="px-3 py-2" style={{ color: COLORS.text.secondary }}>{formatPct(c.share)}</td>
                    <td className="px-3 py-2" style={{ color: COLORS.text.secondary }}>{c.supplierCount}</td>
                    <td className="px-3 py-2" style={{ color: COLORS.text.secondary }}>{c.materialCount}</td>
                    <td className="px-3 py-2">
                      <span
                        className="px-2 py-0.5 rounded-full text-[11px] font-semibold"
                        style={{ backgroundColor: c.contractCoveragePct >= 0.5 ? '#DCFCE7' : '#F1F5F9', color: c.contractCoveragePct >= 0.5 ? '#16A34A' : '#475569' }}
                      >
                        {formatPct(c.contractCoveragePct)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {categoryDrilldown && (
          <div className="mt-4 pt-4 space-y-4" style={{ borderTop: `1px solid ${COLORS.borderGray}` }}>
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold" style={{ color: TEAL.base }}>{selectedCategory} — materials, suppliers & contracts</p>
              <button onClick={() => setSelectedCategory(null)} className="text-[11px] font-medium" style={{ color: COLORS.text.tertiary }}>Close</button>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: COLORS.text.tertiary }}>Materials ({categoryDrilldown.materials.length})</p>
                <div className="rounded-lg overflow-auto" style={{ border: `1px solid ${COLORS.borderGray}`, maxHeight: 220 }}>
                  {categoryDrilldown.materials.map((m) => (
                    <div key={m.material?.material_id} className="px-3 py-1.5 flex items-center justify-between gap-3" style={{ borderBottom: `1px solid ${COLORS.lightGray}` }}>
                      <span className="text-xs truncate" style={{ color: COLORS.text.primary }}>{m.material?.material_desc || m.material?.material_id}</span>
                      <span className="text-xs font-medium flex-shrink-0" style={{ color: COLORS.text.secondary }}>{formatINR(m.spend)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: COLORS.text.tertiary }}>Suppliers ({categoryDrilldown.suppliers.length})</p>
                <div className="rounded-lg overflow-auto" style={{ border: `1px solid ${COLORS.borderGray}`, maxHeight: 220 }}>
                  {categoryDrilldown.suppliers.map((v) => (
                    <div key={v.vendor?.vendor_id} className="px-3 py-1.5 flex items-center justify-between gap-3" style={{ borderBottom: `1px solid ${COLORS.lightGray}` }}>
                      <span className="text-xs truncate" style={{ color: COLORS.text.primary }}>{v.vendor?.vendor_name || v.vendor?.vendor_id}</span>
                      <span className="text-xs font-medium flex-shrink-0" style={{ color: COLORS.text.secondary }}>{formatINR(v.spend)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            {categoryDrilldown.contracts.length > 0 && (
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: COLORS.text.tertiary }}>Contracts covering this category ({categoryDrilldown.contracts.length})</p>
                <div className="flex flex-wrap gap-2">
                  {categoryDrilldown.contracts.map((c) => (
                    <span key={c.contract_id} className="px-2.5 py-1 rounded-lg text-[11px]" style={{ backgroundColor: TEAL.tint, color: TEAL.dark }}>
                      {c.contract_id} · {vendorById.get(c.vendor_id)?.vendor_name || c.vendor_id} · {formatINR(c.total_contract_value)}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: COLORS.text.tertiary }}>Purchase order evidence</p>
              <PoEvidenceTable pos={categoryDrilldown.pos} />
            </div>
          </div>
        )}
      </SectionCard>

      {/* 3. Spend Trend — DynamicBarChart renders its own bordered/shadowed
          card with its own title, so it's used directly here rather than
          nested inside a second SectionCard: nesting one card's chrome
          inside another just doubles the border/shadow/padding and squeezes
          the chart smaller than its declared height. */}
      {monthlyTrend.length > 0 ? (
        <DynamicBarChart
          config={{
            data: monthlyTrend,
            xAxisKey: 'month',
            metricKeys: ['onContract', 'offContract'],
            metricLabels: ['On-Contract', 'Off-Contract'],
            height: 300,
            orientation: 'vertical',
            compactAxisLabels: true,
            colorPalette: [TEAL.base, COLORS.borderGray],
          }}
          title="Spend Trend"
          description="Monthly on-contract vs. off-contract spend."
        />
      ) : (
        <SectionCard title="Spend Trend" subtitle="Monthly on-contract vs. off-contract spend.">
          <p className="text-xs py-3" style={{ color: COLORS.text.tertiary }}>No purchase order dates available to chart.</p>
        </SectionCard>
      )}

      {/* 4. Supplier Concentration */}
      <SectionCard title="Supplier Concentration" subtitle="How dependent spend is on a small number of suppliers — click a supplier for evidence.">
        {concentration && (
          <div className="grid grid-cols-3 gap-3 mb-4">
            <StatBlock label="Top Supplier Share" value={formatPct(concentration.topSupplierShare)} />
            <StatBlock label="Top 10 Share" value={formatPct(concentration.top10Share)} />
            <StatBlock label={`HHI — ${concentration.hhiLabel}`} value={Math.round(concentration.hhi).toLocaleString('en-IN')} tone="teal" />
          </div>
        )}
        <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${COLORS.borderGray}` }}>
          <table className="w-full text-sm border-collapse" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col />
              <col style={{ width: '130px' }} />
              <col style={{ width: '90px' }} />
              <col style={{ width: '130px' }} />
            </colgroup>
            <thead>
              <tr style={{ backgroundColor: COLORS.lightBackground }}>
                {['Supplier', 'Spend', 'POs', 'On-Contract'].map((h) => (
                  <th key={h} className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide truncate" style={{ color: COLORS.text.secondary, borderBottom: `1px solid ${TEAL.border}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {vendorSpendStats.slice(0, 20).map((v) => {
                const selected = selectedVendorId === v.vendor_id;
                return (
                  <tr
                    key={v.vendor_id}
                    onClick={() => setSelectedVendorId(selected ? null : v.vendor_id)}
                    className="cursor-pointer transition-colors duration-150"
                    style={{ borderTop: `1px solid ${COLORS.lightGray}`, backgroundColor: selected ? TEAL.tint : 'transparent' }}
                  >
                    <td className="px-3 py-2 font-semibold truncate" style={{ color: COLORS.text.primary }}>{v.vendor?.vendor_name || v.vendor_id}</td>
                    <td className="px-3 py-2 font-medium" style={{ color: COLORS.text.primary }}>{formatINR(v.spend)}</td>
                    <td className="px-3 py-2" style={{ color: COLORS.text.secondary }}>{v.poCount}</td>
                    <td className="px-3 py-2" style={{ color: COLORS.text.secondary }}>{formatPct(v.spend ? v.onContract / v.spend : 0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {selectedVendorDrilldown && (
          <div className="mt-4 pt-4 space-y-3" style={{ borderTop: `1px solid ${COLORS.borderGray}` }}>
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold" style={{ color: TEAL.base }}>
                {selectedVendorDrilldown.vendor?.vendor_name || selectedVendorId} — purchase order & contract evidence
              </p>
              <button onClick={() => setSelectedVendorId(null)} className="text-[11px] font-medium" style={{ color: COLORS.text.tertiary }}>Close</button>
            </div>
            {selectedVendorDrilldown.contracts.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedVendorDrilldown.contracts.map((c) => (
                  <span key={c.contract_id} className="px-2.5 py-1 rounded-lg text-[11px]" style={{ backgroundColor: TEAL.tint, color: TEAL.dark }}>
                    {c.contract_id} · {c.contract_type} · {c.material_group} · {formatINR(c.total_contract_value)}
                  </span>
                ))}
              </div>
            )}
            <PoEvidenceTable pos={selectedVendorDrilldown.pos} />
          </div>
        )}
      </SectionCard>

      {/* 5. Savings & Leakage Opportunities */}
      <SectionCard title="Savings & Leakage Opportunities" subtitle="Click an opportunity to see the exact purchase orders behind it.">
        <div className="grid grid-cols-4 gap-3 mb-4">
          {OPPORTUNITY_META.map((o) => {
            const selected = selectedOpportunity === o.key;
            return (
              <div
                key={o.key}
                onClick={() => setSelectedOpportunity(selected ? null : o.key)}
                className="rounded-lg p-3 cursor-pointer"
                style={{ border: `1px solid ${selected ? TEAL.base : COLORS.borderGray}`, backgroundColor: selected ? TEAL.tint : COLORS.white }}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <Icon icon={o.icon} className="w-4 h-4" style={{ color: TEAL.base }} />
                  <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>{o.title}</p>
                </div>
                <p className="text-lg font-bold mb-1" style={{ color: COLORS.text.primary }}>{o.headline}</p>
                <p className="text-[11px] leading-snug" style={{ color: COLORS.text.tertiary }}>{o.description}</p>
              </div>
            );
          })}
        </div>

        {selectedOpportunity && (
          <div className="pt-4 space-y-3" style={{ borderTop: `1px solid ${COLORS.borderGray}` }}>
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold" style={{ color: TEAL.base }}>
                {OPPORTUNITY_META.find((o) => o.key === selectedOpportunity)?.title} — purchase order evidence
              </p>
              <button onClick={() => setSelectedOpportunity(null)} className="text-[11px] font-medium" style={{ color: COLORS.text.tertiary }}>Close</button>
            </div>
            {selectedOpportunity === 'fragmentation' && (
              <div className="rounded-lg overflow-auto mb-2" style={{ border: `1px solid ${COLORS.borderGray}`, maxHeight: 180 }}>
                <table className="w-full text-sm border-collapse">
                  <thead className="sticky top-0" style={{ backgroundColor: COLORS.lightBackground }}>
                    <tr>
                      {['Material', 'Suppliers', 'Largest Share', 'Total Spend'].map((h) => (
                        <th key={h} className="text-left px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide truncate" style={{ color: COLORS.text.secondary, borderBottom: `1px solid ${TEAL.border}` }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {fragmentedMaterials.slice(0, 50).map((f) => (
                      <tr key={f.materialId} style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                        <td className="px-3 py-1.5 truncate" style={{ color: COLORS.text.primary }}>{f.material?.material_desc || f.materialId}</td>
                        <td className="px-3 py-1.5" style={{ color: COLORS.text.secondary }}>{f.vendorCount}</td>
                        <td className="px-3 py-1.5" style={{ color: COLORS.text.secondary }}>{formatPct(f.maxShare)}</td>
                        <td className="px-3 py-1.5 font-medium" style={{ color: COLORS.text.primary }}>{formatINR(f.totalSpend)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {selectedOpportunity === 'aboveStandard' ? (
              <PoEvidenceTable
                pos={aboveStandardPOs}
                extraColumn={{ label: 'Overspend', render: (po) => formatINR((po as any).overspend) }}
              />
            ) : (
              <PoEvidenceTable pos={opportunityPOs[selectedOpportunity]} />
            )}
          </div>
        )}
      </SectionCard>

    </div>
  );
};

(SpendCategory as SpendCategoryComponent).Metadata = METADATA;

export default SpendCategory;
