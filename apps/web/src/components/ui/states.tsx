import type { ReactNode } from "react";
import { Button } from "./button";
import { Icon, type IconName } from "./icon";

interface EmptyStateProps {
  title: string;
  description: string;
  icon?: IconName;
  action?: ReactNode;
}

export function EmptyState({ title, description, icon = "mail", action }: EmptyStateProps) {
  return (
    <div className="state-panel empty-state" role="status" aria-live="polite">
      <span aria-hidden="true" className="state-panel__icon"><Icon name={icon} size={22} /></span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

interface ErrorStateProps {
  title?: string;
  description: string;
  onRetry?: () => void;
}

export function ErrorState({
  title = "We couldn't load this view",
  description,
  onRetry
}: ErrorStateProps) {
  return (
    <div className="state-panel error-state" role="alert">
      <span aria-hidden="true" className="state-panel__icon state-panel__icon--error"><Icon name="alert" size={22} /></span>
      <h2>{title}</h2>
      <p>{description}</p>
      {onRetry && <Button onClick={onRetry} variant="secondary">Try again</Button>}
    </div>
  );
}

export function LoadingSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <main aria-busy="true" className="loading-page">
      <p className="visually-hidden" role="status">Loading MailPilot workspace</p>
      <div aria-hidden="true" className="skeleton skeleton--eyebrow" />
      <div aria-hidden="true" className="skeleton skeleton--title" />
      <div aria-hidden="true" className="skeleton skeleton--subtitle" />
      <div aria-hidden="true" className="loading-stats">
        {Array.from({ length: 3 }, (_, index) => <div className="skeleton skeleton--stat" key={index} />)}
      </div>
      <div aria-hidden="true" className="skeleton skeleton--panel-title" />
      <div aria-hidden="true" className="loading-rows">
        {Array.from({ length: rows }, (_, index) => <div className="skeleton skeleton--row" key={index} />)}
      </div>
    </main>
  );
}

export function LoadingRows({ rows = 6, label = "Loading messages" }: { rows?: number; label?: string }) {
  return (
    <div aria-busy="true" className="inline-loading" role="status">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div aria-hidden="true" className="inline-loading__row" key={index}>
          <span />
          <span />
          <span />
        </div>
      ))}
    </div>
  );
}
