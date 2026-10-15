import React, { useState, useCallback, useMemo } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../types';

// Types
export type ScheduleFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';
export type ExportFormat = 'pdf' | 'excel' | 'csv' | 'word';
export type DeliveryMethod = 'email' | 'slack' | 'download' | 'cloud';

export interface ScheduleConfig {
  // Basic settings
  name: string;
  enabled: boolean;
  // Frequency
  frequency: ScheduleFrequency;
  // Time settings
  dayOfWeek: number; // 0-6 (Sun-Sat)
  dayOfMonth: number; // 1-31
  time: string; // HH:MM format
  timezone: string;
  // Export settings
  format: ExportFormat;
  deliveryMethod: DeliveryMethod;
  // Recipients
  recipients: string[];
  // Additional options
  includeCharts: boolean;
  includeSummary: boolean;
  dateRange: 'last7days' | 'last30days' | 'lastMonth' | 'lastQuarter' | 'custom';
  // Cloud settings (if delivery is cloud)
  cloudProvider?: 'gdrive' | 's3' | 'dropbox';
  cloudPath?: string;
  // Slack settings (if delivery is slack)
  slackChannel?: string;
}

interface ReportSchedulerProps {
  /** Initial schedule configuration */
  initialConfig?: Partial<ScheduleConfig>;
  /** Available report types to schedule */
  reportTypes?: { id: string; name: string }[];
  /** Callback when configuration changes */
  onChange?: (config: ScheduleConfig) => void;
  /** Callback when schedule is saved */
  onSave?: (config: ScheduleConfig) => void;
  /** Callback when schedule is deleted */
  onDelete?: () => void;
  /** Callback to test/preview the schedule */
  onTest?: (config: ScheduleConfig) => void;
  /** Show delete button */
  showDelete?: boolean;
  /** Component size */
  size?: 'sm' | 'md' | 'lg';
  /** Additional class name */
  className?: string;
}

const METADATA: ComponentMetadata = {
  id: 'report-scheduler',
  name: 'ReportScheduler',
  displayName: 'Report Scheduler',
  isDisplayComp: true,
  type: 'ReportScheduler',
  description: 'Schedule automated report generation and delivery',
  category: 'finance',
  keywords: ['report', 'schedule', 'automation', 'email', 'export'],
  props: {
    initialConfig: 'Initial schedule configuration',
    reportTypes: 'Available report types to schedule',
    onChange: 'Callback when configuration changes',
    onSave: 'Callback when schedule is saved',
    onDelete: 'Callback when schedule is deleted',
    onTest: 'Callback to test the schedule',
  }
};

// Constants
const DAYS_OF_WEEK = [
  { value: 0, label: 'Sunday', short: 'Sun' },
  { value: 1, label: 'Monday', short: 'Mon' },
  { value: 2, label: 'Tuesday', short: 'Tue' },
  { value: 3, label: 'Wednesday', short: 'Wed' },
  { value: 4, label: 'Thursday', short: 'Thu' },
  { value: 5, label: 'Friday', short: 'Fri' },
  { value: 6, label: 'Saturday', short: 'Sat' },
];

const TIMEZONES = [
  { value: 'UTC', label: 'UTC', offset: '+00:00' },
  { value: 'America/New_York', label: 'Eastern Time', offset: '-05:00' },
  { value: 'America/Chicago', label: 'Central Time', offset: '-06:00' },
  { value: 'America/Denver', label: 'Mountain Time', offset: '-07:00' },
  { value: 'America/Los_Angeles', label: 'Pacific Time', offset: '-08:00' },
  { value: 'Europe/London', label: 'London', offset: '+00:00' },
  { value: 'Europe/Paris', label: 'Paris', offset: '+01:00' },
  { value: 'Europe/Berlin', label: 'Berlin', offset: '+01:00' },
  { value: 'Asia/Dubai', label: 'Dubai', offset: '+04:00' },
  { value: 'Asia/Kolkata', label: 'India (IST)', offset: '+05:30' },
  { value: 'Asia/Singapore', label: 'Singapore', offset: '+08:00' },
  { value: 'Asia/Tokyo', label: 'Tokyo', offset: '+09:00' },
  { value: 'Australia/Sydney', label: 'Sydney', offset: '+11:00' },
];

