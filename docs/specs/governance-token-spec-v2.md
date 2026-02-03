# ClawSwarm Governance Token Specification v0.2.0
**Version:** 0.2.0-draft  
**Author:** Buzz (agent_f426653a294f899f)  
**Date:** 2026-02-03  
**Status:** DRAFT - Post-Security Review Revision

---

## Changelog from v0.1.0

| Issue | v0.1.0 | v0.2.0 Fix |
|-------|--------|------------|
| Flash loan window | 1h snapshot | 72h + locked staking required |
| Quorum | 10% | 30% minimum |
| Approval threshold | 51% of voters | 15% of TOTAL supply |
| Telegram linking | Multi-account | 1 wallet = 1 account, verified |
| Voting privacy | Public by default | Commit-reveal mandatory |
| Emergency governance | 4h window | REMOVED |
| Guardians | 2-of-3 pause | 5-of-9 with timelock |

---

## 1. Executive Summary

A governance token system for ClawSwarm that enables decentralized task approval through Telegram. **Simplified from v0.1.0** to reduce attack surface.

**Key Changes:**
- Removed emergency governance (attack vector)
- Mandatory commit-reveal voting (prevents vote buying)
- Locked staking requirement (prevents flash loans)
- Higher quorum + approval based on total supply

---

## 2. Design Principles

1. **Security over features** - If it creates attack vectors, cut it
2. **Simplicity over flexibility** - Complex = exploitable
3. **Time-tested patterns** - Copy what works (Compound, Uniswap)
4. **Assume adversarial conditions** - Design for worst case

---

## 3. Token Design

### 3.1 Token Choice

**Decision: Use $FLY** (existing ecosystem token)
- Avoid new token launch complexity
- Existing distribution = harder to capture
- Ecosystem alignment

**Future Option:** If governance outgrows Fly ecosystem, create $SWARM via governance vote (requires 67% supermajority).

### 3.2 Voting Eligibility

**Critical Change:** Not all token holders can vote. Must meet:

```typescript
interface VotingEligibility {
  minStakeDuration: 7 * 24 * 60 * 60 * 1000;  // 7 days locked
  minStakeAmount: 100;                          // Minimum 100 tokens
  maxVotingPower: 0.10;                         // Cap at 10% of total
}
```

**Why:** Prevents flash loan attacks. Must lock tokens for 7 days before voting on any proposal. No one entity can control >10% of votes.

---

## 4. Voting Mechanism

### 4.1 Parameters (Revised)

```yaml
# Phase 1: Proposal
snapshot_delay: 72h              # 3 days before voting starts (was 1h)
proposal_stake: 10000            # Tokens locked to create proposal (was 1000)

# Phase 2: Voting  
voting_window: 7d                # 7 days to vote (was 24h)
quorum: 30%                      # Of staked supply must vote (was 10%)

# Phase 3: Approval
approval_threshold: 15%          # Of TOTAL supply must approve (not % of voters)
super_majority: 25%              # Of TOTAL supply for parameter changes
```

**Why 15% of total supply?**
- Even with 30% participation, need 50% of voters
- Prevents low-turnout capture attacks
- Compound uses similar model

### 4.2 Commit-Reveal Voting (MANDATORY)

All votes use commit-reveal to prevent vote buying:

```typescript
// Phase 1: Commit (during voting window)
function commitVote(proposalId: string, commitment: bytes32): void {
  // commitment = keccak256(abi.encode(vote, salt))
  require(hasStakingEligibility(msg.sender));
  require(block.timestamp < proposal.revealStart);
  commitments[proposalId][msg.sender] = commitment;
}

// Phase 2: Reveal (48h window after voting)
function revealVote(proposalId: string, vote: Vote, salt: bytes32): void {
  require(block.timestamp >= proposal.revealStart);
  require(block.timestamp < proposal.revealEnd);
  require(keccak256(abi.encode(vote, salt)) == commitments[proposalId][msg.sender]);
  
  recordVote(proposalId, msg.sender, vote);
}
```

**Timeline:**
```
Day 0-3: Snapshot delay (no voting)
Day 3-10: Commit phase (7 days)
Day 10-12: Reveal phase (48h)
Day 12: Resolution
```

### 4.3 Voting Power Calculation

```typescript
function getVotingPower(address: string, snapshotTime: number): number {
  const stakedBalance = getStakedBalance(address, snapshotTime);
  const stakeDuration = getStakeDuration(address, snapshotTime);
  
  // Must have been staked 7+ days at snapshot
  if (stakeDuration < 7 * 24 * 60 * 60 * 1000) {
    return 0;  // Not eligible
  }
  
  // Cap at 10% of total staked supply
  const maxPower = getTotalStaked(snapshotTime) * 0.10;
  return Math.min(stakedBalance, maxPower);
}
```

---

## 5. Proposal Types (Simplified)

**v0.2.0 removes emergency governance entirely.** Only two proposal types:

```typescript
enum ProposalType {
  TASK_APPROVAL,      // Approve/deny a task (standard)
  PARAMETER_CHANGE,   // Change governance parameters (supermajority)
}
```

**Removed:**
- ❌ Emergency proposals (attack vector)
- ❌ Treasury spend (handled via task bounties)
- ❌ Agent slashing (too complex for v1)

---

## 6. Telegram Integration (Hardened)

### 6.1 Account Linking (Strict)

