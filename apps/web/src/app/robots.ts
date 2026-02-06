import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
    },
    sitemap: 'https://clawed.pro/sitemap.xml',
    host: 'https://clawed.pro',
  };
}
