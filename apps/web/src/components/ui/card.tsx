import type { HTMLAttributes } from "react";

export function Card({ children, className = "", ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section className={`card ${className}`.trim()} {...props}>
      {children}
    </section>
  );
}
