/** @type {import('next').NextConfig} */
const path = require('path');

const nextConfig = {
  env: {
    API_URL: process.env.API_URL || 'https://clawedescrow-production.up.railway.app',
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'https://clawedescrow-production.up.railway.app',
    NEXT_PUBLIC_WC_PROJECT_ID: process.env.NEXT_PUBLIC_WC_PROJECT_ID || 'clawed-escrow',
  },

  // Fix Next.js monorepo tracing warning (prevents it from accidentally using /home/ubuntu/clawd)
  outputFileTracingRoot: path.join(__dirname, '../..'),

  webpack: (config) => {
    // Some wallet deps reference optional node/react-native modules.
    // We don't need them in the browser bundle; alias them away to avoid noisy build warnings.
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      '@react-native-async-storage/async-storage': false,
      'pino-pretty': false,
    };
    return config;
  },

  // Basic security headers (kept intentionally conservative to avoid breaking wallet flows)
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          // COOP can help isolate popups; keep permissive enough for wallet connects.
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
