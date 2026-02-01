/**
 * Escrow Service - HBAR bounty escrow management
 * v0.8.0
 * 
 * Flow:
 * 1. Poster deposits HBAR → escrow (deposit)
 * 2. Agent claims task (claim) 
 * 3. Agent submits work (submit)
 * 4. Poster releases funds OR auto-release after timeout (release)
 * 5. Disputes handled by arbitrator (dispute/resolve)
 */

// Escrow states
const EscrowState = {
  NONE: "NONE",
  POSTED: "POSTED",       // Bounty posted, awaiting deposit
  DEPOSITED: "DEPOSITED", // HBAR deposited to escrow
  CLAIMED: "CLAIMED",     // Task claimed by agent
  SUBMITTED: "SUBMITTED", // Work submitted, awaiting approval
  DISPUTED: "DISPUTED",   // In dispute resolution
  RELEASED: "RELEASED",   // Funds released to agent
  REFUNDED: "REFUNDED"    // Funds refunded to poster
};

// In-memory escrow records (will need persistence)
const escrows = new Map();

/**
 * Create escrow record for a task
 */
function create(taskId, posterId, amountHbar, deadline = null) {
  if (escrows.has(taskId)) {
    throw new Error("Escrow already exists for this task");
  }

  const escrow = {
    taskId,
    posterId,
    amountHbar,
    agentId: null,
    state: EscrowState.POSTED,
    depositTx: null,
    releaseTx: null,
    deadline: deadline || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days default
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    proofHash: null,
    disputeReason: null,
    resolution: null
  };

  escrows.set(taskId, escrow);
  console.log(`💰 Escrow created: ${taskId} - ${amountHbar} HBAR`);
  return escrow;
}

/**
 * Record deposit transaction
 */
function recordDeposit(taskId, transactionId) {
  const escrow = escrows.get(taskId);
  if (!escrow) throw new Error("Escrow not found");
  if (escrow.state !== EscrowState.POSTED) throw new Error("Invalid state for deposit");

  escrow.depositTx = transactionId;
  escrow.state = EscrowState.DEPOSITED;
  escrow.updatedAt = new Date().toISOString();

  console.log(`💵 Escrow deposit recorded: ${taskId} tx:${transactionId}`);
  return escrow;
}

/**
 * Agent claims the escrowed task
 */
function claim(taskId, agentId, agentWallet) {
  const escrow = escrows.get(taskId);
  if (!escrow) throw new Error("Escrow not found");
  if (escrow.state !== EscrowState.DEPOSITED) throw new Error("Task not available for claim");

  escrow.agentId = agentId;
  escrow.agentWallet = agentWallet;
  escrow.state = EscrowState.CLAIMED;
  escrow.claimedAt = new Date().toISOString();
  escrow.updatedAt = new Date().toISOString();

  console.log(`🎯 Escrow claimed: ${taskId} by ${agentId}`);
  return escrow;
}

/**
 * Agent submits work proof
 */
function submit(taskId, agentId, proofHash) {
  const escrow = escrows.get(taskId);
  if (!escrow) throw new Error("Escrow not found");
  if (escrow.agentId !== agentId) throw new Error("Not the assigned agent");
  if (escrow.state !== EscrowState.CLAIMED) throw new Error("Invalid state for submission");

  escrow.proofHash = proofHash;
  escrow.state = EscrowState.SUBMITTED;
  escrow.submittedAt = new Date().toISOString();
  escrow.updatedAt = new Date().toISOString();

  console.log(`📤 Work submitted: ${taskId} proof:${proofHash.slice(0,16)}...`);
  return escrow;
}

/**
 * Release funds to agent
 */
function release(taskId, posterId, transactionId = null) {
  const escrow = escrows.get(taskId);
  if (!escrow) throw new Error("Escrow not found");
  if (escrow.posterId !== posterId && posterId !== "system") throw new Error("Not authorized");
  if (escrow.state !== EscrowState.SUBMITTED && escrow.state !== EscrowState.CLAIMED) {
    throw new Error("Invalid state for release");
  }

  escrow.releaseTx = transactionId;
  escrow.state = EscrowState.RELEASED;
  escrow.releasedAt = new Date().toISOString();
  escrow.updatedAt = new Date().toISOString();

  console.log(`✅ Escrow released: ${taskId} to ${escrow.agentId} tx:${transactionId}`);
  return escrow;
}

/**
 * Refund to poster (dispute resolution or cancellation)
 */
function refund(taskId, reason, transactionId = null) {
  const escrow = escrows.get(taskId);
  if (!escrow) throw new Error("Escrow not found");

  escrow.releaseTx = transactionId;
  escrow.state = EscrowState.REFUNDED;
  escrow.resolution = reason;
  escrow.refundedAt = new Date().toISOString();
  escrow.updatedAt = new Date().toISOString();

  console.log(`↩️ Escrow refunded: ${taskId} reason:${reason}`);
  return escrow;
}

/**
 * Open dispute
 */
function dispute(taskId, disputerId, reason) {
  const escrow = escrows.get(taskId);
  if (!escrow) throw new Error("Escrow not found");
  if (escrow.state !== EscrowState.SUBMITTED) throw new Error("Can only dispute submitted work");

  escrow.state = EscrowState.DISPUTED;
  escrow.disputeReason = reason;
  escrow.disputedBy = disputerId;
  escrow.disputedAt = new Date().toISOString();
  escrow.updatedAt = new Date().toISOString();

  console.log(`⚠️ Dispute opened: ${taskId} by ${disputerId}`);
  return escrow;
}

/**
 * Get escrow by task ID
 */
function get(taskId) {
  return escrows.get(taskId);
}

/**
 * List all escrows (with optional filters)
 */
function list(filters = {}) {
  const results = [];
  escrows.forEach((escrow, taskId) => {
    if (filters.state && escrow.state !== filters.state) return;
    if (filters.posterId && escrow.posterId !== filters.posterId) return;
    if (filters.agentId && escrow.agentId !== filters.agentId) return;
    results.push(escrow);
  });
  return results;
}

/**
 * Check for auto-release (past deadline)
 */
function checkAutoRelease() {
  const now = new Date();
  const autoReleased = [];
  
  escrows.forEach((escrow, taskId) => {
    if (escrow.state === EscrowState.SUBMITTED) {
      const deadline = new Date(escrow.deadline);
      if (now > deadline) {
        release(taskId, "system", null);
        autoReleased.push(taskId);
      }
    }
  });
  
  return autoReleased;
}

module.exports = {
  EscrowState,
  create,
  recordDeposit,
  claim,
  submit,
  release,
  refund,
  dispute,
  get,
  list,
  checkAutoRelease
};
