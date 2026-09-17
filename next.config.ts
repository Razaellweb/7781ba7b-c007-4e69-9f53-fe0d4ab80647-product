import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack(config) {
    config.ignoreWarnings = [
      /Critical dependency: the request of a dependency is an expression/,
    ];
    return config;
  },
};

export default nextConfig;
