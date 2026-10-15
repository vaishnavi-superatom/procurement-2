/**
 * Design System Tokens
 * Based on design-system.md documentation
 */

// ============================================
// COLOR PALETTE
// ============================================

export const COLORS = {
  // Primary Colors
  primary: '#4A7FFF',
  darkNavy: '#1E293B',
  darkNavyAlt: '#2D3748',
  lightBackground: '#F8F9FB',

  // Functional Colors
  success: '#4ADE80',
  warning: '#FB923C',
  error: '#FF6B4A',
  info: '#FBBF24',

  // Text Colors
  text: {
    primary: '#1E293B',
    secondary: '#64748B',
    tertiary: '#94A3B8',
    white: '#FFFFFF',
  },

  // UI Colors
  white: '#FFFFFF',
  lightGray: '#F1F5F9',
  borderGray: '#E2E8F0',

  // Chart Colors
  chart: {
    positive: '#4A7FFF',
    negative: '#FF6B4A',
    secondary: '#C084FC',
    tertiary: '#22D3EE',
  },
};

// ============================================
// TYPOGRAPHY
// ============================================

export const TYPOGRAPHY = {
  fontFamily: {
    primary: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    monospace: 'SF Mono, Monaco, Cascadia Code, monospace',
  },

  fontSize: {
    hero: '48px',      // 3rem
    pageTitle: '32px', // 2rem
    section: '24px',   // 1.5rem
    subsection: '20px', // 1.25rem
    bodyLarge: '16px', // 1rem
    body: '14px',      // 0.875rem
    small: '12px',     // 0.75rem
    tiny: '10px',      // 0.625rem
  },

  fontWeight: {
    regular: '400',
    medium: '500',
    semibold: '600',
    bold: '700',
  },

  lineHeight: {
    heading: '1.2',
    body: '1.5',
    compact: '1.4',
  },
};

// ============================================
// SPACING SYSTEM (8px grid)
// ============================================

export const SPACING = {
  xs: '4px',   // 0.5
  sm: '8px',   // 1
  md: '12px',  // 1.5
  lg: '16px',  // 2
  xl: '24px',  // 3
  '2xl': '32px', // 4
  '3xl': '48px', // 6
  '4xl': '64px', // 8
};

export const SPACING_VALUES = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
  '3xl': 48,
  '4xl': 64,
};

// ============================================
// BORDER RADIUS
// ============================================

export const BORDER_RADIUS = {
  small: '4px',
  medium: '8px',
  large: '12px',
  xlarge: '16px',
  circle: '50%',
  full: '9999px',
};

// ============================================
// SHADOWS & ELEVATION
// ============================================

export const SHADOWS = {
  card: '0 1px 3px rgba(0, 0, 0, 0.1)',
  dropdown: '0 4px 6px rgba(0, 0, 0, 0.1)',
  modal: '0 10px 15px rgba(0, 0, 0, 0.1)',
  overlay: '0 20px 25px rgba(0, 0, 0, 0.1)',
  hover: '0 4px 16px rgba(0, 0, 0, 0.12)',
  elevated: '0 8px 24px rgba(0, 0, 0, 0.15)',
  subtle: '0 1px 3px rgba(0, 0, 0, 0.06)',
};

// ============================================
// TRANSITIONS & ANIMATIONS
// ============================================

export const TRANSITIONS = {
  default: 'all 0.2s ease-in-out',
  slow: 'all 0.3s ease-in-out',
  fast: 'all 0.15s ease-in-out',
};

export const ANIMATION = {
  duration: {
    fast: 150,
    default: 200,
    slow: 300,
  },
  easing: {
    easeInOut: 'ease-in-out',
    easeOut: 'ease-out',
    easeIn: 'ease-in',
  },
};

// ============================================
// LAYOUT
// ============================================

export const LAYOUT = {
  containerMaxWidth: '1440px',
  sidebarWidth: '224px',
  contentPadding: '24px',
  cardGap: '20px',
  container: {
    maxWidth: '1440px',
    padding: {
      mobile: '24px',
      tablet: '32px',
      desktop: '48px',
    },
  },
  sidebar: {
    width: '224px',
    background: `linear-gradient(180deg, #2D3748 0%, #1E293B 100%)`,
    padding: {
      horizontal: '24px',
      vertical: '16px',
    },
  },
  content: {
    padding: '32px',
    background: '#F8F9FB',
    gap: '24px',
  },
  grid: {
    gap: '24px',
  },
};

// ============================================
// BREAKPOINTS
// ============================================

export const BREAKPOINTS = {
  mobile: 768,
  tablet: 1024,
  desktop: 1440,
};

// ============================================
// Z-INDEX LAYERS
// ============================================

export const Z_INDEX = {
  base: 1,
  dropdown: 100,
  sticky: 200,
  modal: 300,
  overlay: 400,
  tooltip: 500,
};

// ============================================
// COMPONENT SPECIFIC
// ============================================

