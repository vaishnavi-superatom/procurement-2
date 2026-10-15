import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, TYPOGRAPHY, SPACING, BORDER_RADIUS, SHADOWS } from '../../design-system/tokens';
import PurchaseRequests from '../PurchaseRequests';
import RfqReceived from '../RfqReceived';
import ActiveNegotiations from '../ActiveNegotiations';
import Negotiations from '../Negotiations';
import VendorsOnboardedHome from '../VendorsOnboardedHome';
import ApprovedRfqsHome from '../ApprovedRfqsHome';
import RfqApprovalHome from '../RfqApprovalHome';

interface HomeProps {
  SA_RUNTIME?: any;
}

// Teal accent used only for the "Procurement at a Glance" banner, matching the
// reference design — distinct from the app's blue COLORS.primary used elsewhere.
// `border` and `shadow` are teal-tinted versions of the app's neutral border/shadow
// so the KPI cards read as part of the same palette as the banner above them.
const TEAL = {
  base: '#0F6B64',
  dark: '#0B4F4A',
  tint: '#E6F5F3',
  border: '#D7E8E6',
  shadow: 'rgba(11, 79, 74, 0.22)',
};

type Period = 'Today' | 'This Week' | 'This Month' | 'This Year';

const PERIOD_OPTIONS: Period[] = ['Today', 'This Week', 'This Month', 'This Year'];

interface KpiMeta {
  label: string;
  icon: string;
  iconColor: string;
  iconBg: string;
}

// Icon/color metadata only — the number itself is fetched live (see
// fetchKpiCounts below) from the exact same tables and period boundaries
// each card's embedded table filters by, so the card and the table it opens
// can never disagree.
const KPI_META: KpiMeta[] = [
  { label: 'Total PRs Raised', icon: 'mdi:file-document-plus-outline', iconColor: '#16A34A', iconBg: '#DCFCE7' },
  { label: 'RFQs received', icon: 'mdi:send-outline', iconColor: '#0EA5E9', iconBg: '#E0F2FE' },
  { label: 'Active Negotiations', icon: 'mdi:shield-outline', iconColor: TEAL.base, iconBg: TEAL.tint },
  { label: 'Approved RFQs', icon: 'mdi:hammer', iconColor: '#EA580C', iconBg: '#FFEDD5' },
  { label: 'Vendors Onboarded', icon: 'mdi:file-document-edit-outline', iconColor: '#16A34A', iconBg: '#DCFCE7' },
];

const TOOL_ID = 'postgres-0fc80d2496ff_query';
const TOOL_NAME = 'Query PostgreSQL Connection';

async function runCount(sql: string, params: Record<string, any>, SA_RUNTIME: any): Promise<number> {
  const toolExecutor = (window as any).SA?.ToolExecutor;
  if (!toolExecutor) throw new Error('ToolExecutor not available');
  const res = await toolExecutor.executeTool({
    externalTool: { toolId: TOOL_ID, toolName: TOOL_NAME, parameters: { sql, params } },
    formData: {},
    SA_RUNTIME,
  });
  const payload = res?.data ?? res;
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.records) ? payload.records : [];
  return Number(rows[0]?.cnt ?? 0);
}

// Same Today/This Week/This Month/This Year semantics as every embedded
// table's own time filter (inTimeFilter), expressed as a [start, end) date
// range so it can be pushed into the COUNT queries instead of pulling every
// row just to count them.
function periodBounds(period: Period): { start: string; end: string } {
  const now = new Date();
  const toISO = (d: Date) => d.toISOString().slice(0, 10);
  if (period === 'Today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start);
    end.setDate(start.getDate() + 1);
    return { start: toISO(start), end: toISO(end) };
  }
  if (period === 'This Week') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    return { start: toISO(start), end: toISO(end) };
  }
  if (period === 'This Month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return { start: toISO(start), end: toISO(end) };
  }
  // This Year
  const start = new Date(now.getFullYear(), 0, 1);
  const end = new Date(now.getFullYear() + 1, 0, 1);
  return { start: toISO(start), end: toISO(end) };
}

