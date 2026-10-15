import React, { forwardRef } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../types';

type InputType = 'text' | 'email' | 'password' | 'number' | 'tel' | 'url' | 'search';
type InputSize = 'xs' | 'sm' | 'md' | 'lg';

interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  type?: InputType;
  size?: InputSize;
  label?: string;
  labelInline?: boolean;
  labelWidth?: string;
  helperText?: string;
  error?: string;
  leftIcon?: string;
  rightIcon?: string;
  onRightIconClick?: () => void;
}

const METADATA: ComponentMetadata = {
  id: 'generic-input',
  name: 'Input',
  displayName: 'Text input field',
  isDisplayComp: true,
  type: 'Input',
  description: 'A flexible input component using DaisyUI. Supports various types and sizes with optional icons.',
  category: 'input',
  keywords: ['input', 'text', 'field', 'form', 'email', 'password'],
  props: {
    type: '"text" (default) | "email" | "password" | "number" | "tel" | "url" | "search"',
    size: '"xs" | "sm" | "md" (default) | "lg"',
    label: 'Label text',
    labelInline: 'Show label inline with input (default: false)',
    labelWidth: 'Width of inline label (default: "w-24")',
    placeholder: 'Placeholder text',
    helperText: 'Helper text below input',
    error: 'Error message (also styles input as error)',
    leftIcon: 'Iconify icon name for left side',
    rightIcon: 'Iconify icon name for right side',
    onRightIconClick: 'Callback when right icon is clicked',
    disabled: 'Disable the input',
    className: 'Additional CSS classes',
  },
};

interface InputComponent extends React.ForwardRefExoticComponent<InputProps & React.RefAttributes<HTMLInputElement>> {
  Metadata: ComponentMetadata;
}

const Input = forwardRef<HTMLInputElement, InputProps>(({
  type = 'text',
  size = 'md',
  label = 'Label',
  labelInline = false,
  labelWidth = 'w-24',
  helperText,
  error,
  leftIcon = 'mdi:text',
  rightIcon,
  onRightIconClick,
  disabled = false,
  className = '',
  id,
  placeholder = 'Enter text...',
  ...props
}, ref) => {
  // Size classes
  const sizeClasses: Record<InputSize, string> = {
    xs: 'input-xs',
    sm: 'input-sm',
    md: '',
    lg: 'input-lg',
  };

  // Icon size and positioning based on input size
  const iconConfig: Record<InputSize, { size: string; left: string; right: string }> = {
    xs: { size: 'w-3 h-3', left: 'left-2', right: 'right-2' },
    sm: { size: 'w-4 h-4', left: 'left-2.5', right: 'right-2.5' },
    md: { size: 'w-5 h-5', left: 'left-3', right: 'right-3' },
    lg: { size: 'w-6 h-6', left: 'left-4', right: 'right-4' },
  };

  const paddingLeft: Record<InputSize, string> = {
    xs: 'pl-7',
    sm: 'pl-9',
    md: 'pl-10',
    lg: 'pl-12',
  };

  const paddingRight: Record<InputSize, string> = {
    xs: 'pr-7',
    sm: 'pr-9',
    md: 'pr-10',
    lg: 'pr-12',
  };

  // Build input classes
  const inputClasses = [
    'input',
    'input-bordered',
    'w-full',
    'outline-none',
    'focus:outline-none',
    'bg-base-100',
    sizeClasses[size],
    error ? 'input-error' : '',
    leftIcon ? paddingLeft[size] : '',
    rightIcon ? paddingRight[size] : '',
    className,
  ].filter(Boolean).join(' ');

  const { size: iconSize, left: iconLeft, right: iconRight } = iconConfig[size];

  const inputField = (
    <div className={labelInline ? 'flex-1' : ''}>
      {/* Input with icons */}
      <div className="relative">
        {/* Left Icon */}
        {leftIcon && (
          <div className={`absolute ${iconLeft} top-1/2 -translate-y-1/2 z-10 text-base-content pointer-events-none`}>
            <Icon icon={leftIcon} className={iconSize} />
          </div>
        )}

        {/* Input */}
        <input
          ref={ref}
          id={id}
          type={type}
          disabled={disabled}
          placeholder={placeholder}
          className={inputClasses}
          {...props}
        />

        {/* Right Icon */}
        {rightIcon && (
          <button
            type="button"
            onClick={onRightIconClick}
            disabled={disabled || !onRightIconClick}
            className={`absolute ${iconRight} top-1/2 -translate-y-1/2 z-10 text-base-content ${onRightIconClick ? 'cursor-pointer hover:text-primary' : ''}`}
          >
            <Icon icon={rightIcon} className={iconSize} />
          </button>
        )}
      </div>

      {/* Helper/Error Text */}
      {(helperText || error) && (
        <label className="label py-1">
          <span className={`label-text-alt ${error ? 'text-error' : ''}`}>
            {error || helperText}
          </span>
        </label>
      )}
    </div>
  );

  // Inline layout
  if (labelInline && label) {
    return (
      <div className="flex items-center gap-3 w-full">
        <label className={`label-text flex-shrink-0 ${labelWidth}`} htmlFor={id}>
          {label}
        </label>
        {inputField}
      </div>
    );
  }

  // Stacked layout (default)
  return (
    <div className="form-control w-full">
      {/* Label */}
      {label && (
        <label className="label py-1" htmlFor={id}>
          <span className="label-text">{label}</span>
        </label>
      )}
      {inputField}
    </div>
  );
}) as InputComponent;

Input.displayName = 'Input';
Input.Metadata = METADATA;

export default Input;
