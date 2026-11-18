import { randomUUID } from "node:crypto";
import { ServiceHealthSchema } from "@mailpilot/shared";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  const incomingRequestId = request.headers.get("x-request-id");
  const requestId = incomingRequestId && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(incomingRequestId)
    ? incomingRequestId
    : randomUUID();
  const body = ServiceHealthSchema.parse({ service: "web", status: "ok", requestId });
  console.info(JSON.stringify({ level: "info", event: "health.live", ...body }));

  return Response.json(body, {
    status: 200,
    headers: { "x-request-id": requestId, "cache-control": "no-store" }
  });
}
