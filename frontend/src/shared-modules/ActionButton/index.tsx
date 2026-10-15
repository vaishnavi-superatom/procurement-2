import React from 'react';
import { COLORS, SPACING, BORDER_RADIUS, TYPOGRAPHY, TRANSITIONS, SHADOWS } from '../../design-system/tokens';

export interface ActionButtonProps {
  /** Display text for the button */
  label: string;

  /** Click handler function */
  onClick: () => void;

  /** Button variant/style type */
  variant?: 'primary' | 'secondary' | 'danger' | 'success';

  /** Size of the button */
  size?: 'small' | 'medium' | 'large';

  /** Whether button is disabled */
  disabled?: boolean;

  /** Loading state - shows spinner */
  isLoading?: boolean;

  /** Optional icon/emoji before label */
  icon?: string;

  /** Full width button */
  fullWidth?: boolean;

  /** Custom className for additional styling */
  className?: string;

  /** Custom style object */
  style?: React.CSSProperties;
}

const ActionButton: React.FC<ActionButtonProps> = ({
  label,
  onClick,
  variant = 'primary',
  size = 'medium',
  disabled = false,
  isLoading = false,
  icon,
  fullWidth = false,
  className = '',
  style = {},
}) => {
  // Define variant styles
  const variantStyles: Record<string, React.CSSProperties> = {
    primary: {
      backgroundColor: COLORS.primary,
      color: COLORS.white,
      border: 'none',
    },
    secondary: {
      backgroundColor: COLORS.lightGray,
      color: COLORS.text.primary,
      border: `1px solid ${COLORS.borderGray}`,
    },
    danger: {
      backgroundColor: COLORS.error,
      color: COLORS.white,
      border: 'none',
    },
    success: {
      backgroundColor: COLORS.success,
      color: COLORS.white,
      border: 'none',
    },
  };

  // Define size styles
  const sizeStyles: Record<string, React.CSSProperties> = {
    small: {
      padding: `${SPACING.sm} ${SPACING.md}`,
      fontSize: TYPOGRAPHY.fontSize.small,
      fontWeight: TYPOGRAPHY.fontWeight.medium,
    },
    medium: {
      padding: `${SPACING.md} ${SPACING.lg}`,
      fontSize: TYPOGRAPHY.fontSize.body,
      fontWeight: TYPOGRAPHY.fontWeight.semibold,
    },
    large: {
      padding: `${SPACING.lg} ${SPACING.xl}`,
      fontSize: TYPOGRAPHY.fontSize.bodyLarge,
      fontWeight: TYPOGRAPHY.fontWeight.semibold,
    },
  };

  // Combine all styles
  const buttonStyle: React.CSSProperties = {
    fontFamily: TYPOGRAPHY.fontFamily.primary,
    borderRadius: BORDER_RADIUS.small,
    transition: TRANSITIONS.default,
    cursor: disabled || isLoading ? 'not-allowed' : 'pointer',
    display: fullWidth ? 'block' : 'inline-block',
    width: fullWidth ? '100%' : 'auto',
    opacity: disabled || isLoading ? 0.6 : 1,
    ...variantStyles[variant],
    ...sizeStyles[size],
    ...style,
  };

  // Hover state styling
  const handleMouseEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!disabled && !isLoading) {
      e.currentTarget.style.boxShadow = SHADOWS.hover;
      e.currentTarget.style.transform = 'translateY(-2px)';
    }
  };

  const handleMouseLeave = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.boxShadow = 'none';
    e.currentTarget.style.transform = 'translateY(0)';
  };

  const handleClick = () => {
    if (!disabled && !isLoading) {
      onClick();
    }
  };

  return (
    <button
      // style={buttonStyle}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      disabled={disabled || isLoading}
      className={`bg-base-150 text-base-content border border-base-300 cursor-pointer px-4 py-2 rounded-md hover:bg-base-200 transition-all flex items-center justify-center gap-2 min-h-[115px] ${fullWidth ? 'w-full' : ''} ${className}`}
      type="button"
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: SPACING.sm }}>
        {isLoading ? (
          <span
            style={{
              display: 'inline-block',
              width: '14px',
              height: '14px',
              border: `2px solid currentColor`,
              borderTopColor: 'transparent',
              borderRadius: '50%',
              animation: 'spin 0.6s linear infinite',
            }}
          />
        ) : icon ? (
          <span>{icon}</span>
        ) : null}
        <span>{label}</span>
      </span>
      <style>{`
        @keyframes spin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </button>
  );
};

export default ActionButton;
