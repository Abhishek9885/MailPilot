import Workspace from "@/components/workspace";
import type { MailView } from "@/lib/mock-mail";

export function ViewPage({ view }: { view: MailView }) {
  return <Workspace initialView={view} />;
}
