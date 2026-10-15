import React, { useState, useRef, useEffect, useCallback } from 'react';
import type { ComponentMetadata } from '../types';

type RangeSliderSize = 'xs' | 'sm' | 'md' | 'lg';
type RangeSliderColor = 'primary' | 'secondary' | 'accent' | 'info' | 'success' | 'warning' | 'error';

interface RangeSliderProps {
  size?: RangeSliderSize;
  color?: RangeSliderColor;
  label?: string;
  labelInline?: boolean;
  labelWidth?: string;
  helperText?: string;
  error?: string;
  // Single value mode
  value?: number;
  defaultValue?: number;
  onChange?: (value: number) => void;
  // Range mode (dual handles)
  range?: boolean;
  rangeValue?: [number, number];
  defaultRangeValue?: [number, number];
  onRangeChange?: (value: [number, number]) => void;
  // Common props
  onChangeEnd?: (value: number | [number, number]) => void;
  min?: number;
  max?: number;
  step?: number;
  showValue?: boolean;
  showMinMax?: boolean;
  showTicks?: boolean;
  tickCount?: number;
  formatValue?: (value: number) => string;
  disabled?: boolean;
  className?: string;
  id?: string;
}

const METADATA: ComponentMetadata = {
  id: 'generic-rangeslider',
  name: 'RangeSlider',
  displayName: 'Range slider input',
  isDisplayComp: true,
  type: 'RangeSlider',
  description: 'A range slider component using DaisyUI. Supports single value and dual-handle range selection.',
  category: 'input',
  keywords: ['range', 'slider', 'input', 'form', 'number', 'value', 'min', 'max'],
  props: {
    size: '"xs" | "sm" | "md" (default) | "lg"',
    color: '"primary" (default) | "secondary" | "accent" | "info" | "success" | "warning" | "error"',
    label: 'Label text',
    labelInline: 'Show label inline with slider (default: false)',
    helperText: 'Helper text below slider',
    error: 'Error message',
    value: 'Current value (single mode, controlled)',
    defaultValue: 'Default value (single mode, uncontrolled)',
    onChange: 'Callback when value changes (fires during drag)',
    range: 'Enable dual-handle range mode (default: false)',
    rangeValue: 'Current range [min, max] (range mode, controlled)',
    defaultRangeValue: 'Default range (range mode, uncontrolled)',
    onRangeChange: 'Callback when range changes (fires during drag)',
    onChangeEnd: 'Callback when drag ends (fires once on release)',
    min: 'Minimum value (default: 0)',
    max: 'Maximum value (default: 100)',
    step: 'Step increment (default: 1)',
    showValue: 'Show current value(s) above slider (default: true)',
    showMinMax: 'Show min/max labels (default: false)',
    showTicks: 'Show tick marks (default: false)',
    tickCount: 'Number of tick marks (default: 5)',
    formatValue: 'Function to format displayed values',
    disabled: 'Disable the slider',
  },
};

interface RangeSliderComponent extends React.FC<RangeSliderProps> {
  Metadata: ComponentMetadata;
}