const METADATA: ComponentMetadata = {
  id: 'home-procurement-glance',
  name: 'Home',
  displayName: 'Show procurement home / at a glance',
  isDisplayComp: true,
  type: 'Home',
  description: 'Procurement homepage showing key metrics at a glance for a selected time period',
  category: 'Dashboard',
  keywords: ['home', 'procurement', 'glance', 'overview', 'dashboard', 'kpi'],
  props: {},
};

interface HomeComponent extends React.FC<HomeProps> {
  Metadata: ComponentMetadata;
}

const Home: React.FC<HomeProps> = ({ SA_RUNTIME }) => {
  const [period, setPeriod] = useState<Period>('This Month');
  const [open, setOpen] = useState(false);
  const [showPRList, setShowPRList] = useState(false);
  const [showRfqList, setShowRfqList] = useState(false);
  const [showNegotiation, setShowNegotiation] = useState(false);
  const [showNegotiationsList, setShowNegotiationsList] = useState(false);
  const [showVendorsList, setShowVendorsList] = useState(false);
  const [showApprovedRfqsList, setShowApprovedRfqsList] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const rfqBlockRef = useRef<HTMLDivElement>(null);
  const negotiationBlockRef = useRef<HTMLDivElement>(null);
  const approvalBlockRef = useRef<HTMLDivElement>(null);

  // Scenario 2: a PR's "Evaluate RFQ(s)" opens the RFQ experience focused on
  // its linked RFQ. focusToken forces RfqReceived to re-jump even if the same
  // PR/RFQ is evaluated again after navigating back.
  const [rfqFocusId, setRfqFocusId] = useState<string | undefined>(undefined);
  const [rfqFocusSearch, setRfqFocusSearch] = useState<string | undefined>(undefined);
  const [rfqFocusToken, setRfqFocusToken] = useState(0);

  const handleEvaluateRfq = ({ prId, rfqId }: { prId: string; rfqId?: string }) => {
    setRfqFocusId(rfqId);
    setRfqFocusSearch(prId);
    setRfqFocusToken((t) => t + 1);
    setShowRfqList(true);
  };

  useEffect(() => {
    if (rfqFocusToken > 0) {
      rfqBlockRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [rfqFocusToken]);

  // An RFQ's "Start Negotiation" opens the negotiation workspace for that
  // exact PR/RFQ/material/supplier.
  const [negotiationContext, setNegotiationContext] = useState<{
    prId: string;
    rfqId: string;
    materialId: string;
    vendorId: string;
  } | null>(null);

  const handleStartNegotiation = ({
    prId,
    rfqId,
    materialId,
    vendorId,
  }: {
    prId: string;
    rfqId: string;
    materialId: string;
    vendorId: string;
    vendorName?: string | null;
  }) => {
    setNegotiationContext({ prId, rfqId, materialId, vendorId });
    setShowNegotiation(true);
  };

  useEffect(() => {
    if (negotiationContext) {
      negotiationBlockRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [negotiationContext]);

  // A negotiation's "Proceed to Approval" opens the approval view for that
  // exact PR/RFQ/material/supplier.
  const [approvalContext, setApprovalContext] = useState<{
    prId: string;
    rfqId: string;
    materialId: string;
    vendorId: string;
  } | null>(null);

  const handleProceedToApproval = (args: { prId: string; rfqId: string; materialId: string; vendorId: string }) => {
    setApprovalContext(args);
  };

  useEffect(() => {
    if (approvalContext) {
      approvalBlockRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [approvalContext]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Real, period-scoped counts — queried with the exact same filters each
  // card's own embedded table applies, so the number on the card and the
  // row count in the table it opens can never disagree.
  const [kpiValues, setKpiValues] = useState<Record<string, number>>({});
  const [kpiLoading, setKpiLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setKpiLoading(true);
      try {
        const { start, end } = periodBounds(period);
        const params = { start, end };
        const [prRows, rfqRows, negRows, apprRows, vendorRows] = await Promise.all([
          runCount(`SELECT COUNT(DISTINCT pr_id) AS cnt FROM purchase_requisitions WHERE pr_date >= @start AND pr_date < @end;`, params, SA_RUNTIME),
          runCount(`SELECT COUNT(*) AS cnt FROM rfq_events WHERE rfq_date >= @start AND rfq_date < @end;`, params, SA_RUNTIME),
          runCount(`SELECT COUNT(*) AS cnt FROM rfq_events WHERE rfq_status = 'In Negotiation' AND rfq_date >= @start AND rfq_date < @end;`, params, SA_RUNTIME),
          runCount(
            `SELECT COUNT(DISTINCT rfq.rfq_id) AS cnt FROM rfq_events rfq JOIN quotations aq ON aq.rfq_id = rfq.rfq_id AND aq.is_awarded = true WHERE rfq.rfq_status = 'Awarded' AND aq.quote_date >= @start AND aq.quote_date < @end;`,
            params,
            SA_RUNTIME
          ),
          runCount(`SELECT COUNT(*) AS cnt FROM vendor_master WHERE onboarding_date >= @start AND onboarding_date < @end;`, params, SA_RUNTIME),
        ]);
        if (!cancelled) {
          setKpiValues({
            'Total PRs Raised': prRows,
            'RFQs received': rfqRows,
            'Active Negotiations': negRows,
            'Approved RFQs': apprRows,
            'Vendors Onboarded': vendorRows,
          });
        }
      } catch (err) {
        console.error('[Home] Failed to load KPI counts', err);
      } finally {
        if (!cancelled) setKpiLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [period, SA_RUNTIME]);

  const kpis = KPI_META.map((meta) => ({ ...meta, value: kpiValues[meta.label] }));

  return (
    <div
      className="w-full max-w-[1120px] mx-auto"
      style={{ fontFamily: TYPOGRAPHY.fontFamily.primary, paddingTop: SPACING.xl }}
    >
      {/* Procurement at a Glance banner */}
      <div
        className="p-6 flex items-center justify-between flex-wrap gap-3"
        style={{
          background: `linear-gradient(135deg, ${TEAL.base} 0%, ${TEAL.dark} 100%)`,
          borderRadius: BORDER_RADIUS.large,
          boxShadow: `0 6px 16px ${TEAL.shadow}`,
        }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: 'rgba(255,255,255,0.16)' }}
          >
            <Icon icon="mdi:view-grid-outline" className="w-5 h-5" style={{ color: COLORS.white }} />
          </div>
          <h1 className="text-xl font-bold" style={{ color: COLORS.white }}>
            Procurement at a Glance
          </h1>
        </div>

        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium"
            style={{ backgroundColor: COLORS.white, color: COLORS.text.primary }}
          >
            {period}
            <Icon icon="mdi:chevron-down" className="w-3.5 h-3.5" />
          </button>
          {open && (
            <div
              className="absolute right-0 mt-2 w-36 rounded-lg overflow-hidden z-10"
              style={{ backgroundColor: COLORS.white, boxShadow: SHADOWS.dropdown }}
            >
              {PERIOD_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  onClick={() => {
                    setPeriod(opt);
                    setOpen(false);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs"
                  style={{
                    color: opt === period ? TEAL.base : COLORS.text.primary,
                    fontWeight: opt === period ? TYPOGRAPHY.fontWeight.semibold : TYPOGRAPHY.fontWeight.regular,
                    backgroundColor: opt === period ? TEAL.tint : 'transparent',
                  }}
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* KPI Cards — always 5 equal-width columns on desktop, never wraps */}
      <div className="grid grid-cols-5 gap-3 mt-4">
        {kpis.map((kpi) => {
          const isPRCard = kpi.label === 'Total PRs Raised';
          const isRfqCard = kpi.label === 'RFQs received';
          const isNegotiationsCard = kpi.label === 'Active Negotiations';
          const isVendorsCard = kpi.label === 'Vendors Onboarded';
          const isApprovedRfqsCard = kpi.label === 'Approved RFQs';
          const isExpanded =
            (isPRCard && showPRList) ||
            (isRfqCard && showRfqList) ||
            (isNegotiationsCard && showNegotiationsList) ||
            (isVendorsCard && showVendorsList) ||
            (isApprovedRfqsCard && showApprovedRfqsList);
          const toggle = isPRCard
            ? () => setShowPRList((s) => !s)
            : isRfqCard
              ? () => setShowRfqList((s) => !s)
              : isNegotiationsCard
                ? () => setShowNegotiationsList((s) => !s)
                : isVendorsCard
                  ? () => setShowVendorsList((s) => !s)
                  : isApprovedRfqsCard
                    ? () => setShowApprovedRfqsList((s) => !s)
                    : undefined;
          return (
            <div
              key={kpi.label}
              onClick={toggle}
              className="min-w-0 rounded-lg p-3"
              style={{
                backgroundColor: COLORS.white,
                border: `1px solid ${isExpanded ? TEAL.base : TEAL.border}`,
                boxShadow: SHADOWS.card,
                cursor: toggle ? 'pointer' : 'default',
              }}
            >
              <div className="flex items-start justify-between mb-2">
                <div
                  className="w-7 h-7 rounded-md flex items-center justify-center"
                  style={{ backgroundColor: kpi.iconBg }}
                >
                  <Icon icon={kpi.icon} className="w-4 h-4" style={{ color: kpi.iconColor }} />
                </div>
                {toggle ? (
                  <Icon
                    icon={isExpanded ? 'mdi:chevron-up' : 'mdi:chevron-down'}
                    className="w-3.5 h-3.5"
                    style={{ color: COLORS.text.tertiary }}
                  />
                ) : (
                  <Icon icon="mdi:information-outline" className="w-3.5 h-3.5" style={{ color: COLORS.text.tertiary }} />
                )}
              </div>
              <p className="text-xs mb-0.5 truncate" style={{ color: COLORS.text.secondary }}>
                {kpi.label}
              </p>
              <p className="text-2xl font-bold" style={{ color: COLORS.text.primary }}>
                {kpi.value === undefined ? (kpiLoading ? '—' : 0) : kpi.value}
              </p>
            </div>
          );
        })}
      </div>

      {/* Total PRs Raised → Purchase Requests list, inline below, same screen.
          Space is given (divider + gap) before the block so it reads as a
          distinct new section rather than appearing flush under the cards. */}
      {showPRList && (
        <div className="mt-8">
          <div style={{ borderTop: `1px solid ${TEAL.border}` }} />
          <div
            className="mt-6 rounded-lg p-4"
            style={{ backgroundColor: COLORS.white, border: `1px solid ${TEAL.border}`, boxShadow: SHADOWS.card }}
          >
            <PurchaseRequests SA_RUNTIME={SA_RUNTIME} simplifiedToolbar showRfqColumn activePeriod={period} onEvaluateRfq={handleEvaluateRfq} />
          </div>
        </div>
      )}

      {/* RFQs received → RFQ list, inline below, same screen (same pattern as Total PRs Raised) */}
      {showRfqList && (
        <div className="mt-8" ref={rfqBlockRef}>
          <div style={{ borderTop: `1px solid ${TEAL.border}` }} />
          <div
            className="mt-6 rounded-lg p-4"
            style={{ backgroundColor: COLORS.white, border: `1px solid ${TEAL.border}`, boxShadow: SHADOWS.card }}
          >
            <RfqReceived
              SA_RUNTIME={SA_RUNTIME}
              focusRfqId={rfqFocusId}
              focusSearch={rfqFocusSearch}
              focusToken={rfqFocusToken}
              initialPeriod={period}
              onStartNegotiation={handleStartNegotiation}
            />
          </div>
        </div>
      )}

      {/* Start Negotiation → negotiation workspace, inline below, same screen */}
      {showNegotiation && negotiationContext && (
        <div className="mt-8" ref={negotiationBlockRef}>
          <div style={{ borderTop: `1px solid ${TEAL.border}` }} />
          <div
            className="mt-6 rounded-lg p-4"
            style={{ backgroundColor: COLORS.white, border: `1px solid ${TEAL.border}`, boxShadow: SHADOWS.card }}
          >
            <ActiveNegotiations
              SA_RUNTIME={SA_RUNTIME}
              prId={negotiationContext.prId}
              rfqId={negotiationContext.rfqId}
              materialId={negotiationContext.materialId}
              vendorId={negotiationContext.vendorId}
              onBack={() => setShowNegotiation(false)}
              onProceedToApproval={handleProceedToApproval}
            />
          </div>
        </div>
      )}

      {/* Proceed to Approval → approval workspace, inline below, same screen */}
      {approvalContext && (
        <div className="mt-8" ref={approvalBlockRef}>
          <div style={{ borderTop: `1px solid ${TEAL.border}` }} />
          <div
            className="mt-6 rounded-lg p-4"
            style={{ backgroundColor: COLORS.white, border: `1px solid ${TEAL.border}`, boxShadow: SHADOWS.card }}
          >
            <RfqApprovalHome
              SA_RUNTIME={SA_RUNTIME}
              prId={approvalContext.prId}
              rfqId={approvalContext.rfqId}
              materialId={approvalContext.materialId}
              vendorId={approvalContext.vendorId}
              onBack={() => setApprovalContext(null)}
              onViewRfq={handleEvaluateRfq}
            />
          </div>
        </div>
      )}

      {/* Active Negotiations card → negotiations list, inline below, same screen */}
      {showNegotiationsList && (
        <div className="mt-8">
          <div style={{ borderTop: `1px solid ${TEAL.border}` }} />
          <div
            className="mt-6 rounded-lg p-4"
            style={{ backgroundColor: COLORS.white, border: `1px solid ${TEAL.border}`, boxShadow: SHADOWS.card }}
          >
            <Negotiations SA_RUNTIME={SA_RUNTIME} compact={false} activePeriod={period} />
          </div>
        </div>
      )}

      {/* Vendors Onboarded card → vendor directory, inline below, same screen */}
      {showVendorsList && (
        <div className="mt-8">
          <div style={{ borderTop: `1px solid ${TEAL.border}` }} />
          <div
            className="mt-6 rounded-lg p-4"
            style={{ backgroundColor: COLORS.white, border: `1px solid ${TEAL.border}`, boxShadow: SHADOWS.card }}
          >
            <VendorsOnboardedHome SA_RUNTIME={SA_RUNTIME} initialPeriod={period} />
          </div>
        </div>
      )}

      {/* Approved RFQs card → approved RFQs list, inline below, same screen */}
      {showApprovedRfqsList && (
        <div className="mt-8">
          <div style={{ borderTop: `1px solid ${TEAL.border}` }} />
          <div
            className="mt-6 rounded-lg p-4"
            style={{ backgroundColor: COLORS.white, border: `1px solid ${TEAL.border}`, boxShadow: SHADOWS.card }}
          >
            <ApprovedRfqsHome SA_RUNTIME={SA_RUNTIME} activePeriod={period} onOpenRfq={handleEvaluateRfq} />
          </div>
        </div>
      )}
    </div>
  );
};

(Home as HomeComponent).Metadata = METADATA;

export default Home;
