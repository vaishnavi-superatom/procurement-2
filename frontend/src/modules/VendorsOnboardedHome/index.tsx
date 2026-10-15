import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, TYPOGRAPHY, SPACING, SHADOWS } from '../../design-system/tokens';
import LoadingState from '../../components/LoadingState';

interface VendorsOnboardedHomeProps {
  SA_RUNTIME?: any;
  /** Starting value for the directory's own Filter by Time control — passed
   * from Home's "This Month" etc. selector so the list opens matching what
   * the card just showed. The user can still change it here independently. */
  initialPeriod?: 'Today' | 'This Week' | 'This Month' | 'This Year';
}

type TimeFilter = 'All Time' | 'Today' | 'This Week' | 'This Month' | 'This Year';
const TIME_FILTER_OPTIONS: TimeFilter[] = ['All Time', 'Today', 'This Week', 'This Month', 'This Year'];

const inTimeFilter = (dateStr: string | null, filter: TimeFilter): boolean => {
  if (filter === 'All Time') return true;
  if (!dateStr) return false;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  if (filter === 'Today') return d.toDateString() === now.toDateString();
  if (filter === 'This Week') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(now.getDate() - now.getDay());
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return d >= start && d < end;
  }
  if (filter === 'This Month') return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  if (filter === 'This Year') return d.getFullYear() === now.getFullYear();
  return true;
};

// Same palette as the rest of this product's procurement screens.
const TEAL = {
  base: '#0F6B64',
  dark: '#0B4F4A',
  tint: '#E6F5F3',
  border: '#D7E8E6',
};

// ============================================================
// Real data shapes (public.vendor_master / supplier_scorecard / contracts /
// contract_items / material_master).
// ============================================================

interface VendorRow {
  vendor_id: string;
  vendor_name: string;
  vendor_type: string;
  category_specialization: string;
  city: string;
  state: string;
  payment_terms: string;
  onboarding_date: string;
  is_active: boolean;
}

interface VendorProfile extends VendorRow {
  annual_spend: number | null;
  otd_pct: number | null;
  otd_trend: string | null;
  quality_acceptance_pct: number | null;
  open_quality_incidents: number | null;
  financial_risk_tier: string | null;
  overall_risk: string | null;
  sanctions_flag: boolean | null;
  ecovadis_score: number | null;
  sustainability_tier: string | null;
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
  material_id: string;
  contract_unit_price: number;
  material_desc: string | null;
  material_group: string | null;
  unit_of_measure: string | null;
}

// ============================================================
// Query helpers — same ToolExecutor path as the other procurement modules.
// ============================================================

const TOOL_ID = 'postgres-0fc80d2496ff_query';
const TOOL_NAME = 'Query PostgreSQL Connection';
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

async function runTool<T = any>(sql: string, params: Record<string, any> | undefined, SA_RUNTIME: any): Promise<T[]> {
  const toolExecutor = (window as any).SA?.ToolExecutor;
  if (!toolExecutor) throw new Error('ToolExecutor not available');
  const res = await toolExecutor.executeTool({
    externalTool: { toolId: TOOL_ID, toolName: TOOL_NAME, parameters: { sql, ...(params ? { params } : {}) } },
    formData: {},
    SA_RUNTIME,
  });
  const payload = res?.data ?? res;
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.records) ? payload.records : [];
  return rows as T[];
}

const formatINR = (n: number | null | undefined): string => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return '₹' + Math.round(n).toLocaleString('en-IN');
};

