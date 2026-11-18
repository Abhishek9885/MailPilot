import type { ReactNode } from "react";
import { requireSignedInUser } from "@/lib/server-auth";

export default async function WorkspaceLayout({ children }: Readonly<{ children: ReactNode }>) {
  await requireSignedInUser();
  return children;
}
