import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createApiLogger } from "../src/logger.js";

describe("API structured logging redaction", () => {
  it("loads its redaction configuration and hides the internal service signature", async () => {
    const records: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        records.push(chunk.toString("utf8"));
        callback();
      }
    });
    const testLogger = createApiLogger(destination, "info");

    testLogger.info({ req: { headers: { "x-service-signature": "signature-secret" } } }, "request");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const serialized = records.join("");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("signature-secret");
    destination.destroy();
  });
});
