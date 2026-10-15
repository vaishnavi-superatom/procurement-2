import React, { useState, useRef, useEffect } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../types';

type TimePickerSize = 'xs' | 'sm' | 'md' | 'lg';
type TimeFormat = '12h' | '24h';

interface TimePickerProps {
  size?: TimePickerSize;
  format?: TimeFormat;
  label?: string;
  labelInline?: boolean;
  labelWidth?: string;
  placeholder?: string;
  helperText?: string;
  error?: string;
  value?: string; // Format: "HH:mm" or "HH:mm:ss"
  onChange?: (time: string) => void;
  showSeconds?: boolean;
  minuteStep?: number;
  disabled?: boolean;
  className?: string;
  id?: string;
  minTime?: string;
  maxTime?: string;
  showNowButton?: boolean;
  showClearButton?: boolean;
}

const METADATA: ComponentMetadata = {
  id: 'generic-timepicker',
  name: 'TimePicker',
  displayName: 'Time picker input',
  isDisplayComp: true,
  type: 'TimePicker',
  description: 'A time picker component with dropdown selection using DaisyUI. Supports 12/24 hour formats.',
  category: 'input',
  keywords: ['time', 'picker', 'clock', 'input', 'form', 'hour', 'minute'],
  props: {
    size: '"xs" | "sm" | "md" (default) | "lg"',
    format: '"12h" | "24h" (default)',
    label: 'Label text',
    labelInline: 'Show label inline with input (default: false)',
    placeholder: 'Placeholder text',
    helperText: 'Helper text below input',
    error: 'Error message',
    value: 'Selected time in HH:mm format',
    onChange: 'Callback when time changes',
    showSeconds: 'Show seconds selector (default: false)',
    minuteStep: 'Minute step interval (default: 5)',
    minTime: 'Minimum selectable time',
    maxTime: 'Maximum selectable time',
    showNowButton: 'Show "Now" button (default: true)',
    showClearButton: 'Show clear button (default: true)',
    disabled: 'Disable the input',
  },
};

interface TimePickerComponent extends React.FC<TimePickerProps> {
  Metadata: ComponentMetadata;
}

