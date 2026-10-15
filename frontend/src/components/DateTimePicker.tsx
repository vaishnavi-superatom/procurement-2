import React, { useState, useRef, useEffect } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../types';

type DateTimePickerSize = 'xs' | 'sm' | 'md' | 'lg';
type TimeFormat = '12h' | '24h';

interface DateTimePickerProps {
  size?: DateTimePickerSize;
  timeFormat?: TimeFormat;
  label?: string;
  labelInline?: boolean;
  labelWidth?: string;
  placeholder?: string;
  helperText?: string;
  error?: string;
  value?: Date | null;
  defaultValue?: Date | null;
  onChange?: (dateTime: Date | null) => void;
  onOpen?: () => void;
  onClose?: () => void;
  minDateTime?: Date;
  maxDateTime?: Date;
  minuteStep?: number;
  disabled?: boolean;
  className?: string;
  id?: string;
  showNowButton?: boolean;
  showClearButton?: boolean;
  dateFormat?: string;
}

const METADATA: ComponentMetadata = {
  id: 'generic-datetimepicker',
  name: 'DateTimePicker',
  displayName: 'Date & Time picker input',
  isDisplayComp: true,
  type: 'DateTimePicker',
  description: 'A combined date and time picker component using DaisyUI. Supports 12/24 hour formats with calendar selection.',
  category: 'input',
  keywords: ['date', 'time', 'picker', 'calendar', 'datetime', 'input', 'form'],
  props: {
    size: '"xs" | "sm" | "md" (default) | "lg"',
    timeFormat: '"12h" | "24h" (default)',
    label: 'Label text',
    labelInline: 'Show label inline with input (default: false)',
    placeholder: 'Placeholder text',
    helperText: 'Helper text below input',
    error: 'Error message',
    value: 'Selected date/time (controlled)',
    defaultValue: 'Default date/time (uncontrolled)',
    onChange: 'Callback when date/time changes',
    onOpen: 'Callback when picker opens',
    onClose: 'Callback when picker closes',
    minDateTime: 'Minimum selectable date/time',
    maxDateTime: 'Maximum selectable date/time',
    minuteStep: 'Minute step interval (default: 5)',
    showNowButton: 'Show "Now" button (default: true)',
    showClearButton: 'Show clear button (default: true)',
    disabled: 'Disable the input',
  },
};

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface DateTimePickerComponent extends React.FC<DateTimePickerProps> {
  Metadata: ComponentMetadata;
}

