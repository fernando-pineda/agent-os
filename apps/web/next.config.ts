import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/backend/:path*',
        destination: 'http://localhost:8787/:path*',
      },
    ];
  },
  // SSE requires no buffering at the proxy layer
  httpAgentOptions: {
    keepAlive: true,
  },
};

export default nextConfig;
