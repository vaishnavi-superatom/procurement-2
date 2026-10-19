import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, TYPOGRAPHY, SPACING, SHADOWS } from '../../design-system/tokens';
import LoadingState from '../../components/LoadingState';
import { VendorProfile } from './VendorProfile';

interface VendorsOnboardedHomeProps {
  SA_RUNTIME?: any;
  /** Starting value for the directory's own Filter by Time control — passed
   * from Home's "This Month" etc. selector so the list opens matching what
   * the card just showed. The user can still change it here independently. */
  initialPeriod?: 'Today' | 'This Week' | 'This Month' | 'This Year';
  /** Opens straight to this vendor's profile instead of the directory — used
   * by the standalone Vendors sidebar page, which has its own directory table
   * and only wants this component for the profile view a row's click hands
   * off to. */
  initialVendorId?: string | null;
  /** Called instead of returning to this component's own directory when the
   * buyer backs out of the profile — lets a caller with its own directory
   * (e.g. the sidebar page above) return to that directory instead. Only used
   * together with initialVendorId. */
  onExitProfile?: () => void;
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
  base: '#3A59CD',
  dark: '#2E47A4',
  tint: '#EBEEFA',
  border: '#D8DEF5',
};

// ============================================================
// Real data shape (public.vendor_master); the profile page loads the rest.
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

// ============================================================
// Query helpers — same ToolExecutor path as the other procurement modules.
// ============================================================

//local-tool id
//const TOOL_ID = 'postgres-6a0f22831b3f_query';
//prod-tool id
const TOOL_ID = 'postgres-0fc80d2496ff_query';
const TOOL_NAME = 'Query PostgreSQL Connection';

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

const formatDate = (d: string | null | undefined): string => {
  if (!d) return '—';
  const date = new Date(d);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const METADATA: ComponentMetadata = {
  id: 'vendors-onboarded-home',
  name: 'VendorsOnboardedHome',
  displayName: 'Vendors (Home tab)',
  isDisplayComp: true,
  type: 'VendorsOnboardedHome',
  description: 'Vendor directory and a profile page for each vendor (picture, rating, contracts, supply history), embedded on the Home "Vendors" card',
  category: 'Dashboard',
  keywords: ['vendors', 'onboarding', 'suppliers', 'contracts', 'esg', 'risk', 'procurement'],
  props: {},
};

interface VendorsOnboardedHomeComponent extends React.FC<VendorsOnboardedHomeProps> {
  Metadata: ComponentMetadata;
}

// The directory, or one vendor's profile page (the directory keeps its search and filter when you come back).
type View = { kind: 'directory' } | { kind: 'profile'; vendorId: string };

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

const VendorsOnboardedHome: React.FC<VendorsOnboardedHomeProps> = ({ SA_RUNTIME, initialPeriod, initialVendorId, onExitProfile }) => {
  const [vendors, setVendors] = useState<VendorRow[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>(initialPeriod || 'All Time');
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Keeps this directory's own Filter by Time control in sync with Home's
  // "Procurement at a Glance" period whenever it changes — this block stays
  // mounted while the period dropdown changes, so without this the table
  // would keep showing whatever period it was first opened with. The buyer
  // can still change it afterward.
  useEffect(() => {
    if (initialPeriod) setTimeFilter(initialPeriod);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPeriod]);

  const [view, setView] = useState<View>(initialVendorId ? { kind: 'profile', vendorId: initialVendorId } : { kind: 'directory' });

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
            <h1 className="text-xl font-bold" style={{ color: COLORS.text.primary }}>Vendors</h1>
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
  // Vendor profile: its own page (picture, rating, contracts, supply history)
  // ============================================================
  return (
    <VendorProfile
      vendorId={view.vendorId}
      SA_RUNTIME={SA_RUNTIME}
      onBack={onExitProfile ?? (() => setView({ kind: 'directory' }))}
      backLabel="Back to Vendors"
    />
  );
};

(VendorsOnboardedHome as VendorsOnboardedHomeComponent).Metadata = METADATA;

export default VendorsOnboardedHome;
