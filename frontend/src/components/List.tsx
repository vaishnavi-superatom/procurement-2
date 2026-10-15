import React from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../types';

// Types for different list variants
interface BaseItem {
  content: React.ReactNode;
}

interface DescriptionItem {
  term: string;
  description: React.ReactNode;
}

interface ChecklistItem {
  label: string;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
}

interface TimelineItem {
  title: string;
  content?: React.ReactNode;
  time?: string;
  icon?: string;
  color?: 'primary' | 'secondary' | 'accent' | 'success' | 'warning' | 'error';
}

interface StepItem {
  label: string;
  content?: React.ReactNode;
  icon?: string;
}

type ListVariant = 'unordered' | 'ordered' | 'description' | 'checklist' | 'timeline' | 'steps';

interface ListProps {
  variant: ListVariant;
  items: (string | BaseItem | DescriptionItem | ChecklistItem | TimelineItem | StepItem)[];
  currentStep?: number;
  horizontal?: boolean;
  className?: string;
}

const METADATA: ComponentMetadata = {
  id: 'generic-list',
  name: 'List',
  displayName: 'List component with multiple variants',
  isDisplayComp: true,
  type: 'List',
  description: 'Versatile list component supporting ordered, unordered, description, checklist, timeline, and steps.',
  category: 'display',
  keywords: ['list', 'ordered', 'unordered', 'timeline', 'steps', 'checklist'],
  props: {
    variant: '"unordered" | "ordered" | "description" | "checklist" | "timeline" | "steps"',
    items: 'Array of items (format depends on variant)',
    currentStep: 'Active step index for steps variant',
    horizontal: 'Horizontal layout for timeline/steps',
    className: 'Additional CSS classes',
  },
};

interface ListComponent extends React.FC<ListProps> {
  Metadata: ComponentMetadata;
}

const DEFAULT_ITEMS = ['First item', 'Second item', 'Third item', 'Fourth item'];

const List: ListComponent = ({
  variant = 'unordered',
  items = DEFAULT_ITEMS,
  currentStep = 0,
  horizontal = false,
  className = '',
}) => {
  // Helper to get string content
  const getContent = (item: string | BaseItem): React.ReactNode => {
    return typeof item === 'string' ? item : (item as BaseItem).content;
  };

  // Unordered List
  if (variant === 'unordered') {
    return (
      <ul className={`list-disc list-inside space-y-1 text-base-content ${className}`}>
        {items.map((item, index) => (
          <li key={index}>{getContent(item as string | BaseItem)}</li>
        ))}
      </ul>
    );
  }

  // Ordered List
  if (variant === 'ordered') {
    return (
      <ol className={`list-decimal list-inside space-y-1 text-base-content ${className}`}>
        {items.map((item, index) => (
          <li key={index}>{getContent(item as string | BaseItem)}</li>
        ))}
      </ol>
    );
  }

  // Description List
  if (variant === 'description') {
    return (
      <dl className={`space-y-4 ${className}`}>
        {(items as DescriptionItem[]).map((item, index) => (
          <div key={index}>
            <dt className="font-semibold text-base-content">{item.term}</dt>
            <dd className="ml-4 text-base-content/80">{item.description}</dd>
          </div>
        ))}
      </dl>
    );
  }

  // Checklist
  if (variant === 'checklist') {
    return (
      <ul className={`space-y-2 ${className}`}>
        {(items as ChecklistItem[]).map((item, index) => (
          <li key={index} className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={item.checked}
              onChange={(e) => item.onChange?.(e.target.checked)}
              className="checkbox checkbox-primary"
            />
            <span className={item.checked ? 'line-through text-base-content/50' : 'text-base-content'}>
              {item.label}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  // Timeline
  if (variant === 'timeline') {
    const timelineItems = items as TimelineItem[];
    return (
      <ul className={`timeline ${horizontal ? 'timeline-horizontal' : 'timeline-vertical'} ${className}`}>
        {timelineItems.map((item, index) => (
          <li key={index}>
            {index > 0 && <hr className={item.color ? `bg-${item.color}` : ''} />}

            {!horizontal && item.time && (
              <div className="timeline-start text-base-content/60">{item.time}</div>
            )}

            <div className="timeline-middle">
              {item.icon ? (
                <Icon icon={item.icon} className={`w-5 h-5 ${item.color ? `text-${item.color}` : 'text-primary'}`} />
              ) : (
                <div className={`w-3 h-3 rounded-full ${item.color ? `bg-${item.color}` : 'bg-primary'}`} />
              )}
            </div>

            <div className="timeline-end timeline-box">
              <div className="font-semibold">{item.title}</div>
              {horizontal && item.time && (
                <div className="text-sm text-base-content/60">{item.time}</div>
              )}
              {item.content && <div className="text-base-content/80">{item.content}</div>}
            </div>

            {index < timelineItems.length - 1 && <hr className={item.color ? `bg-${item.color}` : ''} />}
          </li>
        ))}
      </ul>
    );
  }

  // Steps
  if (variant === 'steps') {
    const stepItems = items as StepItem[];
    return (
      <ul className={`steps ${horizontal ? '' : 'steps-vertical'} w-full ${className}`}>
        {stepItems.map((item, index) => (
          <li
            key={index}
            className={`step ${index <= currentStep ? 'step-primary' : ''}`}
            data-content={item.icon || (index <= currentStep ? '✓' : index + 1)}
          >
            <div className={horizontal ? '' : 'text-left py-2'}>
              <div className="font-medium">{item.label}</div>
              {item.content && <div className="text-sm text-base-content/60">{item.content}</div>}
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return null;
};

List.Metadata = METADATA;

export default List;
