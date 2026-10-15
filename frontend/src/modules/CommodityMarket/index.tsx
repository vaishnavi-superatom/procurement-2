import React from 'react';
import type { ComponentMetadata } from '../../types';
import PlaceholderPage from '../_shared/PlaceholderPage';

const METADATA: ComponentMetadata = {
  id: 'commodity-market-dashboard',
  name: 'CommodityMarket',
  displayName: 'Show commodity & market dashboard',
  isDisplayComp: true,
  type: 'CommodityMarket',
  description: 'Dashboard for commodity and market trends',
  category: 'Dashboard',
  keywords: ['commodity', 'market', 'trends', 'procurement'],
  dashboard: { label: 'Commodity & Market', icon: 'mdi:trending-up', order: 7 },
  props: {},
};

interface CommodityMarketComponent extends React.FC {
  Metadata: ComponentMetadata;
}

const CommodityMarket: React.FC = () => (
  <PlaceholderPage
    icon="mdi:trending-up"
    title="Commodity & Market"
    description="Track commodity prices and market intelligence. This dashboard is coming soon."
  />
);

(CommodityMarket as CommodityMarketComponent).Metadata = METADATA;

export default CommodityMarket;
