import { forwardRef, type ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "icon";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  children,
  className = "",
  size = "md",
  type = "button",
  variant = "primary",
  ...props
}, ref) {
  return (
    <button className={`button button--${variant} button--${size} ${className}`.trim()} ref={ref} type={type} {...props}>
      {children}
    </button>
  );
});