const formatDate = (d: string | null | undefined): string => {
  if (!d) return '—';
  const date = new Date(d);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const METADATA: ComponentMetadata = {
  id: 'vendors-onboarded-home',
  name: 'VendorsOnboardedHome',
  displayName: 'Vendors Onboarded (Home tab)',
  isDisplayComp: true,
  type: 'VendorsOnboardedHome',
  description: 'Vendor directory, profile, and contracts, embedded on the Home "Vendors Onboarded" card',
  category: 'Dashboard',
  keywords: ['vendors', 'onboarding', 'suppliers', 'contracts', 'esg', 'risk', 'procurement'],
  props: {},
};

interface VendorsOnboardedHomeComponent extends React.FC<VendorsOnboardedHomeProps> {
  Metadata: ComponentMetadata;
}

// Back-navigable view stack: directory → profile → contracts (active/past) → one contract's detail.
type View =
  | { kind: 'directory' }
  | { kind: 'profile'; vendorId: string }
  | { kind: 'contracts'; vendorId: string; filter: 'active' | 'past' }
  | { kind: 'contractDetail'; vendorId: string; filter: 'active' | 'past'; contractId: string };

const RiskBadge: React.FC<{ tier: string | null }> = ({ tier }) => {
  if (!tier) return <span style={{ color: COLORS.text.tertiary }}>—</span>;
  const high = tier === 'High';
  const med = tier === 'Medium';
  return (
    <span
      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold"
      style={{
        backgroundColor: high ? '#F1F5F9' : med ? '#FFEDD5' : '#DCFCE7',
        color: high ? '#475569' : med ? '#EA580C' : '#16A34A',
      }}
    >
      {tier}
    </span>
  );
};

const ToolbarDropdown: React.FC<{ label: string; icon: string; value: string; options: string[]; onChange: (v: string) => void }> = ({
  label,
  icon,
  value,
  options,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium"
        style={{ border: `1px solid ${COLORS.borderGray}`, color: COLORS.text.primary, backgroundColor: COLORS.white }}
      >
        <Icon icon={icon} className="w-4 h-4" style={{ color: COLORS.text.secondary }} />
        <span style={{ color: COLORS.text.secondary }}>{label}:</span>
        <span className="font-semibold">{value}</span>
        <Icon icon="mdi:chevron-down" className="w-3.5 h-3.5" style={{ color: COLORS.text.secondary }} />
      </button>
      {open && (
        <div
          className="absolute left-0 mt-1 w-40 rounded-lg overflow-hidden z-20"
          style={{ backgroundColor: COLORS.white, boxShadow: SHADOWS.dropdown, border: `1px solid ${COLORS.borderGray}` }}
        >
          {options.map((opt) => (
            <button
              key={opt}
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-xs"
              style={{
                color: opt === value ? TEAL.base : COLORS.text.primary,
                fontWeight: opt === value ? TYPOGRAPHY.fontWeight.semibold : TYPOGRAPHY.fontWeight.regular,
                backgroundColor: opt === value ? TEAL.tint : 'transparent',
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const VendorsOnboardedHome: React.FC<VendorsOnboardedHomeProps> = ({ SA_RUNTIME, initialPeriod }) => {
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>(initialPeriod || 'All Time');
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const [view, setView] = useState<View>({ kind: 'directory' });

  const [profile, setProfile] = useState<VendorProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [contracts, setContracts] = useState<ContractRow[]>([]);
  const [contractsLoading, setContractsLoading] = useState(false);
  const [contractsError, setContractsError] = useState<string | null>(null);

  const [contractItems, setContractItems] = useState<ContractItemRow[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState<string | null>(null);

  // 1. Vendor directory
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setListLoading(true);
      setListError(null);
      try {
        const data = await runTool<VendorRow>(
          `SELECT vendor_id, vendor_name, vendor_type, category_specialization, city, state, payment_terms, onboarding_date, is_active
           FROM vendor_master ORDER BY onboarding_date DESC LIMIT 5000;`,
          undefined,
          SA_RUNTIME
        );
        if (!cancelled) setVendors(data);
      } catch (err) {
        if (!cancelled) setListError(err instanceof Error ? err.message : 'Failed to load vendors');
      } finally {
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [SA_RUNTIME]);

  const filteredVendors = useMemo(() => {
    const q = search.trim().toLowerCase();
    return vendors.filter((v) => {
      if (!inTimeFilter(v.onboarding_date, timeFilter)) return false;
      if (!q) return true;
      return (
        v.vendor_name.toLowerCase().includes(q) ||
        (v.category_specialization || '').toLowerCase().includes(q) ||
        (v.city || '').toLowerCase().includes(q) ||
        (v.state || '').toLowerCase().includes(q)
      );
    });
  }, [vendors, search, timeFilter]);

  const latestOnboarding = useMemo(() => {
    if (vendors.length === 0) return null;
    return vendors.reduce((max, v) => (v.onboarding_date > max ? v.onboarding_date : max), vendors[0].onboarding_date);
  }, [vendors]);

  // 3. Vendor profile (fetched on open)
  useEffect(() => {
    if (view.kind !== 'profile' && view.kind !== 'contracts' && view.kind !== 'contractDetail') return;
    const vendorId = view.vendorId;
    if (!SAFE_ID.test(vendorId)) return;
    let cancelled = false;
    (async () => {
      setProfileLoading(true);
      setProfileError(null);
      try {
        const rows = await runTool<VendorProfile>(
          `
          SELECT v.vendor_id, v.vendor_name, v.vendor_type, v.category_specialization, v.city, v.state,
                 v.payment_terms, v.onboarding_date, v.is_active,
                 sc.annual_spend, sc.otd_pct, sc.otd_trend, sc.quality_acceptance_pct, sc.open_quality_incidents,
                 sc.financial_risk_tier, sc.overall_risk, sc.sanctions_flag, sc.ecovadis_score, sc.sustainability_tier
          FROM vendor_master v
          LEFT JOIN supplier_scorecard sc ON sc.vendor_id = v.vendor_id
          WHERE v.vendor_id = @vendorId
          LIMIT 1;
          `,
          { vendorId },
          SA_RUNTIME
        );
        if (cancelled) return;
        if (rows.length === 0) throw new Error(`No vendor found for ${vendorId}`);
        setProfile(rows[0]);
      } catch (err) {
        if (!cancelled) setProfileError(err instanceof Error ? err.message : 'Failed to load this vendor');
      } finally {
        if (!cancelled) setProfileLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, SA_RUNTIME]);

  // 4. Contracts for the vendor (fetched once per vendor; active/past split client-side by date)
  useEffect(() => {
    if (view.kind !== 'profile' && view.kind !== 'contracts' && view.kind !== 'contractDetail') return;
    const vendorId = view.vendorId;
    if (!SAFE_ID.test(vendorId)) return;
    let cancelled = false;
    (async () => {
      setContractsLoading(true);
      setContractsError(null);
      try {
        const rows = await runTool<ContractRow>(
          `
          SELECT contract_id, vendor_id, contract_type, material_group, start_date, end_date,
                 total_contract_value, price_escalation_clause, escalation_index
          FROM contracts
          WHERE vendor_id = @vendorId
          ORDER BY start_date DESC;
          `,
          { vendorId },
          SA_RUNTIME
        );
        if (!cancelled) setContracts(rows);
      } catch (err) {
        if (!cancelled) setContractsError(err instanceof Error ? err.message : 'Failed to load contracts');
      } finally {
        if (!cancelled) setContractsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, SA_RUNTIME]);

  const now = useMemo(() => new Date(), []);
  const activeContracts = useMemo(() => contracts.filter((c) => new Date(c.end_date) >= now), [contracts, now]);
  const pastContracts = useMemo(() => contracts.filter((c) => new Date(c.end_date) < now), [contracts, now]);

  // 5. Contract detail — line items for the selected contract
  useEffect(() => {
    if (view.kind !== 'contractDetail') return;
    const contractId = view.contractId;
    if (!SAFE_ID.test(contractId)) return;
    let cancelled = false;
    (async () => {
      setItemsLoading(true);
      setItemsError(null);
      try {
        const rows = await runTool<ContractItemRow>(
          `
          SELECT ci.contract_id, ci.material_id, ci.contract_unit_price, m.material_desc, m.material_group, m.unit_of_measure
          FROM contract_items ci
          LEFT JOIN material_master m ON m.material_id = ci.material_id
          WHERE ci.contract_id = @contractId
          ORDER BY m.material_desc ASC;
          `,
          { contractId },
          SA_RUNTIME
        );
        if (!cancelled) setContractItems(rows);
      } catch (err) {
        if (!cancelled) setItemsError(err instanceof Error ? err.message : 'Failed to load contract items');
      } finally {
        if (!cancelled) setItemsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, SA_RUNTIME]);

  const goBack = () => {
    if (view.kind === 'contractDetail') setView({ kind: 'contracts', vendorId: view.vendorId, filter: view.filter });
    else if (view.kind === 'contracts') setView({ kind: 'profile', vendorId: view.vendorId });
    else if (view.kind === 'profile') setView({ kind: 'directory' });
  };

  // ============================================================
  // Directory
  // ============================================================
  if (view.kind === 'directory') {
    if (listLoading) {
      return <LoadingState height={520} message="Loading vendors…" variant="skeleton" size="lg" />;
    }
    if (listError) {
      return (
        <div className="bg-white rounded-xl shadow-sm border border-[#F1F5F9] p-6">
          <div className="flex items-center gap-3">
            <Icon icon="mdi:alert-circle" className="w-5 h-5 text-[#475569] flex-shrink-0" />
            <p className="text-sm" style={{ color: '#475569' }}>{listError}</p>
          </div>
        </div>
      );
    }
    return (
      <div className="w-full flex flex-col" style={{ fontFamily: TYPOGRAPHY.fontFamily.primary, paddingTop: SPACING.xl, height: 'calc(100vh - 160px)', minHeight: 480 }}>
        <div className="flex items-center justify-between flex-wrap gap-3 mb-4 flex-shrink-0">
          <div>
            <h1 className="text-xl font-bold" style={{ color: COLORS.text.primary }}>Vendors Onboarded</h1>
            <p className="text-xs mt-0.5" style={{ color: COLORS.text.secondary }}>
              {filteredVendors.length.toLocaleString('en-IN')} of {vendors.length.toLocaleString('en-IN')} vendors
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ border: `1px solid ${COLORS.borderGray}`, backgroundColor: COLORS.white }}>
              <Icon icon="mdi:magnify" className="w-4 h-4" style={{ color: COLORS.text.tertiary }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search vendor, specialization, location…"
                className="text-xs w-56"
                style={{ color: COLORS.text.primary, border: 'none', outline: 'none', boxShadow: 'none', background: 'transparent' }}
              />
            </div>
            <ToolbarDropdown
              label="Onboarded"
              icon="mdi:calendar-range-outline"
              value={timeFilter}
              options={TIME_FILTER_OPTIONS}
              onChange={(v) => setTimeFilter(v as TimeFilter)}
            />
          </div>
        </div>

        <div className="flex-1 min-h-0 rounded-xl overflow-auto" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
          <table className="w-full text-sm border-collapse" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col />
              <col style={{ width: '110px' }} />
              <col style={{ width: '150px' }} />
              <col style={{ width: '150px' }} />
              <col style={{ width: '110px' }} />
              <col style={{ width: '90px' }} />
            </colgroup>
            <thead className="sticky top-0 z-10" style={{ backgroundColor: COLORS.lightBackground }}>
              <tr>
                {['Vendor', 'Type', 'Specialization', 'Location', 'Onboarded', 'Status'].map((h) => (
                  <th key={h} className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide leading-tight" style={{ color: COLORS.text.secondary, borderBottom: `1px solid ${TEAL.border}` }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredVendors.map((v) => (
                <tr
                  key={v.vendor_id}
                  onMouseEnter={() => setHoveredId(v.vendor_id)}
                  onMouseLeave={() => setHoveredId((id) => (id === v.vendor_id ? null : id))}
                  onClick={() => setView({ kind: 'profile', vendorId: v.vendor_id })}
                  className="cursor-pointer transition-colors duration-150"
                  style={{ borderBottom: `1px solid ${COLORS.lightGray}`, backgroundColor: hoveredId === v.vendor_id ? TEAL.tint : 'transparent' }}
                >
                  <td className="px-3 py-1.5 font-semibold truncate" style={{ color: COLORS.text.primary }}>{v.vendor_name}</td>
                  <td className="px-3 py-1.5 truncate" style={{ color: COLORS.text.secondary }}>{v.vendor_type}</td>
                  <td className="px-3 py-1.5 truncate" style={{ color: COLORS.text.secondary }}>{v.category_specialization}</td>
                  <td className="px-3 py-1.5 truncate" style={{ color: COLORS.text.secondary }}>{[v.city, v.state].filter(Boolean).join(', ')}</td>
                  <td className="px-3 py-1.5 truncate" style={{ color: COLORS.text.secondary }}>{formatDate(v.onboarding_date)}</td>
                  <td className="px-3 py-1.5">
                    <span
                      className="px-2 py-0.5 rounded-full text-[11px] font-semibold"
                      style={{ backgroundColor: v.is_active ? '#DCFCE7' : COLORS.lightGray, color: v.is_active ? '#16A34A' : COLORS.text.secondary }}
                    >
                      {v.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                </tr>
              ))}
              {filteredVendors.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-12 text-center text-sm" style={{ color: COLORS.text.tertiary }}>
                    {vendors.length > 0 && timeFilter !== 'All Time' && !search ? (
                      <div className="flex flex-col items-center gap-2">
                        <p>
                          No vendors were onboarded in <span className="font-medium">{timeFilter}</span>.
                          {latestOnboarding && <> The most recently onboarded vendor is from {formatDate(latestOnboarding)}.</>}
                        </p>
                        <button
                          onClick={() => setTimeFilter('All Time')}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold"
                          style={{ backgroundColor: TEAL.tint, color: TEAL.base }}
                        >
                          View All Time
                        </button>
                      </div>
                    ) : (
                      'No vendors match this search.'
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  // ============================================================
  // Profile / Contracts / Contract detail share the back-nav header
  // ============================================================
  const backLabel =
    view.kind === 'profile' ? 'Back to Vendor Directory' : view.kind === 'contracts' ? 'Back to Vendor Profile' : 'Back to Contracts';

  if (profileLoading && !profile) {
    return <LoadingState height={520} message="Loading vendor profile…" variant="skeleton" size="lg" />;
  }
  if (profileError || !profile) {
    return (
      <div className="w-full">
        <button onClick={goBack} className="flex items-center gap-1.5 text-xs font-medium mb-4" style={{ color: TEAL.base }}>
          <Icon icon="mdi:arrow-left" className="w-4 h-4" /> {backLabel}
        </button>
        <div className="bg-white rounded-xl shadow-sm border border-[#F1F5F9] p-6">
          <div className="flex items-center gap-3">
            <Icon icon="mdi:alert-circle" className="w-5 h-5 text-[#475569] flex-shrink-0" />
            <p className="text-sm" style={{ color: '#475569' }}>{profileError || 'Vendor not found.'}</p>
          </div>
        </div>
      </div>
    );
  }

  // ============================================================
  // 3. Vendor profile
  // ============================================================
  if (view.kind === 'profile') {
    return (
      <div className="w-full" style={{ fontFamily: TYPOGRAPHY.fontFamily.primary, paddingTop: SPACING.xl }}>
        <button onClick={goBack} className="flex items-center gap-1.5 text-xs font-medium mb-3" style={{ color: TEAL.base }}>
          <Icon icon="mdi:arrow-left" className="w-4 h-4" /> {backLabel}
        </button>
        <div className="flex items-center gap-3 mb-4">
          <h1 className="text-xl font-bold" style={{ color: COLORS.text.primary }}>{profile.vendor_name}</h1>
          <span
            className="px-2 py-0.5 rounded-full text-[11px] font-semibold"
            style={{ backgroundColor: profile.is_active ? '#DCFCE7' : COLORS.lightGray, color: profile.is_active ? '#16A34A' : COLORS.text.secondary }}
          >
            {profile.is_active ? 'Active' : 'Inactive'}
          </span>
        </div>

        {/* Available profile data: location, actual spend, OTD, quality, risk, ESG */}
        <div
          className="rounded-lg px-4 py-2.5 mb-4 flex flex-wrap items-center gap-x-5 gap-y-1.5"
          style={{ backgroundColor: '#F0FDF4', border: '1px solid #BBF7D0' }}
        >
          {[
            ['Location', [profile.city, profile.state].filter(Boolean).join(', ') || '—'],
            ['Type', profile.vendor_type],
            ['Specialization', profile.category_specialization],
            ['Payment Terms', profile.payment_terms],
            ['Onboarded', formatDate(profile.onboarding_date)],
            ['Actual Spend', profile.annual_spend != null ? formatINR(profile.annual_spend) : 'Not available'],
          ].map(([label, value]) => (
            <div key={label} className="flex items-baseline gap-1.5">
              <span className="text-[10px] uppercase tracking-wide" style={{ color: '#15803D' }}>{label}</span>
              <span className="text-xs font-semibold" style={{ color: '#14532D' }}>{value}</span>
            </div>
          ))}
        </div>

        {/* Performance: OTD, quality, risk, ESG */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          {[
            {
              label: 'On-Time Delivery',
              value: profile.otd_pct != null ? `${profile.otd_pct}%` : 'Not available',
              sub: profile.otd_trend || undefined,
              icon: 'mdi:truck-fast-outline',
            },
            {
              label: 'Quality Acceptance',
              value: profile.quality_acceptance_pct != null ? `${profile.quality_acceptance_pct}%` : 'Not available',
              sub: profile.open_quality_incidents != null ? `${profile.open_quality_incidents} open incidents` : undefined,
              icon: 'mdi:check-decagram-outline',
            },
            {
              label: 'Risk',
              value: profile.overall_risk || 'Not available',
              sub: profile.sanctions_flag ? 'Sanctions flag present' : profile.financial_risk_tier ? `Financial: ${profile.financial_risk_tier}` : undefined,
              icon: 'mdi:alert-octagon-outline',
            },
            {
              label: 'ESG',
              value: profile.ecovadis_score != null ? `${profile.ecovadis_score} EcoVadis` : 'Not available',
              sub: profile.sustainability_tier || undefined,
              icon: 'mdi:leaf',
            },
          ].map((m) => (
            <div key={m.label} className="rounded-lg p-3" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
              <div className="flex items-center gap-1.5 mb-1">
                <Icon icon={m.icon} className="w-3.5 h-3.5" style={{ color: TEAL.base }} />
                <span className="text-[10px] uppercase tracking-wide" style={{ color: COLORS.text.tertiary }}>{m.label}</span>
              </div>
              <p className="text-sm font-bold" style={{ color: m.value === 'Not available' ? COLORS.text.tertiary : COLORS.text.primary }}>{m.value}</p>
              {m.sub && <p className="text-[11px] mt-0.5" style={{ color: COLORS.text.secondary }}>{m.sub}</p>}
            </div>
          ))}
        </div>

        {/* 4. Clickable Active / Past Contracts cards */}
        <div className="grid grid-cols-2 gap-3 max-w-md">
          {[
            { key: 'active' as const, label: 'Active Contracts', count: activeContracts.length, icon: 'mdi:file-check-outline' },
            { key: 'past' as const, label: 'Past Contracts', count: pastContracts.length, icon: 'mdi:file-clock-outline' },
          ].map((c) => (
            <div
              key={c.key}
              onClick={() => !contractsLoading && setView({ kind: 'contracts', vendorId: profile.vendor_id, filter: c.key })}
              className="rounded-lg p-3"
              style={{
                border: `1px solid ${TEAL.border}`,
                backgroundColor: COLORS.white,
                boxShadow: SHADOWS.card,
                cursor: contractsLoading ? 'default' : 'pointer',
              }}
            >
              <div className="flex items-start justify-between mb-2">
                <div className="w-7 h-7 rounded-md flex items-center justify-center" style={{ backgroundColor: TEAL.tint }}>
                  <Icon icon={c.icon} className="w-4 h-4" style={{ color: TEAL.base }} />
                </div>
                <Icon icon="mdi:chevron-right" className="w-3.5 h-3.5" style={{ color: COLORS.text.tertiary }} />
              </div>
              <p className="text-xs mb-0.5" style={{ color: COLORS.text.secondary }}>{c.label}</p>
              <p className="text-2xl font-bold" style={{ color: COLORS.text.primary }}>
                {contractsLoading ? '…' : c.count}
              </p>
            </div>
          ))}
        </div>
        {contractsError && <p className="text-xs mt-2" style={{ color: '#475569' }}>{contractsError}</p>}
      </div>
    );
  }

  // ============================================================
  // 4. Filtered contract table (Active or Past)
  // ============================================================
  if (view.kind === 'contracts') {
    const list = view.filter === 'active' ? activeContracts : pastContracts;
    return (
      <div className="w-full" style={{ fontFamily: TYPOGRAPHY.fontFamily.primary, paddingTop: SPACING.xl }}>
        <button onClick={goBack} className="flex items-center gap-1.5 text-xs font-medium mb-3" style={{ color: TEAL.base }}>
          <Icon icon="mdi:arrow-left" className="w-4 h-4" /> {backLabel}
        </button>
        <h1 className="text-xl font-bold mb-3" style={{ color: COLORS.text.primary }}>
          {profile.vendor_name} — {view.filter === 'active' ? 'Active' : 'Past'} Contracts
        </h1>
        {contractsLoading ? (
          <LoadingState height={360} message="Loading contracts…" variant="skeleton" size="md" />
        ) : list.length === 0 ? (
          <div className="rounded-xl p-6 text-center text-sm" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, color: COLORS.text.tertiary }}>
            No {view.filter} contracts recorded for this vendor.
          </div>
        ) : (
          <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ backgroundColor: COLORS.lightBackground }}>
                  {['Contract ID', 'Type', 'Material Group', 'Start', 'End', 'Value'].map((h) => (
                    <th key={h} className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr
                    key={c.contract_id}
                    onClick={() => setView({ kind: 'contractDetail', vendorId: profile.vendor_id, filter: view.filter, contractId: c.contract_id })}
                    className="cursor-pointer transition-colors duration-150"
                    style={{ borderTop: `1px solid ${COLORS.lightGray}` }}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = TEAL.tint)}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
                  >
                    <td className="px-3 py-1.5 font-semibold" style={{ color: COLORS.text.primary }}>{c.contract_id}</td>
                    <td className="px-3 py-1.5" style={{ color: COLORS.text.secondary }}>{c.contract_type}</td>
                    <td className="px-3 py-1.5" style={{ color: COLORS.text.secondary }}>{c.material_group}</td>
                    <td className="px-3 py-1.5" style={{ color: COLORS.text.secondary }}>{formatDate(c.start_date)}</td>
                    <td className="px-3 py-1.5" style={{ color: COLORS.text.secondary }}>{formatDate(c.end_date)}</td>
                    <td className="px-3 py-1.5 font-medium" style={{ color: COLORS.text.primary }}>{formatINR(c.total_contract_value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  // ============================================================
  // 5. Contract detail
  // ============================================================
  const contract = contracts.find((c) => c.contract_id === view.contractId) || null;
  return (
    <div className="w-full" style={{ fontFamily: TYPOGRAPHY.fontFamily.primary, paddingTop: SPACING.xl }}>
      <button onClick={goBack} className="flex items-center gap-1.5 text-xs font-medium mb-3" style={{ color: TEAL.base }}>
        <Icon icon="mdi:arrow-left" className="w-4 h-4" /> {backLabel}
      </button>
      <h1 className="text-xl font-bold mb-3" style={{ color: COLORS.text.primary }}>
        Contract {view.contractId}
      </h1>

      {contract && (
        <div
          className="rounded-lg px-4 py-2.5 mb-4 flex flex-wrap items-center gap-x-5 gap-y-1.5"
          style={{ backgroundColor: '#F0FDF4', border: '1px solid #BBF7D0' }}
        >
          {[
            ['Vendor', profile.vendor_name],
            ['Type', contract.contract_type],
            ['Material Group', contract.material_group],
            ['Start', formatDate(contract.start_date)],
            ['End', formatDate(contract.end_date)],
            ['Total Value', formatINR(contract.total_contract_value)],
            ['Price Escalation', contract.price_escalation_clause ? `Yes (${contract.escalation_index || 'index not specified'})` : 'No'],
          ].map(([label, value]) => (
            <div key={label} className="flex items-baseline gap-1.5">
              <span className="text-[10px] uppercase tracking-wide" style={{ color: '#15803D' }}>{label}</span>
              <span className="text-xs font-semibold" style={{ color: '#14532D' }}>{value}</span>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
        <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
          <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>Contracted Materials</h2>
        </div>
        {itemsLoading ? (
          <LoadingState height={200} message="Loading contract items…" variant="skeleton" size="sm" />
        ) : itemsError ? (
          <p className="px-4 py-4 text-xs" style={{ color: '#475569' }}>{itemsError}</p>
        ) : contractItems.length === 0 ? (
          <p className="px-4 py-4 text-xs" style={{ color: COLORS.text.tertiary }}>No line items recorded for this contract.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: COLORS.lightBackground }}>
                {['Material', 'Group', 'Contract Unit Price'].map((h) => (
                  <th key={h} className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: COLORS.text.secondary }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {contractItems.map((item) => (
                <tr key={item.material_id} style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                  <td className="px-3 py-1.5" style={{ color: COLORS.text.primary }}>
                    {item.material_desc || item.material_id}
                    <span className="ml-1.5 text-[11px]" style={{ color: COLORS.text.tertiary }}>{item.material_id}</span>
                  </td>
                  <td className="px-3 py-1.5" style={{ color: COLORS.text.secondary }}>{item.material_group}</td>
                  <td className="px-3 py-1.5 font-medium" style={{ color: COLORS.text.primary }}>
                    {formatINR(item.contract_unit_price)} / {item.unit_of_measure}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

(VendorsOnboardedHome as VendorsOnboardedHomeComponent).Metadata = METADATA;

export default VendorsOnboardedHome;