const FREQUENCIES = [
  { value: 'daily', label: 'Daily', icon: 'mdi:calendar-today' },
  { value: 'weekly', label: 'Weekly', icon: 'mdi:calendar-week' },
  { value: 'biweekly', label: 'Bi-weekly', icon: 'mdi:calendar-week' },
  { value: 'monthly', label: 'Monthly', icon: 'mdi:calendar-month' },
  { value: 'quarterly', label: 'Quarterly', icon: 'mdi:calendar-range' },
  { value: 'yearly', label: 'Yearly', icon: 'mdi:calendar' },
];

const FORMATS = [
  { value: 'pdf', label: 'PDF', icon: 'mdi:file-pdf-box', color: 'text-red-500' },
  { value: 'excel', label: 'Excel', icon: 'mdi:file-excel', color: 'text-green-600' },
  { value: 'csv', label: 'CSV', icon: 'mdi:file-delimited', color: 'text-blue-500' },
  { value: 'word', label: 'Word', icon: 'mdi:file-word', color: 'text-blue-700' },
];

const DELIVERY_METHODS = [
  { value: 'email', label: 'Email', icon: 'mdi:email-outline', description: 'Send to email addresses' },
  { value: 'slack', label: 'Slack', icon: 'mdi:slack', description: 'Post to Slack channel' },
  { value: 'download', label: 'Download Link', icon: 'mdi:link-variant', description: 'Generate download link' },
  { value: 'cloud', label: 'Cloud Storage', icon: 'mdi:cloud-upload', description: 'Upload to cloud storage' },
];

const DATE_RANGES = [
  { value: 'last7days', label: 'Last 7 Days' },
  { value: 'last30days', label: 'Last 30 Days' },
  { value: 'lastMonth', label: 'Last Month' },
  { value: 'lastQuarter', label: 'Last Quarter' },
  { value: 'custom', label: 'Custom Range' },
];

// Default config
const DEFAULT_CONFIG: ScheduleConfig = {
  name: '',
  enabled: true,
  frequency: 'weekly',
  dayOfWeek: 1, // Monday
  dayOfMonth: 1,
  time: '09:00',
  timezone: 'UTC',
  format: 'pdf',
  deliveryMethod: 'email',
  recipients: [],
  includeCharts: true,
  includeSummary: true,
  dateRange: 'last30days',
};

interface ReportSchedulerComponent extends React.FC<ReportSchedulerProps> {
  Metadata: ComponentMetadata;
}

