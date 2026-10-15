import React from 'react';
import type { ComponentMetadata } from '../../types';
import PlaceholderPage from '../_shared/PlaceholderPage';

const METADATA: ComponentMetadata = {
  id: 'inventory-capital-dashboard',
  name: 'InventoryCapital',
  displayName: 'Show inventory & capital dashboard',
  isDisplayComp: true,
  type: 'InventoryCapital',
  description: 'Dashboard for inventory levels and capital assets',
  category: 'Dashboard',
  keywords: ['inventory', 'capital', 'stock', 'assets', 'procurement'],
  dashboard: { label: 'Inventory & Capital', icon: 'mdi:package-variant-closed', order: 3 },
  props: {},
};

interface InventoryCapitalComponent extends React.FC {
  Metadata: ComponentMetadata;
}

const InventoryCapital: React.FC = () => (
  <PlaceholderPage
    icon="mdi:package-variant-closed"
    title="Inventory & Capital"
    description="Monitor inventory levels and capital asset utilization. This dashboard is coming soon."
  />
);

(InventoryCapital as InventoryCapitalComponent).Metadata = METADATA;

export default InventoryCapital;
