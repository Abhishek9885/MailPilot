export function getCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const cookieName = process.env.NODE_ENV === "production"
    ? "__Host-mailpilot_csrf"
    : "mailpilot_csrf";
  for (const item of document.cookie.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== cookieName) continue;
    try {
      return decodeURIComponent(item.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}