const ReportScheduler: React.FC<ReportSchedulerProps> = ({
  initialConfig,
  reportTypes = [],
  onChange,
  onSave,
  onDelete,
  onTest,
  showDelete = false,
  size = 'md',
  className = '',
}) => {
  const [config, setConfig] = useState<ScheduleConfig>({ ...DEFAULT_CONFIG, ...initialConfig });
  const [newRecipient, setNewRecipient] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Update config helper
  const updateConfig = useCallback((updates: Partial<ScheduleConfig>) => {
    setConfig(prev => {
      const newConfig = { ...prev, ...updates };
      onChange?.(newConfig);
      return newConfig;
    });
  }, [onChange]);

  // Add recipient
  const addRecipient = useCallback(() => {
    const email = newRecipient.trim();
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (!config.recipients.includes(email)) {
        updateConfig({ recipients: [...config.recipients, email] });
      }
      setNewRecipient('');
      setErrors(prev => ({ ...prev, recipient: '' }));
    } else {
      setErrors(prev => ({ ...prev, recipient: 'Invalid email address' }));
    }
  }, [newRecipient, config.recipients, updateConfig]);

  // Remove recipient
  const removeRecipient = useCallback((email: string) => {
    updateConfig({ recipients: config.recipients.filter(r => r !== email) });
  }, [config.recipients, updateConfig]);

  // Validate and save
  const handleSave = useCallback(() => {
    const newErrors: Record<string, string> = {};

    if (!config.name.trim()) {
      newErrors.name = 'Schedule name is required';
    }
    if (config.deliveryMethod === 'email' && config.recipients.length === 0) {
      newErrors.recipients = 'At least one recipient is required';
    }
    if (config.deliveryMethod === 'slack' && !config.slackChannel) {
      newErrors.slackChannel = 'Slack channel is required';
    }

    setErrors(newErrors);

    if (Object.keys(newErrors).length === 0) {
      onSave?.(config);
    }
  }, [config, onSave]);

  // Generate schedule summary
  const scheduleSummary = useMemo(() => {
    const freq = FREQUENCIES.find(f => f.value === config.frequency);
    const tz = TIMEZONES.find(t => t.value === config.timezone);
    const day = DAYS_OF_WEEK.find(d => d.value === config.dayOfWeek);

    let schedule = '';
    switch (config.frequency) {
      case 'daily':
        schedule = `Every day at ${config.time}`;
        break;
      case 'weekly':
        schedule = `Every ${day?.label} at ${config.time}`;
        break;
      case 'biweekly':
        schedule = `Every other ${day?.label} at ${config.time}`;
        break;
      case 'monthly':
        schedule = `On day ${config.dayOfMonth} of every month at ${config.time}`;
        break;
      case 'quarterly':
        schedule = `On day ${config.dayOfMonth} every 3 months at ${config.time}`;
        break;
      case 'yearly':
        schedule = `On day ${config.dayOfMonth} every year at ${config.time}`;
        break;
    }

    return `${schedule} (${tz?.label || config.timezone})`;
  }, [config]);

  // Size classes
  const inputSize = size === 'sm' ? 'input-sm' : size === 'lg' ? 'input-lg' : 'input-md';
  const selectSize = size === 'sm' ? 'select-sm' : size === 'lg' ? 'select-lg' : 'select-md';
  const btnSize = size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : 'btn-md';

  return (
    <div className={`report-scheduler ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6 p-4 bg-base-200 rounded-lg">
        <div className="flex items-center gap-3">
          <Icon icon="mdi:calendar-clock" className="w-6 h-6 text-primary" />
          <div>
            <h2 className="font-bold text-lg">Schedule Report</h2>
            <p className="text-sm text-base-content/60">Configure automated report delivery</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Enable/Disable Toggle */}
          <label className="label cursor-pointer gap-2">
            <span className="label-text text-sm">{config.enabled ? 'Active' : 'Paused'}</span>
            <input
              type="checkbox"
              className="toggle toggle-primary toggle-sm"
              checked={config.enabled}
              onChange={e => updateConfig({ enabled: e.target.checked })}
            />
          </label>
        </div>
      </div>

      <div className="space-y-6 bg-base-100 rounded-lg p-6 border border-base-300">
        {/* Schedule Name */}
        <div className="form-control">
          <label className="label">
            <span className="label-text font-medium">Schedule Name</span>
          </label>
          <input
            type="text"
            placeholder="e.g., Weekly Sales Report"
            className={`input input-bordered w-full ${inputSize} ${errors.name ? 'input-error' : ''}`}
            value={config.name}
            onChange={e => updateConfig({ name: e.target.value })}
          />
          {errors.name && <span className="text-error text-xs mt-1">{errors.name}</span>}
        </div>

        {/* Frequency Selection */}
        <div className="form-control">
          <label className="label">
            <span className="label-text font-medium">Frequency</span>
          </label>
          <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
            {FREQUENCIES.map(freq => (
              <button
                key={freq.value}
                type="button"
                className={`btn ${btnSize} ${config.frequency === freq.value ? 'btn-primary' : 'btn-outline'} flex-col h-auto py-3`}
                onClick={() => updateConfig({ frequency: freq.value as ScheduleFrequency })}
              >
                <Icon icon={freq.icon} className="w-5 h-5" />
                <span className="text-xs mt-1">{freq.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Day & Time Selection */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Day of Week (for weekly/biweekly) */}
          {(config.frequency === 'weekly' || config.frequency === 'biweekly') && (
            <div className="form-control">
              <label className="label">
                <span className="label-text font-medium">Day of Week</span>
              </label>
              <select
                className={`select select-bordered w-full ${selectSize}`}
                value={config.dayOfWeek}
                onChange={e => updateConfig({ dayOfWeek: parseInt(e.target.value) })}
              >
                {DAYS_OF_WEEK.map(day => (
                  <option key={day.value} value={day.value}>{day.label}</option>
                ))}
              </select>
            </div>
          )}

          {/* Day of Month (for monthly/quarterly/yearly) */}
          {(config.frequency === 'monthly' || config.frequency === 'quarterly' || config.frequency === 'yearly') && (
            <div className="form-control">
              <label className="label">
                <span className="label-text font-medium">Day of Month</span>
              </label>
              <select
                className={`select select-bordered w-full ${selectSize}`}
                value={config.dayOfMonth}
                onChange={e => updateConfig({ dayOfMonth: parseInt(e.target.value) })}
              >
                {Array.from({ length: 31 }, (_, i) => i + 1).map(day => (
                  <option key={day} value={day}>{day}</option>
                ))}
              </select>
            </div>
          )}

          {/* Time */}
          <div className="form-control">
            <label className="label">
              <span className="label-text font-medium">Time</span>
            </label>
            <input
              type="time"
              className={`input input-bordered w-full ${inputSize}`}
              value={config.time}
              onChange={e => updateConfig({ time: e.target.value })}
            />
          </div>

          {/* Timezone */}
          <div className="form-control">
            <label className="label">
              <span className="label-text font-medium">Timezone</span>
            </label>
            <select
              className={`select select-bordered w-full ${selectSize}`}
              value={config.timezone}
              onChange={e => updateConfig({ timezone: e.target.value })}
            >
              {TIMEZONES.map(tz => (
                <option key={tz.value} value={tz.value}>{tz.label} ({tz.offset})</option>
              ))}
            </select>
          </div>
        </div>

        {/* Schedule Summary */}
        <div className="alert bg-base-200">
          <Icon icon="mdi:clock-outline" className="w-5 h-5" />
          <span className="text-sm">{scheduleSummary}</span>
        </div>

        <div className="divider">Export Settings</div>

        {/* Export Format */}
        <div className="form-control">
          <label className="label">
            <span className="label-text font-medium">Export Format</span>
          </label>
          <div className="flex flex-wrap gap-2">
            {FORMATS.map(format => (
              <button
                key={format.value}
                type="button"
                className={`btn ${btnSize} gap-2 ${config.format === format.value ? 'btn-primary' : 'btn-outline'}`}
                onClick={() => updateConfig({ format: format.value as ExportFormat })}
              >
                <Icon icon={format.icon} className={`w-5 h-5 ${config.format === format.value ? '' : format.color}`} />
                {format.label}
              </button>
            ))}
          </div>
        </div>

        {/* Date Range */}
        <div className="form-control">
          <label className="label">
            <span className="label-text font-medium">Data Range</span>
          </label>
          <select
            className={`select select-bordered w-full max-w-xs ${selectSize}`}
            value={config.dateRange}
            onChange={e => updateConfig({ dateRange: e.target.value as ScheduleConfig['dateRange'] })}
          >
            {DATE_RANGES.map(range => (
              <option key={range.value} value={range.value}>{range.label}</option>
            ))}
          </select>
        </div>

        {/* Include Options */}
        <div className="flex flex-wrap gap-4">
          <label className="label cursor-pointer gap-2">
            <input
              type="checkbox"
              className="checkbox checkbox-primary checkbox-sm"
              checked={config.includeCharts}
              onChange={e => updateConfig({ includeCharts: e.target.checked })}
            />
            <span className="label-text">Include Charts</span>
          </label>
          <label className="label cursor-pointer gap-2">
            <input
              type="checkbox"
              className="checkbox checkbox-primary checkbox-sm"
              checked={config.includeSummary}
              onChange={e => updateConfig({ includeSummary: e.target.checked })}
            />
            <span className="label-text">Include Summary</span>
          </label>
        </div>

        <div className="divider">Delivery Method</div>

        {/* Delivery Method */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {DELIVERY_METHODS.map(method => (
            <button
              key={method.value}
              type="button"
              className={`btn ${btnSize} flex-col h-auto py-4 ${config.deliveryMethod === method.value ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => updateConfig({ deliveryMethod: method.value as DeliveryMethod })}
            >
              <Icon icon={method.icon} className="w-6 h-6" />
              <span className="text-sm font-medium mt-1">{method.label}</span>
              <span className="text-xs opacity-70 mt-0.5">{method.description}</span>
            </button>
          ))}
        </div>

        {/* Email Recipients */}
        {config.deliveryMethod === 'email' && (
          <div className="form-control">
            <label className="label">
              <span className="label-text font-medium">Recipients</span>
            </label>
            <div className="flex gap-2">
              <input
                type="email"
                placeholder="Enter email address"
                className={`input input-bordered flex-1 ${inputSize} ${errors.recipient ? 'input-error' : ''}`}
                value={newRecipient}
                onChange={e => setNewRecipient(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addRecipient())}
              />
              <button type="button" className={`btn btn-primary ${btnSize}`} onClick={addRecipient}>
                <Icon icon="mdi:plus" className="w-4 h-4" />
                Add
              </button>
            </div>
            {errors.recipient && <span className="text-error text-xs mt-1">{errors.recipient}</span>}
            {errors.recipients && <span className="text-error text-xs mt-1">{errors.recipients}</span>}

            {/* Recipients List */}
            {config.recipients.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {config.recipients.map(email => (
                  <div key={email} className="badge badge-lg gap-1 pr-1">
                    <Icon icon="mdi:email" className="w-3 h-3" />
                    <span className="text-xs">{email}</span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-xs btn-circle"
                      onClick={() => removeRecipient(email)}
                    >
                      <Icon icon="mdi:close" className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Slack Channel */}
        {config.deliveryMethod === 'slack' && (
          <div className="form-control">
            <label className="label">
              <span className="label-text font-medium">Slack Channel</span>
            </label>
            <div className="input-group">
              <span className="bg-base-200 px-3 flex items-center">#</span>
              <input
                type="text"
                placeholder="channel-name"
                className={`input input-bordered flex-1 ${inputSize} ${errors.slackChannel ? 'input-error' : ''}`}
                value={config.slackChannel || ''}
                onChange={e => updateConfig({ slackChannel: e.target.value })}
              />
            </div>
            {errors.slackChannel && <span className="text-error text-xs mt-1">{errors.slackChannel}</span>}
          </div>
        )}

        {/* Cloud Storage */}
        {config.deliveryMethod === 'cloud' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="form-control">
              <label className="label">
                <span className="label-text font-medium">Cloud Provider</span>
              </label>
              <select
                className={`select select-bordered w-full ${selectSize}`}
                value={config.cloudProvider || 'gdrive'}
                onChange={e => updateConfig({ cloudProvider: e.target.value as 'gdrive' | 's3' | 'dropbox' })}
              >
                <option value="gdrive">Google Drive</option>
                <option value="s3">Amazon S3</option>
                <option value="dropbox">Dropbox</option>
              </select>
            </div>
            <div className="form-control">
              <label className="label">
                <span className="label-text font-medium">Folder Path</span>
              </label>
              <input
                type="text"
                placeholder="/reports/scheduled/"
                className={`input input-bordered w-full ${inputSize}`}
                value={config.cloudPath || ''}
                onChange={e => updateConfig({ cloudPath: e.target.value })}
              />
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center justify-between gap-4 mt-6 p-4 bg-base-200 rounded-lg">
        <div className="flex gap-2">
          {showDelete && (
            <button type="button" className={`btn btn-error btn-outline ${btnSize} gap-1`} onClick={onDelete}>
              <Icon icon="mdi:delete" className="w-4 h-4" />
              Delete
            </button>
          )}
          {onTest && (
            <button
              type="button"
              className={`btn btn-outline ${btnSize} gap-1`}
              onClick={() => onTest(config)}
            >
              <Icon icon="mdi:play" className="w-4 h-4" />
              Test Now
            </button>
          )}
        </div>
        <button
          type="button"
          className={`btn btn-primary ${btnSize} gap-1`}
          onClick={handleSave}
        >
          <Icon icon="mdi:content-save" className="w-4 h-4" />
          Save Schedule
        </button>
      </div>
    </div>
  );
};

// Attach metadata
(ReportScheduler as ReportSchedulerComponent).Metadata = METADATA;

export default ReportScheduler;
