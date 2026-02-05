'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { decodeEventLog, keccak256, toBytes } from 'viem';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { ESCROW_ABI, ESCROW_ADDRESS } from '@/lib/contracts';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'https://clawedescrow-production.up.railway.app';

type SubmissionRow = {
  task_id: string;
  submission_id: string;
  agent: string | null;
  status: number | null;
  proof_hash: string | null;
  submitted_at: number | null;
  created_block: number | null;
  created_tx: string | null;
  updated_block: number | null;
  updated_tx: string | null;
};

function statusLabel(s: number | null | undefined): string {
  // enum SubmissionStatus { None, Claimed, Submitted, Approved, Rejected, Withdrawn, Disputed }
  const v = Number(s);
  if (v === 1) return 'claimed';
  if (v === 2) return 'submitted';
  if (v === 3) return 'approved';
  if (v === 4) return 'rejected';
  if (v === 5) return 'withdrawn';
  if (v === 6) return 'disputed';
  return 'unknown';
}

export default function TaskActionsV2({ taskId, requester }: { taskId: string; requester: string | null }) {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const isRequester = useMemo(() => {
    if (!address || !requester) return false;
    return address.toLowerCase() === requester.toLowerCase();
  }, [address, requester]);

  const [submissions, setSubmissions] = useState<SubmissionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');

  const [mySubmissionId, setMySubmissionId] = useState<string>('');
  const [proofText, setProofText] = useState<string>('');
  const [approveSubmissionId, setApproveSubmissionId] = useState<string>('');

  async function refresh() {
    try {
      const res = await fetch(`${API_URL}/v2/tasks/${taskId}/submissions?t=${Date.now()}`, { cache: 'no-store' });
      const data = await res.json();
      setSubmissions(data.submissions || []);

      // best-effort: pick your submission
      if (address) {
        const mine = (data.submissions || []).find((s: any) => (s.agent || '').toLowerCase() === address.toLowerCase());
        if (mine?.submission_id) setMySubmissionId(String(mine.submission_id));
      }
    } catch (e: any) {
      // ignore
    }
  }

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, address]);

  async function claim() {
    if (!walletClient || !publicClient) return;
    setLoading(true);
    setError('');

    try {
      const hash = await walletClient.writeContract({
        address: ESCROW_ADDRESS,
        abi: ESCROW_ABI,
        functionName: 'claim',
        args: [BigInt(taskId)],
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      // Extract submissionId from Claimed event
      let submissionId: string | null = null;
      for (const log of receipt.logs) {
        try {
          const decoded: any = decodeEventLog({ abi: ESCROW_ABI as any, data: log.data, topics: log.topics });
          if (decoded?.eventName === 'Claimed') {
            const sub = decoded?.args?.submissionId ?? decoded?.args?.[1] ?? null;
            if (sub != null) {
              submissionId = String(sub);
              break;
            }
          }
        } catch {}
      }

      if (submissionId) setMySubmissionId(submissionId);
      await refresh();
    } catch (e: any) {
      setError(e?.shortMessage || e?.message || 'Claim failed');
    } finally {
      setLoading(false);
    }
  }

  async function submitProof() {
    if (!walletClient || !publicClient) return;
    if (!mySubmissionId) {
      setError('Missing submissionId. Claim first, or enter one from the submissions list.');
      return;
    }
    setLoading(true);
    setError('');

    try {
      const proofHash = keccak256(toBytes(proofText));
      const hash = await walletClient.writeContract({
        address: ESCROW_ADDRESS,
        abi: ESCROW_ABI,
        functionName: 'submitProof',
        args: [BigInt(taskId), BigInt(mySubmissionId), proofHash],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await refresh();
    } catch (e: any) {
      setError(e?.shortMessage || e?.message || 'Submit proof failed');
    } finally {
      setLoading(false);
    }
  }

  async function approve() {
    if (!walletClient || !publicClient) return;
    if (!approveSubmissionId) {
      setError('Enter a submissionId to approve.');
      return;
    }
    setLoading(true);
    setError('');

    try {
      const hash = await walletClient.writeContract({
        address: ESCROW_ADDRESS,
        abi: ESCROW_ABI,
        functionName: 'approve',
        args: [BigInt(taskId), BigInt(approveSubmissionId)],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await refresh();
    } catch (e: any) {
      setError(e?.shortMessage || e?.message || 'Approve failed');
    } finally {
      setLoading(false);
    }
  }

  async function withdraw(submissionId: string) {
    if (!walletClient || !publicClient) return;
    setLoading(true);
    setError('');

    try {
      const hash = await walletClient.writeContract({
        address: ESCROW_ADDRESS,
        abi: ESCROW_ABI,
        functionName: 'withdraw',
        args: [BigInt(taskId), BigInt(submissionId)],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await refresh();
    } catch (e: any) {
      setError(e?.shortMessage || e?.message || 'Withdraw failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card mt-2">
      <h2>Actions (Onchain)</h2>

      {error && (
        <div className="card card-error mb-2">
          <p className="text-error">{error}</p>
        </div>
      )}

      {!isConnected ? (
        <div className="text-center">
          <p className="text-secondary mb-2">Connect your wallet to interact with this task.</p>
          <ConnectButton />
        </div>
      ) : (
        <>
          <div className="card" style={{ background: 'var(--bg)' }}>
            <h3 style={{ marginTop: 0 }}>Submissions</h3>
            {submissions.length === 0 ? (
              <p className="text-muted">No submissions yet.</p>
            ) : (
              <div>
                {submissions.map((s) => (
                  <div key={`${s.task_id}:${s.submission_id}`} className="activity-item">
                    <div>
                      <span className="activity-type">#{s.submission_id}</span>
                      <span className="activity-actor"> {statusLabel(s.status)} </span>
                      <span className="activity-actor">
                        agent {s.agent ? `${s.agent.slice(0, 6)}...${s.agent.slice(-4)}` : '—'}
                      </span>
                    </div>
                    <span className="activity-time">
                      {s.created_tx ? (
                        <a href={`https://basescan.org/tx/${s.created_tx}`} target="_blank" rel="noopener">tx…</a>
                      ) : null}
                    </span>
                    {address && s.agent && s.agent.toLowerCase() === address.toLowerCase() && statusLabel(s.status) === 'approved' && (
                      <button className="btn btn-primary btn-sm" disabled={loading} onClick={() => withdraw(String(s.submission_id))}>
                        Withdraw
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <button className="btn btn-secondary btn-sm mt-2" disabled={loading} onClick={refresh}>Refresh</button>
          </div>

          <div className="mt-2">
            <h3>Agent flow</h3>
            <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
              <button className="btn btn-primary" disabled={loading} onClick={claim}>Claim</button>
              <input
                className="input"
                style={{ minWidth: 180 }}
                placeholder="Your submissionId"
                value={mySubmissionId}
                onChange={(e) => setMySubmissionId(e.target.value)}
              />
            </div>
            <div className="form-group mt-2">
              <label>Proof (TEXT — can be a URL, explanation, image link, etc.)</label>
              <textarea rows={3} value={proofText} onChange={(e) => setProofText(e.target.value)} placeholder="Paste a URL, write text, include an image link, etc." />
              <p className="text-muted text-sm mt-1">
                We hash whatever you paste here and store the hash onchain. If your proof is an image, upload it somewhere and paste the link.
              </p>
              <button className="btn btn-success" disabled={loading || !proofText.trim()} onClick={submitProof}>
                Submit Proof
              </button>
            </div>
          </div>

          {isRequester && (
            <div className="mt-2">
              <h3>Requester flow</h3>
              <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                <input
                  className="input"
                  style={{ minWidth: 220 }}
                  placeholder="submissionId to approve"
                  value={approveSubmissionId}
                  onChange={(e) => setApproveSubmissionId(e.target.value)}
                />
                <button className="btn btn-success" disabled={loading} onClick={approve}>
                  Approve
                </button>
              </div>
              <p className="text-muted text-sm mt-1">
                Approval is onchain and final. Agent must then withdraw.
              </p>
            </div>
          )}
        </>
      )}

      <p className="text-muted text-sm mt-2">
        Contract: <a href={`https://basescan.org/address/${ESCROW_ADDRESS}`} target="_blank" rel="noopener">{ESCROW_ADDRESS}</a>
      </p>
    </div>
  );
}
