export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const CLAWED_ESCROW_ADDRESS = (process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS || process.env.ESCROW_CONTRACT_ADDRESS || "0x879537938aaCCD249cA750F865E810414ac08D3E") as `0x${string}`;

// Minimal ABI for web+api (can be expanded)
export const CLAWED_ESCROW_ABI = [
  // views
  "function usdc() view returns (address)",
  "function treasury() view returns (address)",
  "function arbiter() view returns (address)",
  "function nextTaskId() view returns (uint256)",
  "function tasks(uint256) view returns (address requester,uint40 deadline,uint40 reviewWindow,uint40 escalationWindow,uint16 maxWinners,uint16 approvedCount,uint16 withdrawnCount,uint32 pendingSubmissions,uint128 payoutAmount,uint128 depositFeeAmount,uint128 recipientFeeAmount,uint8 status,bytes32 specHash,uint256 balance,uint256 submissionCount,uint256 claimCount)",
  "function submissions(uint256,uint256) view returns (address agent,uint8 status,uint40 submittedAt,bytes32 proofHash)",

  // writes
  "function createTask(uint128 payoutAmount,uint16 maxWinners,uint40 deadline,uint40 reviewWindow,uint40 escalationWindow,bytes32 specHash) returns (uint256)",
  "function fundTask(uint256 taskId)",
  "function claim(uint256 taskId) returns (uint256)",
  "function submitProof(uint256 taskId,uint256 submissionId,bytes32 proofHash)",
  "function approve(uint256 taskId,uint256 submissionId)",
  "function reject(uint256 taskId,uint256 submissionId)",
  "function withdraw(uint256 taskId,uint256 submissionId)",
  "function closeAndRefundRemainder(uint256 taskId)",
  "function cancelAndRefund(uint256 taskId,string reason)",
  "function openDispute(uint256 taskId,uint256 submissionId)",
  "function resolveDispute(uint256 taskId,uint256 submissionId,bool approved)",

  // events
  "event TaskCreated(uint256 indexed taskId, address indexed requester, uint128 payoutAmount, uint16 maxWinners, uint40 deadline, bytes32 specHash)",
  "event TaskFunded(uint256 indexed taskId, address indexed requester, uint256 escrowedAmount, uint256 depositFeePaid)",
  "event Claimed(uint256 indexed taskId, uint256 indexed submissionId, address indexed agent)",
  "event ProofSubmitted(uint256 indexed taskId, uint256 indexed submissionId, address indexed agent, bytes32 proofHash)",
  "event Approved(uint256 indexed taskId, uint256 indexed submissionId, address indexed approver)",
  "event Rejected(uint256 indexed taskId, uint256 indexed submissionId, address indexed approver)",
  "event Withdrawn(uint256 indexed taskId, uint256 indexed submissionId, address indexed agent, uint256 netPayout, uint256 recipientFee)",
  "event DisputeOpened(uint256 indexed taskId, uint256 indexed submissionId, address indexed by)",
  "event DisputeResolved(uint256 indexed taskId, uint256 indexed submissionId, address indexed by, bool approved)",
  "event TaskClosed(uint256 indexed taskId, address indexed requester, uint256 refunded)",
  "event TaskCancelled(uint256 indexed taskId, address indexed requester, uint256 refunded)",
  "event TaskRefunded(uint256 indexed taskId, address indexed requester, uint256 refunded, string reason)"
] as const;
