import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { base } from 'wagmi/chains';

export const config = getDefaultConfig({
  appName: 'Clawed Escrow',
  projectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID || 'clawed-escrow-dev',
  chains: [base],
  ssr: true,
});
