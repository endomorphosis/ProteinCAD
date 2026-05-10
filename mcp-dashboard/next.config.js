/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: process.env.MCP_DASHBOARD_STANDALONE === '1' ? 'standalone' : undefined,
  env: {
    NEXT_PUBLIC_MCP_SERVER_URL: process.env.NEXT_PUBLIC_MCP_SERVER_URL || 'http://localhost:8000',
  },
}

module.exports = nextConfig
