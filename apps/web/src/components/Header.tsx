'use client';

import Link from 'next/link';
import { ConnectButton } from '@rainbow-me/rainbowkit';

export function Header() {
  return (
    <header className="header">
      <div className="header-content">
        <Link href="/" className="logo">
          <span className="logo-icon">🔒</span>
          <span className="logo-text">Clawed Escrow</span>
        </Link>
        <nav className="nav-links">
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
