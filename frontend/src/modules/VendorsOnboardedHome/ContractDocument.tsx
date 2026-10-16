import React, { useEffect, useRef } from 'react';
import { Icon } from '@iconify/react';
import { COLORS } from '../../design-system/tokens';

const TEAL = {
  base: '#0F6B64',
  dark: '#0B4F4A',
  tint: '#E6F5F3',
  border: '#D7E8E6',
};

export interface ContractRecord {
  contract_id: string;
  contract_type: string;
  material_group: string;
  start_date: string;
  end_date: string;
  total_contract_value: number;
  price_escalation_clause: boolean;
  escalation_index: string | null;
  /** Ends today or later (decided by the database, not the browser's clock). */
  active: boolean;
  item_count: number;
}

export interface ContractItem {
  material_id: string;
  contract_unit_price: number;
  material_desc: string | null;
  unit_of_measure: string | null;
}

export interface ContractParty {
  vendor_id: string;
  vendor_name: string;
  city: string | null;
  state: string | null;
  payment_terms: string | null;
}

const formatINR = (n: number | null | undefined): string => {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
};

const formatDate = (d: string | null | undefined): string => {
  if (!d) return '—';
  const date = new Date(d);
  if (isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

// The sheet uses inline styles only, so the same markup prints on its own
// (the print frame has none of the app's CSS).
const ink = '#1E293B';
const muted = '#475569';
const sheet: React.CSSProperties = {
  backgroundColor: '#FFFFFF',
  color: ink,
  fontFamily: 'Georgia, "Times New Roman", serif',
  fontSize: 13,
  lineHeight: 1.6,
  padding: '40px 48px',
  maxWidth: 760,
  margin: '0 auto',
};
const clauseTitle: React.CSSProperties = { fontWeight: 700, margin: '18px 0 4px' };
const cell: React.CSSProperties = { borderBottom: '1px solid #CBD5E1', padding: '6px 8px', textAlign: 'left', verticalAlign: 'top' };
const headCell: React.CSSProperties = { ...cell, borderBottom: '1px solid #0F172A', fontWeight: 700, fontSize: 12 };

const PRINT_CSS = '@page { size: A4; margin: 14mm; } body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * A vendor's contract shown as a document (walkthrough, 16 Oct: "when somebody
 * clicks on one of the active contracts, the contract should pop up. Generally
 * a contract is a paper, PDF thing"). Built from the contract record, since no
 * signed copies are stored yet; Print / Save as PDF produces a real PDF.
 */
export const ContractDocument: React.FC<{
  contract: ContractRecord;
  vendor: ContractParty;
  /** null while loading */
  items: ContractItem[] | null;
  itemsError: string | null;
  onClose: () => void;
}> = ({ contract, vendor, items, itemsError, onClose }) => {
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Prints just the sheet, through a hidden frame; the browser's dialog offers "Save as PDF".
  const print = () => {
    const node = sheetRef.current;
    if (!node) return;
    const frame = document.createElement('iframe');
    Object.assign(frame.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    if (!doc || !frame.contentWindow) {
      frame.remove();
      return;
    }
    doc.open();
    doc.write(
      `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(`${contract.contract_id} ${vendor.vendor_name}`)}</title>` +
        `<style>${PRINT_CSS}</style></head><body>${node.outerHTML}</body></html>`
    );
    doc.close();
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 1000);
  };

  const place = [vendor.city, vendor.state].filter(Boolean).join(', ');
  const type = contract.contract_type || 'Contract';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ backgroundColor: 'rgba(15, 23, 42, 0.45)' }} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Contract ${contract.contract_id}`}
        className="w-full max-w-4xl rounded-xl overflow-hidden flex flex-col"
        style={{ backgroundColor: COLORS.white, maxHeight: '90vh', boxShadow: '0 10px 30px rgba(15, 23, 42, 0.25)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 flex items-center justify-between gap-3" style={{ borderBottom: `1px solid ${TEAL.border}` }}>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold truncate" style={{ color: COLORS.text.primary }}>
              {contract.contract_id} · {vendor.vendor_name}
            </h3>
            <p className="text-[11px]" style={{ color: COLORS.text.tertiary }}>
              {contract.active ? 'Active' : 'Lapsed'} · {formatDate(contract.start_date)} to {formatDate(contract.end_date)}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={print}
              disabled={items === null}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold"
              style={{ backgroundColor: items === null ? COLORS.lightGray : TEAL.base, color: items === null ? COLORS.text.tertiary : COLORS.white }}
            >
              <Icon icon="mdi:printer-outline" className="w-4 h-4" />
              Print / Save as PDF
            </button>
            <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg" style={{ color: COLORS.text.secondary }}>
              <Icon icon="mdi:close" className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="overflow-auto p-6" style={{ backgroundColor: COLORS.lightBackground }}>
          <div style={{ boxShadow: '0 1px 4px rgba(15, 23, 42, 0.15)', maxWidth: 760, margin: '0 auto' }}>
            <div ref={sheetRef} style={sheet}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #0F172A', paddingBottom: 12, marginBottom: 18 }}>
                <div>
                  <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase' }}>{type}</div>
                  <div style={{ fontSize: 12, color: muted }}>Supply of {contract.material_group} items</div>
                </div>
                <div style={{ textAlign: 'right', fontSize: 12 }}>
                  <div>
                    <b>Contract No.</b> {contract.contract_id}
                  </div>
                  <div>
                    <b>Status:</b> {contract.active ? 'Active' : 'Lapsed'}
                  </div>
                </div>
              </div>

              <p style={{ margin: 0 }}>
                This {type.toLowerCase()} is made between <b>the Buyer</b> and <b>{vendor.vendor_name}</b>
                {place && `, ${place}`} (supplier code {vendor.vendor_id}), the <b>Supplier</b>.
              </p>

              <div style={clauseTitle}>1. Term</div>
              <div>
                Valid from <b>{formatDate(contract.start_date)}</b> to <b>{formatDate(contract.end_date)}</b>.
              </div>

              <div style={clauseTitle}>2. Scope</div>
              <div>
                The Supplier will supply the items in the schedule below against the Buyer's purchase orders, at the agreed unit prices, for the
                term of this contract.
              </div>

              <div style={clauseTitle}>3. Schedule of rates</div>
              {itemsError ? (
                <div style={{ color: muted }}>The schedule couldn't be loaded: {itemsError}</div>
              ) : items === null ? (
                <div style={{ color: muted }}>Loading the schedule…</div>
              ) : items.length === 0 ? (
                <div style={{ color: muted }}>No items are recorded for this contract.</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th style={headCell}>#</th>
                      <th style={headCell}>Material</th>
                      <th style={headCell}>Code</th>
                      <th style={headCell}>Unit</th>
                      <th style={{ ...headCell, textAlign: 'right' }}>Contract unit price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, i) => (
                      <tr key={it.material_id}>
                        <td style={cell}>{i + 1}</td>
                        <td style={cell}>{it.material_desc || it.material_id}</td>
                        <td style={cell}>{it.material_id}</td>
                        <td style={cell}>{it.unit_of_measure || '—'}</td>
                        <td style={{ ...cell, textAlign: 'right' }}>{formatINR(it.contract_unit_price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div style={clauseTitle}>4. Price escalation</div>
              <div>
                {contract.price_escalation_clause
                  ? `Unit prices may be revised in line with the ${contract.escalation_index || 'agreed'} index.`
                  : 'Unit prices are fixed for the term of this contract.'}
              </div>

              <div style={clauseTitle}>5. Payment</div>
              <div>Payment terms: {vendor.payment_terms || 'as agreed'}.</div>

              <div style={clauseTitle}>6. Estimated contract value</div>
              <div>{formatINR(contract.total_contract_value)} over the term.</div>

              <div style={{ display: 'flex', gap: 48, marginTop: 40 }}>
                {['For the Buyer', `For ${vendor.vendor_name}`].map((party) => (
                  <div key={party} style={{ flex: 1 }}>
                    <div style={{ borderBottom: '1px solid #0F172A', height: 36 }} />
                    <div style={{ fontSize: 12, marginTop: 4 }}>{party}</div>
                    <div style={{ fontSize: 11, color: muted }}>Authorised signatory · Date: {formatDate(contract.start_date)}</div>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 32, paddingTop: 8, borderTop: '1px solid #CBD5E1', fontSize: 10, color: muted }}>
                Generated from the contract record on {formatDate(new Date().toISOString())}. A signed copy has not been uploaded.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
