import * as React from 'react';
import { cn } from '@renderer/utils/utils';

const Spinner = React.forwardRef<
  SVGSVGElement,
  React.SVGProps<SVGSVGElement> & {
    size?: 'sm' | 'md' | 'lg';
  }
>(({ className, size = 'md', ...props }, ref) => {
  const sizeClasses = {
    sm: 'h-4 w-4',
    md: 'h-5 w-5',
    lg: 'h-6 w-6',
  };

  return (
    <svg
      ref={ref}
      className={cn('animate-spin', sizeClasses[size], className)}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      {...props}
    >
      <circle
        className="opacity-20"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="2.25"
      />
      <path
        className="opacity-80"
        d="M22 12a10 10 0 0 0-10-10"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
      />
    </svg>
  );
});

Spinner.displayName = 'Spinner';

export { Spinner };
