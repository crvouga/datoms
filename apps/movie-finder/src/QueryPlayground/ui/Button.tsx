import type {ReactNode} from 'react';
import {KeyboardShortcut} from './KeyboardShortcut';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'success';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  loadingText?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  keyboardShortcut?: string[];
  className?: string;
  title?: string;
  type?: 'button' | 'submit' | 'reset';
  children: ReactNode;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary: 'bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600',
  secondary: 'bg-gray-700 hover:bg-gray-600 disabled:bg-gray-600',
  danger: 'bg-red-600 hover:bg-red-700 disabled:bg-gray-600',
  success: 'bg-green-600 hover:bg-green-700 disabled:bg-gray-600',
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-base',
  lg: 'px-6 py-3 text-lg',
};

export function Button({
  onClick,
  disabled = false,
  loading = false,
  loadingText = 'Loading...',
  variant = 'primary',
  size = 'md',
  icon,
  keyboardShortcut,
  className = '',
  title,
  type = 'button',
  children,
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <button
      onClick={onClick}
      disabled={isDisabled}
      type={type}
      className={`
        flex items-center gap-2
        ${variantStyles[variant]}
        ${sizeStyles[size]}
        disabled:cursor-not-allowed
        text-white rounded font-medium transition-colors
        ${className}
      `.trim()}
      title={title}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <span className="flex-1">{loading ? loadingText : children}</span>
      {keyboardShortcut && <KeyboardShortcut keys={keyboardShortcut} />}
    </button>
  );
}
