import React, { useRef, useState, useCallback, useEffect } from 'react';
import { Icon } from '@iconify/react';
import type { ComponentMetadata } from '../types';

// A4 dimensions at 96 DPI: 794px x 1123px
// A4 in mm: 210mm x 297mm
const A4_WIDTH_PX = 794;
const A4_HEIGHT_PX = 1123;

type ReportSize = 'xs' | 'sm' | 'md' | 'lg';
type ReportOrientation = 'portrait' | 'landscape';
type ReportMode = 'content' | 'pdf';

interface ReportPage {
  id: string;
  content: React.ReactNode;
}

interface ReportViewerProps {
  /** Report mode - 'content' for JSX/HTML, 'pdf' for PDF files */
  mode?: ReportMode;
  /** PDF file URL (when mode is 'pdf') */
  pdfUrl?: string;
  /** PDF File object (alternative to pdfUrl - for uploaded files) */
  pdfFile?: File | null;
  /** Allow user to upload PDF via file picker */
  allowPdfUpload?: boolean;
  /** Callback when PDF file is selected */
  onPdfFileChange?: (file: File | null) => void;
  /** Report title displayed in header */
  title?: string;
  /** Report subtitle/description */
  subtitle?: string;
  /** Company/organization logo URL */
  logo?: string;
  /** Pages of the report - each page is rendered separately */
  pages?: ReportPage[];
  /** Single page content (alternative to pages array) */
  children?: React.ReactNode;
  /** Paper orientation */
  orientation?: ReportOrientation;
  /** Viewer size - scales the preview */
  size?: ReportSize;
  /** Show/hide toolbar */
  showToolbar?: boolean;
  /** Show/hide page numbers */
  showPageNumbers?: boolean;
  /** Custom header content */
  header?: React.ReactNode;
  /** Custom footer content */
  footer?: React.ReactNode;
  /** Date displayed on report */
  date?: string;
  /** Report ID/reference number */
  reportId?: string;
  /** Callback when print is triggered */
  onPrint?: () => void;
  /** Callback when download is triggered */
  onDownload?: () => void;
  /** Callback when share is triggered */
  onShare?: () => void;
  /** Additional class name */
  className?: string;
}

const METADATA: ComponentMetadata = {
  id: 'report-viewer',
  name: 'ReportViewer',
  displayName: 'A4 Report Viewer',
  isDisplayComp: true,
  type: 'ReportViewer',
  description: 'A4-sized printable report viewer with multi-page support and PDF viewing',
  category: 'document',
  keywords: ['report', 'print', 'pdf', 'a4', 'document', 'invoice', 'statement'],
  props: {
    mode: "'content' for JSX pages, 'pdf' for PDF files",
    pdfUrl: 'URL of PDF file to display',
    title: 'Report title',
    subtitle: 'Report subtitle/description',
    logo: 'Company logo URL',
    pages: 'Array of page objects with id and content',
    orientation: 'portrait or landscape',
    size: 'xs, sm, md, or lg - scales the preview',
    showToolbar: 'Show/hide toolbar (default: true)',
    showPageNumbers: 'Show/hide page numbers (default: true)',
  }
};

// Scale factors for different viewer sizes
const SCALE_FACTORS: Record<ReportSize, number> = {
  xs: 0.4,
  sm: 0.55,
  md: 0.7,
  lg: 0.85,
};

// Container heights to prevent overflow
const CONTAINER_HEIGHTS: Record<ReportSize, number> = {
  xs: A4_HEIGHT_PX * 0.4 + 40,
  sm: A4_HEIGHT_PX * 0.55 + 40,
  md: A4_HEIGHT_PX * 0.7 + 40,
  lg: A4_HEIGHT_PX * 0.85 + 40,
};

interface ReportViewerComponent extends React.FC<ReportViewerProps> {
  Metadata: ComponentMetadata;
}

