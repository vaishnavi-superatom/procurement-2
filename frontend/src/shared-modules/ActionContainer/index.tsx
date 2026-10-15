import React from 'react';
import ActionButton from '../ActionButton';
 
export interface Action {
  /** Unique identifier for the action */
  id: string;
 
  /** Display label for the action */
  label: string;
 
  /** Click handler for the action */
  onClick: () => void;
 
  /** Button variant/style */
  variant?: 'primary' | 'secondary' | 'danger' | 'success';
 
  /** Button size */
  size?: 'small' | 'medium' | 'large';
 
  /** Icon/emoji for the button */
  icon?: string;
 
  /** Whether the action is disabled */
  disabled?: boolean;
 
  /** Loading state for the action */
  isLoading?: boolean;
}
 
export interface ActionContainerProps {
  /** Array of actions to display */
  actions: Action[];
 
  /** Layout direction */
  direction?: 'row' | 'column';
 
  /** Space between action buttons */
  gap?: string;
 
  /** Justify content alignment */
  justifyContent?: 'flex-start' | 'flex-end' | 'center' | 'space-between' | 'space-around';
 
  /** Custom className */
  className?: string;
 
  /** Custom style object */
  style?: React.CSSProperties;
}
 
const ActionContainer: React.FC<ActionContainerProps> = ({
  actions,
  direction = 'row',
  gap,
  justifyContent = 'flex-start',
  className = '',
  style = {},
}) => {
  // Don't render if no actions
  if (!actions || actions.length === 0) {
    return null;
  }
 
 
  // Map justifyContent to Tailwind classes
  const justifyMap: Record<string, string> = {
    'flex-start': 'justify-start',
    'flex-end': 'justify-end',
    'center': 'justify-center',
    'space-between': 'justify-between',
    'space-around': 'justify-around',
  };

  const justifyClass = justifyMap[justifyContent] || 'justify-start';

  return (
    <>
      <style>{`
        .actions-container {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }
        @media (min-width: 1024px) {
          .actions-container {
            flex-direction: row;
          }
        }
      `}</style>

      <div
        className="w-full flex flex-col gap-6 border border-base-300 bg-base-100 rounded-xl p-2"
        style={style}
      >
        <div>
          <h3 className="text-base-400">Follow Up Questions</h3>
        </div>
        <div className={`actions-container items-stretch ${justifyClass} transition-all`}>
          {actions.slice(0, 3).map((action) => (
            <ActionButton
              key={action.id}
              label={action.label}
              onClick={action.onClick}
              variant={action.variant || 'primary'}
              size={action.size || 'medium'}
              icon={action.icon}
              disabled={action.disabled}
              isLoading={action.isLoading}
            />
          ))}
        </div>
      </div>
    </>
  );
};
 
export default ActionContainer;