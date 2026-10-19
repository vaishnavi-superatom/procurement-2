import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import { COLORS, TYPOGRAPHY, SPACING, SHADOWS } from '../../design-system/tokens';
import LoadingState from '../../components/LoadingState';
import { getVendorPhoto, removeVendorPhoto, setVendorPhoto, toProfilePhoto } from '../../data/vendor-profiles';
import { ContractDocument, type ContractItem, type ContractRecord } from './ContractDocument';

const TEAL = {
  base: '#3A59CD',
  dark: '#2E47A4',
  tint: '#EBEEFA',
  border: '#D8DEF5',
};

// ============================================================
// Data (vendor_master, supplier_scorecard, contracts, contract_items,
// purchase_orders, vendor_profile_photos)
// ============================================================

interface ProfileRow {
  vendor_id: string;
  vendor_name: string;
  vendor_type: string | null;
  category_specialization: string | null;
  city: string | null;
  state: string | null;
  payment_terms: string | null;
  onboarding_date: string | null;
  is_active: boolean;
  otd_pct: number | null;
  otd_trend: string | null;
  quality_acceptance_pct: number | null;
  open_quality_incidents: number | null;
  financial_risk_tier: string | null;
  overall_risk: string | null;
  sanctions_flag: boolean | null;
  ecovadis_score: number | string | null;
  sustainability_tier: string | null;
}

interface SupplySummary {
  orders: number;
  total_value: number | null;
  first_order: string | null;
  last_order: string | null;
  open_orders: number;
}

interface SupplyRow {
  po_id: string;
  po_line_item: number;
  po_date: string;
  material_id: string;
  material_desc: string | null;
  unit_of_measure: string | null;
  ordered_qty: number;
  unit_price: number;
  total_value: number;
  delivery_date: string | null;
  actual_delivery_date: string | null;
  po_status: string | null;
  payment_status: string | null;
  /** actual − promised delivery date, in days (negative = early) */
  days_late: number | null;
}

//local-tool id
//const TOOL_ID = 'postgres-6a0f22831b3f_query';
//prod-tool id
const TOOL_ID = 'postgres-0fc80d2496ff_query';
const TOOL_NAME = 'Query PostgreSQL Connection';
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
const SUPPLY_LIMIT = 500; // latest orders loaded; the summary still counts all of them
const SUPPLY_PREVIEW = 15;

async function runTool<T = unknown>(sql: string, params: Record<string, unknown> | undefined, SA_RUNTIME: unknown): Promise<T[]> {
  const toolExecutor = (window as unknown as { SA?: { ToolExecutor?: { executeTool: (args: unknown) => Promise<{ data?: unknown } | undefined> } } }).SA
    ?.ToolExecutor;
  if (!toolExecutor) throw new Error('ToolExecutor not available');
  const res = await toolExecutor.executeTool({
    externalTool: { toolId: TOOL_ID, toolName: TOOL_NAME, parameters: { sql, ...(params ? { params } : {}) } },
    formData: {},
    SA_RUNTIME,
  });
  const payload = (res?.data ?? res) as { data?: unknown; records?: unknown } | unknown[] | undefined;
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown })?.data)
      ? (payload as { data: unknown[] }).data
      : Array.isArray((payload as { records?: unknown })?.records)
        ? (payload as { records: unknown[] }).records
        : [];
  return rows as T[];
}

const formatINR = (n: number | null | undefined): string => {
  if (n === null || n === undefined || isNaN(Number(n))) return '—';
  return '₹' + Math.round(Number(n)).toLocaleString('en-IN');
};

