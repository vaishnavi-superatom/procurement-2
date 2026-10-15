/**
 * Format a number with commas and optional decimal places
 * @param value - The number to format
 * @param decimals - Number of decimal places (default: 2)
 * @param forceDecimals - Whether to always show decimals even for whole numbers (default: false)
 * @returns Formatted string
 */
export function formatNumber(
  value: number | string | null | undefined,
  decimals: number = 2,
  forceDecimals: boolean = false
): string {
  if (value === null || value === undefined || value === '') {
    return 'N/A';
  }

  const numValue = typeof value === 'string' ? parseFloat(value) : value;

  if (isNaN(numValue)) {
    return 'N/A';
  }

  // Check if it's a whole number
  const isWholeNumber = numValue % 1 === 0;

  // If it's a whole number and we don't force decimals, don't show decimals
  if (isWholeNumber && !forceDecimals) {
    return numValue.toLocaleString('en-US');
  }

  // Otherwise, show with specified decimal places
  return numValue.toLocaleString('en-US', {
    minimumFractionDigits: forceDecimals ? decimals : 0,
    maximumFractionDigits: decimals
  });
}

/**
 * Format currency with $ sign, commas, and 2 decimal places
 * @param value - The number to format
 * @param decimals - Number of decimal places (default: 2)
 * @returns Formatted currency string
 */
export function formatCurrency(
  value: number | string | null | undefined,
  decimals: number = 2
): string {
  if (value === null || value === undefined || value === '') {
    return 'N/A';
  }

  const numValue = typeof value === 'string' ? parseFloat(value) : value;

  if (isNaN(numValue)) {
    return 'N/A';
  }

  return `$${numValue.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })}`;
}

/**
 * Format percentage with % sign and specified decimal places
 * @param value - The number to format
 * @param decimals - Number of decimal places (default: 2)
 * @returns Formatted percentage string
 */
export function formatPercentage(
  value: number | string | null | undefined,
  decimals: number = 2
): string {
  if (value === null || value === undefined || value === '') {
    return 'N/A';
  }

  const numValue = typeof value === 'string' ? parseFloat(value) : value;

  if (isNaN(numValue)) {
    return 'N/A';
  }

  return `${numValue.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  })}%`;
}
