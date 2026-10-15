import { useState } from 'react';
import { Icon } from '@iconify/react';
import DynamicBarChart from '../shared-modules/DynamicBarChart';
import DynamicDataTable from '../shared-modules/DynamicDataTable';
import DynamicKPICard from '../shared-modules/DynamicKPICard';
import DynamicLineChart from '../shared-modules/DynamicLineChart';
import DynamicPieChart from '../shared-modules/DynamicPieChart';
import DynamicForm from '../shared-modules/DynamicForm';
import DynamicLeafletMapView from '../shared-modules/DynamicLeafletMapView';
import type { ComponentMetadata } from '../types';

// Get metadata from each component
const AVAILABLE_COMPONENTS = [
  { Component: DynamicKPICard, metadata: (DynamicKPICard as any).Metadata as ComponentMetadata },
  { Component: DynamicLeafletMapView, metadata: (DynamicLeafletMapView as any).Metadata as ComponentMetadata },
  { Component: DynamicBarChart, metadata: (DynamicBarChart as any).Metadata as ComponentMetadata },
  { Component: DynamicLineChart, metadata: (DynamicLineChart as any).Metadata as ComponentMetadata },
  { Component: DynamicPieChart, metadata: (DynamicPieChart as any).Metadata as ComponentMetadata },
  { Component: DynamicDataTable, metadata: (DynamicDataTable as any).Metadata as ComponentMetadata },
  { Component: DynamicForm, metadata: (DynamicForm as any).Metadata as ComponentMetadata },
];

const Showcase = () => {
  const [activeComponentId, setActiveComponentId] = useState<string>(
    AVAILABLE_COMPONENTS[0]?.metadata?.id || ''
  );

  // Get the active component
  const activeComponent = AVAILABLE_COMPONENTS.find(c => c.metadata.id === activeComponentId);

  // Helper function to get icon for component type
  const getIconForType = (type: string): string => {
    const iconMap: Record<string, string> = {
      'KPICard': 'mdi:chart-box',
      'BarChart': 'mdi:chart-bar',
      'LineChart': 'mdi:chart-line',
      'PieChart': 'mdi:chart-pie',
      'DataTable': 'mdi:table',
      'Container': 'mdi:view-dashboard',
      'FormLayout': 'mdi:form-select',
    };
    return iconMap[type] || 'mdi:cube-outline';
  };

  return (
    <div className="min-h-screen bg-[#F8F9FB]">
      {/* Header */}
      <div className="bg-white border-b border-[#E2E8F0] sticky top-0 z-20 shadow-sm">
        <div className="max-w-7xl mx-auto px-8 py-6">
          <div className="flex items-center gap-4 mb-2">
            <Icon icon="mdi:view-dashboard" className="w-8 h-8 text-[#4A7FFF]" />
            <div>
              <h1 className="text-3xl font-bold text-[#1E293B]">IKEA Data Visualization Components</h1>
              <p className="text-sm text-[#64748B] mt-1">
                Explore all available modules and components
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-8 py-8">
        <div className="grid grid-cols-12 gap-6">
          {/* Sidebar Navigation */}
          <div className="col-span-12 lg:col-span-3">
            <div className="bg-white rounded-xl border border-[#E2E8F0] p-4 sticky top-32">
              <h3 className="text-xs font-semibold text-[#94A3B8] uppercase tracking-wide mb-3 px-2">
                Components
              </h3>
              <div className="space-y-1">
                {AVAILABLE_COMPONENTS.map((item) => (
                  <button
                    key={item.metadata.id}
                    onClick={() => setActiveComponentId(item.metadata.id)}
                    className={`w-full text-left px-4 py-3 rounded-lg transition-all duration-200 flex items-center gap-3 ${
                      activeComponentId === item.metadata.id
                        ? 'bg-[#4A7FFF] text-white shadow-md'
                        : 'text-[#64748B] hover:bg-[#F1F5F9] hover:text-[#1E293B]'
                    }`}
                  >
                    <Icon
                      icon={getIconForType(item.metadata.type)}
                      className={`w-5 h-5 flex-shrink-0 ${
                        activeComponentId === item.metadata.id ? 'text-white' : 'text-[#94A3B8]'
                      }`}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{item.metadata.name}</p>
                      <p className={`text-xs truncate ${
                        activeComponentId === item.metadata.id ? 'text-white/80' : 'text-[#94A3B8]'
                      }`}>
                        {item.metadata.type}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Main Content Area */}
          <div className="col-span-12 lg:col-span-9">
            {/* Component Info Header */}
            {activeComponent && (
              <div className="bg-white rounded-xl border border-[#E2E8F0] p-6 mb-6">
                <div className="flex items-center gap-4">
                  <div
                    className="w-14 h-14 rounded-xl flex items-center justify-center bg-gradient-to-br from-[#4A7FFF] to-[#4A7FFF]/80 shadow-lg"
                  >
                    <Icon icon={getIconForType(activeComponent.metadata.type)} className="w-7 h-7 text-white" />
                  </div>
                  <div className="flex-1">
                    <h2 className="text-2xl font-bold text-[#1E293B]">{activeComponent.metadata.name}</h2>
                    <p className="text-sm text-[#64748B] mt-1">{activeComponent.metadata.description}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="px-3 py-1 rounded-full text-xs font-semibold bg-[#E0E7FF] text-[#4338CA]">
                      {activeComponent.metadata.category}
                    </span>
                  </div>
                </div>

                {/* Keywords */}
                {activeComponent.metadata.keywords && activeComponent.metadata.keywords.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-[#E2E8F0]">
                    <p className="text-xs font-medium text-[#94A3B8] uppercase tracking-wide mb-2">Keywords</p>
                    <div className="flex flex-wrap gap-2">
                      {activeComponent.metadata.keywords.map((keyword, index) => (
                        <span key={index} className="px-2 py-1 rounded text-xs bg-[#F1F5F9] text-[#64748B]">
                          {keyword}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Component Preview */}
            <div className="space-y-6">
              {activeComponent && (
                <div className="bg-gradient-to-br from-[#F8F9FB] to-[#E2E8F0] rounded-xl p-8 border border-[#E2E8F0]">
                  <div className="mb-4">
                    <h3 className="text-lg font-semibold text-[#1E293B] mb-1">Live Preview</h3>
                    <p className="text-sm text-[#64748B]">Interact with the component below</p>
                  </div>
                  <div className="bg-white rounded-lg p-6 shadow-sm">
                    {activeComponent.metadata.id === 'dynamic-form' ? (
                      <activeComponent.Component
                        
                      />
                    ) : (
                      <activeComponent.Component {...(activeComponent.metadata.props as any)} />
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Footer Info */}
            <div className="mt-8 p-4 bg-white rounded-xl border border-[#E2E8F0]">
              <p className="text-xs text-[#94A3B8] text-center">
                All components support dynamic data fetching and action handling
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Showcase;
