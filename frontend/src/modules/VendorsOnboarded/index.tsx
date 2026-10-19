import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, TYPOGRAPHY, SPACING, SHADOWS } from '../../design-system/tokens';
import LoadingState from '../../components/LoadingState';
import VendorsOnboardedHome from '../VendorsOnboardedHome';

interface VendorsOnboardedProps {
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
// Real data shape — the full vendor directory (public.vendor_master), the
// live "PostgreSQL Connection" source registered for this project.
// ============================================================

interface VendorRow {
  vendor_id: string;
  vendor_name: string;
  vendor_type: string;
  category_specialization: string;
  city: string;
  state: string;
  onboarding_date: string;
  is_active: boolean;
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

const VENDOR_QUERY = `
SELECT vendor_id, vendor_name, vendor_type, category_specialization, city, state, onboarding_date, is_active
FROM vendor_master
ORDER BY onboarding_date DESC
LIMIT 5000;
`;

const formatDate = (d: string | null | undefined): string => {
  if (!d) return '—';
  const date = new Date(d);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

// ============================================================
// Small shared bits
// ============================================================

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

const METADATA: ComponentMetadata = {
  id: 'vendors-onboarded-dashboard',
  name: 'VendorsOnboarded',
  displayName: 'Show vendors',
  isDisplayComp: true,
  type: 'VendorsOnboarded',
  description: 'Full vendor directory with search and time filter; each vendor opens a profile page with picture, rating, contracts and supply history',
  category: 'Dashboard',
  keywords: ['vendors', 'onboarding', 'suppliers', 'directory', 'vendor profile', 'contracts', 'procurement'],
  // "Vendors", not "Vendors Onboarded" (walkthrough, 16 Oct): a list of vendors, not of contracts.
  dashboard: { label: 'Vendors', icon: 'mdi:storefront-outline', order: 5 },
  props: {},
};

interface VendorsOnboardedComponent extends React.FC<VendorsOnboardedProps> {
  Metadata: ComponentMetadata;
}

const VendorsOnboarded: React.FC<VendorsOnboardedProps> = ({ SA_RUNTIME }) => {
  const [rows, setRows] = useState<VendorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('All Time');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // Opens the existing vendor profile/contracts view (VendorsOnboardedHome,
  // in its profile mode) for the clicked row's exact vendor_id — reused as
  // is, never a second/duplicate profile view.
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await runTool<VendorRow>(VENDOR_QUERY, SA_RUNTIME, 5000);
        if (!cancelled) setRows(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load vendors');
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
    return rows.filter((v) => {
      if (!inTimeFilter(v.onboarding_date, timeFilter)) return false;
      if (!q) return true;
      return (
        v.vendor_name.toLowerCase().includes(q) ||
        (v.category_specialization || '').toLowerCase().includes(q) ||
        (v.vendor_type || '').toLowerCase().includes(q) ||
        (v.city || '').toLowerCase().includes(q) ||
        (v.state || '').toLowerCase().includes(q)
      );
    });
  }, [rows, search, timeFilter]);

  const latestOnboarding = useMemo(() => {
    if (rows.length === 0) return null;
    return rows.reduce((max, v) => (v.onboarding_date > max ? v.onboarding_date : max), rows[0].onboarding_date);
  }, [rows]);

  if (loading) {
    return <LoadingState height={520} message="Loading vendors…" variant="skeleton" size="lg" />;
  }

  if (error) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-[#F1F5F9] p-6">
        <div className="flex items-center gap-3">
          <Icon icon="mdi:alert-circle" className="w-5 h-5 text-[#475569] flex-shrink-0" />
          <div>
            <p className="text-sm font-medium text-[#475569]">Couldn't load vendors</p>
            <p className="text-xs mt-1" style={{ color: COLORS.text.secondary }}>{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (selectedVendorId) {
    return (
      <div style={{ fontFamily: TYPOGRAPHY.fontFamily.primary }}>
        <VendorsOnboardedHome SA_RUNTIME={SA_RUNTIME} initialVendorId={selectedVendorId} onExitProfile={() => setSelectedVendorId(null)} />
      </div>
    );
  }

  return (
    <div
      className="w-full flex flex-col mx-auto"
      style={{ fontFamily: TYPOGRAPHY.fontFamily.primary, paddingTop: SPACING.xl, height: 'calc(100vh - 120px)', minHeight: 480, width: '82%', minWidth: 760 }}
    >
      {/* Toolbar — fixed, never scrolls. Search and time filter sit side by side. */}
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4 flex-shrink-0">
        <div>
          <h1 className="text-xl font-bold" style={{ color: COLORS.text.primary }}>Vendors</h1>
          <p className="text-xs mt-0.5" style={{ color: COLORS.text.secondary }}>
            {filtered.length.toLocaleString('en-IN')} of {rows.length.toLocaleString('en-IN')} vendors
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ border: `1px solid ${COLORS.borderGray}`, backgroundColor: COLORS.white }}>
            <Icon icon="mdi:magnify" className="w-4 h-4" style={{ color: COLORS.text.tertiary }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search vendor, type, specialization, location…"
              className="text-xs w-64"
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

      {/* Table — the only internally-scrolling region */}
      <div className="flex-1 min-h-0 rounded-xl overflow-auto" style={{ border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card }}>
        <table className="w-full text-sm border-collapse" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            <col />
            <col style={{ width: '120px' }} />
            <col style={{ width: '160px' }} />
            <col style={{ width: '160px' }} />
            <col style={{ width: '120px' }} />
            <col style={{ width: '90px' }} />
          </colgroup>
          <thead className="sticky top-0 z-10" style={{ backgroundColor: COLORS.lightBackground }}>
            <tr>
              {['Vendor', 'Type', 'Specialization', 'Location', 'Onboarded', 'Status'].map((h) => (
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
            {filtered.map((v) => (
              <tr
                key={v.vendor_id}
                onClick={() => setSelectedVendorId(v.vendor_id)}
                onMouseEnter={() => setHoveredId(v.vendor_id)}
                onMouseLeave={() => setHoveredId((id) => (id === v.vendor_id ? null : id))}
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
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-12 text-center text-sm" style={{ color: COLORS.text.tertiary }}>
                  {rows.length > 0 && timeFilter !== 'All Time' && !search ? (
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
};

(VendorsOnboarded as VendorsOnboardedComponent).Metadata = METADATA;

export default VendorsOnboarded;
