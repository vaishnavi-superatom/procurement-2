import React from 'react';
import type { ComponentMetadata } from '../../types';
import VendorsOnboardedHome from '../VendorsOnboardedHome';

// "Vendors", not "Vendors Onboarded" (walkthrough, 16 Oct): a list of vendors,
// each opening its profile page — the same directory as the Home "Vendors" card.
const METADATA: ComponentMetadata = {
  id: 'vendors-onboarded-dashboard',
  name: 'VendorsOnboarded',
  displayName: 'Show vendors',
  isDisplayComp: true,
  type: 'VendorsOnboarded',
  description: 'Vendor directory; each vendor opens a profile page with picture, rating, contracts and supply history',
  category: 'Dashboard',
  keywords: ['vendors', 'suppliers', 'vendor profile', 'contracts', 'supply history', 'procurement'],
  dashboard: { label: 'Vendors', icon: 'mdi:storefront-outline', order: 5 },
  props: {},
};

interface VendorsOnboardedProps {
  SA_RUNTIME?: unknown;
}

interface VendorsOnboardedComponent extends React.FC<VendorsOnboardedProps> {
  Metadata: ComponentMetadata;
}

const VendorsOnboarded: React.FC<VendorsOnboardedProps> = ({ SA_RUNTIME }) => <VendorsOnboardedHome SA_RUNTIME={SA_RUNTIME} />;

(VendorsOnboarded as VendorsOnboardedComponent).Metadata = METADATA;

export default VendorsOnboarded;
