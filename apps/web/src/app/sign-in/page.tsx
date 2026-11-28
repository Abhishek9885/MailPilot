import { redirect } from "next/navigation";
import { APP_PATHS } from "@/lib/app-routes";
import { webEnvironment } from "@/lib/environment";
import { getSignedInUser } from "@/lib/server-auth";

type SearchParams = Record<string, string | string[] | undefined>;

const SIGN_IN_ERRORS: Record<string, string> = {
  sign_in_cancelled: "Sign-in was cancelled. You can try again when you’re ready.",
  sign_in_failed: "We couldn’t verify that Google account. Please try again.",
  unavailable: "Google sign-in isn’t configured for this environment yet."
};

export default async function SignInPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  if (await getSignedInUser()) redirect("/");
  const params = await searchParams;
  const requestedReturnTo = Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo;
  const allowedReturnPaths = new Set<string>(Object.values(APP_PATHS));
  const returnTo = requestedReturnTo && allowedReturnPaths.has(requestedReturnTo)
    ? requestedReturnTo
    : "/";
  const errorCode = Array.isArray(params.error) ? params.error[0] : params.error;
  const errorMessage = errorCode ? SIGN_IN_ERRORS[errorCode] : undefined;
  const signInUrl = new URL("/v1/auth/google/start", webEnvironment.apiBaseUrl);
  signInUrl.searchParams.set("returnTo", returnTo);

  return (
    <main className="sign-in-page">
      <section aria-labelledby="sign-in-title" className="sign-in-card">
        <span aria-hidden="true" className="sign-in-brand-mark">M</span>
        <p className="sign-in-eyebrow">MailPilot AI</p>
        <h1 id="sign-in-title">Sign in to your workspace</h1>
        <p className="sign-in-copy">Use your Google account to sign in. MailPilot will request only your account identity and email address.</p>
        {errorMessage && <p className="sign-in-error" role="alert">{errorMessage}</p>}
        {errorCode === "unavailable" && (
          <details className="sign-in-setup-help">
            <summary>Local setup help</summary>
            <p>Add <code>GOOGLE_OIDC_CLIENT_ID</code> and <code>GOOGLE_OIDC_CLIENT_SECRET</code> to the repository <code>.env</code> file, then restart the API.</p>
            <p>Google Cloud authorized redirect URI: <code>http://localhost:4000/v1/auth/google/callback</code></p>
          </details>
        )}
        <a className="sign-in-button" href={signInUrl.toString()}>Continue with Google</a>
        <p className="sign-in-note">Signing in does not connect Gmail. You can authorize mailbox access separately from settings.</p>
      </section>
    </main>
  );
}
