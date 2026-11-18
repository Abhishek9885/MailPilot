import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

interface SharedFieldProps {
  label: string;
  hint?: string;
  error?: string;
  labelHidden?: boolean;
}

interface TextFieldProps extends SharedFieldProps, InputHTMLAttributes<HTMLInputElement> {
  leadingIcon?: ReactNode;
}

function FieldMessages({ error, hint, id }: { error: string | undefined; hint: string | undefined; id: string }) {
  if (error) {
    return <p className="field__error" id={id} role="alert">{error}</p>;
  }
  if (hint) {
    return <p className="field__hint" id={id}>{hint}</p>;
  }
  return null;
}

export function TextField({
  className = "",
  error,
  hint,
  id,
  label,
  labelHidden = false,
  leadingIcon,
  ...props
}: TextFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const messageId = `${fieldId}-message`;
  const describedBy = error || hint ? messageId : undefined;

  return (
    <div className="field">
      <label className={labelHidden ? "field__label visually-hidden" : "field__label"} htmlFor={fieldId}>{label}</label>
      <div className={`field__control ${leadingIcon ? "field__control--icon" : ""}`.trim()}>
        {leadingIcon && <span aria-hidden="true" className="field__leading-icon">{leadingIcon}</span>}
        <input
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={`field__input ${className}`.trim()}
          id={fieldId}
          {...props}
        />
      </div>
      <FieldMessages error={error} hint={hint} id={messageId} />
    </div>
  );
}

interface SelectFieldProps extends SharedFieldProps, SelectHTMLAttributes<HTMLSelectElement> {}

export function SelectField({
  children,
  className = "",
  error,
  hint,
  id,
  label,
  labelHidden = false,
  ...props
}: SelectFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const messageId = `${fieldId}-message`;
  const describedBy = error || hint ? messageId : undefined;

  return (
    <div className="field">
      <label className={labelHidden ? "field__label visually-hidden" : "field__label"} htmlFor={fieldId}>{label}</label>
      <select
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={`field__input field__select ${className}`.trim()}
        id={fieldId}
        {...props}
      >
        {children}
      </select>
      <FieldMessages error={error} hint={hint} id={messageId} />
    </div>
  );
}

interface TextAreaFieldProps extends SharedFieldProps, TextareaHTMLAttributes<HTMLTextAreaElement> {}

export function TextAreaField({
  className = "",
  error,
  hint,
  id,
  label,
  labelHidden = false,
  ...props
}: TextAreaFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const messageId = `${fieldId}-message`;
  const describedBy = error || hint ? messageId : undefined;

  return (
    <div className="field">
      <label className={labelHidden ? "field__label visually-hidden" : "field__label"} htmlFor={fieldId}>{label}</label>
      <textarea
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={`field__input field__textarea ${className}`.trim()}
        id={fieldId}
        {...props}
      />
      <FieldMessages error={error} hint={hint} id={messageId} />
    </div>
  );
}
