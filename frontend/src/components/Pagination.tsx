import { Icon } from '@iconify/react';

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  totalItems: number;
  itemsPerPage: number;
  startIndex: number;
  endIndex: number;
}

const Pagination = ({
  currentPage,
  totalPages,
  onPageChange,
  totalItems,
  startIndex,
  endIndex
}: PaginationProps) => {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-between mt-4 pt-4 border-t border-[#E2E8F0]">
      <p className="text-sm text-[#64748B]">
        Showing {startIndex + 1} to {Math.min(endIndex, totalItems)} of {totalItems.toLocaleString()} rows
      </p>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPageChange(Math.max(1, currentPage - 1))}
          disabled={currentPage === 1}
          className="px-3 py-1.5 text-sm font-medium text-[#64748B] hover:bg-[#F1F5F9] rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200 flex items-center gap-1"
          aria-label="Previous page"
        >
          <Icon icon="mdi:chevron-left" className="w-5 h-5" />
          Previous
        </button>
        <span className="px-4 py-1.5 text-sm font-medium text-[#1E293B] bg-[#F8F9FB] rounded-lg">
          {currentPage} of {totalPages}
        </span>
        <button
          onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
          disabled={currentPage === totalPages}
          className="px-3 py-1.5 text-sm font-medium text-[#64748B] hover:bg-[#F1F5F9] rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200 flex items-center gap-1"
          aria-label="Next page"
        >
          Next
          <Icon icon="mdi:chevron-right" className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
};

export default Pagination;
