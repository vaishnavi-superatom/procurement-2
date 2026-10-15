import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../../types';
import { COLORS, TYPOGRAPHY, SPACING, BORDER_RADIUS, SHADOWS } from '../../design-system/tokens';
import PurchaseRequests from '../PurchaseRequests';

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

interface KPI {
  label: string;
  value: number;
  icon: string;
  iconColor: string;
  iconBg: string;
}

const KPI_DATA: Record<Period, KPI[]> = {
  Today: [
    { label: 'Total PRs Raised', value: 2, icon: 'mdi:file-document-plus-outline', iconColor: '#16A34A', iconBg: '#DCFCE7' },
    { label: 'RFQs received', value: 3, icon: 'mdi:send-outline', iconColor: '#0EA5E9', iconBg: '#E0F2FE' },
    { label: 'Active Negotiations', value: 4, icon: 'mdi:shield-outline', iconColor: TEAL.base, iconBg: TEAL.tint },
    { label: 'Approved RFQs', value: 0, icon: 'mdi:hammer', iconColor: '#EA580C', iconBg: '#FFEDD5' },
    { label: 'Vendors Onboarded', value: 0, icon: 'mdi:file-document-edit-outline', iconColor: '#16A34A', iconBg: '#DCFCE7' },
  ],
  'This Week': [
    { label: 'Total PRs Raised', value: 6, icon: 'mdi:file-document-plus-outline', iconColor: '#16A34A', iconBg: '#DCFCE7' },
    { label: 'RFQs received', value: 9, icon: 'mdi:send-outline', iconColor: '#0EA5E9', iconBg: '#E0F2FE' },
    { label: 'Active Negotiations', value: 10, icon: 'mdi:shield-outline', iconColor: TEAL.base, iconBg: TEAL.tint },
    { label: 'Approved RFQs', value: 1, icon: 'mdi:hammer', iconColor: '#EA580C', iconBg: '#FFEDD5' },
    { label: 'Vendors Onboarded', value: 1, icon: 'mdi:file-document-edit-outline', iconColor: '#16A34A', iconBg: '#DCFCE7' },
  ],
  'This Month': [
    { label: 'Total PRs Raised', value: 13, icon: 'mdi:file-document-plus-outline', iconColor: '#16A34A', iconBg: '#DCFCE7' },
    { label: 'RFQs received', value: 18, icon: 'mdi:send-outline', iconColor: '#0EA5E9', iconBg: '#E0F2FE' },
    { label: 'Active Negotiations', value: 18, icon: 'mdi:shield-outline', iconColor: TEAL.base, iconBg: TEAL.tint },
    { label: 'Approved RFQs', value: 2, icon: 'mdi:hammer', iconColor: '#EA580C', iconBg: '#FFEDD5' },
    { label: 'Vendors Onboarded', value: 4, icon: 'mdi:file-document-edit-outline', iconColor: '#16A34A', iconBg: '#DCFCE7' },
  ],
  'This Year': [
    { label: 'Total PRs Raised', value: 142, icon: 'mdi:file-document-plus-outline', iconColor: '#16A34A', iconBg: '#DCFCE7' },
    { label: 'RFQs received', value: 196, icon: 'mdi:send-outline', iconColor: '#0EA5E9', iconBg: '#E0F2FE' },
    { label: 'Active Negotiations', value: 54, icon: 'mdi:shield-outline', iconColor: TEAL.base, iconBg: TEAL.tint },
    { label: 'Approved RFQs', value: 37, icon: 'mdi:hammer', iconColor: '#EA580C', iconBg: '#FFEDD5' },
    { label: 'Vendors Onboarded', value: 29, icon: 'mdi:file-document-edit-outline', iconColor: '#16A34A', iconBg: '#DCFCE7' },
  ],
};

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
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const kpis = KPI_DATA[period];

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
          return (
            <div
              key={kpi.label}
              onClick={isPRCard ? () => setShowPRList((s) => !s) : undefined}
              className="min-w-0 rounded-lg p-3"
              style={{
                backgroundColor: COLORS.white,
                border: `1px solid ${isPRCard && showPRList ? TEAL.base : TEAL.border}`,
                boxShadow: SHADOWS.card,
                cursor: isPRCard ? 'pointer' : 'default',
              }}
            >
              <div className="flex items-start justify-between mb-2">
                <div
                  className="w-7 h-7 rounded-md flex items-center justify-center"
                  style={{ backgroundColor: kpi.iconBg }}
                >
                  <Icon icon={kpi.icon} className="w-4 h-4" style={{ color: kpi.iconColor }} />
                </div>
                {isPRCard ? (
                  <Icon
                    icon={showPRList ? 'mdi:chevron-up' : 'mdi:chevron-down'}
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
                {kpi.value}
              </p>
            </div>
          );
        })}
      </div>

      {/* Total PRs Raised → Purchase Requests list, inline below, same screen */}
      {showPRList && (
        <div className="mt-4 rounded-lg p-4" style={{ backgroundColor: COLORS.white, border: `1px solid ${TEAL.border}`, boxShadow: SHADOWS.card }}>
          <PurchaseRequests SA_RUNTIME={SA_RUNTIME} rfqFilterEnabled />
        </div>
      )}
    </div>
  );
};

(Home as HomeComponent).Metadata = METADATA;

export default Home;
