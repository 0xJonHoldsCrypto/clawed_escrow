import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre;

const toUSDC = (n: number) => BigInt(n) * 10n ** 6n;

describe("ClawedEscrow", function () {
  async function deploy() {
    const [owner, requester, agent, treasury, arbiter, other] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();

    const Escrow = await ethers.getContractFactory("ClawedEscrow");
    const escrow = await Escrow.connect(owner).deploy(usdc.getAddress(), treasury.address, arbiter.address);

    return { owner, requester, agent, treasury, arbiter, other, usdc, escrow };
  }

  it("charges 2% creator fee at funding and 2% recipient fee at withdrawal", async () => {
    const { requester, agent, treasury, usdc, escrow } = await deploy();

    const payout = toUSDC(100); // 100 USDC
    const maxWinners = 2;

    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const deadline = now + 7 * 24 * 3600;
    const reviewWindow = 3600;
    const escalationWindow = 3600;

    const txCreate = await escrow
      .connect(requester)
      .createTask(payout, maxWinners, deadline, reviewWindow, escalationWindow, ethers.ZeroHash);
    const receipt = await txCreate.wait();
    const taskId = receipt!.logs
      .map((l) => {
        try {
          return escrow.interface.parseLog(l as any);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.name === "TaskCreated")!.args.taskId as bigint;

    // Mint USDC to requester and fund
    const escrowAmount = payout * BigInt(maxWinners);
    const depositFeePerWinner = (payout * 200n) / 10_000n;
    const depositFeeTotal = depositFeePerWinner * BigInt(maxWinners);
    await usdc.mint(requester.address, escrowAmount + depositFeeTotal);
    await usdc.connect(requester).approve(await escrow.getAddress(), escrowAmount + depositFeeTotal);

    const treasuryBefore = await usdc.balanceOf(treasury.address);
    await escrow.connect(requester).fundTask(taskId);
    const treasuryAfterFund = await usdc.balanceOf(treasury.address);
    expect(treasuryAfterFund - treasuryBefore).to.equal(depositFeeTotal);

    // Agent claim + submit + approve + withdraw
    const txClaim = await escrow.connect(agent).claim(taskId);
    const claimRcpt = await txClaim.wait();
    const submissionId = claimRcpt!.logs
      .map((l) => {
        try {
          return escrow.interface.parseLog(l as any);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.name === "Claimed")!.args.submissionId as bigint;

    await escrow.connect(agent).submitProof(taskId, submissionId, ethers.keccak256("0x1234"));
    await escrow.connect(requester).approve(taskId, submissionId);

    const agentBefore = await usdc.balanceOf(agent.address);
    const treasuryBeforeWithdraw = await usdc.balanceOf(treasury.address);

    await escrow.connect(agent).withdraw(taskId, submissionId);

    const agentAfter = await usdc.balanceOf(agent.address);
    const treasuryAfterWithdraw = await usdc.balanceOf(treasury.address);

    const recipientFee = (payout * 200n) / 10_000n;
    expect(agentAfter - agentBefore).to.equal(payout - recipientFee);
    expect(treasuryAfterWithdraw - treasuryBeforeWithdraw).to.equal(recipientFee);
  });

  it("prevents close/refund remainder while there are pending submissions; allows arbiter escalation after review window", async () => {
    const { requester, agent, treasury, arbiter, usdc, escrow } = await deploy();

    const payout = toUSDC(10);
    const maxWinners = 1;

    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const deadline = now + 100;
    const reviewWindow = 50;
    const escalationWindow = 2000;

    const rcpt = await (
      await escrow.connect(requester).createTask(payout, maxWinners, deadline, reviewWindow, escalationWindow, ethers.ZeroHash)
    ).wait();

    const taskId = rcpt!.logs
      .map((l) => {
        try {
          return escrow.interface.parseLog(l as any);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.name === "TaskCreated")!.args.taskId as bigint;

    const escrowAmount = payout * BigInt(maxWinners);
    const depositFeeTotal = (payout * 200n) / 10_000n;
    await usdc.mint(requester.address, escrowAmount + depositFeeTotal);
    await usdc.connect(requester).approve(await escrow.getAddress(), escrowAmount + depositFeeTotal);
    await escrow.connect(requester).fundTask(taskId);

    const claimRcpt = await (await escrow.connect(agent).claim(taskId)).wait();
    const submissionId = claimRcpt!.logs
      .map((l) => {
        try {
          return escrow.interface.parseLog(l as any);
        } catch {
          return null;
        }
      })
      .find((p) => p && p.name === "Claimed")!.args.submissionId as bigint;

    await escrow.connect(agent).submitProof(taskId, submissionId, ethers.keccak256("0xabcd"));

    // move past deadline but while pending submission exists
    await ethers.provider.send("evm_increaseTime", [200]);
    await ethers.provider.send("evm_mine", []);

    await expect(escrow.connect(requester).closeAndRefundRemainder(taskId)).to.be.revertedWithCustomError(
      escrow,
      "HasPendingSubmissions"
    );

    // Move past review window so the agent can escalate to the arbiter
    await ethers.provider.send("evm_increaseTime", [60]);
    await ethers.provider.send("evm_mine", []);

    await escrow.connect(agent).openDispute(taskId, submissionId);
    await escrow.connect(arbiter).resolveDispute(taskId, submissionId, true);

    // Now can close, should refund nothing since winner approved and balance equals payout
    await escrow.connect(requester).closeAndRefundRemainder(taskId);

    // Withdraw still works after task is Closed
    const agentBefore = await usdc.balanceOf(agent.address);
    await escrow.connect(agent).withdraw(taskId, submissionId);
    const agentAfter = await usdc.balanceOf(agent.address);

    expect(agentAfter - agentBefore).to.equal(payout - (payout * 200n) / 10_000n);
  });

  it("owner can pause/unpause; pause blocks non-withdraw flows; rescueERC20 works for non-usdc", async () => {
    const { owner, requester, treasury, arbiter, other, usdc, escrow } = await deploy();

    await escrow.connect(owner).pause();

    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    await expect(
      escrow.connect(requester).createTask(toUSDC(1), 1, now + 1000, 10, 10, ethers.ZeroHash)
    ).to.be.revertedWithCustomError(escrow, "EnforcedPause");

    await escrow.connect(owner).unpause();

    // Rescue other token
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const otherToken = await MockERC20.deploy("Other", "OT");
    await otherToken.mint(await escrow.getAddress(), 123n);

    await escrow.connect(owner).rescueERC20(await otherToken.getAddress(), other.address, 123n);
    expect(await otherToken.balanceOf(other.address)).to.equal(123n);

    // cannot rescue USDC
    await expect(
      escrow.connect(owner).rescueERC20(await usdc.getAddress(), other.address, 1n)
    ).to.be.revertedWith("no usdc rescue");
  });
});
