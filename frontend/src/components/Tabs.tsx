import React, { createContext, useContext, useState, useId } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../types';

// ============================================
// Context
// ============================================

interface TabsContextValue {
  activeTab: string;
  setActiveTab: (value: string) => void;
  variant: 'underline' | 'pills' | 'bordered';
  size: 'xs' | 'sm' | 'md' | 'lg';
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

const useTabsContext = () => {
  const context = useContext(TabsContext);
  if (!context) {
    throw new Error('Tabs components must be used within a <Tabs> provider');
  }
  return context;
};

// ============================================
// Tabs Root
// ============================================

interface TabsProps {
  /**
   * Default active tab value
   */
  defaultValue?: string;
  /**
   * Controlled active tab value
   */
  value?: string;
  /**
   * Callback when tab changes
   */
  onValueChange?: (value: string) => void;
  /**
   * Tab style variant
   */
  variant?: 'underline' | 'pills' | 'bordered';
  /**
   * Tab size
   */
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /**
   * Additional CSS classes
   */
  className?: string;
  /**
   * Children components
   */
  children?: React.ReactNode;
}

// Default content when no children provided
const DefaultTabsContent = () => (
  <>
    <TabsList>
      <TabsTrigger value="tab1">Tab 1</TabsTrigger>
      <TabsTrigger value="tab2">Tab 2</TabsTrigger>
      <TabsTrigger value="tab3">Tab 3</TabsTrigger>
    </TabsList>
    <TabsContent value="tab1">
      <div className="p-4 bg-base-200 rounded-lg">Content for Tab 1</div>
    </TabsContent>
    <TabsContent value="tab2">
      <div className="p-4 bg-base-200 rounded-lg">Content for Tab 2</div>
    </TabsContent>
    <TabsContent value="tab3">
      <div className="p-4 bg-base-200 rounded-lg">Content for Tab 3</div>
    </TabsContent>
  </>
);

const Tabs: React.FC<TabsProps> & {
  List: typeof TabsList;
  Trigger: typeof TabsTrigger;
  Content: typeof TabsContent;
  Metadata: ComponentMetadata;
} = ({
  defaultValue = 'tab1',
  value,
  onValueChange,
  variant = 'underline',
  size = 'md',
  className = '',
  children,
}) => {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const baseId = useId().replace(/:/g, '');

  const activeTab = value ?? internalValue;

  const setActiveTab = (newValue: string) => {
    if (!value) {
      setInternalValue(newValue);
    }
    onValueChange?.(newValue);
  };

  return (
    <TabsContext.Provider value={{ activeTab, setActiveTab, variant, size, baseId }}>
      <div className={`w-full ${className}`}>
        {children || <DefaultTabsContent />}
      </div>
    </TabsContext.Provider>
  );
};

// ============================================
// TabsList
// ============================================

interface TabsListProps {
  /**
   * Tab alignment
   */
  alignment?: 'start' | 'center' | 'end';
  /**
   * Full width tabs
   */
  fullWidth?: boolean;
  /**
   * Additional CSS classes
   */
  className?: string;
  /**
   * Children (TabsTrigger components)
   */
  children: React.ReactNode;
}

const TabsList: React.FC<TabsListProps> = ({
  alignment = 'start',
  fullWidth = false,
  className = '',
  children,
}) => {
  const { variant } = useTabsContext();

  const alignmentClasses = {
    start: 'justify-start',
    center: 'justify-center',
    end: 'justify-end',
  };

  // Underline variant
  if (variant === 'underline') {
    return (
      <div
        role="tablist"
        className={`flex ${alignmentClasses[alignment]} border-b border-base-300 ${fullWidth ? 'w-full' : ''} ${className}`}
      >
        {React.Children.map(children, (child) => {
          if (React.isValidElement(child)) {
            return React.cloneElement(child as React.ReactElement<any>, { fullWidth });
          }
          return child;
        })}
      </div>
    );
  }

  // Pills variant
  if (variant === 'pills') {
    return (
      <div
        role="tablist"
        className={`flex ${alignmentClasses[alignment]} gap-1 p-1 bg-base-200 rounded-lg ${fullWidth ? 'w-full' : 'w-fit'} ${className}`}
      >
        {React.Children.map(children, (child) => {
          if (React.isValidElement(child)) {
            return React.cloneElement(child as React.ReactElement<any>, { fullWidth });
          }
          return child;
        })}
      </div>
    );
  }

  // Bordered variant - simple bottom border
  const tabListClasses = [
    'tabs',
    variant === 'bordered' ? 'tabs-bordered' : '',
    fullWidth ? 'w-full' : '',
    alignmentClasses[alignment],
    className,
  ].filter(Boolean).join(' ');

  return (
    <div role="tablist" className={tabListClasses}>
      {React.Children.map(children, (child) => {
        if (React.isValidElement(child)) {
          return React.cloneElement(child as React.ReactElement<any>, { fullWidth });
        }
        return child;
      })}
    </div>
  );
};

// ============================================
// TabsTrigger
// ============================================

interface TabsTriggerProps {
  /**
   * Unique value for this tab
   */
  value: string;
  /**
   * Whether the tab is disabled
   */
  disabled?: boolean;
  /**
   * Icon (iconify icon name)
   */
  icon?: string;
  /**
   * Additional CSS classes
   */
  className?: string;
  /**
   * Full width (passed from TabsList)
   */
  fullWidth?: boolean;
  /**
   * Children (tab label)
   */
  children: React.ReactNode;
}

const TabsTrigger: React.FC<TabsTriggerProps> = ({
  value,
  disabled = false,
  icon,
  className = '',
  fullWidth = false,
  children,
}) => {
  const { activeTab, setActiveTab, variant, size, baseId } = useTabsContext();
  const isActive = activeTab === value;

  // Size classes for custom variants
  const sizeClasses = {
    xs: 'text-xs py-1.5 px-2.5',
    sm: 'text-sm py-2 px-3',
    md: 'text-sm py-2.5 px-4',
    lg: 'text-base py-3 px-5',
  };

  // DaisyUI size classes
  const daisySizeClasses = {
    xs: 'tab-xs',
    sm: 'tab-sm',
    md: '',
    lg: 'tab-lg',
  };

  const handleClick = () => {
    if (!disabled) {
      setActiveTab(value);
    }
  };

  // Underline variant
  if (variant === 'underline') {
    return (
      <button
        role="tab"
        id={`${baseId}-tab-${value}`}
        aria-controls={`${baseId}-panel-${value}`}
        aria-selected={isActive}
        disabled={disabled}
        onClick={handleClick}
        className={`
          relative flex items-center gap-2 ${sizeClasses[size]} font-medium transition-colors
          ${fullWidth ? 'flex-1 justify-center' : ''}
          ${disabled
            ? 'text-base-content/30 cursor-not-allowed'
            : isActive
              ? 'text-primary'
              : 'text-base-content/60 hover:text-base-content'
          }
          ${className}
        `}
      >
        {icon && <Icon icon={icon} className="w-4 h-4" />}
        {children}
        {isActive && (
          <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-t-full" />
        )}
      </button>
    );
  }

  // Pills variant
  if (variant === 'pills') {
    return (
      <button
        role="tab"
        id={`${baseId}-tab-${value}`}
        aria-controls={`${baseId}-panel-${value}`}
        aria-selected={isActive}
        disabled={disabled}
        onClick={handleClick}
        className={`
          flex items-center gap-2 ${sizeClasses[size]} font-medium rounded-md transition-all
          ${fullWidth ? 'flex-1 justify-center' : ''}
          ${disabled
            ? 'text-base-content/30 cursor-not-allowed'
            : isActive
              ? 'bg-base-100 text-base-content shadow-sm'
              : 'text-base-content/60 hover:text-base-content'
          }
          ${className}
        `}
      >
        {icon && <Icon icon={icon} className="w-4 h-4" />}
        {children}
      </button>
    );
  }

  // Bordered variant - DaisyUI native tabs
  const tabClasses = [
    'tab gap-2',
    daisySizeClasses[size],
    isActive ? 'tab-active' : '',
    disabled ? 'tab-disabled' : '',
    fullWidth ? 'flex-1' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button
      role="tab"
      id={`${baseId}-tab-${value}`}
      aria-controls={`${baseId}-panel-${value}`}
      aria-selected={isActive}
      disabled={disabled}
      onClick={handleClick}
      className={tabClasses}
    >
      {icon && <Icon icon={icon} className="w-4 h-4" />}
      {children}
    </button>
  );
};

// ============================================
// TabsContent
// ============================================

interface TabsContentProps {
  /**
   * Value matching the TabsTrigger
   */
  value: string;
  /**
   * Additional CSS classes
   */
  className?: string;
  /**
   * Children (tab content)
   */
  children: React.ReactNode;
}

const TabsContent: React.FC<TabsContentProps> = ({
  value,
  className = '',
  children,
}) => {
  const { activeTab, baseId } = useTabsContext();
  const isActive = activeTab === value;

  if (!isActive) {
    return null;
  }

  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-tab-${value}`}
      className={`mt-6 ${className}`}
    >
      {children}
    </div>
  );
};

// ============================================
// Metadata
// ============================================

const METADATA: ComponentMetadata = {
  id: 'generic-tabs',
  name: 'Tabs',
  displayName: 'Display tabbed content',
  isDisplayComp: true,
  type: 'Tabs',
  description: 'A compound component for tabbed content using DaisyUI. Includes Tabs, Tabs.List, Tabs.Trigger, and Tabs.Content for maximum flexibility.',
  category: 'display',
  keywords: ['tabs', 'navigation', 'content', 'panels', 'sections', 'compound'],
  props: {
    'Tabs': {
      defaultValue: 'Initial active tab value (required)',
      value: 'Controlled active tab value (optional)',
      onValueChange: 'Callback when tab changes',
      variant: '"underline" (default) | "pills" | "bordered"',
      size: '"xs" | "sm" | "md" (default) | "lg"',
      className: 'Additional CSS classes',
    },
    'Tabs.List': {
      alignment: '"start" (default) | "center" | "end"',
      fullWidth: 'Whether tabs take full width (default: false)',
      className: 'Additional CSS classes',
    },
    'Tabs.Trigger': {
      value: 'Unique value for this tab (required)',
      disabled: 'Whether tab is disabled (default: false)',
      icon: 'Iconify icon name (optional)',
      className: 'Additional CSS classes',
    },
    'Tabs.Content': {
      value: 'Value matching the TabsTrigger (required)',
      className: 'Additional CSS classes',
    },
  },
};

// ============================================
// Attach sub-components and metadata
// ============================================

Tabs.List = TabsList;
Tabs.Trigger = TabsTrigger;
Tabs.Content = TabsContent;
Tabs.Metadata = METADATA;

export { TabsList, TabsTrigger, TabsContent };
export default Tabs;