const DateTimePicker: DateTimePickerComponent = ({
  size = 'md',
  timeFormat = '24h',
  label,
  labelInline = false,
  labelWidth = 'w-24',
  placeholder = 'Select date & time...',
  helperText,
  error,
  value,
  defaultValue,
  onChange,
  onOpen,
  onClose,
  minDateTime,
  maxDateTime,
  minuteStep = 5,
  disabled = false,
  className = '',
  id,
  showNowButton = true,
  showClearButton = true,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [internalValue, setInternalValue] = useState<Date | null>(defaultValue ?? null);
  const [currentMonth, setCurrentMonth] = useState((value ?? defaultValue ?? new Date()).getMonth());
  const [currentYear, setCurrentYear] = useState((value ?? defaultValue ?? new Date()).getFullYear());
  const [activeTab, setActiveTab] = useState<'date' | 'time'>('date');
  const containerRef = useRef<HTMLDivElement>(null);

  // Use controlled or uncontrolled value
  const selectedValue = value !== undefined ? value : internalValue;

  // Selected time parts
  const selectedHour = selectedValue?.getHours() ?? null;
  const selectedMinute = selectedValue?.getMinutes() ?? null;

  // Size classes
  const sizeClasses: Record<DateTimePickerSize, string> = {
    xs: 'input-xs text-xs',
    sm: 'input-sm text-sm',
    md: '',
    lg: 'input-lg text-lg',
  };

  const iconSizes: Record<DateTimePickerSize, string> = {
    xs: 'w-3 h-3',
    sm: 'w-4 h-4',
    md: 'w-5 h-5',
    lg: 'w-6 h-6',
  };

  const calendarSizes: Record<DateTimePickerSize, { day: string; text: string }> = {
    xs: { day: 'w-6 h-6 text-xs', text: 'text-xs' },
    sm: { day: 'w-7 h-7 text-sm', text: 'text-sm' },
    md: { day: 'w-8 h-8 text-sm', text: 'text-base' },
    lg: { day: 'w-10 h-10 text-base', text: 'text-lg' },
  };

  const scrollSizes: Record<DateTimePickerSize, string> = {
    xs: 'h-32',
    sm: 'h-36',
    md: 'h-40',
    lg: 'h-48',
  };

  // Handle open/close
  const handleOpen = () => {
    if (!disabled) {
      setIsOpen(true);
      onOpen?.();
    }
  };

  const handleClose = () => {
    setIsOpen(false);
    onClose?.();
  };

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        handleClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Format date/time for display
  const formatDateTime = (date: Date | null): string => {
    if (!date) return '';

    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    let hour = date.getHours();
    const minute = date.getMinutes();
    let suffix = '';

    if (timeFormat === '12h') {
      suffix = hour >= 12 ? ' PM' : ' AM';
      hour = hour % 12 || 12;
    }

    const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}${suffix}`;
    return `${dateStr} ${timeStr}`;
  };

  // Get days in month
  const getDaysInMonth = (month: number, year: number): number => {
    return new Date(year, month + 1, 0).getDate();
  };

  // Get first day of month
  const getFirstDayOfMonth = (month: number, year: number): number => {
    return new Date(year, month, 1).getDay();
  };

  // Check if date is disabled
  const isDateDisabled = (date: Date): boolean => {
    if (minDateTime) {
      const minDate = new Date(minDateTime);
      minDate.setHours(0, 0, 0, 0);
      if (date < minDate) return true;
    }
    if (maxDateTime) {
      const maxDate = new Date(maxDateTime);
      maxDate.setHours(23, 59, 59, 999);
      if (date > maxDate) return true;
    }
    return false;
  };

  // Check if date is selected
  const isDateSelected = (date: Date): boolean => {
    return selectedValue?.toDateString() === date.toDateString();
  };

  // Check if date is today
  const isToday = (date: Date): boolean => {
    return date.toDateString() === new Date().toDateString();
  };

  // Update value helper
  const updateValue = (newValue: Date | null) => {
    if (value === undefined) {
      setInternalValue(newValue);
    }
    onChange?.(newValue);
  };

  // Handle date click
  const handleDateClick = (day: number) => {
    const newDate = new Date(currentYear, currentMonth, day);
    if (isDateDisabled(newDate)) return;

    // Preserve existing time if available
    if (selectedValue) {
      newDate.setHours(selectedValue.getHours(), selectedValue.getMinutes(), 0, 0);
    } else {
      newDate.setHours(0, 0, 0, 0);
    }

    updateValue(newDate);
    setActiveTab('time');
  };

  // Handle time selection
  const handleTimeSelect = (hour: number, minute: number, period?: 'AM' | 'PM') => {
    let h = hour;
    if (timeFormat === '12h' && period) {
      if (period === 'PM' && hour !== 12) h = hour + 12;
      if (period === 'AM' && hour === 12) h = 0;
    }

    const newDate = selectedValue ? new Date(selectedValue) : new Date();
    if (!selectedValue) {
      newDate.setHours(0, 0, 0, 0);
    }
    newDate.setHours(h, minute, 0, 0);

    updateValue(newDate);
  };

  // Generate hours array
  const getHours = (): number[] => {
    if (timeFormat === '12h') {
      return Array.from({ length: 12 }, (_, i) => i === 0 ? 12 : i);
    }
    return Array.from({ length: 24 }, (_, i) => i);
  };

  // Generate minutes array
  const getMinutes = (): number[] => {
    return Array.from({ length: Math.ceil(60 / minuteStep) }, (_, i) => i * minuteStep);
  };

  // Get display hour for 12h format
  const getDisplayHour = (hour: number | null): number | null => {
    if (hour === null) return null;
    if (timeFormat === '12h') {
      return hour % 12 || 12;
    }
    return hour;
  };

  // Get period for 12h format
  const getPeriod = (hour: number | null): 'AM' | 'PM' => {
    if (hour === null || hour < 12) return 'AM';
    return 'PM';
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

  // Handle now click
  const handleNowClick = () => {
    const now = new Date();
    now.setMinutes(Math.floor(now.getMinutes() / minuteStep) * minuteStep, 0, 0);
    updateValue(now);
    handleClose();
  };

  // Handle clear
  const handleClear = () => {
    updateValue(null);
    handleClose();
  };

  // Generate calendar days
  const renderCalendarDays = () => {
    const daysInMonth = getDaysInMonth(currentMonth, currentYear);
    const firstDay = getFirstDayOfMonth(currentMonth, currentYear);
    const days = [];

    for (let i = 0; i < firstDay; i++) {
      days.push(<div key={`empty-${i}`} className={calendarSizes[size].day} />);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(currentYear, currentMonth, day);
      const isDisabled = isDateDisabled(date);
      const isSelected = isDateSelected(date);
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
            ${isTodayDate && !isSelected ? 'border border-primary text-primary font-semibold' : ''}
          `}
        >
          {day}
        </button>
      );
    }

    return days;
  };

  const scrollItemClass = `px-3 py-1.5 cursor-pointer hover:bg-base-200 rounded text-center transition-colors`;
  const selectedItemClass = `bg-primary text-primary-content hover:bg-primary`;

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

  const pickerContent = (
    <div className="p-3 bg-base-100 rounded-lg shadow-xl border border-base-300 min-w-[300px]">
      {/* Tabs */}
      <div className="tabs tabs-boxed mb-3">
        <button
          type="button"
          className={`tab flex-1 ${activeTab === 'date' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('date')}
        >
          <Icon icon="mdi:calendar" className="w-4 h-4 mr-1" />
          Date
        </button>
        <button
          type="button"
          className={`tab flex-1 ${activeTab === 'time' ? 'tab-active' : ''}`}
          onClick={() => setActiveTab('time')}
        >
          <Icon icon="mdi:clock-outline" className="w-4 h-4 mr-1" />
          Time
        </button>
      </div>

      {/* Date Tab */}
      {activeTab === 'date' && (
        <>
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
        </>
      )}

      {/* Time Tab */}
      {activeTab === 'time' && (
        <div className="flex gap-2 justify-center">
          {/* Hours */}
          <div className="flex flex-col">
            <span className="text-xs text-base-content/60 text-center mb-1 font-medium">Hour</span>
            <div className={`${scrollSizes[size]} overflow-y-auto scrollbar-thin`}>
              {getHours().map((hour) => {
                const displayHour = getDisplayHour(selectedHour);
                const isSelected = timeFormat === '12h'
                  ? displayHour === hour
                  : selectedHour === hour;

                return (
                  <div
                    key={hour}
                    onClick={() => handleTimeSelect(
                      hour,
                      selectedMinute ?? 0,
                      timeFormat === '12h' ? getPeriod(selectedHour) : undefined
                    )}
                    className={`${scrollItemClass} ${isSelected ? selectedItemClass : ''}`}
                  >
                    {hour.toString().padStart(2, '0')}
                  </div>
                );
              })}
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
                    timeFormat === '12h' ? (getDisplayHour(selectedHour) ?? 12) : (selectedHour ?? 0),
                    minute,
                    timeFormat === '12h' ? getPeriod(selectedHour) : undefined
                  )}
                  className={`${scrollItemClass} ${selectedMinute === minute ? selectedItemClass : ''}`}
                >
                  {minute.toString().padStart(2, '0')}
                </div>
              ))}
            </div>
          </div>

          {/* AM/PM */}
          {timeFormat === '12h' && (
            <div className="flex flex-col">
              <span className="text-xs text-base-content/60 text-center mb-1 font-medium">&nbsp;</span>
              <div className="flex flex-col gap-1">
                <div
                  onClick={() => handleTimeSelect(
                    getDisplayHour(selectedHour) ?? 12,
                    selectedMinute ?? 0,
                    'AM'
                  )}
                  className={`${scrollItemClass} ${getPeriod(selectedHour) === 'AM' ? selectedItemClass : ''}`}
                >
                  AM
                </div>
                <div
                  onClick={() => handleTimeSelect(
                    getDisplayHour(selectedHour) ?? 12,
                    selectedMinute ?? 0,
                    'PM'
                  )}
                  className={`${scrollItemClass} ${getPeriod(selectedHour) === 'PM' ? selectedItemClass : ''}`}
                >
                  PM
                </div>
              </div>
            </div>
          )}
        </div>
      )}

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

      {/* Selected value display */}
      {selectedValue && (
        <div className="text-xs text-center text-base-content/60 mt-2 pt-2 border-t border-base-300">
          {formatDateTime(selectedValue)}
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
          value={formatDateTime(selectedValue)}
          onClick={handleOpen}
          className={inputClasses}
        />
        <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-base-content/50">
          <Icon icon="mdi:calendar-clock" className={iconSizes[size]} />
        </div>
      </div>

      {/* Picker Dropdown */}
      {isOpen && (
        <div className="absolute z-50 mt-1 left-0">
          {pickerContent}
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

DateTimePicker.Metadata = METADATA;

export default DateTimePicker;
