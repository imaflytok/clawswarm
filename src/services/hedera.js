/**
 * Hedera Integration Service for ClawSwarm
 * Handles HBAR payments for task bounties
 */

const {
  Client,
  AccountId,
  PrivateKey,
  PublicKey,
  TransferTransaction,
  TopicMessageSubmitTransaction,
  Hbar
} = require('@hashgraph/sdk');

// ClawSwarm Treasury Account (set via env vars)
const TREASURY_ACCOUNT_ID = process.env.HEDERA_ACCOUNT_ID || '0.0.8011904';
const TREASURY_PRIVATE_KEY = process.env.HEDERA_PRIVATE_KEY;
const HCS_TOPIC_ID = process.env.CLAWSWARM_HCS_TOPIC || null; // Optional audit log topic

// Initialize Hedera client
let hederaClient = null;

function initClient() {
  if (hederaClient) return hederaClient;
  
  if (!TREASURY_PRIVATE_KEY) {
    console.log('⚠️ Hedera: No private key configured - payments disabled');
    return null;
  }
  
  try {
    hederaClient = Client.forMainnet();
    hederaClient.setOperator(
      AccountId.fromString(TREASURY_ACCOUNT_ID),
      PrivateKey.fromString(TREASURY_PRIVATE_KEY)
    );
    console.log(`✅ Hedera client initialized: ${TREASURY_ACCOUNT_ID}`);
    return hederaClient;
  } catch (err) {
    console.error('❌ Hedera client init failed:', err.message);
    return null;
  }
}

/**
 * Check if Hedera payments are enabled
 */
function isEnabled() {
  return !!TREASURY_PRIVATE_KEY;
}

/**
 * Validate a Hedera account ID format
 */
function isValidAccountId(accountId) {
  if (!accountId) return false;
  const pattern = /^0\.0\.\d+$/;
  return pattern.test(accountId);
}

/**
 * Pay bounty to an agent's Hedera wallet
 * @param {string} toAccountId - Recipient's Hedera account ID
 * @param {number} amountHbar - Amount in HBAR
 * @param {string} memo - Transaction memo (task ID, etc)
 * @returns {object} - Transaction result
 */
async function payBounty(toAccountId, amountHbar, memo = '') {
  const client = initClient();
  
  if (!client) {
    return {
      success: false,
      error: 'Hedera payments not configured',
      simulated: true,
      amount: amountHbar,
      to: toAccountId
    };
  }
  
  if (!isValidAccountId(toAccountId)) {
    return {
      success: false,
      error: `Invalid Hedera account ID: ${toAccountId}`
    };
  }
  
  try {
    // Create transfer transaction
    const transaction = new TransferTransaction()
      .addHbarTransfer(TREASURY_ACCOUNT_ID, new Hbar(-amountHbar))
      .addHbarTransfer(toAccountId, new Hbar(amountHbar))
      .setTransactionMemo(memo.substring(0, 100)) // Max 100 chars
      .freezeWith(client);
    
    // Sign and execute
    const signedTx = await transaction.sign(PrivateKey.fromString(TREASURY_PRIVATE_KEY));
    const txResponse = await signedTx.execute(client);
    const receipt = await txResponse.getReceipt(client);
    
    const result = {
      success: true,
      transactionId: txResponse.transactionId.toString(),
      status: receipt.status.toString(),
      amount: amountHbar,
      from: TREASURY_ACCOUNT_ID,
      to: toAccountId,
      memo,
      timestamp: new Date().toISOString()
    };
    
    // Log to HCS if configured
    if (HCS_TOPIC_ID) {
      await logToHCS(result);
    }
    
    console.log(`💰 Bounty paid: ${amountHbar} HBAR to ${toAccountId} (${memo})`);
    return result;
    
  } catch (err) {
    console.error('❌ Bounty payment failed:', err.message);
    return {
      success: false,
      error: err.message,
      amount: amountHbar,
      to: toAccountId
    };
  }
}

/**
 * Log payment to HCS for audit trail
 */
async function logToHCS(paymentResult) {
  if (!HCS_TOPIC_ID) return;
  
  const client = initClient();
  if (!client) return;
  
  try {
    const message = JSON.stringify({
      type: 'BOUNTY_PAYMENT',
      ...paymentResult,
      source: 'ClawSwarm'
    });
    
    await new TopicMessageSubmitTransaction()
      .setTopicId(HCS_TOPIC_ID)
      .setMessage(message)
      .execute(client);
      
    console.log(`📝 Payment logged to HCS: ${HCS_TOPIC_ID}`);
  } catch (err) {
    console.error('⚠️ HCS logging failed:', err.message);
  }
}

/**
 * Get treasury balance
 */
async function getTreasuryBalance() {
  const client = initClient();
  
  if (!client) {
    return { success: false, error: 'Hedera not configured' };
  }
  
  try {
    const balance = await client.getAccountBalance(TREASURY_ACCOUNT_ID);
    return {
      success: true,
      accountId: TREASURY_ACCOUNT_ID,
      balance: balance.hbars.toString(),
      balanceHbar: balance.hbars.toTinybars().toNumber() / 100000000
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Verify a signature to prove wallet ownership
 * @param {string} message - The original message that was signed
 * @param {string} signature - The signature (hex or base64)
 * @param {string} publicKeyStr - The public key (DER encoded, hex or base64)
 * @param {string} accountId - Expected Hedera account ID (for logging)
 * @returns {boolean} - True if signature is valid
 */
async function verifySignature(message, signature, publicKeyStr, accountId) {
  try {
    // Parse the public key
    let publicKey;
    try {
      // Try parsing as DER-encoded hex first
      publicKey = PublicKey.fromString(publicKeyStr);
    } catch (e) {
      // Try other formats
      try {
        publicKey = PublicKey.fromStringED25519(publicKeyStr);
      } catch (e2) {
        try {
          publicKey = PublicKey.fromStringECDSA(publicKeyStr);
        } catch (e3) {
          throw new Error('Unable to parse public key. Provide DER-encoded hex or raw key.');
        }
      }
    }
    
    // Convert message to bytes
    const messageBytes = new TextEncoder().encode(message);
    
    // Convert signature from hex or base64 to Uint8Array
    let signatureBytes;
    if (signature.match(/^[0-9a-fA-F]+$/)) {
      // Hex
      signatureBytes = Uint8Array.from(Buffer.from(signature, 'hex'));
    } else {
      // Assume base64
      signatureBytes = Uint8Array.from(Buffer.from(signature, 'base64'));
    }
    
    // Verify the signature
    const isValid = publicKey.verify(messageBytes, signatureBytes);
    
    console.log(`🔐 Signature verification for ${accountId}: ${isValid ? '✅ VALID' : '❌ INVALID'}`);
    
    return isValid;
  } catch (err) {
    console.error(`❌ Signature verification error for ${accountId}:`, err.message);
    throw err;
  }
}

module.exports = {
  isEnabled,
  isValidAccountId,
  payBounty,
  getTreasuryBalance,
  verifySignature,
  TREASURY_ACCOUNT_ID
};
