import { WebEnvironmentSchema } from "@mailpilot/shared";

export const webEnvironment = WebEnvironmentSchema.parse(process.env);
