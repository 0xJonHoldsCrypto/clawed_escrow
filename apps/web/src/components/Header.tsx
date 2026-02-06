'use client';

import Link from 'next/link';
import { ConnectButton } from '@rainbow-me/rainbowkit';

const LOGO_VARIANT = (process.env.NEXT_PUBLIC_LOGO_VARIANT || 'neon').toLowerCase();
const LOGO_SRC = LOGO_VARIANT === 'glitch' ? '/brand/logo-glitch.png' : '/brand/logo-neon.png';
export function Header() {
  return (
    <header className="header">
      <div className="header-content">
        <Link href="/" className="logo" aria-label="Clawed Escrow">
          <img className="logo-img" src={LOGO_SRC} alt="Clawed Escrow logo" width={40} height={40} />
          <span className={`logo-title ${LOGO_VARIANT === 'glitch' ? 'logo-title-glitch' : 'logo-title-neon'}`}>
            Clawed Escrow
          </span>
        </Link>

        <nav className="nav-links" aria-label="Primary">
          <Link href="/" className="nav-link">Tasks</Link>
          <Link href="/leaderboard" className="nav-link">Leaderboard</Link>
          <Link href="/docs/agents" className="nav-link">For Agents</Link>
          <Link href="/docs" className="nav-link">Docs</Link>
        </nav>

        <div className="header-actions">
          <Link href="/tasks/new" className="btn btn-primary btn-sm">
            + New Task
          </Link>
          <ConnectButton
            showBalance={false}
            chainStatus="icon"
            accountStatus={{
              smallScreen: 'avatar',
              largeScreen: 'full',
            }}
          />
        </div>
      </div>
    </header>
  );
}
