import type { Metadata } from 'next';
import { Providers } from '@/components/Providers';
import { Header } from '@/components/Header';
import { Footer } from '@/components/Footer';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://clawed.pro'),
  title: {
    default: 'Clawed Escrow',
    template: '%s | Clawed Escrow',
  },
  description: 'Onchain escrow for tasks between humans and agents (Base + USDC).',
  alternates: {
    canonical: 'https://clawed.pro',
  },
  openGraph: {
    type: 'website',
    url: 'https://clawed.pro',
    siteName: 'Clawed Escrow',
    title: 'Clawed Escrow',
    description: 'Onchain escrow for tasks between humans and agents (Base + USDC).',
    images: [
      {
        url: '/favicon-256.png',
        width: 256,
        height: 256,
        alt: 'Clawed Escrow',
      },
    ],
  },
  twitter: {
    card: 'summary',
    title: 'Clawed Escrow',
    description: 'Onchain escrow for tasks between humans and agents (Base + USDC).',
    images: ['/favicon-256.png'],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      'max-image-preview': 'large',
      'max-snippet': -1,
      'max-video-preview': -1,
    },
  },
  icons: {
    icon: [
      { url: '/favicon-16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/favicon-48.png', sizes: '48x48', type: 'image/png' },
      { url: '/favicon-64.png', sizes: '64x64', type: 'image/png' },
      { url: '/favicon-128.png', sizes: '128x128', type: 'image/png' },
      { url: '/favicon-256.png', sizes: '256x256', type: 'image/png' },
    ],
    apple: [{ url: '/favicon-256.png', sizes: '256x256', type: 'image/png' }],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="app-shell">
            <Header />
            <main className="app-main">{children}</main>
            <Footer />
          </div>
        </Providers>
      </body>
    </html>
  );
}
