import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import clsx from "clsx";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary:
    "bg-lantern-500 text-white hover:bg-lantern-400 active:scale-[0.98] shadow-sm shadow-lantern-500/20",
  secondary:
    "border border-zinc-700 bg-surface-1 text-zinc-200 hover:bg-surface-3 hover:border-zinc-600",
  ghost:
    "text-zinc-400 hover:text-zinc-100 hover:bg-surface-3",
  danger:
    "bg-red-500/10 text-red-300 border border-red-500/20 hover:bg-red-500/20",
};

const SIZE: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[11px] gap-1 rounded-md",
  md: "h-8 px-3 text-xs gap-1.5 rounded-lg",
  lg: "h-10 px-4 text-sm gap-2 rounded-lg",
};

interface CommonProps {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}

type ButtonProps = CommonProps & ButtonHTMLAttributes<HTMLButtonElement>;

const BASE =
  "inline-flex items-center justify-center font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed outline-none focus:ring-2 focus:ring-lantern-500/30 focus:ring-offset-0";

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = "secondary",
      size = "md",
      loading,
      icon,
      className,
      children,
      disabled,
      ...rest
    },
    ref,
  ) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={clsx(BASE, VARIANT[variant], SIZE[size], className)}
        {...rest}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          icon
        )}
        {children}
      </button>
    );
  },
);

interface LinkButtonProps extends CommonProps {
  href: string;
  external?: boolean;
}

export function LinkButton({
  variant = "secondary",
  size = "md",
  icon,
  className,
  children,
  href,
  external,
}: LinkButtonProps) {
  const cls = clsx(BASE, VARIANT[variant], SIZE[size], className);
  if (external) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
        {icon}
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {icon}
      {children}
    </Link>
  );
}
