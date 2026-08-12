import type { NextConfig } from "next";

const basePath = process.env.APP_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  basePath,
};

export default nextConfig;