const TimePicker: TimePickerComponent = ({
  size = 'md',
  format = '24h',
  label,
  labelInline = false,
  labelWidth = 'w-24',
  placeholder = 'Select time...',
  helperText,
  error,
  value,
  onChange,
  showSeconds = false,
  minuteStep = 5,
  disabled = false,
  className = '',
  id,
  minTime,
  maxTime,
  showNowButton = true,
  showClearButton = true,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedHour, setSelectedHour] = useState<number | null>(null);
  const [selectedMinute, setSelectedMinute] = useState<number | null>(null);
  const [selectedSecond, setSelectedSecond] = useState<number | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<'AM' | 'PM'>('AM');
  const containerRef = useRef<HTMLDivElement>(null);

  // Parse value on mount and when value changes
  useEffect(() => {
    if (value) {
      const parts = value.split(':');
      let hour = parseInt(parts[0], 10);
      const minute = parseInt(parts[1], 10);
      const second = parts[2] ? parseInt(parts[2], 10) : 0;

      if (format === '12h') {
        setSelectedPeriod(hour >= 12 ? 'PM' : 'AM');
        hour = hour % 12 || 12;
      }

      setSelectedHour(hour);
      setSelectedMinute(minute);
      setSelectedSecond(second);
    }
  }, [value, format]);

  // Size classes
  const sizeClasses: Record<TimePickerSize, string> = {
    xs: 'input-xs text-xs',
    sm: 'input-sm text-sm',
    md: '',
    lg: 'input-lg text-lg',
  };

  const iconSizes: Record<TimePickerSize, string> = {
    xs: 'w-3 h-3',
    sm: 'w-4 h-4',
    md: 'w-5 h-5',
    lg: 'w-6 h-6',
  };

  const scrollSizes: Record<TimePickerSize, string> = {
    xs: 'h-32',
    sm: 'h-36',
    md: 'h-40',
    lg: 'h-48',
  };

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Format time for display
  const formatTime = (): string => {
    if (selectedHour === null || selectedMinute === null) return '';

    let displayHour = selectedHour;
    let suffix = '';

    if (format === '12h') {
      suffix = ` ${selectedPeriod}`;
    }

    const hourStr = displayHour.toString().padStart(2, '0');
    const minStr = selectedMinute.toString().padStart(2, '0');

    if (showSeconds && selectedSecond !== null) {
      const secStr = selectedSecond.toString().padStart(2, '0');
      return `${hourStr}:${minStr}:${secStr}${suffix}`;
    }

    return `${hourStr}:${minStr}${suffix}`;
  };

  // Get time value in 24h format for onChange
  const getTimeValue = (hour: number, minute: number, second: number, period: 'AM' | 'PM'): string => {
    let h = hour;
    if (format === '12h') {
      if (period === 'PM' && hour !== 12) h = hour + 12;
      if (period === 'AM' && hour === 12) h = 0;
    }

    const hourStr = h.toString().padStart(2, '0');
    const minStr = minute.toString().padStart(2, '0');

    if (showSeconds) {
      const secStr = second.toString().padStart(2, '0');
      return `${hourStr}:${minStr}:${secStr}`;
    }

    return `${hourStr}:${minStr}`;
  };

  // Handle time selection
  const handleTimeSelect = (hour: number, minute: number, second: number, period: 'AM' | 'PM') => {
    setSelectedHour(hour);
    setSelectedMinute(minute);
    setSelectedSecond(second);
    setSelectedPeriod(period);

    const timeValue = getTimeValue(hour, minute, second, period);
    onChange?.(timeValue);
  };

  // Generate hours array
  const getHours = (): number[] => {
    if (format === '12h') {
      return Array.from({ length: 12 }, (_, i) => i === 0 ? 12 : i);
    }
    return Array.from({ length: 24 }, (_, i) => i);
  };

  // Generate minutes array
  const getMinutes = (): number[] => {
    return Array.from({ length: Math.ceil(60 / minuteStep) }, (_, i) => i * minuteStep);
  };

  // Generate seconds array
  const getSeconds = (): number[] => {
    return Array.from({ length: 60 }, (_, i) => i);
  };

  // Handle now click
  const handleNowClick = () => {
    const now = new Date();
    let hour = now.getHours();
    const minute = Math.floor(now.getMinutes() / minuteStep) * minuteStep;
    const second = now.getSeconds();
    let period: 'AM' | 'PM' = 'AM';

    if (format === '12h') {
      period = hour >= 12 ? 'PM' : 'AM';
      hour = hour % 12 || 12;
    }

    handleTimeSelect(hour, minute, second, period);
    setIsOpen(false);
  };

  // Handle clear
  const handleClear = () => {
    setSelectedHour(null);
    setSelectedMinute(null);
    setSelectedSecond(null);
    setSelectedPeriod('AM');
    onChange?.('');
    setIsOpen(false);
  };

  const inputClasses = [
    'input',
    'input-bordered',
    'w-full',
    'pr-10',
    'cursor-pointer',
    'bg-base-100',
    sizeClasses[size],
    error ? 'input-error' : '',
    className,
  ].filter(Boolean).join(' ');

  const scrollItemClass = `px-3 py-1.5 cursor-pointer hover:bg-base-200 rounded text-center transition-colors`;
  const selectedItemClass = `bg-primary text-primary-content hover:bg-primary`;

  const timePickerContent = (
    <div className="p-3 bg-base-100 rounded-lg shadow-xl border border-base-300">
      <div className="flex gap-2">
        {/* Hours */}
        <div className="flex flex-col">
          <span className="text-xs text-base-content/60 text-center mb-1 font-medium">Hour</span>
          <div className={`${scrollSizes[size]} overflow-y-auto scrollbar-thin`}>
            {getHours().map((hour) => (
              <div
                key={hour}
                onClick={() => handleTimeSelect(
                  hour,
                  selectedMinute ?? 0,
                  selectedSecond ?? 0,
                  selectedPeriod
                )}
                className={`${scrollItemClass} ${selectedHour === hour ? selectedItemClass : ''}`}
              >
                {hour.toString().padStart(2, '0')}
              </div>
            ))}
          </div>
        </div>

        {/* Minutes */}
        <div className="flex flex-col">
          <span className="text-xs text-base-content/60 text-center mb-1 font-medium">Min</span>
          <div className={`${scrollSizes[size]} overflow-y-auto scrollbar-thin`}>
            {getMinutes().map((minute) => (
              <div
                key={minute}
                onClick={() => handleTimeSelect(
                  selectedHour ?? (format === '12h' ? 12 : 0),
                  minute,
                  selectedSecond ?? 0,
                  selectedPeriod
                )}
                className={`${scrollItemClass} ${selectedMinute === minute ? selectedItemClass : ''}`}
              >
                {minute.toString().padStart(2, '0')}
              </div>
            ))}
          </div>
        </div>

        {/* Seconds */}
        {showSeconds && (
          <div className="flex flex-col">
            <span className="text-xs text-base-content/60 text-center mb-1 font-medium">Sec</span>
            <div className={`${scrollSizes[size]} overflow-y-auto scrollbar-thin`}>
              {getSeconds().map((second) => (
                <div
                  key={second}
                  onClick={() => handleTimeSelect(
                    selectedHour ?? (format === '12h' ? 12 : 0),
                    selectedMinute ?? 0,
                    second,
                    selectedPeriod
                  )}
                  className={`${scrollItemClass} ${selectedSecond === second ? selectedItemClass : ''}`}
                >
                  {second.toString().padStart(2, '0')}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* AM/PM */}
        {format === '12h' && (
          <div className="flex flex-col">
            <span className="text-xs text-base-content/60 text-center mb-1 font-medium">&nbsp;</span>
            <div className="flex flex-col gap-1">
              <div
                onClick={() => handleTimeSelect(
                  selectedHour ?? 12,
                  selectedMinute ?? 0,
                  selectedSecond ?? 0,
                  'AM'
                )}
                className={`${scrollItemClass} ${selectedPeriod === 'AM' ? selectedItemClass : ''}`}
              >
                AM
              </div>
              <div
                onClick={() => handleTimeSelect(
                  selectedHour ?? 12,
                  selectedMinute ?? 0,
                  selectedSecond ?? 0,
                  'PM'
                )}
                className={`${scrollItemClass} ${selectedPeriod === 'PM' ? selectedItemClass : ''}`}
              >
                PM
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer buttons */}
      {(showNowButton || showClearButton) && (
        <div className="flex gap-2 mt-3 pt-3 border-t border-base-300">
          {showNowButton && (
            <button
              type="button"
              onClick={handleNowClick}
              className="btn btn-ghost btn-sm flex-1"
            >
              Now
            </button>
          )}
          {showClearButton && (
            <button
              type="button"
              onClick={handleClear}
              className="btn btn-ghost btn-sm flex-1"
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  );

  const inputField = (
    <div className={`relative ${labelInline ? 'flex-1' : ''}`} ref={containerRef}>
      {/* Input */}
      <div className="relative">
        <input
          id={id}
          type="text"
          readOnly
          disabled={disabled}
          placeholder={placeholder}
          value={formatTime()}
          onClick={() => !disabled && setIsOpen(!isOpen)}
          className={inputClasses}
        />
        <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-base-content/50">
          <Icon icon="mdi:clock-outline" className={iconSizes[size]} />
        </div>
      </div>

      {/* Time Picker Dropdown */}
      {isOpen && (
        <div className="absolute z-50 mt-1 left-0">
          {timePickerContent}
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
      <div className="flex items-start gap-3 w-full">
        <label className={`label-text flex-shrink-0 ${labelWidth} pt-3`} htmlFor={id}>
          {label}
        </label>
        {inputField}
      </div>
    );
  }

  // Stacked layout
  return (
    <div className="form-control w-full">
      {label && (
        <label className="label py-1" htmlFor={id}>
          <span className="label-text">{label}</span>
        </label>
      )}
      {inputField}
    </div>
  );
};

TimePicker.Metadata = METADATA;

export default TimePicker;
