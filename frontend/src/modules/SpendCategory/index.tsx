import React from 'react';
import type { ComponentMetadata } from '../../types';
import PlaceholderPage from '../_shared/PlaceholderPage';

const METADATA: ComponentMetadata = {
  id: 'spend-category-dashboard',
  name: 'SpendCategory',
  displayName: 'Show spend & category dashboard',
  isDisplayComp: true,
  type: 'SpendCategory',
  description: 'Dashboard for spend breakdown by category',
  category: 'Dashboard',
  keywords: ['spend', 'category', 'market intelligence', 'procurement'],
  dashboard: { label: 'Spend & Category', icon: 'mdi:chart-pie-outline', order: 6 },
  props: {},
};

interface SpendCategoryComponent extends React.FC {
  Metadata: ComponentMetadata;
}

const SpendCategory: React.FC = () => (
  <PlaceholderPage
    icon="mdi:chart-pie-outline"
    title="Spend & Category"
    description="Analyze spend breakdown across categories. This dashboard is coming soon."
  />
);

(SpendCategory as SpendCategoryComponent).Metadata = METADATA;

export default SpendCategory;