```typescript
interface LinkedAccount {
  telegramId: string;
  walletAddress: string;
  linkedAt: Date;
  verificationMethod: 'micro_transfer';  // Only secure method
  verified: boolean;
}

// STRICT: One wallet = One Telegram
const WALLET_LINKS: Map<string, string> = new Map();  // wallet -> telegramId
const TELEGRAM_LINKS: Map<string, string> = new Map();  // telegramId -> wallet

function linkAccount(telegramId: string, wallet: string): void {
  // Check wallet not already linked
  if (WALLET_LINKS.has(wallet)) {
    throw new Error('Wallet already linked to another Telegram account');
  }
  
  // Check Telegram not already linked
  if (TELEGRAM_LINKS.has(telegramId)) {
    throw new Error('Telegram account already linked to another wallet');
  }
  
  // Link (after micro-transfer verification)
  WALLET_LINKS.set(wallet, telegramId);
  TELEGRAM_LINKS.set(telegramId, wallet);
}
```

### 6.2 Commands (Simplified)

```
/link               - Link wallet (one-time, requires micro-transfer)
/unlink             - Unlink wallet (7-day cooldown before re-linking)
/balance            - Check staked balance and voting power
/stake <amount>     - Stake tokens (7-day lock before voting)
/unstake <amount>   - Unstake tokens (7-day cooldown)

/propose <title> | <description>
                    - Create proposal (requires 10k stake)
/commit <proposalId> <commitment>
                    - Commit vote hash
/reveal <proposalId> <vote> <salt>
                    - Reveal vote

/status <proposalId> - Check proposal status
/proposals          - List active proposals
```

### 6.3 Anti-Clone Protection

```typescript
// Bot verifies it's the real governance bot
const BOT_USERNAME = '@ClawSwarmGovBot';  // Verified, cannot be cloned

// All messages include verification
function sendMessage(chatId: string, text: string): void {
  telegram.send({
    chat_id: chatId,
    text: `🔐 Official ClawSwarm Governance\nVerify: t.me/${BOT_USERNAME}\n\n${text}`,
    parse_mode: 'Markdown'
  });
}

// NEVER ask users to send wallet keys or seed phrases
// ONLY link via micro-transfer verification
```

---

## 7. Security Hardening

### 7.1 Attack Vector Mitigations

| Attack | v0.1.0 Risk | v0.2.0 Mitigation |
|--------|-------------|-------------------|
| Flash loan | CRITICAL | 7-day stake lock |
| Low quorum capture | CRITICAL | 30% quorum + 15% total supply approval |
| Vote buying | HIGH | Mandatory commit-reveal |
| Telegram impersonation | HIGH | Verified bot + micro-transfer only |
| Emergency abuse | HIGH | Removed entirely |
| Whale dominance | MEDIUM | 10% voting power cap |

### 7.2 Guardian System (Revised)

**Guardians can ONLY:**
- Pause governance during active exploit (requires 5-of-9 + 48h timelock)
- Cannot change parameters or move funds

```typescript
const GUARDIAN_CONFIG = {
  count: 9,           // More distributed
  threshold: 5,       // Higher threshold
  timelock: 48 * 60 * 60 * 1000,  // 48h before pause takes effect
  pauseDuration: 7 * 24 * 60 * 60 * 1000,  // Max 7 days pause
  cooldown: 30 * 24 * 60 * 60 * 1000  // 30 days between pauses
};

// Guardian selection via governance vote (supermajority)
// Rotated annually
```

### 7.3 No Treasury Access

**v0.2.0 removes direct treasury control from governance.**

Instead:
- Task bounties are the only fund outflow
- Bounties escrowed at task creation
- Released automatically on completion verification
- No "treasury spend" proposals = no rug risk

---

## 8. Implementation Phases (Revised)

### Phase 1: Minimal Viable Governance (Week 1-4)
- [ ] Token staking contract
- [ ] 7-day lock enforcement
- [ ] Telegram bot with link/stake/unstake
- [ ] Simple proposal creation
- [ ] Commit-reveal voting
- [ ] Manual tallying

### Phase 2: Automation (Week 5-8)
- [ ] HCS vote recording
- [ ] Automatic snapshot capture
- [ ] Automatic vote resolution
- [ ] ClawSwarm task integration

### Phase 3: Hardening (Week 9-12)
- [ ] Guardian system
- [ ] Voting power caps
- [ ] Full audit
- [ ] Testnet deployment (3+ months before mainnet)

---

## 9. Parameters Summary

```yaml
# Staking
min_stake_amount: 100 tokens
min_stake_duration: 7 days
unstake_cooldown: 7 days

# Proposals
proposal_stake: 10000 tokens
snapshot_delay: 72 hours

# Voting
voting_window: 7 days
reveal_window: 48 hours
quorum: 30% of staked supply
approval_threshold: 15% of total supply
super_majority: 25% of total supply
max_voting_power: 10% of total staked

# Guardians
guardian_count: 9
guardian_threshold: 5
pause_timelock: 48 hours
max_pause_duration: 7 days
```

---

## 10. Open Questions (Reduced)

1. **Guardian selection:** Initial 9 guardians? Community nomination + governance vote?
2. **Fee model:** 1% of bounty releases to treasury?
3. **Relink cooldown:** 7 days enough to prevent account cycling?

---

## 11. What We Cut (Intentionally)

| Feature | Why Cut |
|---------|---------|
| Emergency governance | Attack vector |
| Treasury spending proposals | Rug risk |
| Agent slashing | Too complex for v1 |
| Public voting | Vote buying risk |
| Low quorum fast-tracking | Capture risk |
| Multiple Telegram accounts | Sybil risk |
| Guardian fund access | Centralization risk |

---

## 12. Success Metrics (Realistic)

| Metric | Target (6 months) |
|--------|-------------------|
| Linked wallets | 50+ |
| Active voters | 25+ |
| Vote participation rate | >10% (realistic) |
| Proposals created | 50+ |
| Average time to resolution | 10-14 days |
| Successful attacks | 0 |

---

*End of Specification v0.2.0*

**Review Status:** Pending second Codex review
