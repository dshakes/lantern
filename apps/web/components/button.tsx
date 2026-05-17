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

// Variant styles read from design tokens (--color-accent, --color-border-*,
// --elev-*) so swapping the palette in globals.css propagates everywhere
// without touching this file.
const VARIANT: Record<Variant, string> = {
  primary:
    "bg-(--color-accent) text-white hover:bg-(--color-accent-hover) active:scale-[0.98] shadow-(--elev-1) hover:shadow-(--elev-2)",
  secondary:
    "border border-(--color-border-default) bg-surface-1 text-zinc-200 hover:bg-surface-3 hover:border-(--color-border-strong)",
  ghost:
    "text-(--color-text-tertiary) hover:text-(--color-text-primary) hover:bg-surface-3",
  danger:
    "bg-(--color-danger-soft) text-red-300 border border-red-500/20 hover:bg-red-500/20",
};

// Sizes read from --text-* + --radius-* so the type scale evolves in one place.
const SIZE: Record<Size, string> = {
  sm: "h-7 px-2.5 text-(--text-xs) gap-1 rounded-(--radius-sm)",
  md: "h-8 px-3 text-(--text-sm) gap-1.5 rounded-(--radius-md)",
  lg: "h-10 px-4 text-(--text-base) gap-2 rounded-(--radius-md)",
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
  "inline-flex items-center justify-center font-medium transition-all duration-(--motion-fast) disabled:opacity-50 disabled:cursor-not-allowed outline-none focus-visible:ring-2 focus-visible:ring-(--color-accent-soft) focus-visible:ring-offset-0";

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
