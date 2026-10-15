import React, { useState, useRef, useEffect, forwardRef } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../types';

type DatePickerSize = 'xs' | 'sm' | 'md' | 'lg';
type DatePickerMode = 'single' | 'range';

interface DatePickerProps {
  size?: DatePickerSize;
  mode?: DatePickerMode;
  label?: string;
  labelInline?: boolean;
  labelWidth?: string;
  placeholder?: string;
  helperText?: string;
  error?: string;
  value?: Date | null;
  startDate?: Date | null;
  endDate?: Date | null;
  onChange?: (date: Date | null) => void;
  onRangeChange?: (start: Date | null, end: Date | null) => void;
  minDate?: Date;
  maxDate?: Date;
  disabled?: boolean;
  className?: string;
  id?: string;
  showTodayButton?: boolean;
  showClearButton?: boolean;
  dateFormat?: string;
}

const METADATA: ComponentMetadata = {
  id: 'generic-datepicker',
  name: 'DatePicker',
  displayName: 'Date picker input',
  isDisplayComp: true,
  type: 'DatePicker',
  description: 'A date picker component with calendar dropdown using DaisyUI. Supports single date and date range selection.',
  category: 'input',
  keywords: ['date', 'picker', 'calendar', 'input', 'form', 'range'],
  props: {
    size: '"xs" | "sm" | "md" (default) | "lg"',
    mode: '"single" (default) | "range"',
    label: 'Label text',
    labelInline: 'Show label inline with input (default: false)',
    placeholder: 'Placeholder text',
    helperText: 'Helper text below input',
    error: 'Error message',
    value: 'Selected date (single mode)',
    startDate: 'Start date (range mode)',
    endDate: 'End date (range mode)',
    onChange: 'Callback when date changes (single mode)',
    onRangeChange: 'Callback when date range changes',
    minDate: 'Minimum selectable date',
    maxDate: 'Maximum selectable date',
    showTodayButton: 'Show today button (default: true)',
    showClearButton: 'Show clear button (default: true)',
    disabled: 'Disable the input',
  },
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface DatePickerComponent extends React.FC<DatePickerProps> {
  Metadata: ComponentMetadata;
}

const DatePicker: DatePickerComponent = ({
  size = 'md',
  mode = 'single',
  label,
  labelInline = false,
  labelWidth = 'w-24',
  placeholder = 'Select date...',
  helperText,
  error,
  value,
  startDate,
  endDate,
  onChange,
  onRangeChange,
  minDate,
  maxDate,
  disabled = false,
  className = '',
  id,
  showTodayButton = true,
  showClearButton = true,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [currentMonth, setCurrentMonth] = useState(value?.getMonth() ?? new Date().getMonth());
  const [currentYear, setCurrentYear] = useState(value?.getFullYear() ?? new Date().getFullYear());
  const [selectingStart, setSelectingStart] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  // Size classes
  const sizeClasses: Record<DatePickerSize, string> = {
    xs: 'input-xs text-xs',
    sm: 'input-sm text-sm',
    md: '',
    lg: 'input-lg text-lg',
  };

  const iconSizes: Record<DatePickerSize, string> = {
    xs: 'w-3 h-3',
    sm: 'w-4 h-4',
    md: 'w-5 h-5',
    lg: 'w-6 h-6',
  };

  const calendarSizes: Record<DatePickerSize, { day: string; text: string }> = {
    xs: { day: 'w-6 h-6 text-xs', text: 'text-xs' },
    sm: { day: 'w-7 h-7 text-sm', text: 'text-sm' },
    md: { day: 'w-8 h-8 text-sm', text: 'text-base' },
    lg: { day: 'w-10 h-10 text-base', text: 'text-lg' },
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

  // Format date for display
  const formatDate = (date: Date | null | undefined): string => {
    if (!date) return '';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  // Get display value
  const getDisplayValue = (): string => {
    if (mode === 'single') {
      return formatDate(value);
    } else {
      if (startDate && endDate) {
        return `${formatDate(startDate)} - ${formatDate(endDate)}`;
      } else if (startDate) {
        return `${formatDate(startDate)} - ...`;
      }
      return '';
    }
  };

  // Get days in month
  const getDaysInMonth = (month: number, year: number): number => {
    return new Date(year, month + 1, 0).getDate();
  };

  // Get first day of month (0 = Sunday)
  const getFirstDayOfMonth = (month: number, year: number): number => {
    return new Date(year, month, 1).getDay();
  };

  // Check if date is disabled
  const isDateDisabled = (date: Date): boolean => {
    if (minDate && date < new Date(minDate.setHours(0, 0, 0, 0))) return true;
    if (maxDate && date > new Date(maxDate.setHours(23, 59, 59, 999))) return true;
    return false;
  };

  // Check if date is selected
  const isDateSelected = (date: Date): boolean => {
    if (mode === 'single') {
      return value?.toDateString() === date.toDateString();
    } else {
      return startDate?.toDateString() === date.toDateString() || endDate?.toDateString() === date.toDateString();
    }
  };

  // Check if date is in range
  const isInRange = (date: Date): boolean => {
    if (mode !== 'range' || !startDate || !endDate) return false;
    return date > startDate && date < endDate;
  };

  // Check if date is today
  const isToday = (date: Date): boolean => {
    return date.toDateString() === new Date().toDateString();
  };

  // Handle date click
  const handleDateClick = (day: number) => {
    const selectedDate = new Date(currentYear, currentMonth, day);
    if (isDateDisabled(selectedDate)) return;

    if (mode === 'single') {
      onChange?.(selectedDate);
      setIsOpen(false);
    } else {
      if (selectingStart || !startDate || selectedDate < startDate) {
        onRangeChange?.(selectedDate, null);
        setSelectingStart(false);
      } else {
        onRangeChange?.(startDate, selectedDate);
        setSelectingStart(true);
        setIsOpen(false);
      }
    }
  };

  // Handle month navigation
  const goToPrevMonth = () => {
    if (currentMonth === 0) {
      setCurrentMonth(11);
      setCurrentYear(currentYear - 1);
    } else {
      setCurrentMonth(currentMonth - 1);
    }
  };

  const goToNextMonth = () => {
    if (currentMonth === 11) {
      setCurrentMonth(0);
      setCurrentYear(currentYear + 1);
    } else {
      setCurrentMonth(currentMonth + 1);
    }
  };

  // Handle today click
  const handleTodayClick = () => {
    const today = new Date();
    setCurrentMonth(today.getMonth());
    setCurrentYear(today.getFullYear());
    if (mode === 'single') {
      onChange?.(today);
      setIsOpen(false);
    }
  };

  // Handle clear
  const handleClear = () => {
    if (mode === 'single') {
      onChange?.(null);
    } else {
      onRangeChange?.(null, null);
      setSelectingStart(true);
    }
    setIsOpen(false);
  };

  // Generate calendar days
  const renderCalendarDays = () => {
    const daysInMonth = getDaysInMonth(currentMonth, currentYear);
    const firstDay = getFirstDayOfMonth(currentMonth, currentYear);
    const days = [];

    // Empty cells for days before first day of month
    for (let i = 0; i < firstDay; i++) {
      days.push(<div key={`empty-${i}`} className={calendarSizes[size].day} />);
    }

    // Days of month
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(currentYear, currentMonth, day);
      const isDisabled = isDateDisabled(date);
      const isSelected = isDateSelected(date);
      const inRange = isInRange(date);
      const isTodayDate = isToday(date);

      days.push(
        <button
          key={day}
          type="button"
          onClick={() => handleDateClick(day)}
          disabled={isDisabled}
          className={`
            ${calendarSizes[size].day} rounded-lg flex items-center justify-center transition-colors
            ${isDisabled ? 'text-base-content/30 cursor-not-allowed' : 'hover:bg-base-200 cursor-pointer'}
            ${isSelected ? 'bg-primary text-primary-content hover:bg-primary' : ''}
            ${inRange ? 'bg-primary/20' : ''}
            ${isTodayDate && !isSelected ? 'border border-primary text-primary font-semibold' : ''}
          `}
        >
          {day}
        </button>
      );
    }

    return days;
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

  const calendarContent = (
    <div className="p-3 bg-base-100 rounded-lg shadow-xl border border-base-300 min-w-[280px]">
      {/* Month/Year Header */}
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={goToPrevMonth}
          className="btn btn-ghost btn-sm btn-circle"
        >
          <Icon icon="mdi:chevron-left" className="w-5 h-5" />
        </button>
        <span className={`font-semibold ${calendarSizes[size].text}`}>
          {MONTHS[currentMonth]} {currentYear}
        </span>
        <button
          type="button"
          onClick={goToNextMonth}
          className="btn btn-ghost btn-sm btn-circle"
        >
          <Icon icon="mdi:chevron-right" className="w-5 h-5" />
        </button>
      </div>

      {/* Day headers */}
      <div className="grid grid-cols-7 gap-1 mb-2">
        {DAYS.map((day) => (
          <div
            key={day}
            className={`${calendarSizes[size].day} flex items-center justify-center text-base-content/60 font-medium`}
          >
            {day.slice(0, 2)}
          </div>
        ))}
      </div>

      {/* Calendar days */}
      <div className="grid grid-cols-7 gap-1">
        {renderCalendarDays()}
      </div>

      {/* Footer buttons */}
      {(showTodayButton || showClearButton) && (
        <div className="flex gap-2 mt-3 pt-3 border-t border-base-300">
          {showTodayButton && (
            <button
              type="button"
              onClick={handleTodayClick}
              className="btn btn-ghost btn-sm flex-1"
            >
              Today
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

      {/* Range mode hint */}
      {mode === 'range' && (
        <div className="text-xs text-base-content/50 text-center mt-2">
          {selectingStart ? 'Select start date' : 'Select end date'}
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
          value={getDisplayValue()}
          onClick={() => !disabled && setIsOpen(!isOpen)}
          className={inputClasses}
        />
        <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-base-content/50">
          <Icon icon="mdi:calendar" className={iconSizes[size]} />
        </div>
      </div>

      {/* Calendar Dropdown */}
      {isOpen && (
        <div className="absolute z-50 mt-1 left-0">
          {calendarContent}
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

DatePicker.Metadata = METADATA;

export default DatePicker;
