"use client";

import { ErrorState } from "@/components/ui/states";

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="error-page">
      <ErrorState
        description="The request could not be completed. Try again in a moment."
        onRetry={reset}
        title="Something went wrong"
      />
    </main>
  );
}
