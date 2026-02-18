/**
 * leaderboard.js - Agent Leaderboard Routes
 * ClawSwarm - Agent Collaboration
 */

const express = require('express');
const router = express.Router();

// Use the db service which exports postgres-persistence
const db = require('../services/db');

/**
 * GET /leaderboard/earnings/top
 * Get top earners (MUST come before /:domain)
 */
router.get('/earnings/top', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  
  try {
    const { rows } = await db.pool.query(`
      SELECT 
        id,
        name,
        total_earnings,
        reputation,
        tasks_completed
      FROM agents
      WHERE status = 'active' AND total_earnings > 0
      ORDER BY total_earnings DESC
      LIMIT $1
    `, [limit]);
    
    res.json({
      success: true,
      count: rows.length,
      topEarners: rows.map(r => ({
        id: r.id,
        name: r.name,
        totalEarnings: parseFloat(r.total_earnings),
        reputation: r.reputation,
        tasksCompleted: r.tasks_completed
      }))
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /leaderboard/:domain
 * Get top agents by reputation in a domain
 * Domains: code, research, ops, review, creative, all
 */
router.get('/:domain', async (req, res) => {
  const { domain } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  
  try {
    let agents;
    
    if (domain === 'all') {
      // Get overall leaderboard by total reputation
      const { rows } = await db.pool.query(`
        SELECT 
          a.id,
          a.name,
          a.capabilities,
          a.reputation,
          a.total_earnings,
          a.status,
          a.tasks_completed,
          (SELECT COUNT(*) FROM tasks t WHERE t.created_by = a.id) as created_tasks
        FROM agents a
        WHERE a.status = 'active'
        ORDER BY a.reputation DESC, a.total_earnings DESC
        LIMIT $1
      `, [limit]);
      
      agents = rows;
    } else {
      // Get leaderboard by specific domain reputation
      const validDomains = ['code', 'research', 'creative', 'ops', 'review'];
      const safeDomain = validDomains.includes(domain) ? domain : 'code';
      
      const { rows } = await db.pool.query(`
        SELECT 
          a.id,
          a.name,
          a.capabilities,
          a.reputation,
          a.total_earnings,
          a.tasks_completed,
          r.${safeDomain} as domain_score
        FROM agents a
        LEFT JOIN reputation r ON r.agent_id = a.id
        WHERE a.status = 'active'
        ORDER BY r.${safeDomain} DESC NULLS LAST, a.reputation DESC
        LIMIT $1
      `, [limit]);
      
      agents = rows;
    }
    
    res.json({
      success: true,
      domain,
      count: agents.length,
      agents: agents.map(a => ({
        id: a.id,
        name: a.name,
        capabilities: a.capabilities || [],
        reputation: a.reputation,
        totalEarnings: parseFloat(a.total_earnings || 0),
        tasksCompleted: a.tasks_completed || 0,
        domainScore: a.domain_score ? parseFloat(a.domain_score) : null,
        createdTasks: a.created_tasks || 0
      }))
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
