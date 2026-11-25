import type { NextConfig } from "next";
import { WebEnvironmentSchema } from "@mailpilot/shared";

WebEnvironmentSchema.parse(process.env);

const apiInternalHostport = process.env.API_INTERNAL_HOSTPORT;
if (apiInternalHostport && !/^[A-Za-z0-9.-]+:[0-9]{1,5}$/.test(apiInternalHostport)) {
  throw new Error("Invalid API_INTERNAL_HOSTPORT configuration");
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    if (!apiInternalHostport) return [];
    const apiOrigin = `http://${apiInternalHostport}`;
    return [
      { source: "/v1/:path*", destination: `${apiOrigin}/v1/:path*` },
      { source: "/health/:path*", destination: `${apiOrigin}/health/:path*` }
    ];
  }
};

export default nextConfig;
