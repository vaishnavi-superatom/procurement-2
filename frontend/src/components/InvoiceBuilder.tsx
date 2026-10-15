import React, { useState, useCallback, useMemo, useRef } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../types';

// Types
export interface InvoiceItem {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface InvoiceData {
  // Invoice info
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  status: 'draft' | 'sent' | 'paid' | 'overdue';
  // Company info
  companyName: string;
  companyAddress: string;
  companyEmail: string;
  companyPhone: string;
  companyLogo?: string;
  // Customer info
  customerName: string;
  customerAddress: string;
  customerEmail: string;
  customerPhone: string;
  // Items
  items: InvoiceItem[];
  // Financials
  currency: string;
  taxRate: number;
  discountRate: number;
  discountType: 'percentage' | 'fixed';
  // Notes
  notes: string;
  terms: string;
}

type InvoiceBuilderSize = 'sm' | 'md' | 'lg';
type InvoiceBuilderMode = 'edit' | 'preview';

interface InvoiceBuilderProps {
  /** Initial invoice data */
  initialData?: Partial<InvoiceData>;
  /** Component size */
  size?: InvoiceBuilderSize;
  /** Edit or preview mode */
  mode?: InvoiceBuilderMode;
  /** Allow mode toggle */
  allowModeToggle?: boolean;
  /** Callback when invoice data changes */
  onChange?: (data: InvoiceData) => void;
  /** Callback when save is clicked */
  onSave?: (data: InvoiceData) => void;
  /** Callback when PDF export is clicked */
  onExportPdf?: (data: InvoiceData) => void;
  /** Callback when send is clicked */
  onSend?: (data: InvoiceData) => void;
  /** Additional class name */
  className?: string;
}

const METADATA: ComponentMetadata = {
  id: 'invoice-builder',
  name: 'InvoiceBuilder',
  displayName: 'Invoice Builder',
  isDisplayComp: true,
  type: 'InvoiceBuilder',
  description: 'Create and edit invoices with line items, tax, and PDF export',
  category: 'finance',
  keywords: ['invoice', 'billing', 'finance', 'pdf', 'business'],
  props: {
    initialData: 'Initial invoice data object',
    size: 'sm, md, or lg',
    mode: 'edit or preview',
    allowModeToggle: 'Allow switching between edit/preview',
    onChange: 'Callback when data changes',
    onSave: 'Callback when save clicked',
    onExportPdf: 'Callback for PDF export',
  }
};

// Currency options
const CURRENCIES = [
  { code: 'USD', symbol: '$', name: 'US Dollar' },
  { code: 'EUR', symbol: '€', name: 'Euro' },
  { code: 'GBP', symbol: '£', name: 'British Pound' },
  { code: 'INR', symbol: '₹', name: 'Indian Rupee' },
  { code: 'SEK', symbol: 'kr', name: 'Swedish Krona' },
];

// Default invoice data
const DEFAULT_INVOICE: InvoiceData = {
  invoiceNumber: '',
  invoiceDate: new Date().toISOString().split('T')[0],
  dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
  status: 'draft',
  companyName: '',
  companyAddress: '',
  companyEmail: '',
  companyPhone: '',
  customerName: '',
  customerAddress: '',
  customerEmail: '',
  customerPhone: '',
  items: [{ id: '1', description: '', quantity: 1, unitPrice: 0 }],
  currency: 'USD',
  taxRate: 0,
  discountRate: 0,
  discountType: 'percentage',
  notes: '',
  terms: 'Payment is due within 30 days of invoice date.',
};

// Generate unique ID
const generateId = () => Math.random().toString(36).substr(2, 9);

// Format currency
const formatCurrency = (amount: number, currency: string): string => {
  const curr = CURRENCIES.find(c => c.code === currency) || CURRENCIES[0];
  return `${curr.symbol}${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

interface InvoiceBuilderComponent extends React.FC<InvoiceBuilderProps> {
  Metadata: ComponentMetadata;
}

const InvoiceBuilder: React.FC<InvoiceBuilderProps> = ({
  initialData,
  size = 'md',
  mode: initialMode = 'edit',
  allowModeToggle = true,
  onChange,
  onSave,
  onExportPdf,
  onSend,
  className = '',
}) => {
  const [invoice, setInvoice] = useState<InvoiceData>({ ...DEFAULT_INVOICE, ...initialData });
  const [mode, setMode] = useState<InvoiceBuilderMode>(initialMode);
  const printRef = useRef<HTMLDivElement>(null);

  // Calculate totals
  const calculations = useMemo(() => {
    const subtotal = invoice.items.reduce((sum, item) => sum + (item.quantity * item.unitPrice), 0);
    const discountAmount = invoice.discountType === 'percentage'
      ? subtotal * (invoice.discountRate / 100)
      : invoice.discountRate;
    const taxableAmount = subtotal - discountAmount;
    const taxAmount = taxableAmount * (invoice.taxRate / 100);
    const total = taxableAmount + taxAmount;

    return { subtotal, discountAmount, taxableAmount, taxAmount, total };
  }, [invoice.items, invoice.taxRate, invoice.discountRate, invoice.discountType]);

  // Update invoice data
  const updateInvoice = useCallback((updates: Partial<InvoiceData>) => {
    setInvoice(prev => {
      const newData = { ...prev, ...updates };
      onChange?.(newData);
      return newData;
    });
  }, [onChange]);

  // Add new line item
  const addItem = useCallback(() => {
    const newItem: InvoiceItem = { id: generateId(), description: '', quantity: 1, unitPrice: 0 };
    updateInvoice({ items: [...invoice.items, newItem] });
  }, [invoice.items, updateInvoice]);

  // Remove line item
  const removeItem = useCallback((id: string) => {
    if (invoice.items.length > 1) {
      updateInvoice({ items: invoice.items.filter(item => item.id !== id) });
    }
  }, [invoice.items, updateInvoice]);

  // Update line item
  const updateItem = useCallback((id: string, updates: Partial<InvoiceItem>) => {
    updateInvoice({
      items: invoice.items.map(item => item.id === id ? { ...item, ...updates } : item)
    });
  }, [invoice.items, updateInvoice]);

  // Handle save
  const handleSave = useCallback(() => {
    onSave?.(invoice);
  }, [invoice, onSave]);

  // Handle PDF export
  const handleExportPdf = useCallback(() => {
    if (onExportPdf) {
      onExportPdf(invoice);
    } else {
      // Default: print the preview
      window.print();
    }
  }, [invoice, onExportPdf]);

  // Handle send
  const handleSend = useCallback(() => {
    onSend?.(invoice);
  }, [invoice, onSend]);

  // Status badge color
  const getStatusColor = (status: InvoiceData['status']) => {
    switch (status) {
      case 'draft': return 'badge-ghost';
      case 'sent': return 'badge-info';
      case 'paid': return 'badge-success';
      case 'overdue': return 'badge-error';
      default: return 'badge-ghost';
    }
  };

  // Size classes
  const sizeClasses = {
    sm: 'text-sm',
    md: 'text-base',
    lg: 'text-lg',
  };

  const inputSize = {
    sm: 'input-sm',
    md: 'input-md',
    lg: 'input-lg',
  };

  // Render edit mode
  const renderEditMode = () => (
    <div className="space-y-6">
      {/* Invoice Header */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Company Info */}
        <div className="space-y-4">
          <h3 className="font-semibold text-base-content flex items-center gap-2">
            <Icon icon="mdi:domain" className="w-5 h-5" />
            Your Company
          </h3>
          <div className="space-y-3">
            <input
              type="text"
              placeholder="Company Name"
              className={`input input-bordered w-full ${inputSize[size]}`}
              value={invoice.companyName}
              onChange={e => updateInvoice({ companyName: e.target.value })}
            />
            <textarea
              placeholder="Company Address"
              className={`textarea textarea-bordered w-full ${inputSize[size]}`}
              rows={2}
              value={invoice.companyAddress}
              onChange={e => updateInvoice({ companyAddress: e.target.value })}
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                type="email"
                placeholder="Email"
                className={`input input-bordered w-full ${inputSize[size]}`}
                value={invoice.companyEmail}
                onChange={e => updateInvoice({ companyEmail: e.target.value })}
              />
              <input
                type="tel"
                placeholder="Phone"
                className={`input input-bordered w-full ${inputSize[size]}`}
                value={invoice.companyPhone}
                onChange={e => updateInvoice({ companyPhone: e.target.value })}
              />
            </div>
          </div>
        </div>

        {/* Customer Info */}
        <div className="space-y-4">
          <h3 className="font-semibold text-base-content flex items-center gap-2">
            <Icon icon="mdi:account" className="w-5 h-5" />
            Bill To
          </h3>
          <div className="space-y-3">
            <input
              type="text"
              placeholder="Customer Name"
              className={`input input-bordered w-full ${inputSize[size]}`}
              value={invoice.customerName}
              onChange={e => updateInvoice({ customerName: e.target.value })}
            />
            <textarea
              placeholder="Customer Address"
              className={`textarea textarea-bordered w-full ${inputSize[size]}`}
              rows={2}
              value={invoice.customerAddress}
              onChange={e => updateInvoice({ customerAddress: e.target.value })}
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                type="email"
                placeholder="Email"
                className={`input input-bordered w-full ${inputSize[size]}`}
                value={invoice.customerEmail}
                onChange={e => updateInvoice({ customerEmail: e.target.value })}
              />
              <input
                type="tel"
                placeholder="Phone"
                className={`input input-bordered w-full ${inputSize[size]}`}
                value={invoice.customerPhone}
                onChange={e => updateInvoice({ customerPhone: e.target.value })}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Invoice Details */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div>
          <label className="label label-text text-xs">Invoice Number</label>
          <input
            type="text"
            placeholder="INV-001"
            className={`input input-bordered w-full ${inputSize[size]}`}
            value={invoice.invoiceNumber}
            onChange={e => updateInvoice({ invoiceNumber: e.target.value })}
          />
        </div>
        <div>
          <label className="label label-text text-xs">Invoice Date</label>
          <input
            type="date"
            className={`input input-bordered w-full ${inputSize[size]}`}
            value={invoice.invoiceDate}
            onChange={e => updateInvoice({ invoiceDate: e.target.value })}
          />
        </div>
        <div>
          <label className="label label-text text-xs">Due Date</label>
          <input
            type="date"
            className={`input input-bordered w-full ${inputSize[size]}`}
            value={invoice.dueDate}
            onChange={e => updateInvoice({ dueDate: e.target.value })}
          />
        </div>
        <div>
          <label className="label label-text text-xs">Currency</label>
          <select
            className={`select select-bordered w-full ${inputSize[size]}`}
            value={invoice.currency}
            onChange={e => updateInvoice({ currency: e.target.value })}
          >
            {CURRENCIES.map(c => (
              <option key={c.code} value={c.code}>{c.code} ({c.symbol})</option>
            ))}
          </select>
        </div>
      </div>

      {/* Line Items */}
      <div className="space-y-4">
        <h3 className="font-semibold text-base-content flex items-center gap-2">
          <Icon icon="mdi:format-list-bulleted" className="w-5 h-5" />
          Line Items
        </h3>
        <div className="overflow-x-auto">
          <table className="table table-sm w-full">
            <thead>
              <tr className="bg-base-200">
                <th className="w-1/2">Description</th>
                <th className="w-24 text-center">Qty</th>
                <th className="w-32 text-right">Unit Price</th>
                <th className="w-32 text-right">Total</th>
                <th className="w-12"></th>
              </tr>
            </thead>
            <tbody>
              {invoice.items.map((item, index) => (
                <tr key={item.id} className="hover">
                  <td>
                    <input
                      type="text"
                      placeholder="Item description"
                      className="input input-bordered input-sm w-full"
                      value={item.description}
                      onChange={e => updateItem(item.id, { description: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="1"
                      className="input input-bordered input-sm w-full text-center"
                      value={item.quantity}
                      onChange={e => updateItem(item.id, { quantity: parseInt(e.target.value) || 1 })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="input input-bordered input-sm w-full text-right"
                      value={item.unitPrice}
                      onChange={e => updateItem(item.id, { unitPrice: parseFloat(e.target.value) || 0 })}
                    />
                  </td>
                  <td className="text-right font-medium">
                    {formatCurrency(item.quantity * item.unitPrice, invoice.currency)}
                  </td>
                  <td>
                    <button
                      className="btn btn-ghost btn-xs btn-circle text-error"
                      onClick={() => removeItem(item.id)}
                      disabled={invoice.items.length === 1}
                    >
                      <Icon icon="mdi:close" className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="btn btn-outline btn-sm gap-1" onClick={addItem}>
          <Icon icon="mdi:plus" className="w-4 h-4" />
          Add Item
        </button>
      </div>

      {/* Totals & Settings */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Notes */}
        <div className="space-y-4">
          <div>
            <label className="label label-text text-xs">Notes</label>
            <textarea
              placeholder="Additional notes..."
              className="textarea textarea-bordered w-full"
              rows={3}
              value={invoice.notes}
              onChange={e => updateInvoice({ notes: e.target.value })}
            />
          </div>
          <div>
            <label className="label label-text text-xs">Terms & Conditions</label>
            <textarea
              placeholder="Payment terms..."
              className="textarea textarea-bordered w-full"
              rows={2}
              value={invoice.terms}
              onChange={e => updateInvoice({ terms: e.target.value })}
            />
          </div>
        </div>

        {/* Calculations */}
        <div className="space-y-3">
          <div className="flex justify-between items-center py-2 border-b border-base-300">
            <span className="text-base-content/70">Subtotal</span>
            <span className="font-medium">{formatCurrency(calculations.subtotal, invoice.currency)}</span>
          </div>

          <div className="flex items-center gap-2 py-2 border-b border-base-300">
            <span className="text-base-content/70 flex-1">Discount</span>
            <select
              className="select select-bordered select-xs"
              value={invoice.discountType}
              onChange={e => updateInvoice({ discountType: e.target.value as 'percentage' | 'fixed' })}
            >
              <option value="percentage">%</option>
              <option value="fixed">Fixed</option>
            </select>
            <input
              type="number"
              min="0"
              step="0.01"
              className="input input-bordered input-xs w-20 text-right"
              value={invoice.discountRate}
              onChange={e => updateInvoice({ discountRate: parseFloat(e.target.value) || 0 })}
            />
            <span className="w-24 text-right text-error">
              -{formatCurrency(calculations.discountAmount, invoice.currency)}
            </span>
          </div>

          <div className="flex items-center gap-2 py-2 border-b border-base-300">
            <span className="text-base-content/70 flex-1">Tax</span>
            <input
              type="number"
              min="0"
              max="100"
              step="0.1"
              className="input input-bordered input-xs w-16 text-right"
              value={invoice.taxRate}
              onChange={e => updateInvoice({ taxRate: parseFloat(e.target.value) || 0 })}
            />
            <span className="text-xs">%</span>
            <span className="w-24 text-right">
              {formatCurrency(calculations.taxAmount, invoice.currency)}
            </span>
          </div>

          <div className="flex justify-between items-center py-3 bg-base-200 rounded-lg px-4">
            <span className="font-bold text-lg">Total</span>
            <span className="font-bold text-xl text-primary">
              {formatCurrency(calculations.total, invoice.currency)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );

  // Render preview mode
  const renderPreviewMode = () => (
    <div ref={printRef} className="bg-white text-gray-900 p-8 shadow-lg rounded-lg max-w-3xl mx-auto print:shadow-none print:p-0">
      {/* Header */}
      <div className="flex justify-between items-start mb-8 pb-6 border-b-2 border-gray-200">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">INVOICE</h1>
          <div className="mt-2 text-sm text-gray-600">
            <div><span className="font-medium">Invoice #:</span> {invoice.invoiceNumber || 'N/A'}</div>
            <div><span className="font-medium">Date:</span> {invoice.invoiceDate}</div>
            <div><span className="font-medium">Due:</span> {invoice.dueDate}</div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xl font-bold text-gray-900">{invoice.companyName || 'Your Company'}</div>
          <div className="text-sm text-gray-600 whitespace-pre-line mt-1">{invoice.companyAddress}</div>
          <div className="text-sm text-gray-600">{invoice.companyEmail}</div>
          <div className="text-sm text-gray-600">{invoice.companyPhone}</div>
        </div>
      </div>

      {/* Bill To */}
      <div className="mb-8">
        <div className="text-sm font-medium text-gray-500 mb-2">BILL TO</div>
        <div className="text-lg font-semibold text-gray-900">{invoice.customerName || 'Customer Name'}</div>
        <div className="text-sm text-gray-600 whitespace-pre-line">{invoice.customerAddress}</div>
        <div className="text-sm text-gray-600">{invoice.customerEmail}</div>
        <div className="text-sm text-gray-600">{invoice.customerPhone}</div>
      </div>

      {/* Items Table */}
      <table className="w-full mb-8">
        <thead>
          <tr className="border-b-2 border-gray-200">
            <th className="text-left py-3 text-gray-600 font-medium">Description</th>
            <th className="text-center py-3 text-gray-600 font-medium w-20">Qty</th>
            <th className="text-right py-3 text-gray-600 font-medium w-28">Unit Price</th>
            <th className="text-right py-3 text-gray-600 font-medium w-28">Total</th>
          </tr>
        </thead>
        <tbody>
          {invoice.items.map((item, index) => (
            <tr key={item.id} className="border-b border-gray-100">
              <td className="py-3 text-gray-800">{item.description || `Item ${index + 1}`}</td>
              <td className="py-3 text-center text-gray-800">{item.quantity}</td>
              <td className="py-3 text-right text-gray-800">{formatCurrency(item.unitPrice, invoice.currency)}</td>
              <td className="py-3 text-right font-medium text-gray-900">{formatCurrency(item.quantity * item.unitPrice, invoice.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals */}
      <div className="flex justify-end mb-8">
        <div className="w-64">
          <div className="flex justify-between py-2 text-gray-600">
            <span>Subtotal</span>
            <span>{formatCurrency(calculations.subtotal, invoice.currency)}</span>
          </div>
          {calculations.discountAmount > 0 && (
            <div className="flex justify-between py-2 text-gray-600">
              <span>Discount {invoice.discountType === 'percentage' ? `(${invoice.discountRate}%)` : ''}</span>
              <span className="text-red-600">-{formatCurrency(calculations.discountAmount, invoice.currency)}</span>
            </div>
          )}
          {invoice.taxRate > 0 && (
            <div className="flex justify-between py-2 text-gray-600">
              <span>Tax ({invoice.taxRate}%)</span>
              <span>{formatCurrency(calculations.taxAmount, invoice.currency)}</span>
            </div>
          )}
          <div className="flex justify-between py-3 border-t-2 border-gray-200 mt-2">
            <span className="font-bold text-lg text-gray-900">Total</span>
            <span className="font-bold text-lg text-gray-900">{formatCurrency(calculations.total, invoice.currency)}</span>
          </div>
        </div>
      </div>

      {/* Notes & Terms */}
      {(invoice.notes || invoice.terms) && (
        <div className="border-t border-gray-200 pt-6 text-sm text-gray-600">
          {invoice.notes && (
            <div className="mb-4">
              <div className="font-medium text-gray-700 mb-1">Notes</div>
              <div className="whitespace-pre-line">{invoice.notes}</div>
            </div>
          )}
          {invoice.terms && (
            <div>
              <div className="font-medium text-gray-700 mb-1">Terms & Conditions</div>
              <div className="whitespace-pre-line">{invoice.terms}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className={`invoice-builder ${sizeClasses[size]} ${className}`}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6 p-4 bg-base-200 rounded-lg">
        <div className="flex items-center gap-3">
          <Icon icon="mdi:receipt-text" className="w-6 h-6 text-primary" />
          <div>
            <h2 className="font-bold text-lg">
              {invoice.invoiceNumber || 'New Invoice'}
            </h2>
            <span className={`badge ${getStatusColor(invoice.status)} badge-sm`}>
              {invoice.status.charAt(0).toUpperCase() + invoice.status.slice(1)}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Mode Toggle */}
          {allowModeToggle && (
            <div className="btn-group">
              <button
                className={`btn btn-sm ${mode === 'edit' ? 'btn-active' : ''}`}
                onClick={() => setMode('edit')}
              >
                <Icon icon="mdi:pencil" className="w-4 h-4" />
                <span className="hidden sm:inline ml-1">Edit</span>
              </button>
              <button
                className={`btn btn-sm ${mode === 'preview' ? 'btn-active' : ''}`}
                onClick={() => setMode('preview')}
              >
                <Icon icon="mdi:eye" className="w-4 h-4" />
                <span className="hidden sm:inline ml-1">Preview</span>
              </button>
            </div>
          )}

          <div className="divider divider-horizontal mx-1 h-8"></div>

          {/* Actions */}
          <button className="btn btn-sm btn-ghost gap-1" onClick={handleExportPdf}>
            <Icon icon="mdi:file-pdf-box" className="w-4 h-4" />
            <span className="hidden sm:inline">PDF</span>
          </button>
          <button className="btn btn-sm btn-ghost gap-1" onClick={handleSend}>
            <Icon icon="mdi:send" className="w-4 h-4" />
            <span className="hidden sm:inline">Send</span>
          </button>
          <button className="btn btn-sm btn-primary gap-1" onClick={handleSave}>
            <Icon icon="mdi:content-save" className="w-4 h-4" />
            <span className="hidden sm:inline">Save</span>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="bg-base-100 rounded-lg p-6 border border-base-300">
        {mode === 'edit' ? renderEditMode() : renderPreviewMode()}
      </div>

      {/* Print styles */}
      <style>{`
        @media print {
          .invoice-builder > *:not(.bg-base-100) {
            display: none !important;
          }
          .invoice-builder .bg-base-100 {
            border: none !important;
            padding: 0 !important;
          }
        }
      `}</style>
    </div>
  );
};

// Attach metadata
(InvoiceBuilder as InvoiceBuilderComponent).Metadata = METADATA;

export default InvoiceBuilder;
