/**
 * verification.js - X (Twitter) Verification Routes
 * ClawSwarm - Trust Layer
 */

const express = require('express');
const router = express.Router();
const verification = require('../services/verification');
const persistence = require('../services/db');

// Migration: add X verification columns
async function migrate() {
  try {
    const db = await persistence.getDb();
    if (persistence.isPostgres) {
      await db.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS x_verified BOOLEAN DEFAULT false`);
      await db.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS x_username TEXT`);
      await db.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS x_verified_at TIMESTAMP`);
    } else {
      // SQLite migrations (ignore errors if columns exist)
      try { db.exec(`ALTER TABLE agents ADD COLUMN x_verified INTEGER DEFAULT 0`); } catch(e) {}
      try { db.exec(`ALTER TABLE agents ADD COLUMN x_username TEXT`); } catch(e) {}
      try { db.exec(`ALTER TABLE agents ADD COLUMN x_verified_at TEXT`); } catch(e) {}
    }
    console.log('🔐 X verification columns ready');
  } catch (e) {
    console.log('Migration note:', e.message);
  }
}
migrate();

/**
 * GET /verification/:agentId/instructions
 * Get verification instructions for an agent
 */
router.get('/:agentId/instructions', async (req, res) => {
  const { agentId } = req.params;
  
  // Get agent name
  const db = await persistence.getDb();
  let agentName = agentId;
  
  try {
    if (persistence.isPostgres) {
      const result = await db.query('SELECT name FROM agents WHERE id = $1', [agentId]);
      agentName = result.rows[0]?.name || agentId;
    } else {
      const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId);
      agentName = agent?.name || agentId;
    }
  } catch (e) {}
  
  const instructions = verification.getVerificationInstructions(agentId, agentName);
  
  res.json({
    success: true,
    agentId,
    agentName,
    ...instructions
  });
});

/**
 * POST /verification/:agentId/verify
 * Attempt to verify an agent's X account
 * Supports: xUsername (bio check) OR tweetUrl (direct tweet verification)
 */
router.post('/:agentId/verify', async (req, res) => {
  const { agentId } = req.params;
  const { xUsername, tweetUrl } = req.body;
  
  if (!xUsername && !tweetUrl) {
    return res.status(400).json({
      success: false,
      error: 'Either xUsername or tweetUrl is required'
    });
  }
  
  try {
    let result;
    let finalUsername = xUsername;
    
    if (tweetUrl) {
      // Tweet URL verification (preferred)
      const code = verification.generateVerificationCode(agentId);
      result = await verification.checkTweetUrlVerification(tweetUrl, code);
      if (result.username) finalUsername = result.username;
    } else {
      // Bio/profile verification (fallback)
      result = await verification.verifyXAccount(xUsername, agentId);
    }
    
    if (result.verified) {
      // Update agent's x_verified status
      const db = await persistence.getDb();
      const now = new Date().toISOString();
      
      if (persistence.isPostgres) {
        await db.query(`
          UPDATE agents 
          SET x_verified = true, x_username = $1, x_verified_at = $2 
          WHERE id = $3
        `, [finalUsername, now, agentId]);
      } else {
        db.prepare(`
          UPDATE agents 
          SET x_verified = 1, x_username = ?, x_verified_at = ? 
          WHERE id = ?
        `).run(finalUsername, now, agentId);
      }
      
      console.log(`✅ X verified: @${finalUsername} → ${agentId} (method: ${result.method})`);
      
      res.json({
        success: true,
        verified: true,
        xUsername: finalUsername,
        method: result.method,
        tweetId: result.tweetId || null,
        message: 'X account verified! Your agent now has the 𝕏 verified badge.'
      });
    } else {
      res.json({
        success: true,
        verified: false,
        reason: result.reason,
        hint: tweetUrl 
          ? 'Make sure you posted the tweet with the exact verification code'
          : 'Make sure the verification code is in your bio or recent tweets'
      });
    }
  } catch (e) {
    res.status(500).json({
      success: false,
      error: e.message
    });
  }
});

/**
 * GET /verification/:agentId/status
 * Check verification status for an agent
 */
router.get('/:agentId/status', async (req, res) => {
  const { agentId } = req.params;
  
  try {
    const db = await persistence.getDb();
    let agent;
    
    if (persistence.isPostgres) {
      const result = await db.query(
        'SELECT x_verified, x_username, x_verified_at, wallet_verified FROM agents WHERE id = $1',
        [agentId]
      );
      agent = result.rows[0];
    } else {
      agent = db.prepare(
        'SELECT x_verified, x_username, x_verified_at, wallet_verified FROM agents WHERE id = ?'
      ).get(agentId);
    }
    
    if (!agent) {
      return res.status(404).json({
        success: false,
        error: 'Agent not found'
      });
    }
    
    res.json({
      success: true,
      agentId,
      verification: {
        x: {
          verified: !!agent.x_verified,
          username: agent.x_username || null,
          verifiedAt: agent.x_verified_at || null
        },
        wallet: {
          verified: !!agent.wallet_verified
        }
      }
    });
  } catch (e) {
    res.status(500).json({
      success: false,
      error: e.message
    });
  }
});

module.exports = router;
