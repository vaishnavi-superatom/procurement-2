import React, { forwardRef, useState, useEffect, useRef } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../types';

type TextareaSize = 'xs' | 'sm' | 'md' | 'lg';

interface TextareaProps extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'size'> {
  size?: TextareaSize;
  label?: string;
  labelInline?: boolean;
  labelWidth?: string;
  helperText?: string;
  error?: string;
  showCharCount?: boolean;
  maxLength?: number;
  autoResize?: boolean;
  minRows?: number;
  maxRows?: number;
  icon?: string;
}

const METADATA: ComponentMetadata = {
  id: 'generic-textarea',
  name: 'Textarea',
  displayName: 'Multi-line text input',
  isDisplayComp: true,
  type: 'Textarea',
  description: 'A flexible textarea component using DaisyUI. Supports auto-resize, character count, and validation states.',
  category: 'input',
  keywords: ['textarea', 'text', 'multiline', 'field', 'form', 'input', 'description', 'comment'],
  props: {
    size: '"xs" | "sm" | "md" (default) | "lg"',
    label: 'Label text',
    labelInline: 'Show label inline with textarea (default: false)',
    labelWidth: 'Width of inline label (default: "w-24")',
    placeholder: 'Placeholder text',
    helperText: 'Helper text below textarea',
    error: 'Error message (also styles textarea as error)',
    showCharCount: 'Show character count (default: false)',
    maxLength: 'Maximum character length',
    autoResize: 'Auto-resize based on content (default: false)',
    minRows: 'Minimum number of rows (default: 3)',
    maxRows: 'Maximum number of rows when auto-resizing (default: 10)',
    icon: 'Iconify icon name for top-left corner',
    disabled: 'Disable the textarea',
    className: 'Additional CSS classes',
  },
};

interface TextareaComponent extends React.ForwardRefExoticComponent<TextareaProps & React.RefAttributes<HTMLTextAreaElement>> {
  Metadata: ComponentMetadata;
}

const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(({
  size = 'md',
  label,
  labelInline = false,
  labelWidth = 'w-24',
  helperText,
  error,
  showCharCount = false,
  maxLength,
  autoResize = false,
  minRows = 3,
  maxRows = 10,
  icon,
  disabled = false,
  className = '',
  id,
  placeholder = 'Enter text...',
  value,
  defaultValue,
  onChange,
  ...props
}, ref) => {
  const [charCount, setCharCount] = useState(0);
  const internalRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = (ref as React.RefObject<HTMLTextAreaElement>) || internalRef;

  // Size classes for textarea
  const sizeClasses: Record<TextareaSize, string> = {
    xs: 'textarea-xs text-xs',
    sm: 'textarea-sm text-sm',
    md: 'text-base',
    lg: 'textarea-lg text-lg',
  };

  // Row heights based on size
  const rowHeights: Record<TextareaSize, number> = {
    xs: 16,
    sm: 20,
    md: 24,
    lg: 28,
  };

  // Icon configuration
  const iconConfig: Record<TextareaSize, { size: string; position: string }> = {
    xs: { size: 'w-3 h-3', position: 'top-2 left-2' },
    sm: { size: 'w-4 h-4', position: 'top-2.5 left-2.5' },
    md: { size: 'w-5 h-5', position: 'top-3 left-3' },
    lg: { size: 'w-6 h-6', position: 'top-4 left-4' },
  };

  const paddingLeft: Record<TextareaSize, string> = {
    xs: 'pl-7',
    sm: 'pl-9',
    md: 'pl-10',
    lg: 'pl-12',
  };

  // Auto-resize effect
  useEffect(() => {
    if (autoResize && textareaRef.current) {
      const textarea = textareaRef.current;
      const lineHeight = rowHeights[size];
      const minHeight = minRows * lineHeight + 16; // 16px for padding
      const maxHeight = maxRows * lineHeight + 16;

      textarea.style.height = 'auto';
      const scrollHeight = textarea.scrollHeight;
      textarea.style.height = `${Math.min(Math.max(scrollHeight, minHeight), maxHeight)}px`;
    }
  }, [value, defaultValue, autoResize, size, minRows, maxRows]);

  // Update character count
  useEffect(() => {
    const currentValue = value?.toString() || defaultValue?.toString() || '';
    setCharCount(currentValue.length);
  }, [value, defaultValue]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setCharCount(e.target.value.length);

    if (autoResize && textareaRef.current) {
      const textarea = textareaRef.current;
      const lineHeight = rowHeights[size];
      const minHeight = minRows * lineHeight + 16;
      const maxHeight = maxRows * lineHeight + 16;

      textarea.style.height = 'auto';
      const scrollHeight = textarea.scrollHeight;
      textarea.style.height = `${Math.min(Math.max(scrollHeight, minHeight), maxHeight)}px`;
    }

    onChange?.(e);
  };

  // Build textarea classes
  const textareaClasses = [
    'textarea',
    'textarea-bordered',
    'w-full',
    'outline-none',
    'focus:outline-none',
    'bg-base-100',
    sizeClasses[size],
    error ? 'textarea-error' : '',
    icon ? paddingLeft[size] : '',
    autoResize ? 'resize-none overflow-hidden' : 'resize-y',
    className,
  ].filter(Boolean).join(' ');

  const { size: iconSize, position: iconPosition } = iconConfig[size];

  const textareaField = (
    <div className={labelInline ? 'flex-1' : ''}>
      {/* Textarea with optional icon */}
      <div className="relative">
        {/* Icon */}
        {icon && (
          <div className={`absolute ${iconPosition} z-10 text-base-content/50 pointer-events-none`}>
            <Icon icon={icon} className={iconSize} />
          </div>
        )}

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          id={id}
          disabled={disabled}
          placeholder={placeholder}
          className={textareaClasses}
          rows={autoResize ? minRows : minRows}
          maxLength={maxLength}
          value={value}
          defaultValue={defaultValue}
          onChange={handleChange}
          {...props}
        />
      </div>

      {/* Helper/Error Text & Character Count */}
      {(helperText || error || showCharCount) && (
        <label className="label py-1">
          <span className={`label-text-alt ${error ? 'text-error' : ''}`}>
            {error || helperText}
          </span>
          {showCharCount && (
            <span className={`label-text-alt ${maxLength && charCount >= maxLength ? 'text-error' : ''}`}>
              {charCount}{maxLength ? `/${maxLength}` : ''}
            </span>
          )}
        </label>
      )}
    </div>
  );

  // Inline layout
  if (labelInline && label) {
    return (
      <div className="flex items-start gap-3 w-full">
        <label className={`label-text flex-shrink-0 ${labelWidth} pt-3`} htmlFor={id}>
          {label}
        </label>
        {textareaField}
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
      {textareaField}
    </div>
  );
}) as TextareaComponent;

Textarea.displayName = 'Textarea';
Textarea.Metadata = METADATA;

export default Textarea;
