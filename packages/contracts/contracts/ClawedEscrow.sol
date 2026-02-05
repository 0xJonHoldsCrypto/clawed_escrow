// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice Non-custodial USDC escrow for bounty-style tasks with multiple winners.
///
/// Fee model (split fee):
/// - On funding: a non-refundable deposit fee is paid immediately to the treasury.
/// - On withdrawal: a per-winner withdrawal fee is paid to the treasury alongside each payout.
///
/// Funding:
/// - Requester funds total = (payout + withdrawFee) * maxWinners, and depositFee is transferred to treasury.
///
/// Payout:
/// - Agents are paid one-by-one after approval (agent calls withdraw).
/// - Withdrawal fee is always collected for each completed payout.
///
/// Remainder:
/// - After deadline, requester can close the task and refund any *unreserved* remainder.
///   Reserved funds for approved-but-not-withdrawn submissions stay in escrow for the agent to claim.
///
/// Disputes resolved by an arbiter.
///
/// ---
/// V2 design notes (signature hooks / verifier):
/// - Keep this V1 contract non-upgradeable.
/// - A future V2 can add optional EIP-712 typed-data signatures to enable:
///   - gasless approvals/rejections by requester (relayed by anyone)
///   - allowlisted "verifier" attestations for submission/proof validity
/// - Suggested hook points:
///   - submitProofWithSig(..., bytes requesterSig) OR approveWithSig(...)
///   - resolveDisputeWithSig(..., bytes arbiterSig)
/// - Include domain separation (chainId, verifyingContract) and nonce per signer.
contract ClawedEscrow is Ownable, Pausable {
  using SafeERC20 for IERC20;

  // ===== Types =====
  enum TaskStatus {
    None,
    Created,
    Funded,
    Cancelled,
    Completed,
    Closed
  }

  enum SubmissionStatus {
    None,
    Claimed,
    Submitted,
    Approved,
    Rejected,
    Withdrawn,
    Disputed
  }

  struct Task {
    address requester;
    uint40 deadline;
    uint40 reviewWindow;     // seconds after submission where requester can approve/reject without arbitration
    uint40 escalationWindow; // seconds after reviewWindow where agent can escalate to arbiter
    uint16 maxWinners;
    uint16 approvedCount;
    uint16 withdrawnCount;
    uint32 pendingSubmissions; // count of submissions awaiting a final decision (Submitted/Disputed)
    uint128 payoutAmount;       // USDC minor units (6 decimals)
    uint128 depositFeeAmount;   // USDC minor units (6 decimals) per winner (charged at fund)
    uint128 recipientFeeAmount; // USDC minor units (6 decimals) per winner (taken from payout on withdraw)
    TaskStatus status;
    bytes32 specHash;     // optional (hash of off-chain instructions)
    uint256 balance;      // USDC held for this task (accounting) — payout principal only
    uint256 submissionCount;
    uint256 claimCount;
  }

  struct Submission {
    address agent;
    SubmissionStatus status;
    uint40 submittedAt; // timestamp of submitProof
    bytes32 proofHash; // optional; can be updated on submit
  }

  // ===== Immutable config =====
  IERC20 public immutable usdc;
  address public immutable treasury;
  address public immutable arbiter;

  // ===== Fee model (fixed) =====
  // Creator fee: charged at funding (non-refundable) as a % of payoutAmount.
  // Recipient fee: charged at withdrawal as a % of payoutAmount.
  uint16 public constant CREATOR_FEE_BPS = 200;   // 2%
  uint16 public constant RECIPIENT_FEE_BPS = 200; // 2%

  // ===== Storage =====
  uint256 public nextTaskId = 1;
  mapping(uint256 => Task) public tasks;
  mapping(uint256 => mapping(uint256 => Submission)) public submissions; // taskId => submissionId => Submission

  // ===== Events =====
  event TaskCreated(uint256 indexed taskId, address indexed requester, uint128 payoutAmount, uint16 maxWinners, uint40 deadline, bytes32 specHash);
  event TaskFunded(uint256 indexed taskId, address indexed requester, uint256 escrowedAmount, uint256 depositFeePaid);
  event TaskClosed(uint256 indexed taskId, address indexed requester, uint256 refunded);
  event TaskCancelled(uint256 indexed taskId, address indexed requester, uint256 refunded);
  event TaskRefunded(uint256 indexed taskId, address indexed requester, uint256 refunded, string reason);

  event Claimed(uint256 indexed taskId, uint256 indexed submissionId, address indexed agent);
  event ProofSubmitted(uint256 indexed taskId, uint256 indexed submissionId, address indexed agent, bytes32 proofHash);
  event Approved(uint256 indexed taskId, uint256 indexed submissionId, address indexed approver);
  event Rejected(uint256 indexed taskId, uint256 indexed submissionId, address indexed approver);
  event DisputeOpened(uint256 indexed taskId, uint256 indexed submissionId, address indexed by);
  event DisputeResolved(uint256 indexed taskId, uint256 indexed submissionId, address indexed by, bool approved);

  event Withdrawn(uint256 indexed taskId, uint256 indexed submissionId, address indexed agent, uint256 netPayout, uint256 recipientFee);

  // ===== Errors =====
  error NotRequester();
  error NotArbiter();
  error InvalidStatus();
  error DeadlineInPast();
  error NotFunded();
  error AlreadyFunded();
  error MaxWinnersZero();
  error OverMaxWinners();
  error SubmissionNotFound();
  error NotAgent();
  error NotApproved();
  error AlreadyWithdrawn();
  error DeadlineNotPassed();
  error HasClaims();
  error HasSubmissions();
  error HasPendingSubmissions();

  constructor(IERC20 usdc_, address treasury_, address arbiter_) Ownable(msg.sender) {
    require(address(usdc_) != address(0), "usdc=0");
    require(treasury_ != address(0), "treasury=0");
    require(arbiter_ != address(0), "arbiter=0");

    usdc = usdc_;
    treasury = treasury_;
    arbiter = arbiter_;
  }

  // ===== Admin (owner) =====
  function pause() external onlyOwner {
    _pause();
  }

  function unpause() external onlyOwner {
    _unpause();
  }

  /// @notice Rescue tokens that are not part of the escrow accounting (e.g., airdrops / mistakes).
  /// @dev For safety, rescuing the configured USDC token is intentionally disabled.
  function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
    require(token != address(usdc), "no usdc rescue");
    IERC20(token).safeTransfer(to, amount);
  }

  // ===== View helpers =====
  function perWinnerEscrowed(uint256 taskId) public view returns (uint256 total) {
    Task storage t = tasks[taskId];
    // escrow holds payout principal
    return uint256(t.payoutAmount);
  }

  function perWinnerDepositFee(uint256 taskId) public view returns (uint256 fee) {
    Task storage t = tasks[taskId];
    return uint256(t.depositFeeAmount);
  }

  function perWinnerRecipientFee(uint256 taskId) public view returns (uint256 fee) {
    Task storage t = tasks[taskId];
    return uint256(t.recipientFeeAmount);
  }

  function requiredEscrowFunding(uint256 taskId) public view returns (uint256 total) {
    Task storage t = tasks[taskId];
    return perWinnerEscrowed(taskId) * uint256(t.maxWinners);
  }

  function requiredDepositFee(uint256 taskId) public view returns (uint256 total) {
    Task storage t = tasks[taskId];
    return perWinnerDepositFee(taskId) * uint256(t.maxWinners);
  }

  // ===== Core flows =====

  /// @notice Create a task. Does not move funds.
  function createTask(
    uint128 payoutAmount,
    uint16 maxWinners,
    uint40 deadline,
    uint40 reviewWindow,
    uint40 escalationWindow,
    bytes32 specHash
  ) external whenNotPaused returns (uint256 taskId) {
    if (maxWinners == 0) revert MaxWinnersZero();
    if (deadline <= uint40(block.timestamp)) revert DeadlineInPast();

    uint256 depositFee = (uint256(payoutAmount) * uint256(CREATOR_FEE_BPS)) / 10_000;
    uint256 recipientFee = (uint256(payoutAmount) * uint256(RECIPIENT_FEE_BPS)) / 10_000;

    taskId = nextTaskId++;

    Task storage t = tasks[taskId];
    t.requester = msg.sender;
    t.deadline = deadline;
    t.reviewWindow = reviewWindow;
    t.escalationWindow = escalationWindow;
    t.maxWinners = maxWinners;
    t.approvedCount = 0;
    t.withdrawnCount = 0;
    t.pendingSubmissions = 0;
    t.payoutAmount = payoutAmount;
    t.depositFeeAmount = uint128(depositFee);
    t.recipientFeeAmount = uint128(recipientFee);
    t.status = TaskStatus.Created;
    t.specHash = specHash;
    t.balance = 0;
    t.submissionCount = 0;
    t.claimCount = 0;

    emit TaskCreated(taskId, msg.sender, payoutAmount, maxWinners, deadline, specHash);
  }

  /// @notice Fund a task with total (payout+fee)*maxWinners. Requester pays gas.
  function fundTask(uint256 taskId) external whenNotPaused {
    Task storage t = tasks[taskId];
    if (t.status != TaskStatus.Created) revert InvalidStatus();
    if (t.requester != msg.sender) revert NotRequester();

    uint256 escrowAmount = requiredEscrowFunding(taskId);
    uint256 depositFeeTotal = requiredDepositFee(taskId);

    t.status = TaskStatus.Funded;
    t.balance = escrowAmount;

    // Pull total from requester, then route fees.
    // (Requester must approve this contract for escrowAmount + depositFeeTotal.)
    usdc.safeTransferFrom(msg.sender, address(this), escrowAmount + depositFeeTotal);

    if (depositFeeTotal > 0) {
      usdc.safeTransfer(treasury, depositFeeTotal);
    }

    emit TaskFunded(taskId, msg.sender, escrowAmount, depositFeeTotal);
  }

  /// @notice Agents claim a slot (creates a submission record). Agent pays gas.
  function claim(uint256 taskId) external whenNotPaused returns (uint256 submissionId) {
    Task storage t = tasks[taskId];
    if (t.status != TaskStatus.Funded) revert NotFunded();
    if (block.timestamp > t.deadline) revert InvalidStatus();

    // Create a new submission record (does not reserve funds beyond maxWinners accounting)
    submissionId = t.submissionCount + 1;
    t.submissionCount = submissionId;
    t.claimCount += 1;

    submissions[taskId][submissionId] = Submission({
      agent: msg.sender,
      status: SubmissionStatus.Claimed,
      submittedAt: 0,
      proofHash: bytes32(0)
    });

    emit Claimed(taskId, submissionId, msg.sender);
  }

  /// @notice Agent submits proof for a specific submissionId. Agent pays gas.
  function submitProof(uint256 taskId, uint256 submissionId, bytes32 proofHash) external whenNotPaused {
    Task storage t = tasks[taskId];
    if (t.status != TaskStatus.Funded) revert NotFunded();

    Submission storage s = submissions[taskId][submissionId];
    if (s.status == SubmissionStatus.None) revert SubmissionNotFound();
    if (s.agent != msg.sender) revert NotAgent();
    if (s.status != SubmissionStatus.Claimed) revert InvalidStatus();

    s.status = SubmissionStatus.Submitted;
    s.submittedAt = uint40(block.timestamp);
    s.proofHash = proofHash;
    t.pendingSubmissions += 1;

    emit ProofSubmitted(taskId, submissionId, msg.sender, proofHash);
  }

  /// @notice Requester approves a submitted proof. Requester pays gas.
  function approve(uint256 taskId, uint256 submissionId) external whenNotPaused {
    Task storage t = tasks[taskId];
    if (t.requester != msg.sender) revert NotRequester();
    if (t.status != TaskStatus.Funded) revert NotFunded();

    Submission storage s = submissions[taskId][submissionId];
    if (s.status == SubmissionStatus.None) revert SubmissionNotFound();
    if (s.status != SubmissionStatus.Submitted) revert InvalidStatus();
    if (block.timestamp > uint256(s.submittedAt) + uint256(t.reviewWindow)) revert InvalidStatus();

    if (t.approvedCount >= t.maxWinners) revert OverMaxWinners();

    s.status = SubmissionStatus.Approved;
    t.approvedCount += 1;
    if (t.pendingSubmissions > 0) t.pendingSubmissions -= 1;

    emit Approved(taskId, submissionId, msg.sender);

    // Mark completed when approvals hit maxWinners (still allows withdrawals)
    if (t.approvedCount == t.maxWinners) {
      t.status = TaskStatus.Completed;
    }
  }

  /// @notice Requester rejects a submission. Requester pays gas.
  function reject(uint256 taskId, uint256 submissionId) external whenNotPaused {
    Task storage t = tasks[taskId];
    if (t.requester != msg.sender) revert NotRequester();
    if (t.status != TaskStatus.Funded && t.status != TaskStatus.Completed) revert NotFunded();

    Submission storage s = submissions[taskId][submissionId];
    if (s.status == SubmissionStatus.None) revert SubmissionNotFound();
    if (s.status != SubmissionStatus.Submitted) revert InvalidStatus();
    if (block.timestamp > uint256(s.submittedAt) + uint256(t.reviewWindow)) revert InvalidStatus();

    s.status = SubmissionStatus.Rejected;
    if (t.pendingSubmissions > 0) t.pendingSubmissions -= 1;
    emit Rejected(taskId, submissionId, msg.sender);
  }

  /// @notice Agent withdraws payout after approval. Agent pays gas.
  function withdraw(uint256 taskId, uint256 submissionId) external {
    Task storage t = tasks[taskId];
    if (t.status != TaskStatus.Funded && t.status != TaskStatus.Completed && t.status != TaskStatus.Closed) revert NotFunded();

    Submission storage s = submissions[taskId][submissionId];
    if (s.status == SubmissionStatus.None) revert SubmissionNotFound();
    if (s.agent != msg.sender) revert NotAgent();
    if (s.status != SubmissionStatus.Approved) revert NotApproved();

    // Effects
    s.status = SubmissionStatus.Withdrawn;
    t.withdrawnCount += 1;

    uint256 payout = uint256(t.payoutAmount);
    uint256 fee = uint256(t.recipientFeeAmount);
    if (fee > payout) revert InvalidStatus();

    // Accounting: escrow only holds payout principal
    if (t.balance < payout) revert InvalidStatus();
    t.balance -= payout;

    // Interactions: take fee out of the payout
    uint256 net = payout - fee;
    usdc.safeTransfer(msg.sender, net);
    if (fee > 0) usdc.safeTransfer(treasury, fee);

    emit Withdrawn(taskId, submissionId, msg.sender, net, fee);
  }

  // ===== Disputes =====

  /// @notice Escalate a submitted proof to the arbiter.
  /// @dev Only the agent can escalate, and only after the review window has elapsed.
  function openDispute(uint256 taskId, uint256 submissionId) external whenNotPaused {
    Task storage t = tasks[taskId];
    if (t.status != TaskStatus.Funded && t.status != TaskStatus.Completed) revert NotFunded();

    Submission storage s = submissions[taskId][submissionId];
    if (s.status == SubmissionStatus.None) revert SubmissionNotFound();
    if (msg.sender != s.agent) revert NotAgent();
    if (s.status != SubmissionStatus.Submitted) revert InvalidStatus();

    uint256 submittedAt_ = uint256(s.submittedAt);
    if (submittedAt_ == 0) revert InvalidStatus();
    uint256 reviewEnds = submittedAt_ + uint256(t.reviewWindow);
    uint256 escalationEnds = reviewEnds + uint256(t.escalationWindow);

    // Must wait for requester review window to end, but must escalate before escalation window ends.
    if (block.timestamp < reviewEnds) revert InvalidStatus();
    if (block.timestamp > escalationEnds) revert InvalidStatus();

    s.status = SubmissionStatus.Disputed;
    emit DisputeOpened(taskId, submissionId, msg.sender);
  }

  function resolveDispute(uint256 taskId, uint256 submissionId, bool approve_) external whenNotPaused {
    if (msg.sender != arbiter) revert NotArbiter();

    Task storage t = tasks[taskId];
    if (t.status != TaskStatus.Funded && t.status != TaskStatus.Completed) revert NotFunded();

    Submission storage s = submissions[taskId][submissionId];
    if (s.status != SubmissionStatus.Disputed) revert InvalidStatus();

    if (approve_) {
      if (t.approvedCount >= t.maxWinners) revert OverMaxWinners();
      s.status = SubmissionStatus.Approved;
      t.approvedCount += 1;
      if (t.pendingSubmissions > 0) t.pendingSubmissions -= 1;
      emit DisputeResolved(taskId, submissionId, msg.sender, true);
      if (t.approvedCount == t.maxWinners) {
        t.status = TaskStatus.Completed;
      }
    } else {
      s.status = SubmissionStatus.Rejected;
      if (t.pendingSubmissions > 0) t.pendingSubmissions -= 1;
      emit DisputeResolved(taskId, submissionId, msg.sender, false);
    }
  }

  // ===== Refunds / cancellation =====

  /// @notice Requester can cancel and refund if nobody has submitted proof yet.
  /// This matches: "refund allowed ... if nobody has submitted proof yet".
  function cancelIfNoSubmissions(uint256 taskId) external whenNotPaused {
    Task storage t = tasks[taskId];
    if (t.requester != msg.sender) revert NotRequester();
    if (t.status != TaskStatus.Funded && t.status != TaskStatus.Created) revert InvalidStatus();

    // If any submission is in Submitted/Approved/Rejected/Withdrawn/Disputed state, don't allow.
    // We only reliably know count; scan is expensive. For MVP: disallow if any submissions exist at all.
    // (Conservative, but safe.)
    if (t.submissionCount > 0) revert HasSubmissions();

    // If never funded, just mark cancelled.
    if (t.status == TaskStatus.Created) {
      t.status = TaskStatus.Cancelled;
      emit TaskCancelled(taskId, msg.sender, 0);
      return;
    }

    uint256 amount = t.balance;
    t.balance = 0;
    t.status = TaskStatus.Cancelled;
    usdc.safeTransfer(msg.sender, amount);

    emit TaskCancelled(taskId, msg.sender, amount);
  }

  /// @notice Refund if never claimed by deadline.
  /// Deposit fee is non-refundable by design.
  function refundIfNeverClaimedAfterDeadline(uint256 taskId) external whenNotPaused {
    Task storage t = tasks[taskId];
    if (t.requester != msg.sender) revert NotRequester();
    if (t.status != TaskStatus.Funded && t.status != TaskStatus.Created) revert InvalidStatus();
    if (block.timestamp <= t.deadline) revert DeadlineNotPassed();
    if (t.submissionCount > 0) revert HasClaims();

    if (t.status == TaskStatus.Created) {
      t.status = TaskStatus.Cancelled;
      emit TaskRefunded(taskId, msg.sender, 0, "never_funded");
      return;
    }

    uint256 amount = t.balance;
    t.balance = 0;
    t.status = TaskStatus.Cancelled;
    usdc.safeTransfer(msg.sender, amount);

    emit TaskRefunded(taskId, msg.sender, amount, "never_claimed_deadline");
  }

  /// @notice After deadline, requester can close the task and refund any *unreserved* remainder.
  /// Reserved = (approved-but-not-withdrawn) * (payout + withdrawFee).
  /// This lets you pay winners one-by-one, then reclaim unused slots.
  /// Deposit fee is non-refundable by design.
  function closeAndRefundRemainder(uint256 taskId) external whenNotPaused {
    Task storage t = tasks[taskId];
    if (t.requester != msg.sender) revert NotRequester();
    if (t.status != TaskStatus.Funded && t.status != TaskStatus.Completed) revert InvalidStatus();
    if (block.timestamp <= t.deadline) revert DeadlineNotPassed();
    if (t.pendingSubmissions > 0) revert HasPendingSubmissions();

    uint256 reservedCount = uint256(t.approvedCount) - uint256(t.withdrawnCount);
    uint256 reserved = reservedCount * perWinnerEscrowed(taskId);

    // Refund everything not needed to honor already-approved claims.
    uint256 refundable = 0;
    if (t.balance > reserved) refundable = t.balance - reserved;

    t.balance -= refundable;
    t.status = TaskStatus.Closed;

    if (refundable > 0) {
      usdc.safeTransfer(msg.sender, refundable);
    }

    emit TaskClosed(taskId, msg.sender, refundable);
  }
}
