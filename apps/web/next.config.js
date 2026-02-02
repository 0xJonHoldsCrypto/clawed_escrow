/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    API_URL: process.env.API_URL || 'https://clawedescrow-production.up.railway.app'
  }
};

module.exports = nextConfig;