export const COMPONENTS = {
  button: {
    padding: {
      sm: '8px 16px',
      md: '10px 20px',
      lg: '12px 24px',
    },
    borderRadius: BORDER_RADIUS.medium,
    fontSize: TYPOGRAPHY.fontSize.body,
    fontWeight: TYPOGRAPHY.fontWeight.medium,
  },

  card: {
    padding: '24px',
    borderRadius: BORDER_RADIUS.large,
    shadow: SHADOWS.card,
    border: `1px solid ${COLORS.borderGray}`,
  },

  input: {
    padding: '8px 12px',
    borderRadius: BORDER_RADIUS.medium,
    fontSize: TYPOGRAPHY.fontSize.body,
    border: `1px solid ${COLORS.borderGray}`,
  },

  badge: {
    padding: '4px 8px',
    borderRadius: BORDER_RADIUS.large,
    fontSize: TYPOGRAPHY.fontSize.tiny,
    fontWeight: TYPOGRAPHY.fontWeight.semibold,
  },

  icon: {
    sm: '16px',
    md: '20px',
    lg: '24px',
    xl: '28px',
  },

  table: {
    header: {
      background: COLORS.lightBackground,
      padding: '12px 16px',
      fontSize: TYPOGRAPHY.fontSize.small,
      fontWeight: TYPOGRAPHY.fontWeight.semibold,
    },
    row: {
      padding: '16px',
      fontSize: TYPOGRAPHY.fontSize.body,
    },
  },
};

// ============================================
// CARD STYLES
// ============================================

export const CARD_STYLES = {
  primary: {
    background: COLORS.white,
    borderRadius: BORDER_RADIUS.large,
    padding: SPACING.xl,
    shadow: SHADOWS.card,
  },
  secondary: {
    background: COLORS.darkNavy,
    borderRadius: BORDER_RADIUS.medium,
    padding: SPACING.lg,
    color: COLORS.white,
  },
};

// ============================================
// TABLE STYLES
// ============================================

export const TABLE_STYLES = {
  header: {
    fontSize: TYPOGRAPHY.fontSize.tiny,
    fontWeight: TYPOGRAPHY.fontWeight.medium,
    color: COLORS.text.secondary,
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  row: {
    padding: `${SPACING.lg} ${SPACING.md}`,
    borderBottom: `1px solid ${COLORS.borderGray}`,
    hoverBackground: 'rgba(74, 127, 255, 0.05)',
  },
  cell: {
    fontSize: TYPOGRAPHY.fontSize.body,
    color: COLORS.text.primary,
  },
};

// ============================================
// CHART STYLES
// ============================================

export const CHART_STYLES = {
  bar: {
    width: '16px',
    gap: '8px',
    borderRadius: '4px',
    gridLine: 'rgba(0, 0, 0, 0.05)',
  },
  line: {
    width: '2px',
    pointSize: '6px',
    gridLine: 'rgba(108, 117, 125, 0.2)',
  },
  pie: {
    strokeWidth: '24px',
    hoverStrokeWidth: '28px',
  },
};

// ============================================
// BUTTON STYLES
// ============================================

export const BUTTON_STYLES = {
  primary: {
    background: COLORS.primary,
    color: COLORS.white,
    padding: `${SPACING.md} ${SPACING.xl}`,
    borderRadius: BORDER_RADIUS.medium,
    fontWeight: TYPOGRAPHY.fontWeight.semibold,
  },
};

// ============================================
// CHART COLORS
// ============================================

export const CHART_COLORS = {
  bar: [COLORS.primary, COLORS.chart.secondary, COLORS.chart.tertiary],
  line: [COLORS.primary, COLORS.success, COLORS.chart.secondary],
  pie: [COLORS.primary, COLORS.success, COLORS.warning, COLORS.chart.secondary],
  default: [COLORS.primary, COLORS.chart.secondary, COLORS.chart.tertiary, COLORS.success],
};

// 30 visually distinct colors for charts with many series/categories
// (scatter, line, pie, bar, treemap, radar). Brand colors first, then extended shades.
export const CHART_COLOR_PALETTE: string[] = [
  COLORS.primary,        // #4A7FFF blue
  COLORS.success,        // #4ADE80 green
  COLORS.warning,        // #FB923C orange
  COLORS.chart.secondary,// #C084FC purple
  COLORS.chart.tertiary, // #22D3EE cyan
  COLORS.error,          // #FF6B4A coral
  COLORS.info,           // #FBBF24 amber
  '#3B82F6', '#EC4899', '#14B8A6', '#F97316', '#6366F1',
  '#84CC16', '#A855F7', '#0EA5E9', '#D946EF', '#22C55E',
  '#EF4444', '#8B5CF6', '#F59E0B', '#06B6D4', '#818CF8',
  '#34D399', '#F472B6', '#38BDF8', '#FACC15', '#C4B5FD',
  '#86EFAC', '#E879F9', '#7DD3FC',
];

// ============================================
// ACCESSIBILITY
// ============================================

export const ACCESSIBILITY = {
  minTouchTarget: '44px',
  minContrastRatio: 4.5,
  focusOutlineWidth: '2px',
  focusOutlineOffset: '2px',
  focusOutlineColor: COLORS.primary,
};

// ============================================
// UTILITY FUNCTIONS
// ============================================

// Utility function to get chart colors based on type
export const getChartColors = (type: 'bar' | 'line' | 'pie' = 'bar') => {
  return CHART_COLORS[type] || CHART_COLORS.default;
};

// Utility function for hover states
export const getHoverShadow = () => SHADOWS.hover;

// Export all as default for convenience
export default {
  COLORS,
  TYPOGRAPHY,
  SPACING,
  SPACING_VALUES,
  BORDER_RADIUS,
  SHADOWS,
  TRANSITIONS,
  ANIMATION,
  LAYOUT,
  BREAKPOINTS,
  Z_INDEX,
  COMPONENTS,
  CARD_STYLES,
  TABLE_STYLES,
  CHART_STYLES,
  BUTTON_STYLES,
  CHART_COLORS,
  CHART_COLOR_PALETTE,
  ACCESSIBILITY,
  getChartColors,
  getHoverShadow,
};
