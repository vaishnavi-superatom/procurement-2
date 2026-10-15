import React from 'react';
import type { ComponentMetadata } from '../../types';
import PlaceholderPage from '../_shared/PlaceholderPage';

const METADATA: ComponentMetadata = {
  id: 'vendors-onboarded-dashboard',
  name: 'VendorsOnboarded',
  displayName: 'Show vendors onboarded dashboard',
  isDisplayComp: true,
  type: 'VendorsOnboarded',
  description: 'Dashboard for vendor onboarding status',
  category: 'Dashboard',
  keywords: ['vendors', 'onboarding', 'suppliers', 'procurement'],
  dashboard: { label: 'Vendors Onboarded', icon: 'mdi:file-document-edit-outline', order: 5 },
  props: {},
};

interface VendorsOnboardedComponent extends React.FC {
  Metadata: ComponentMetadata;
}

const VendorsOnboarded: React.FC = () => (
  <PlaceholderPage
    icon="mdi:file-document-edit-outline"
    title="Vendors Onboarded"
    description="Review vendors onboarded and their onboarding status. This dashboard is coming soon."
  />
);

(VendorsOnboarded as VendorsOnboardedComponent).Metadata = METADATA;

export default VendorsOnboarded;
