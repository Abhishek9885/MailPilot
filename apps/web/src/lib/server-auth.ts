import { AppSessionResponseSchema } from "@mailpilot/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { webEnvironment } from "./environment";

export async function getSignedInUser(): Promise<{ id: string; email: string } | null> {
  const cookieName = process.env.NODE_ENV === "production" ? "__Host-mailpilot_session" : "mailpilot_session";
  const sessionToken = (await cookies()).get(cookieName)?.value;
  if (!sessionToken) return null;

  try {
    const response = await fetch(new URL("/v1/auth/session", webEnvironment.apiBaseUrl), {
      headers: { cookie: `${cookieName}=${sessionToken}` },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) return null;
    const session = AppSessionResponseSchema.safeParse(await response.json());
    return session.success ? session.data.user : null;
  } catch {
    return null;
  }
}

export async function requireSignedInUser(): Promise<{ id: string; email: string }> {
  const user = await getSignedInUser();
  if (!user) redirect("/sign-in");
  return user;
}
