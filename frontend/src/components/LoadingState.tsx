import { Icon } from '@iconify/react';

interface LoadingStateProps {
  /**
   * The height of the loading container
   */
  height?: string | number;
  /**
   * Message to display while loading
   */
  message?: string;
  /**
   * Type of loading animation
   */
  variant?: 'spinner' | 'pulse' | 'skeleton';
  /**
   * Size of the loading indicator
   */
  size?: 'sm' | 'md' | 'lg';
}

/**
 * Professional loading state component with multiple variants
 * Follows IKEA design system with smooth animations
 */
const LoadingState = ({
  height = 400,
  message = 'Loading...',
  variant = 'spinner',
  size = 'md'
}: LoadingStateProps) => {
  const heightValue = typeof height === 'number' ? `${height}px` : height;

  const sizeMap = {
    sm: { icon: 'w-6 h-6', text: 'text-xs', skeleton: 'h-8' },
    md: { icon: 'w-8 h-8', text: 'text-sm', skeleton: 'h-12' },
    lg: { icon: 'w-12 h-12', text: 'text-base', skeleton: 'h-16' }
  };

  const currentSize = sizeMap[size];

  if (variant === 'skeleton') {
    return (
      <div
        style={{ height: heightValue }}
        className="bg-white rounded-xl shadow-sm border border-[#E2E8F0] p-6 animate-pulse"
      >
        <div className="space-y-4">
          {/* Header skeleton */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-[#E2E8F0] rounded-lg"></div>
            <div className="flex-1 space-y-2">
              <div className="h-5 bg-[#E2E8F0] rounded w-1/3"></div>
              <div className="h-3 bg-[#E2E8F0] rounded w-1/2"></div>
            </div>
          </div>

          {/* Content skeleton */}
          <div className="space-y-3 pt-4">
            <div className={`${currentSize.skeleton} bg-[#E2E8F0] rounded w-full`}></div>
            <div className={`${currentSize.skeleton} bg-[#E2E8F0] rounded w-5/6`}></div>
            <div className={`${currentSize.skeleton} bg-[#E2E8F0] rounded w-4/6`}></div>
          </div>
        </div>
      </div>
    );
  }

  if (variant === 'pulse') {
    return (
      <div
        style={{ height: heightValue }}
        className="bg-white rounded-xl shadow-sm border border-[#E2E8F0] flex items-center justify-center"
      >
        <div className="text-center">
          <div className="inline-flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 bg-[#4A7FFF] rounded-full animate-bounce [animation-delay:0ms]"></div>
              <div className="w-2.5 h-2.5 bg-[#4A7FFF] rounded-full animate-bounce [animation-delay:150ms]"></div>
              <div className="w-2.5 h-2.5 bg-[#4A7FFF] rounded-full animate-bounce [animation-delay:300ms]"></div>
            </div>
          </div>
          <p className={`${currentSize.text} text-[#64748B] mt-3 font-medium`}>{message}</p>
        </div>
      </div>
    );
  }

  // Default: spinner variant
  return (
    <div
      style={{ height: heightValue }}
      className="bg-white rounded-xl shadow-sm border border-[#E2E8F0] flex items-center justify-center"
    >
      <div className="text-center">
        <div className="inline-flex items-center justify-center">
          <Icon
            icon="mdi:loading"
            className={`${currentSize.icon} text-[#4A7FFF] animate-spin`}
          />
        </div>
        <p className={`${currentSize.text} text-[#64748B] mt-3 font-medium`}>{message}</p>
      </div>
    </div>
  );
};

export default LoadingState;
