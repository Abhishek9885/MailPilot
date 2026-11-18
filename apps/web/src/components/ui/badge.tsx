import type { HTMLAttributes } from "react";

export type BadgeTone = "neutral" | "teal" | "amber" | "blue" | "green" | "red";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  dot?: boolean;
}

export function Badge({ children, className = "", dot = false, tone = "neutral", ...props }: BadgeProps) {
  return (
    <span className={`badge badge--${tone} ${className}`.trim()} {...props}>
      {dot && <span aria-hidden="true" className="badge__dot" />}
      {children}
    </span>
  );
}
