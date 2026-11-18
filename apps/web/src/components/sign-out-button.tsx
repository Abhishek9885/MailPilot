"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { webEnvironment } from "@/lib/environment";

function getCookieValue(name: string): string | null {
  for (const item of document.cookie.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(item.slice(separator + 1).trim());
  }
  return null;
}

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const signOut = async () => {
    setPending(true);
    setError("");
    const csrfCookieName = process.env.NODE_ENV === "production" ? "__Host-mailpilot_csrf" : "mailpilot_csrf";
    const csrfToken = getCookieValue(csrfCookieName);
    if (!csrfToken) {
      setPending(false);
      setError("Your session needs refreshing. Please reload and try again.");
      return;
    }

    try {
      const response = await fetch(new URL("/v1/auth/sign-out", webEnvironment.apiBaseUrl), {
        method: "POST",
        credentials: "include",
        headers: { "x-csrf-token": csrfToken }
      });
      if (response.ok || response.status === 401) {
        router.replace("/sign-in");
        return;
      }
      setError("Sign-out could not be completed. Please try again.");
    } catch {
      setError("Sign-out could not be completed. Please try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="sign-out-control">
      <button className="sign-out-button" disabled={pending} onClick={() => void signOut()} type="button">
        {pending ? "Signing out…" : "Sign out"}
      </button>
      {error && <p aria-live="polite" className="sign-out-error">{error}</p>}
    </div>
  );
}
