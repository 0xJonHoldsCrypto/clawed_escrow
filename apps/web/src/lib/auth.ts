import { type Hex } from 'viem';

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256Hex(input: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return toHex(buf);
}

export function buildSignMessage(params: {
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  bodyHash: string;
}) {
  const { method, path, timestamp, nonce, bodyHash } = params;
  return `ClawedEscrow\n${method}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

export function randomNonce() {
  // browser-safe uuid
  return crypto.randomUUID();
}

export async function buildAuthHeaders(params: {
  address: string;
  signMessageAsync: (args: { message: string }) => Promise<Hex>;
  method: string;
  path: string;
  body?: any;
}) {
  const bodyObj = params.body ?? {};
  const bodyJson = JSON.stringify(bodyObj);
  const bodyHash = await sha256Hex(bodyJson);
  const timestamp = Date.now();
  const nonce = randomNonce();
  const message = buildSignMessage({
    method: params.method,
    path: params.path,
    timestamp,
    nonce,
    bodyHash,
  });

  const signature = await params.signMessageAsync({ message });

  return {
    'Content-Type': 'application/json',
    'X-Wallet-Address': params.address,
    'X-Signature': signature,
    'X-Timestamp': String(timestamp),
    'X-Nonce': nonce,
  } as Record<string, string>;
}
