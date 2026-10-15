import React from 'react';
import type { ComponentMetadata } from '../../types';
import PlaceholderPage from '../_shared/PlaceholderPage';

const METADATA: ComponentMetadata = {
  id: 'negotiations-dashboard',
  name: 'Negotiations',
  displayName: 'Show negotiations dashboard',
  isDisplayComp: true,
  type: 'Negotiations',
  description: 'Dashboard for active vendor negotiations',
  category: 'Dashboard',
  keywords: ['negotiations', 'rfq', 'vendor', 'procurement'],
  dashboard: { label: 'Negotiations', icon: 'mdi:bullhorn-outline', order: 4 },
  props: {},
};

interface NegotiationsComponent extends React.FC {
  Metadata: ComponentMetadata;
}

const Negotiations: React.FC = () => (
  <PlaceholderPage
    icon="mdi:bullhorn-outline"
    title="Negotiations"
    description="Track active and past vendor negotiations. This dashboard is coming soon."
  />
);

(Negotiations as NegotiationsComponent).Metadata = METADATA;

export default Negotiations;
