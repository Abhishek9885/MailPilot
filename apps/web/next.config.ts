import type { NextConfig } from "next";
import { WebEnvironmentSchema } from "@mailpilot/shared";

WebEnvironmentSchema.parse(process.env);

const nextConfig: NextConfig = {
  poweredByHeader: false
};

export default nextConfig;
