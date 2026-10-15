import React from 'react';
import type { ComponentMetadata } from '../../types';
import PlaceholderPage from '../_shared/PlaceholderPage';

const METADATA: ComponentMetadata = {
  id: 'catalog-classification-dashboard',
  name: 'CatalogClassification',
  displayName: 'Show catalog & classification dashboard',
  isDisplayComp: true,
  type: 'CatalogClassification',
  description: 'Dashboard for catalog and item classification',
  category: 'Dashboard',
  keywords: ['catalog', 'classification', 'items', 'categories', 'procurement'],
  dashboard: { label: 'Catalog & Classification', icon: 'mdi:bookshelf', order: 2 },
  props: {},
};

interface CatalogClassificationComponent extends React.FC {
  Metadata: ComponentMetadata;
}

const CatalogClassification: React.FC = () => (
  <PlaceholderPage
    icon="mdi:bookshelf"
    title="Catalog & Classification"
    description="Browse and manage the item catalog and its classification hierarchy. This dashboard is coming soon."
  />
);

(CatalogClassification as CatalogClassificationComponent).Metadata = METADATA;

export default CatalogClassification;