const ReportViewer: React.FC<ReportViewerProps> = ({
  mode = 'content',
  pdfUrl,
  pdfFile,
  allowPdfUpload = false,
  onPdfFileChange,
  title = 'Report',
  subtitle,
  logo,
  pages,
  children,
  orientation = 'portrait',
  size = 'md',
  showToolbar = true,
  showPageNumbers = true,
  header,
  footer,
  date,
  reportId,
  onPrint,
  onDownload,
  onShare,
  className = '',
}) => {
  const reportRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [localPdfUrl, setLocalPdfUrl] = useState<string | null>(null);

  // Create object URL for uploaded file
  useEffect(() => {
    if (pdfFile) {
      const url = URL.createObjectURL(pdfFile);
      setLocalPdfUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setLocalPdfUrl(null);
    }
  }, [pdfFile]);

  // Hide body scroll when in fullscreen mode
  useEffect(() => {
    if (isFullscreen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isFullscreen]);

  // Get the effective PDF URL (either from prop or uploaded file)
  const effectivePdfUrl = localPdfUrl || pdfUrl;

  // Calculate dimensions based on orientation
  const paperWidth = orientation === 'portrait' ? A4_WIDTH_PX : A4_HEIGHT_PX;
  const paperHeight = orientation === 'portrait' ? A4_HEIGHT_PX : A4_WIDTH_PX;

  // Get scale factor
  const scale = isFullscreen ? 1 : SCALE_FACTORS[size];
  const containerHeight = isFullscreen ? '100vh' : CONTAINER_HEIGHTS[size];

  // Build pages array
  const reportPages: ReportPage[] = pages || (children ? [{ id: 'main', content: children }] : []);
  const totalPages = reportPages.length;

  const handlePrint = useCallback(() => {
    if (onPrint) {
      onPrint();
    }
    if (mode === 'pdf' && effectivePdfUrl) {
      // Open PDF in new window and print
      const printWindow = window.open(effectivePdfUrl, '_blank');
      printWindow?.addEventListener('load', () => {
        printWindow.print();
      });
    } else {
      window.print();
    }
  }, [onPrint, mode, effectivePdfUrl]);

  const handleDownload = useCallback(() => {
    if (onDownload) {
      onDownload();
    }
    if (mode === 'pdf' && effectivePdfUrl) {
      // Direct download for PDF
      const link = document.createElement('a');
      link.href = effectivePdfUrl;
      link.download = pdfFile?.name || `${title.replace(/\s+/g, '_')}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } else {
      // For content mode, trigger print dialog (save as PDF)
      window.print();
    }
  }, [onDownload, mode, effectivePdfUrl, title, pdfFile]);

  const handleShare = useCallback(async () => {
    if (onShare) {
      onShare();
      return;
    }
    const shareUrl = mode === 'pdf' && pdfUrl ? pdfUrl : window.location.href;

    if (navigator.share) {
      try {
        await navigator.share({
          title: title,
          text: subtitle || `Report: ${title}`,
          url: shareUrl,
        });
      } catch (err) {
        console.log('Share cancelled or failed:', err);
      }
    } else {
      await navigator.clipboard.writeText(shareUrl);
    }
  }, [onShare, title, subtitle, mode, pdfUrl]);

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    if (file && file.type === 'application/pdf') {
      onPdfFileChange?.(file);
    }
  }, [onPdfFileChange]);

  const handleClearFile = useCallback(() => {
    onPdfFileChange?.(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [onPdfFileChange]);

  const handlePrevPage = () => {
    setCurrentPage((prev) => Math.max(0, prev - 1));
  };

  const handleNextPage = () => {
    setCurrentPage((prev) => Math.min(totalPages - 1, prev + 1));
  };

  const toggleFullscreen = () => {
    setIsFullscreen(!isFullscreen);
  };

  // Default header renderer - using explicit dark colors for white paper
  const renderDefaultHeader = () => (
    <div className="flex items-start justify-between mb-6 pb-4 border-b-2 border-gray-300">
      <div className="flex items-center gap-4">
        {logo && (
          <img src={logo} alt="Logo" className="h-12 w-auto object-contain" />
        )}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
          {subtitle && <p className="text-sm text-gray-500 mt-1">{subtitle}</p>}
        </div>
      </div>
      <div className="text-right text-sm text-gray-500">
        {reportId && <div className="font-mono">Ref: {reportId}</div>}
        {date && <div className="mt-1">{date}</div>}
      </div>
    </div>
  );

  // Default footer renderer - using explicit dark colors for white paper
  const renderDefaultFooter = (pageNum: number) => (
    <div className="mt-auto pt-4 border-t border-gray-300 flex items-center justify-between text-xs text-gray-400">
      <div>Generated on {date || new Date().toLocaleDateString()}</div>
      {showPageNumbers && totalPages > 0 && (
        <div>Page {pageNum + 1} of {totalPages}</div>
      )}
    </div>
  );

  // Render a single page
  const renderPage = (page: ReportPage, index: number) => (
    <div
      key={page.id}
      className="bg-white shadow-xl relative text-gray-900"
      style={{
        width: paperWidth,
        height: paperHeight,
        padding: '48px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        pageBreakAfter: 'always',
        pageBreakInside: 'avoid',
        color: '#111827',
      }}
    >
      {/* Header */}
      {index === 0 && (header || renderDefaultHeader())}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {page.content}
      </div>

      {/* Footer */}
      {footer || renderDefaultFooter(index)}
    </div>
  );

  // Render PDF viewer
  const renderPdfViewer = () => (
    <div
      className="bg-white shadow-xl overflow-hidden"
      style={{
        width: paperWidth,
        height: paperHeight,
      }}
    >
      <iframe
        src={`${effectivePdfUrl}#toolbar=0&navpanes=0&scrollbar=0`}
        title={title}
        className="w-full h-full border-0"
        style={{
          backgroundColor: 'white',
          overflow: 'hidden',
        }}
      />
    </div>
  );

  // Render PDF upload placeholder
  const renderPdfUpload = () => (
    <div
      className="bg-white shadow-xl flex flex-col items-center justify-center cursor-pointer hover:bg-gray-50 transition-colors"
      style={{
        width: paperWidth,
        height: paperHeight,
        color: '#6B7280',
      }}
      onClick={handleFileSelect}
    >
      <Icon icon="mdi:file-pdf-box" className="w-20 h-20 mb-4 text-red-400" />
      <p className="text-lg font-medium text-gray-700 mb-2">Click to upload PDF</p>
      <p className="text-sm text-gray-500">or drag and drop</p>
    </div>
  );

  // Render empty state
  const renderEmpty = () => (
    <div
      className="bg-white shadow-xl flex items-center justify-center"
      style={{
        width: paperWidth,
        height: paperHeight,
        color: '#9CA3AF',
      }}
    >
      <div className="text-center">
        <Icon icon="mdi:file-document-outline" className="w-16 h-16 mx-auto mb-4 opacity-30" />
        <p>No content to display</p>
      </div>
    </div>
  );

  return (
    <>
      {/* Print-specific styles */}
      <style>{`
        @media print {
          /* Hide everything except print area */
          body * {
            visibility: hidden;
          }

          /* Show print area and its children */
          .report-print-area,
          .report-print-area * {
            visibility: visible !important;
          }

          /* Reset container and wrapper for print */
          .report-container {
            position: static !important;
            height: auto !important;
            overflow: visible !important;
          }

          .report-scaled-wrapper {
            position: static !important;
            width: auto !important;
            height: auto !important;
          }

          /* Reset print area - remove scaling */
          .report-print-area {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: ${paperWidth}px !important;
            height: auto !important;
            transform: none !important;
          }

          /* Page styling for print */
          .report-page {
            page-break-after: always;
            margin: 0 !important;
            box-shadow: none !important;
          }

          .report-page > div {
            width: 100% !important;
            height: auto !important;
            min-height: ${paperHeight}px !important;
            box-shadow: none !important;
          }

          /* Hide UI elements */
          .report-toolbar,
          .report-pagination,
          .report-viewer {
            display: block !important;
          }

          .report-toolbar,
          .report-pagination {
            display: none !important;
          }

          @page {
            size: ${orientation === 'portrait' ? 'A4 portrait' : 'A4 landscape'};
            margin: 10mm;
          }
        }
      `}</style>

      {/* Hidden file input for PDF upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        onChange={handleFileChange}
        className="hidden"
      />

      <div className={`report-viewer ${className}`}>
        {/* Toolbar */}
        {showToolbar && (
          <div className="report-toolbar flex items-center justify-between bg-base-200 rounded-lg p-3 mb-4">
            <div className="flex items-center gap-2">
              <Icon
                icon={mode === 'pdf' ? 'mdi:file-pdf-box' : 'mdi:file-document-outline'}
                className="w-5 h-5 text-base-content/60"
              />
              <span className="font-medium text-sm truncate max-w-[200px]" title={pdfFile?.name || title}>
                {pdfFile?.name || title}
              </span>
              {mode === 'content' && totalPages > 1 && (
                <span className="badge badge-ghost badge-sm">{totalPages} pages</span>
              )}
              {mode === 'pdf' && (
                <span className="badge badge-error badge-sm">PDF</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* Upload/File display for PDF mode */}
              {mode === 'pdf' && allowPdfUpload && (
                <>
                  {pdfFile ? (
                    /* Show uploaded file name with remove button */
                    <div className="flex items-center gap-1 bg-base-300 rounded-lg px-2 py-1">
                      <Icon icon="mdi:file-pdf-box" className="w-4 h-4 text-red-500" />
                      <span className="text-xs font-medium max-w-[120px] truncate" title={pdfFile.name}>
                        {pdfFile.name}
                      </span>
                      <button
                        className="btn btn-xs btn-circle btn-ghost"
                        onClick={handleClearFile}
                        title="Remove PDF"
                      >
                        <Icon icon="mdi:close" className="w-3 h-3" />
                      </button>
                    </div>
                  ) : (
                    /* Show upload button when no file */
                    <button
                      className="btn btn-sm btn-ghost gap-1"
                      onClick={handleFileSelect}
                      title="Upload PDF"
                    >
                      <Icon icon="mdi:upload" className="w-4 h-4" />
                      <span className="hidden sm:inline">Upload</span>
                    </button>
                  )}
                  <div className="divider divider-horizontal mx-0 h-6"></div>
                </>
              )}
              <button
                className="btn btn-sm btn-ghost gap-1"
                onClick={toggleFullscreen}
                title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              >
                <Icon icon={isFullscreen ? 'mdi:fullscreen-exit' : 'mdi:fullscreen'} className="w-4 h-4" />
              </button>
              <div className="divider divider-horizontal mx-0 h-6"></div>
              <button
                className="btn btn-sm btn-ghost gap-1"
                onClick={handlePrint}
                title="Print"
                disabled={mode === 'pdf' && !effectivePdfUrl}
              >
                <Icon icon="mdi:printer" className="w-4 h-4" />
                <span className="hidden sm:inline">Print</span>
              </button>
              <button
                className="btn btn-sm btn-ghost gap-1"
                onClick={handleDownload}
                title="Download PDF"
                disabled={mode === 'pdf' && !effectivePdfUrl}
              >
                <Icon icon="mdi:download" className="w-4 h-4" />
                <span className="hidden sm:inline">PDF</span>
              </button>
              <button
                className="btn btn-sm btn-ghost gap-1"
                onClick={handleShare}
                title="Share"
              >
                <Icon icon="mdi:share-variant" className="w-4 h-4" />
                <span className="hidden sm:inline">Share</span>
              </button>
            </div>
          </div>
        )}

        {/* Page container - fixed height based on size to prevent overflow */}
        <div
          className={`report-container flex justify-center ${isFullscreen ? 'fixed inset-0 z-50 bg-base-300 overflow-auto' : 'items-center overflow-hidden'}`}
          style={{
            height: isFullscreen ? '100vh' : (typeof containerHeight === 'number' ? `${containerHeight}px` : containerHeight),
          }}
        >
          {/* Fullscreen close button */}
          {isFullscreen && (
            <button
              className="btn btn-circle btn-sm fixed top-4 right-4 z-20 bg-base-100"
              onClick={toggleFullscreen}
            >
              <Icon icon="mdi:close" className="w-4 h-4" />
            </button>
          )}

          {/* Fullscreen mode - show at actual size, centered with padding */}
          {isFullscreen ? (
            <div
              ref={reportRef}
              className="report-print-area my-8"
              style={{
                width: paperWidth,
                flexShrink: 0,
              }}
            >
              {mode === 'pdf' ? (
                effectivePdfUrl ? (
                  <div className="report-page">
                    {renderPdfViewer()}
                  </div>
                ) : allowPdfUpload ? (
                  <div className="report-page">
                    {renderPdfUpload()}
                  </div>
                ) : (
                  renderEmpty()
                )
              ) : totalPages > 0 ? (
                <div className="report-page">
                  {renderPage(reportPages[currentPage], currentPage)}
                </div>
              ) : (
                renderEmpty()
              )}
            </div>
          ) : (
            /* Normal mode - scaled preview */
            <div
              className="report-scaled-wrapper"
              style={{
                width: paperWidth * scale,
                height: paperHeight * scale,
                position: 'relative',
                flexShrink: 0,
              }}
            >
              <div
                ref={reportRef}
                className="report-print-area"
                style={{
                  transform: `scale(${scale})`,
                  transformOrigin: 'top left',
                  width: paperWidth,
                  height: paperHeight,
                  position: 'absolute',
                  top: 0,
                  left: 0,
                }}
              >
                {mode === 'pdf' ? (
                  effectivePdfUrl ? (
                    <div className="report-page">
                      {renderPdfViewer()}
                    </div>
                  ) : allowPdfUpload ? (
                    <div className="report-page">
                      {renderPdfUpload()}
                    </div>
                  ) : (
                    renderEmpty()
                  )
                ) : totalPages > 0 ? (
                  <div className="report-page">
                    {renderPage(reportPages[currentPage], currentPage)}
                  </div>
                ) : (
                  renderEmpty()
                )}
              </div>
            </div>
          )}
        </div>

        {/* Pagination - only for content mode with multiple pages */}
        {mode === 'content' && totalPages > 1 && (
          <div className="report-pagination flex items-center justify-center gap-4 mt-4">
            <button
              className="btn btn-sm btn-ghost"
              onClick={handlePrevPage}
              disabled={currentPage === 0}
            >
              <Icon icon="mdi:chevron-left" className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2">
              {reportPages.map((_, index) => (
                <button
                  key={index}
                  className={`btn btn-sm btn-circle ${currentPage === index ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setCurrentPage(index)}
                >
                  {index + 1}
                </button>
              ))}
            </div>
            <button
              className="btn btn-sm btn-ghost"
              onClick={handleNextPage}
              disabled={currentPage === totalPages - 1}
            >
              <Icon icon="mdi:chevron-right" className="w-5 h-5" />
            </button>
          </div>
        )}
      </div>
    </>
  );
};

// Attach metadata to component
(ReportViewer as ReportViewerComponent).Metadata = METADATA;

export default ReportViewer;
