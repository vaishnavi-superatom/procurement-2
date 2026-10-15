import React, { forwardRef } from 'react';
import type { ComponentMetadata } from '../types';

type CheckboxSize = 'xs' | 'sm' | 'md' | 'lg';

interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size' | 'type'> {
  size?: CheckboxSize;
  label?: string;
  labelPosition?: 'left' | 'right';
  helperText?: string;
  error?: string;
}

const METADATA: ComponentMetadata = {
  id: 'generic-checkbox',
  name: 'Checkbox',
  displayName: 'Checkbox input',
  isDisplayComp: true,
  type: 'Checkbox',
  description: 'A checkbox component using DaisyUI. Style with className for colors.',
  category: 'input',
  keywords: ['checkbox', 'check', 'toggle', 'form', 'input', 'boolean'],
  props: {
    size: '"xs" | "sm" | "md" (default) | "lg"',
    label: 'Label text',
    labelPosition: '"left" | "right" (default)',
    helperText: 'Helper text below',
    error: 'Error message',
    checked: 'Controlled checked state',
    defaultChecked: 'Default checked state',
    disabled: 'Disable the checkbox',
    onChange: 'Change handler',
    id: 'Checkbox id (required for label)',
    className: 'Additional CSS classes (use checkbox-primary, checkbox-secondary, etc.)',
  },
};

interface CheckboxComponent extends React.ForwardRefExoticComponent<CheckboxProps & React.RefAttributes<HTMLInputElement>> {
  Metadata: ComponentMetadata;
  Group: typeof CheckboxGroup;
}

const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(({
  size = 'md',
  label = 'Checkbox label',
  labelPosition = 'right',
  helperText,
  error,
  disabled = false,
  className = 'checkbox-primary',
  id = 'default-checkbox',
  ...props
}, ref) => {
  const sizeClasses: Record<CheckboxSize, string> = {
    xs: 'checkbox-xs',
    sm: 'checkbox-sm',
    md: '',
    lg: 'checkbox-lg',
  };

  const checkboxClasses = [
    'checkbox',
    sizeClasses[size],
    error ? 'checkbox-error' : '',
    className,
  ].filter(Boolean).join(' ');

  const checkbox = (
    <input
      ref={ref}
      id={id}
      type="checkbox"
      disabled={disabled}
      className={checkboxClasses}
      {...props}
    />
  );

  // No label - just return checkbox
  if (!label) {
    return (
      <div className="form-control">
        {checkbox}
        {(helperText || error) && (
          <span className={`label-text-alt mt-1 ${error ? 'text-error' : 'text-base-content/60'}`}>
            {error || helperText}
          </span>
        )}
      </div>
    );
  }

  // With label
  return (
    <div className="form-control">
      <label
        htmlFor={id}
        className={`label cursor-pointer justify-start gap-3 ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        {labelPosition === 'left' && <span className="label-text">{label}</span>}
        {checkbox}
        {labelPosition === 'right' && <span className="label-text">{label}</span>}
      </label>
      {(helperText || error) && (
        <span className={`label-text-alt ml-7 ${error ? 'text-error' : 'text-base-content/60'}`}>
          {error || helperText}
        </span>
      )}
    </div>
  );
}) as CheckboxComponent;

// ============================================
// Checkbox Group
// ============================================

interface CheckboxGroupProps {
  children: React.ReactNode;
  label?: string;
  helperText?: string;
  error?: string;
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}

const CheckboxGroup: React.FC<CheckboxGroupProps> = ({
  children,
  label,
  helperText,
  error,
  orientation = 'vertical',
  className = '',
}) => {
  return (
    <div className={`form-control ${className}`}>
      {label && (
        <span className="label-text font-medium mb-2">{label}</span>
      )}
      <div className={`flex ${orientation === 'vertical' ? 'flex-col gap-1' : 'flex-row flex-wrap gap-4'}`}>
        {children}
      </div>
      {(helperText || error) && (
        <span className={`label-text-alt mt-2 ${error ? 'text-error' : 'text-base-content/60'}`}>
          {error || helperText}
        </span>
      )}
    </div>
  );
};

Checkbox.displayName = 'Checkbox';
Checkbox.Metadata = METADATA;
Checkbox.Group = CheckboxGroup;

export { CheckboxGroup };
export default Checkbox;