const RangeSlider: RangeSliderComponent = ({
  size = 'md',
  color = 'primary',
  label,
  labelInline = false,
  labelWidth = 'w-24',
  helperText,
  error,
  value,
  defaultValue,
  onChange,
  range = false,
  rangeValue,
  defaultRangeValue,
  onRangeChange,
  onChangeEnd,
  min = 0,
  max = 100,
  step = 1,
  showValue = true,
  showMinMax = false,
  showTicks = false,
  tickCount = 5,
  formatValue = (v) => v.toString(),
  disabled = false,
  className = '',
  id,
}) => {
  // Internal state for uncontrolled usage
  const [internalValue, setInternalValue] = useState(defaultValue ?? min);
  const [internalRangeValue, setInternalRangeValue] = useState<[number, number]>(
    defaultRangeValue ?? [min, (min + max) / 2]
  );
  const [activeHandle, setActiveHandle] = useState<'min' | 'max' | null>(null);

  const trackRef = useRef<HTMLDivElement>(null);

  // Get current values (controlled or uncontrolled)
  const currentValue = value !== undefined ? value : internalValue;
  const currentRangeValue = rangeValue !== undefined ? rangeValue : internalRangeValue;

  // Size classes
  const sizeClasses: Record<RangeSliderSize, { track: string; thumb: string; text: string }> = {
    xs: { track: 'h-1', thumb: 'w-3 h-3', text: 'text-xs' },
    sm: { track: 'h-1.5', thumb: 'w-4 h-4', text: 'text-sm' },
    md: { track: 'h-2', thumb: 'w-5 h-5', text: 'text-base' },
    lg: { track: 'h-3', thumb: 'w-6 h-6', text: 'text-lg' },
  };

  // Color classes
  const colorClasses: Record<RangeSliderColor, string> = {
    primary: 'bg-primary',
    secondary: 'bg-secondary',
    accent: 'bg-accent',
    info: 'bg-info',
    success: 'bg-success',
    warning: 'bg-warning',
    error: 'bg-error',
  };

  // Calculate percentage from value
  const valueToPercent = (val: number): number => {
    return ((val - min) / (max - min)) * 100;
  };

  // Calculate value from percentage
  const percentToValue = (percent: number): number => {
    const rawValue = (percent / 100) * (max - min) + min;
    const steppedValue = Math.round(rawValue / step) * step;
    return Math.max(min, Math.min(max, steppedValue));
  };

  // Get percentage from mouse/touch event
  const getPercentFromEvent = useCallback((e: MouseEvent | TouchEvent | React.MouseEvent | React.TouchEvent): number => {
    if (!trackRef.current) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const percent = ((clientX - rect.left) / rect.width) * 100;
    return Math.max(0, Math.min(100, percent));
  }, []);

  // Handle single value change
  const handleSingleChange = useCallback((percent: number) => {
    const newValue = percentToValue(percent);
    if (value === undefined) {
      setInternalValue(newValue);
    }
    onChange?.(newValue);
  }, [value, min, max, step, onChange]);

  // Handle range value change
  const handleRangeChange = useCallback((percent: number, handle: 'min' | 'max') => {
    const newValue = percentToValue(percent);
    let newRange: [number, number];

    if (handle === 'min') {
      newRange = [Math.min(newValue, currentRangeValue[1] - step), currentRangeValue[1]];
    } else {
      newRange = [currentRangeValue[0], Math.max(newValue, currentRangeValue[0] + step)];
    }

    if (rangeValue === undefined) {
      setInternalRangeValue(newRange);
    }
    onRangeChange?.(newRange);
  }, [rangeValue, currentRangeValue, step, onRangeChange]);

  // Mouse/touch event handlers
  const handleTrackClick = (e: React.MouseEvent) => {
    if (disabled) return;
    const percent = getPercentFromEvent(e);

    if (range) {
      // Click on track in range mode - move closest handle
      const minPercent = valueToPercent(currentRangeValue[0]);
      const maxPercent = valueToPercent(currentRangeValue[1]);
      const closestHandle = Math.abs(percent - minPercent) < Math.abs(percent - maxPercent) ? 'min' : 'max';
      handleRangeChange(percent, closestHandle);
      onChangeEnd?.(currentRangeValue);
    } else {
      handleSingleChange(percent);
      onChangeEnd?.(percentToValue(percent));
    }
  };

  const handleThumbMouseDown = (handle: 'min' | 'max' | 'single') => (e: React.MouseEvent | React.TouchEvent) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();

    if (handle === 'single') {
      setActiveHandle(null);
    } else {
      setActiveHandle(handle);
    }

    const handleMove = (moveEvent: MouseEvent | TouchEvent) => {
      const percent = getPercentFromEvent(moveEvent);
      if (range && handle !== 'single') {
        handleRangeChange(percent, handle);
      } else {
        handleSingleChange(percent);
      }
    };

    const handleUp = () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      document.removeEventListener('touchmove', handleMove);
      document.removeEventListener('touchend', handleUp);
      setActiveHandle(null);

      if (range) {
        onChangeEnd?.(currentRangeValue);
      } else {
        onChangeEnd?.(currentValue);
      }
    };

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    document.addEventListener('touchmove', handleMove);
    document.addEventListener('touchend', handleUp);
  };

  // Generate tick marks
  const renderTicks = () => {
    if (!showTicks) return null;
    const ticks = [];
    for (let i = 0; i < tickCount; i++) {
      const percent = (i / (tickCount - 1)) * 100;
      ticks.push(
        <div
          key={i}
          className="absolute w-0.5 h-1 bg-base-content/30 -translate-x-1/2"
          style={{ left: `${percent}%`, top: '100%' }}
        />
      );
    }
    return <div className="relative mt-1">{ticks}</div>;
  };

  const { track: trackSize, thumb: thumbSize, text: textSize } = sizeClasses[size];

  const sliderContent = (
    <div className={`w-full ${labelInline ? 'flex-1' : ''}`}>
      {/* Value Display */}
      {showValue && (
        <div className={`flex justify-between mb-1 ${textSize}`}>
          {range ? (
            <>
              <span className="font-medium">{formatValue(currentRangeValue[0])}</span>
              <span className="text-base-content/50">-</span>
              <span className="font-medium">{formatValue(currentRangeValue[1])}</span>
            </>
          ) : (
            <span className="font-medium mx-auto">{formatValue(currentValue)}</span>
          )}
        </div>
      )}

      {/* Slider Track */}
      <div
        ref={trackRef}
        className={`relative w-full ${trackSize} bg-base-300 rounded-full cursor-pointer ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        onClick={handleTrackClick}
      >
        {/* Filled Track */}
        {range ? (
          <div
            className={`absolute ${trackSize} rounded-full ${colorClasses[color]}`}
            style={{
              left: `${valueToPercent(currentRangeValue[0])}%`,
              right: `${100 - valueToPercent(currentRangeValue[1])}%`,
            }}
          />
        ) : (
          <div
            className={`absolute ${trackSize} rounded-full ${colorClasses[color]}`}
            style={{
              left: 0,
              width: `${valueToPercent(currentValue)}%`,
            }}
          />
        )}

        {/* Thumb(s) */}
        {range ? (
          <>
            {/* Min Thumb */}
            <div
              className={`absolute ${thumbSize} rounded-full bg-base-100 border-2 ${error ? 'border-error' : `border-${color}`} shadow-md cursor-grab active:cursor-grabbing -translate-x-1/2 -translate-y-1/2 top-1/2 transition-transform hover:scale-110 ${activeHandle === 'min' ? 'scale-110 z-10' : ''} ${disabled ? 'cursor-not-allowed' : ''}`}
              style={{
                left: `${valueToPercent(currentRangeValue[0])}%`,
                borderColor: error ? undefined : `var(--${color === 'primary' ? 'p' : color === 'secondary' ? 's' : color === 'accent' ? 'a' : color})`,
              }}
              onMouseDown={handleThumbMouseDown('min')}
              onTouchStart={handleThumbMouseDown('min')}
            />
            {/* Max Thumb */}
            <div
              className={`absolute ${thumbSize} rounded-full bg-base-100 border-2 ${error ? 'border-error' : `border-${color}`} shadow-md cursor-grab active:cursor-grabbing -translate-x-1/2 -translate-y-1/2 top-1/2 transition-transform hover:scale-110 ${activeHandle === 'max' ? 'scale-110 z-10' : ''} ${disabled ? 'cursor-not-allowed' : ''}`}
              style={{
                left: `${valueToPercent(currentRangeValue[1])}%`,
                borderColor: error ? undefined : `var(--${color === 'primary' ? 'p' : color === 'secondary' ? 's' : color === 'accent' ? 'a' : color})`,
              }}
              onMouseDown={handleThumbMouseDown('max')}
              onTouchStart={handleThumbMouseDown('max')}
            />
          </>
        ) : (
          <div
            className={`absolute ${thumbSize} rounded-full bg-base-100 border-2 ${error ? 'border-error' : ''} shadow-md cursor-grab active:cursor-grabbing -translate-x-1/2 -translate-y-1/2 top-1/2 transition-transform hover:scale-110 ${disabled ? 'cursor-not-allowed' : ''}`}
            style={{
              left: `${valueToPercent(currentValue)}%`,
              borderColor: error ? undefined : `var(--${color === 'primary' ? 'p' : color === 'secondary' ? 's' : color === 'accent' ? 'a' : color})`,
            }}
            onMouseDown={handleThumbMouseDown('single')}
            onTouchStart={handleThumbMouseDown('single')}
          />
        )}

        {/* Tick Marks */}
        {renderTicks()}
      </div>

      {/* Min/Max Labels */}
      {showMinMax && (
        <div className={`flex justify-between mt-1 ${textSize} text-base-content/60`}>
          <span>{formatValue(min)}</span>
          <span>{formatValue(max)}</span>
        </div>
      )}

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
      <div className={`flex items-start gap-3 w-full ${className}`}>
        <label className={`label-text flex-shrink-0 ${labelWidth} pt-1`} htmlFor={id}>
          {label}
        </label>
        {sliderContent}
      </div>
    );
  }

  // Stacked layout
  return (
    <div className={`form-control w-full ${className}`}>
      {label && (
        <label className="label py-1" htmlFor={id}>
          <span className="label-text">{label}</span>
        </label>
      )}
      {sliderContent}
    </div>
  );
};

RangeSlider.Metadata = METADATA;

export default RangeSlider;
