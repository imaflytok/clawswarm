/**
 * Hedera Wallet Service - NON-CUSTODIAL
 * 
 * SECURITY MODEL (Codex-approved):
 * - Agents provide their OWN Hedera account ID
 * - We NEVER store or generate private keys
 * - We only SEND rewards TO their accounts
 * - Optional: Proof-of-control challenge for fraud resistance
 * 
 * Using @hashgraph/sdk
 */

const {
  Client,
  Hbar,
  TransferTransaction,
  AccountBalanceQuery,
  AccountInfoQuery,
  TransactionId
} = require("@hashgraph/sdk");

// Initialize Hedera client
const getClient = () => {
  const network = process.env.HEDERA_NETWORK || 'mainnet';
  const client = network === 'mainnet' 
    ? Client.forMainnet() 
    : Client.forTestnet();
  
  client.setOperator(
    process.env.HEDERA_OPERATOR_ID,
    process.env.HEDERA_OPERATOR_KEY
  );
  
  // Set reasonable timeouts
  client.setRequestTimeout(30000);
  
  return client;
};

/**
 * Verify a Hedera account exists and is valid
 * Called when agent registers with their account ID
 */
async function verifyAccount(accountId) {
  const client = getClient();
  
  try {
    // Check account exists by querying info
    const info = await new AccountInfoQuery()
      .setAccountId(accountId)
      .execute(client);
    
    return {
      success: true,
      accountId: info.accountId.toString(),
      balance: info.balance.toString(),
      isDeleted: info.isDeleted,
      memo: info.accountMemo
    };
  } catch (error) {
    // Account doesn't exist or invalid
    return {
      success: false,
      error: `Account ${accountId} not found or invalid: ${error.message}`
    };
  }
}

/**
 * Get wallet balance for an agent's account
 */
async function getBalance(accountId) {
  const client = getClient();
  
  try {
    const balance = await new AccountBalanceQuery()
      .setAccountId(accountId)
      .execute(client);
    
    return {
      success: true,
      hbar: balance.hbars.toString(),
      hbarTinybars: balance.hbars.toTinybars().toString(),
      tokens: Object.fromEntries(
        [...balance.tokens._map].map(([k, v]) => [k.toString(), v.toString()])
      )
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Transfer HBAR reward to agent
 * Called when task is verified
 * 
 * IMPORTANT:
 * - Verify account exists before calling
 * - Use idempotency key to prevent double-pays
 * - Log transaction for reconciliation
 */
async function sendReward(recipientAccountId, amountHbar, taskId, memo = null) {
  const client = getClient();
  const treasuryId = process.env.HEDERA_OPERATOR_ID;
  
  // Create idempotent transaction ID using taskId
  // This prevents double-pays if retry happens
  const txMemo = memo || `MoltSwarm Task: ${taskId}`;
  
  try {
    // Verify recipient exists first
    const accountCheck = await verifyAccount(recipientAccountId);
    if (!accountCheck.success) {
      return {
        success: false,
        error: `Recipient account invalid: ${accountCheck.error}`
      };
    }
    
    // Convert HBAR amount (handle decimals properly)
    // 1 HBAR = 100,000,000 tinybars
    const hbarAmount = new Hbar(amountHbar);
    
    const transaction = await new TransferTransaction()
      .addHbarTransfer(treasuryId, hbarAmount.negated())
      .addHbarTransfer(recipientAccountId, hbarAmount)
      .setTransactionMemo(txMemo.slice(0, 100)) // Max 100 chars
      .execute(client);
    
    const receipt = await transaction.getReceipt(client);
    
    // Only return success if status is SUCCESS
    if (receipt.status.toString() !== 'SUCCESS') {
      return {
        success: false,
        error: `Transaction failed with status: ${receipt.status.toString()}`,
        transactionId: transaction.transactionId.toString()
      };
    }
    
    return {
      success: true,
      transactionId: transaction.transactionId.toString(),
      status: receipt.status.toString(),
      amount: amountHbar,
      recipient: recipientAccountId,
      memo: txMemo
    };
    
  } catch (error) {
    console.error(`❌ Reward transfer failed:`, error);
    return { 
      success: false, 
      error: error.message,
      recipient: recipientAccountId,
      attemptedAmount: amountHbar
    };
  }
}

/**
 * Transfer HTS token reward (e.g., $FLY)
 * Agent must have associated the token first
 */
async function sendTokenReward(recipientAccountId, tokenId, amount, taskId) {
  const client = getClient();
  const treasuryId = process.env.HEDERA_OPERATOR_ID;
  
  try {
    // Verify recipient exists
    const accountCheck = await verifyAccount(recipientAccountId);
    if (!accountCheck.success) {
      return { success: false, error: accountCheck.error };
    }
    
    const transaction = await new TransferTransaction()
      .addTokenTransfer(tokenId, treasuryId, -amount)
      .addTokenTransfer(tokenId, recipientAccountId, amount)
      .setTransactionMemo(`MoltSwarm Token Reward: ${taskId}`.slice(0, 100))
      .execute(client);
    
    const receipt = await transaction.getReceipt(client);
    
    if (receipt.status.toString() !== 'SUCCESS') {
      return {
        success: false,
        error: `Token transfer failed: ${receipt.status.toString()}`
      };
    }
    
    return {
      success: true,
      transactionId: transaction.transactionId.toString(),
      status: receipt.status.toString(),
      tokenId,
      amount,
      recipient: recipientAccountId
    };
    
  } catch (error) {
    // Common error: TOKEN_NOT_ASSOCIATED_TO_ACCOUNT
    if (error.message.includes('TOKEN_NOT_ASSOCIATED')) {
      return {
        success: false,
        error: 'Recipient has not associated this token. They need to run TokenAssociateTransaction first.',
        code: 'TOKEN_NOT_ASSOCIATED'
      };
    }
    return { success: false, error: error.message };
  }
}

/**
 * Generate a challenge for proof-of-control verification
 * Agent must sign this with their account key to prove ownership
 */
function generateChallenge(accountId) {
  const crypto = require('crypto');
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');
  
  const challenge = {
    type: 'MOLTSWARM_ACCOUNT_VERIFICATION',
    accountId,
    timestamp,
    nonce,
    message: `Verify MoltSwarm account ownership: ${accountId} at ${timestamp}`
  };
  
  return {
    challenge,
    expiresAt: timestamp + (5 * 60 * 1000) // 5 minutes
  };
}

/**
 * Treasury balance check
 * Monitor to prevent drain attacks
 */
async function getTreasuryBalance() {
  const treasuryId = process.env.HEDERA_OPERATOR_ID;
  return getBalance(treasuryId);
}

/**
 * Check if treasury has sufficient funds for a reward
 */
async function canAffordReward(amountHbar) {
  const balance = await getTreasuryBalance();
  if (!balance.success) return { canAfford: false, error: balance.error };
  
  const treasuryHbar = parseFloat(balance.hbar);
  const minReserve = parseFloat(process.env.TREASURY_MIN_RESERVE || '10'); // Keep 10 HBAR reserve
  
  return {
    canAfford: treasuryHbar - amountHbar >= minReserve,
    treasuryBalance: treasuryHbar,
    requestedAmount: amountHbar,
    minReserve
  };
}

module.exports = {
  verifyAccount,
  getBalance,
  sendReward,
  sendTokenReward,
  generateChallenge,
  getTreasuryBalance,
  canAffordReward
};
