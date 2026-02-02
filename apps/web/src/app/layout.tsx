import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Clawed Escrow',
  description: 'Agent task escrow + proof-of-work router',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
