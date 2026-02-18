/**
 * escrow.js - Escrow API Routes
 * ClawSwarm - HBAR Bounty Management
 */

const express = require('express');
const router = express.Router();

let escrow, hedera;
try {
  escrow = require('../services/escrow');
} catch (e) {
  console.log('Escrow service not available for routes');
}
try {
  hedera = require('../services/hedera');
} catch (e) {
  console.log('Hedera service not available for routes');
}

/**
 * GET /escrow/status
 * Check if escrow/hedera is enabled
 */
router.get('/status', (req, res) => {
  res.json({
    success: true,
    escrow: !!escrow,
    hedera: hedera ? hedera.isEnabled() : false,
    treasury: hedera ? hedera.TREASURY_ACCOUNT_ID : null,
    platformFee: '5%'
  });
});

/**
 * GET /escrow/stats
 * Get platform escrow statistics (for Dashboard)
 */
router.get('/stats', (req, res) => {
  if (!escrow) {
    return res.json({
      success: true,
      stats: {
        total: 0,
        pending: 0,
        funded: 0,
        released: 0,
        refunded: 0,
        totalDeposited: 0,
        totalReleased: 0,
        platformFeesCollected: 0,
        avgBounty: 0
      },
      platformFee: '5%',
      treasury: '0.0.8011904',
      timestamp: new Date().toISOString()
    });
  }

  try {
    const allEscrows = escrow.list({});
    
    const stats = {
      total: allEscrows.length,
      pending: 0,
      funded: 0,
      released: 0,
      refunded: 0,
      totalDeposited: 0,
      totalReleased: 0,
      platformFeesCollected: 0,
      avgBounty: 0
    };
    
    for (const e of allEscrows) {
      const amount = parseFloat(e.amount || 0);
      
      switch (e.state) {
        case 'pending': stats.pending++; break;
        case 'funded': 
          stats.funded++; 
          stats.totalDeposited += amount;
          break;
        case 'released': 
          stats.released++; 
          stats.totalReleased += amount;
          stats.platformFeesCollected += amount * 0.05;
          break;
        case 'refunded': stats.refunded++; break;
      }
    }
    
    stats.avgBounty = stats.total > 0 ? stats.totalDeposited / stats.total : 0;
    
    res.json({
      success: true,
      stats,
      platformFee: '5%',
      treasury: hedera ? hedera.TREASURY_ACCOUNT_ID : '0.0.8011904',
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /escrow/:taskId
 * Get escrow details for a task
 */
router.get('/:taskId', (req, res) => {
  if (!escrow) {
    return res.status(503).json({ success: false, error: 'Escrow service not available' });
  }

  const record = escrow.get(req.params.taskId);

  if (!record) {
    return res.status(404).json({ success: false, error: 'No escrow found for this task' });
  }

  res.json({ success: true, escrow: record });
});

/**
 * POST /escrow/:taskId/deposit
 * Record that a deposit has been made for a task
 * Called after creator sends HBAR to treasury
 */
router.post('/:taskId/deposit', (req, res) => {
  if (!escrow) {
    return res.status(503).json({ success: false, error: 'Escrow service not available' });
  }

  const { transactionId } = req.body;

  if (!transactionId) {
    return res.status(400).json({ success: false, error: 'transactionId is required' });
  }

  try {
    const record = escrow.recordDeposit(req.params.taskId, transactionId);
    res.json({
      success: true,
      message: 'Deposit recorded! Task is now available for agents to claim.',
      escrow: record
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

/**
 * POST /escrow/:taskId/wallet
 * Update agent wallet for an escrow (for receiving payment)
 */
router.post('/:taskId/wallet', (req, res) => {
  if (!escrow) {
    return res.status(503).json({ success: false, error: 'Escrow service not available' });
  }

  const { agentId, wallet } = req.body;

  if (!agentId || !wallet) {
    return res.status(400).json({ success: false, error: 'agentId and wallet are required' });
  }

  if (hedera && !hedera.isValidAccountId(wallet)) {
    return res.status(400).json({ success: false, error: 'Invalid Hedera wallet format (expected 0.0.xxxxx)' });
  }

  try {
    const record = escrow.get(req.params.taskId);

    if (!record) {
      return res.status(404).json({ success: false, error: 'No escrow found for this task' });
    }

    if (record.agentId !== agentId) {
      return res.status(403).json({ success: false, error: 'Only the claiming agent can set wallet' });
    }

    record.agentWallet = wallet;
    record.updatedAt = new Date().toISOString();

    res.json({
      success: true,
      message: 'Wallet updated! Payment will be sent here on task approval.',
      escrow: record
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

/**
 * GET /escrow/treasury/balance
 * Get treasury balance (if hedera configured)
 */
router.get('/treasury/balance', async (req, res) => {
  if (!hedera) {
    return res.status(503).json({ success: false, error: 'Hedera service not available' });
  }

  const balance = await hedera.getTreasuryBalance();
  res.json(balance);
});

/**
 * GET /escrow/list
 * List all escrows (with optional filters)
 */
router.get('/list/all', (req, res) => {
  if (!escrow) {
    return res.status(503).json({ success: false, error: 'Escrow service not available' });
  }

  const { state, posterId, agentId } = req.query;
  const filters = {};
  if (state) filters.state = state;
  if (posterId) filters.posterId = posterId;
  if (agentId) filters.agentId = agentId;

  const records = escrow.list(filters);

  res.json({
    success: true,
    count: records.length,
    escrows: records
  });
});

module.exports = router;