const formatDate = (d: string | null | undefined): string => {
  if (!d) return '—';
  const date = new Date(d);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter((w) => /[A-Za-z0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();

// ============================================================
// Rating (walkthrough, 16 Oct: "put some sort of rating")
// ============================================================

const RISK_SCORE: Record<string, number> = { Low: 100, Medium: 60, High: 20 };

/** The average of on-time delivery, quality, risk and EcoVadis (each 0–100), scaled to 5. */
function ratingOf(p: ProfileRow): { value: number; basis: string } | null {
  const parts: [string, number][] = [];
  if (p.otd_pct != null) parts.push([`on-time delivery ${p.otd_pct}%`, Number(p.otd_pct)]);
  if (p.quality_acceptance_pct != null) parts.push([`quality ${p.quality_acceptance_pct}%`, Number(p.quality_acceptance_pct)]);
  if (p.overall_risk && RISK_SCORE[p.overall_risk] != null) parts.push([`${p.overall_risk.toLowerCase()} risk (${RISK_SCORE[p.overall_risk]})`, RISK_SCORE[p.overall_risk]]);
  if (p.ecovadis_score != null) parts.push([`EcoVadis ${p.ecovadis_score}`, Number(p.ecovadis_score)]);
  if (!parts.length) return null;
  const avg = parts.reduce((s, [, v]) => s + v, 0) / parts.length;
  return {
    value: Math.round((avg / 20) * 10) / 10,
    basis: `Average of ${parts.map(([t]) => t).join(', ')}, scaled to 5.`,
  };
}

const Stars: React.FC<{ value: number }> = ({ value }) => (
  <span className="inline-flex items-center" aria-hidden>
    {[1, 2, 3, 4, 5].map((i) => (
      <Icon
        key={i}
        icon={value >= i - 0.25 ? 'mdi:star' : value >= i - 0.75 ? 'mdi:star-half-full' : 'mdi:star-outline'}
        className="w-4 h-4"
        style={{ color: '#F59E0B' }}
      />
    ))}
  </span>
);

// ============================================================
// Profile picture: click to add or change; stored with the vendor
// ============================================================

const VendorAvatar: React.FC<{ vendorId: string; name: string; photo: string | null; onChange: (photo: string | null) => void }> = ({
  vendorId,
  name,
  photo,
  onChange,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await setVendorPhoto(vendorId, await toProfilePhoto(file));
      onChange(saved.photo);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the picture");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await removeVendorPhoto(vendorId);
      onChange(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't remove the picture");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-1 flex-shrink-0" style={{ width: 88 }}>
      <button
        type="button"
        onClick={() => !busy && inputRef.current?.click()}
        className="group relative rounded-full overflow-hidden"
        style={{ width: 80, height: 80, border: `2px solid ${TEAL.border}`, backgroundColor: TEAL.tint }}
        title={photo ? 'Change the picture' : 'Add a picture'}
        aria-label={photo ? `Change ${name}'s picture` : `Add a picture for ${name}`}
      >
        {photo ? (
          <img src={photo} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="text-2xl font-bold" style={{ color: TEAL.dark }}>
            {initialsOf(name)}
          </span>
        )}
        <span
          className={`absolute inset-0 flex items-center justify-center transition-opacity ${busy ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
          style={{ backgroundColor: 'rgba(15, 23, 42, 0.45)', color: COLORS.white }}
        >
          <Icon icon={busy ? 'mdi:loading' : 'mdi:camera-outline'} className={`w-6 h-6 ${busy ? 'animate-spin' : ''}`} />
        </span>
      </button>
      <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
      {photo && !busy && (
        <button type="button" onClick={remove} className="text-[10px] underline" style={{ color: COLORS.text.tertiary }}>
          Remove picture
        </button>
      )}
      {error && (
        <p className="text-[10px] text-center leading-tight" style={{ color: '#475569' }}>
          {error}
        </p>
      )}
    </div>
  );
};

// ============================================================
// Sections
// ============================================================

const cardStyle = { border: `1px solid ${TEAL.border}`, backgroundColor: COLORS.white, boxShadow: SHADOWS.card };
const th = 'text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide whitespace-nowrap';
const td = 'px-3 py-1.5';

const Section: React.FC<{ title: string; subtitle?: string; children: React.ReactNode }> = ({ title, subtitle, children }) => (
  <div className="rounded-xl overflow-hidden mb-4" style={cardStyle}>
    <div className="px-4 py-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
      <h2 className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>{title}</h2>
      {subtitle && <p className="text-[11px] mt-0.5" style={{ color: COLORS.text.secondary }}>{subtitle}</p>}
    </div>
    {children}
  </div>
);

const ContractTable: React.FC<{ rows: ContractRecord[]; onOpen: (c: ContractRecord) => void; empty: string }> = ({ rows, onOpen, empty }) =>
  rows.length === 0 ? (
    <p className="px-4 py-3 text-xs" style={{ color: COLORS.text.tertiary }}>{empty}</p>
  ) : (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr style={{ backgroundColor: COLORS.lightBackground }}>
            {['Contract', 'Type', 'Covers', 'Items', 'Valid', 'Value', 'Price escalation', ''].map((h, i) => (
              <th key={i} className={th} style={{ color: COLORS.text.secondary }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr
              key={c.contract_id}
              onClick={() => onOpen(c)}
              className="cursor-pointer transition-colors duration-150"
              style={{ borderTop: `1px solid ${COLORS.lightGray}` }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = TEAL.tint)}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = 'transparent')}
              title="Open the contract"
            >
              <td className={`${td} font-semibold`} style={{ color: COLORS.text.primary }}>{c.contract_id}</td>
              <td className={td} style={{ color: COLORS.text.secondary }}>{c.contract_type}</td>
              <td className={td} style={{ color: COLORS.text.secondary }}>{c.material_group}</td>
              <td className={td} style={{ color: COLORS.text.secondary }}>{c.item_count}</td>
              <td className={`${td} whitespace-nowrap`} style={{ color: COLORS.text.secondary }}>
                {formatDate(c.start_date)} – {formatDate(c.end_date)}
              </td>
              <td className={`${td} font-medium`} style={{ color: COLORS.text.primary }}>{formatINR(c.total_contract_value)}</td>
              <td className={td} style={{ color: COLORS.text.secondary }}>
                {c.price_escalation_clause ? `Yes, ${c.escalation_index || 'index not set'}` : 'Fixed prices'}
              </td>
              <td className={`${td} text-right`}>
                <span className="inline-flex items-center gap-1 text-[11px] font-medium whitespace-nowrap" style={{ color: TEAL.base }}>
                  <Icon icon="mdi:file-document-outline" className="w-3.5 h-3.5" /> Open
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

const Delivery: React.FC<{ row: SupplyRow }> = ({ row }) => {
  if (!row.actual_delivery_date || row.po_status === 'Open') {
    return <span style={{ color: COLORS.text.tertiary }}>Open · due {formatDate(row.delivery_date)}</span>;
  }
  const late = row.days_late != null ? Number(row.days_late) : 0;
  return late > 0 ? (
    <span style={{ color: '#EA580C' }}>
      {late} day{late === 1 ? '' : 's'} late
    </span>
  ) : (
    <span style={{ color: '#16A34A' }}>On time</span>
  );
};

// ============================================================
// Profile page
// ============================================================

/**
 * A vendor's profile page (walkthrough, 16 Oct): who they are with a picture
 * and a rating, their history with us, active and lapsed contracts (each opens
 * as a document), and their supply history.
 */
export const VendorProfile: React.FC<{ vendorId: string; SA_RUNTIME: unknown; onBack: () => void; backLabel: string }> = ({
  vendorId,
  SA_RUNTIME,
  onBack,
  backLabel,
}) => {
  const [profile, setProfile] = useState<ProfileRow | null>(null);
  const [contracts, setContracts] = useState<ContractRecord[]>([]);
  const [summary, setSummary] = useState<SupplySummary | null>(null);
  const [supply, setSupply] = useState<SupplyRow[]>([]);
  const [photo, setPhoto] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAllSupply, setShowAllSupply] = useState(false);

  const [openContract, setOpenContract] = useState<ContractRecord | null>(null);
  const [items, setItems] = useState<ContractItem[] | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setShowAllSupply(false);
      try {
        if (!SAFE_ID.test(vendorId)) throw new Error('Invalid vendor id');
        const p = { vendorId };
        const [profileRows, contractRows, summaryRows, supplyRows, savedPhoto] = await Promise.all([
          runTool<ProfileRow>(
            `SELECT v.vendor_id, v.vendor_name, v.vendor_type, v.category_specialization, v.city, v.state, v.payment_terms,
                    v.onboarding_date, v.is_active,
                    sc.otd_pct, sc.otd_trend, sc.quality_acceptance_pct, sc.open_quality_incidents,
                    sc.financial_risk_tier, sc.overall_risk, sc.sanctions_flag, sc.ecovadis_score, sc.sustainability_tier
             FROM vendor_master v
             LEFT JOIN supplier_scorecard sc ON sc.vendor_id = v.vendor_id
             WHERE v.vendor_id = @vendorId
             LIMIT 1;`,
            p,
            SA_RUNTIME
          ),
          runTool<ContractRecord>(
            `SELECT c.contract_id, c.contract_type, c.material_group, c.start_date, c.end_date, c.total_contract_value,
                    c.price_escalation_clause, c.escalation_index, (c.end_date >= CURRENT_DATE) AS active,
                    (SELECT count(*)::int FROM contract_items ci WHERE ci.contract_id = c.contract_id) AS item_count
             FROM contracts c
             WHERE c.vendor_id = @vendorId
             ORDER BY c.end_date DESC;`,
            p,
            SA_RUNTIME
          ),
          runTool<SupplySummary>(
            `SELECT count(*)::int AS orders, sum(total_value) AS total_value, min(po_date) AS first_order, max(po_date) AS last_order,
                    count(*) FILTER (WHERE po_status = 'Open')::int AS open_orders
             FROM purchase_orders
             WHERE vendor_id = @vendorId;`,
            p,
            SA_RUNTIME
          ),
          runTool<SupplyRow>(
            `SELECT po.po_id, po.po_line_item, po.po_date, po.material_id, m.material_desc, m.unit_of_measure,
                    po.ordered_qty, po.unit_price, po.total_value, po.delivery_date, po.actual_delivery_date,
                    po.po_status, po.payment_status, (po.actual_delivery_date - po.delivery_date) AS days_late
             FROM purchase_orders po
             LEFT JOIN material_master m ON m.material_id = po.material_id
             WHERE po.vendor_id = @vendorId
             ORDER BY po.po_date DESC, po.po_id DESC, po.po_line_item
             LIMIT ${SUPPLY_LIMIT};`,
            p,
            SA_RUNTIME
          ),
          // The picture is optional: the page works without it.
          getVendorPhoto(vendorId).catch(() => null),
        ]);
        if (cancelled) return;
        if (profileRows.length === 0) throw new Error(`No vendor found for ${vendorId}`);
        setProfile(profileRows[0]);
        setContracts(contractRows);
        setSummary(summaryRows[0] ?? null);
        setSupply(supplyRows);
        setPhoto(savedPhoto?.photo ?? null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load this vendor');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vendorId, SA_RUNTIME]);

  // The opened contract's schedule of rates.
  useEffect(() => {
    if (!openContract) return;
    let cancelled = false;
    setItems(null);
    setItemsError(null);
    runTool<ContractItem>(
      `SELECT ci.material_id, ci.contract_unit_price, m.material_desc, m.unit_of_measure
       FROM contract_items ci
       LEFT JOIN material_master m ON m.material_id = ci.material_id
       WHERE ci.contract_id = @contractId
       ORDER BY m.material_desc ASC;`,
      { contractId: openContract.contract_id },
      SA_RUNTIME
    )
      .then((rows) => !cancelled && setItems(rows))
      .catch((err) => !cancelled && setItemsError(err instanceof Error ? err.message : 'Failed to load the schedule'));
    return () => {
      cancelled = true;
    };
  }, [openContract, SA_RUNTIME]);

  const back = (
    <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-medium mb-3" style={{ color: TEAL.base }}>
      <Icon icon="mdi:arrow-left" className="w-4 h-4" /> {backLabel}
    </button>
  );

  if (loading) return <LoadingState height={520} message="Loading vendor profile…" variant="skeleton" size="lg" />;
  if (error || !profile) {
    return (
      <div className="w-full">
        {back}
        <div className="bg-white rounded-xl shadow-sm border border-[#F1F5F9] p-6">
          <div className="flex items-center gap-3">
            <Icon icon="mdi:alert-circle" className="w-5 h-5 text-[#475569] flex-shrink-0" />
            <p className="text-sm" style={{ color: '#475569' }}>{error || 'Vendor not found.'}</p>
          </div>
        </div>
      </div>
    );
  }

  const rating = ratingOf(profile);
  const active = contracts.filter((c) => c.active);
  const lapsed = contracts.filter((c) => !c.active);
  const visibleSupply = showAllSupply ? supply : supply.slice(0, SUPPLY_PREVIEW);
  const performance = [
    profile.otd_pct != null && `On-time delivery ${profile.otd_pct}%${profile.otd_trend ? ` (${profile.otd_trend.toLowerCase()})` : ''}`,
    profile.quality_acceptance_pct != null &&
      `Quality ${profile.quality_acceptance_pct}%${profile.open_quality_incidents ? `, ${profile.open_quality_incidents} open incident${Number(profile.open_quality_incidents) === 1 ? '' : 's'}` : ''}`,
    profile.overall_risk && `Risk ${profile.overall_risk}${profile.financial_risk_tier ? ` (financial ${profile.financial_risk_tier.toLowerCase()})` : ''}`,
    profile.ecovadis_score != null && `EcoVadis ${profile.ecovadis_score}${profile.sustainability_tier ? `, ${profile.sustainability_tier}` : ''}`,
  ].filter(Boolean) as string[];
  const history = [
    profile.onboarding_date && `Vendor since ${formatDate(profile.onboarding_date)}`,
    summary && summary.orders > 0
      ? `${summary.orders} order${summary.orders === 1 ? '' : 's'} from ${formatDate(summary.first_order)} to ${formatDate(summary.last_order)}`
      : 'No orders yet',
    summary && summary.orders > 0 && `${formatINR(summary.total_value)} bought`,
    summary && summary.open_orders > 0 && `${summary.open_orders} open`,
    profile.payment_terms && `Payment terms ${profile.payment_terms}`,
  ].filter(Boolean) as string[];

  return (
    <div className="w-full" style={{ fontFamily: TYPOGRAPHY.fontFamily.primary, paddingTop: SPACING.xl }}>
      {back}

      {/* Who they are: picture, legal name, rating — no metric boxes ("remove so many boxes") */}
      <div className="rounded-xl mb-4" style={cardStyle}>
        <div className="p-5 flex gap-5 items-start">
          <VendorAvatar vendorId={profile.vendor_id} name={profile.vendor_name} photo={photo} onChange={setPhoto} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold" style={{ color: COLORS.text.primary }}>{profile.vendor_name}</h1>
              <span
                className="px-2 py-0.5 rounded-full text-[11px] font-semibold"
                style={{ backgroundColor: profile.is_active ? '#DCFCE7' : COLORS.lightGray, color: profile.is_active ? '#16A34A' : COLORS.text.secondary }}
              >
                {profile.is_active ? 'Active' : 'Inactive'}
              </span>
              {profile.sanctions_flag && (
                <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold" style={{ backgroundColor: '#FFEDD5', color: '#C2410C' }}>
                  Sanctions flag
                </span>
              )}
            </div>
            <p className="text-xs mt-0.5" style={{ color: COLORS.text.secondary }}>
              {[profile.vendor_type, profile.category_specialization, [profile.city, profile.state].filter(Boolean).join(', '), profile.vendor_id]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {rating ? (
              <div className="flex items-center gap-1.5 mt-2" title={rating.basis}>
                <Stars value={rating.value} />
                <span className="text-sm font-semibold" style={{ color: COLORS.text.primary }}>{rating.value.toFixed(1)}</span>
                <span className="text-xs" style={{ color: COLORS.text.tertiary }}>/ 5 rating</span>
                <Icon icon="mdi:information-outline" className="w-3.5 h-3.5" style={{ color: COLORS.text.tertiary }} />
              </div>
            ) : (
              <p className="text-xs mt-2" style={{ color: COLORS.text.tertiary }}>No rating yet: no scorecard for this vendor.</p>
            )}
            {performance.length > 0 && (
              <p className="text-xs mt-1.5" style={{ color: COLORS.text.secondary }}>{performance.join(' · ')}</p>
            )}
          </div>
        </div>
        {/* Their history with us */}
        <div className="px-5 py-2.5 flex flex-wrap items-baseline gap-x-2" style={{ borderTop: `1px solid ${TEAL.border}`, backgroundColor: COLORS.lightBackground }}>
          <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: COLORS.text.tertiary }}>History</span>
          <span className="text-xs" style={{ color: COLORS.text.secondary }}>{history.join(' · ')}</span>
        </div>
      </div>

      <Section title={`Active contracts (${active.length})`} subtitle="One contract can cover many materials. Click a contract to open it.">
        <ContractTable rows={active} onOpen={setOpenContract} empty="No active contracts with this vendor." />
      </Section>

      <Section title={`Lapsed contracts (${lapsed.length})`}>
        <ContractTable rows={lapsed} onOpen={setOpenContract} empty="No lapsed contracts." />
      </Section>

      <Section
        title="Supply history"
        subtitle={
          summary && summary.orders > supply.length
            ? `The latest ${supply.length} of ${summary.orders} purchase orders.`
            : 'Purchase orders, newest first, with how each delivery went.'
        }
      >
        {supply.length === 0 ? (
          <p className="px-4 py-3 text-xs" style={{ color: COLORS.text.tertiary }}>No purchase orders with this vendor yet.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ backgroundColor: COLORS.lightBackground }}>
                    {['Date', 'PO', 'Material', 'Qty', 'Unit price', 'Value', 'Delivery', 'Payment'].map((h) => (
                      <th key={h} className={th} style={{ color: COLORS.text.secondary }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleSupply.map((r) => (
                    <tr key={`${r.po_id}-${r.po_line_item}`} style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                      <td className={`${td} whitespace-nowrap`} style={{ color: COLORS.text.secondary }}>{formatDate(r.po_date)}</td>
                      <td className={`${td} whitespace-nowrap font-medium`} style={{ color: COLORS.text.primary }}>{r.po_id}</td>
                      <td className={td} style={{ color: COLORS.text.primary }}>{r.material_desc || r.material_id}</td>
                      <td className={`${td} whitespace-nowrap`} style={{ color: COLORS.text.secondary }}>
                        {r.ordered_qty} {r.unit_of_measure || ''}
                      </td>
                      <td className={`${td} whitespace-nowrap`} style={{ color: COLORS.text.secondary }}>{formatINR(r.unit_price)}</td>
                      <td className={`${td} whitespace-nowrap font-medium`} style={{ color: COLORS.text.primary }}>{formatINR(r.total_value)}</td>
                      <td className={`${td} whitespace-nowrap text-xs`}>
                        <Delivery row={r} />
                      </td>
                      <td className={`${td} whitespace-nowrap text-xs`} style={{ color: COLORS.text.secondary }}>{r.payment_status || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {supply.length > SUPPLY_PREVIEW && (
              <div className="px-4 py-2.5 flex justify-center" style={{ borderTop: `1px solid ${COLORS.lightGray}` }}>
                <button type="button" onClick={() => setShowAllSupply((v) => !v)} className="text-xs font-medium" style={{ color: TEAL.base }}>
                  {showAllSupply ? 'Show fewer' : `Show all ${supply.length} orders`}
                </button>
              </div>
            )}
          </>
        )}
      </Section>

      {openContract && (
        <ContractDocument
          contract={openContract}
          vendor={profile}
          items={items}
          itemsError={itemsError}
          onClose={() => setOpenContract(null)}
        />
      )}
    </div>
  );
};
