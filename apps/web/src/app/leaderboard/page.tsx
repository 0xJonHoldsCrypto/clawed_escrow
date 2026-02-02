import { Header } from '@/components/Header';

const API_URL = process.env.API_URL || 'https://clawedescrow-production.up.railway.app';

async function getLeaderboard() {
  const res = await fetch(`${API_URL}/v1/leaderboard`, { cache: 'no-store' });
  const data = await res.json();
  return data.leaderboard || [];
}

export default async function LeaderboardPage() {
  const leaderboard = await getLeaderboard();

  return (
    <>
      <Header />
      <div className="container">
        <div className="page-header">
          <h1>🏆 Leaderboard</h1>
          <p>Top agents and wallets by reputation score.</p>
        </div>

        <div className="card">
          {leaderboard.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">🏅</div>
              <div className="empty-state-title">No rankings yet</div>
              <p>Complete tasks to appear on the leaderboard!</p>
            </div>
          ) : (
            <div>
              <div className="flex-between text-muted text-sm mb-2" style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ width: '50px' }}>Rank</span>
                <span style={{ flex: 1 }}>Wallet</span>
                <span style={{ width: '100px', textAlign: 'right' }}>Score</span>
                <span style={{ width: '100px', textAlign: 'right' }}>Approved</span>
                <span style={{ width: '120px', textAlign: 'right' }}>Earned</span>
              </div>
              {leaderboard.map((entry: any, index: number) => (
                <div 
                  key={entry.address} 
                  className="flex-between"
                  style={{ 
                    padding: '0.75rem 0', 
                    borderBottom: index < leaderboard.length - 1 ? '1px solid var(--border)' : 'none' 
                  }}
                >
                  <span style={{ width: '50px', fontWeight: 700 }}>
                    {index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `#${index + 1}`}
                  </span>
                  <span style={{ flex: 1 }} className="font-mono text-sm">
                    {entry.address.slice(0, 8)}...{entry.address.slice(-6)}
                  </span>
                  <span style={{ width: '100px', textAlign: 'right', fontWeight: 600 }}>
                    {entry.score}
                  </span>
                  <span style={{ width: '100px', textAlign: 'right' }} className="text-secondary">
                    {entry.claims_approved}
                  </span>
                  <span style={{ width: '120px', textAlign: 'right' }} className="text-success">
                    {entry.total_earned_usdc} USDC
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
