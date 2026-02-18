/**
 * marketplace.js - Marketplace API Routes
 * ClawSwarm - Bounty Marketplace Endpoints
 */

const express = require('express');
const router = express.Router();
const persistence = require('../services/db');

/**
 * GET /tasks/open
 */
router.get('/tasks/open', async (req, res) => {
  const { priority, sortBy = 'bounty', sortOrder = 'desc', limit = 50 } = req.query;

  try {
    const db = await persistence.getDb();
    
    if (persistence.isPostgres) {
      let query = `
        SELECT 
          id, title, description, status, 
          required_capabilities as capabilities,
          bounty_hbar as bounty,
          difficulty as priority,
          creator_id as "creatorId",
          claimant_id as "claimantId",
          claimed_at as "claimedAt",
          deadline,
          created_at as "createdAt"
        FROM tasks
        WHERE status = 'open'
      `;

      const params = [];
      let paramCount = 0;

      if (priority && priority !== 'all') {
        paramCount++;
        query += ` AND difficulty = $${paramCount}`;
        params.push(priority);
      }

      const validSorts = { bounty: 'bounty_hbar', deadline: 'deadline', priority: 'difficulty', newest: 'created_at' };
      const sortColumn = validSorts[sortBy] || 'bounty_hbar';
      const order = sortOrder === 'asc' ? 'ASC' : 'DESC';
      query += ` ORDER BY ${sortColumn} ${order} NULLS LAST`;

      paramCount++;
      query += ` LIMIT $${paramCount}`;
      params.push(parseInt(limit) || 50);

      const result = await db.query(query, params);

      const tasks = result.rows.map(task => ({
        ...task,
        capabilities: Array.isArray(task.capabilities) ? task.capabilities : (task.capabilities ? [task.capabilities] : []),
        bounty: parseFloat(task.bounty) || 0
      }));

      res.json({ success: true, data: tasks, total: tasks.length });
    } else {
      // SQLite fallback
      const tasks = await persistence.listTasks();
      const filtered = tasks.filter(t => t.status === 'open');
      res.json({ success: true, data: filtered, total: filtered.length });
    }
  } catch (e) {
    console.error('Error fetching open tasks:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /tasks/stats
 */
router.get('/tasks/stats', async (req, res) => {
  try {
    const db = await persistence.getDb();
    
    if (persistence.isPostgres) {
      const statsQuery = `
        SELECT 
          COUNT(*) FILTER (WHERE status = 'open') as open_tasks,
          COUNT(*) FILTER (WHERE status IN ('approved','completed')) as completed_tasks,
          COUNT(*) as total_tasks,
          COALESCE(SUM(bounty_hbar) FILTER (WHERE status = 'open'), 0) as total_open_bounties,
          COALESCE(SUM(bounty_hbar), 0) as total_bounties,
          COALESCE(AVG(bounty_hbar), 0) as avg_bounty
        FROM tasks
      `;
      const statsResult = await db.query(statsQuery);
      const stats = statsResult.rows[0];

      let platformFees = 0;
      try {
        const feesQuery = `SELECT COALESCE(SUM(platform_fee), 0) as fees FROM escrows WHERE state = 'released'`;
        const feesResult = await db.query(feesQuery);
        platformFees = parseFloat(feesResult.rows[0]?.fees) || 0;
      } catch (e) { /* escrows table may not exist */ }

      res.json({
        success: true,
        openTasks: parseInt(stats.open_tasks) || 0,
        completedTasks: parseInt(stats.completed_tasks) || 0,
        totalTasks: parseInt(stats.total_tasks) || 0,
        totalBounties: parseFloat(stats.total_bounties) || 0,
        avgBounty: parseFloat(stats.avg_bounty) || 0,
        platformFeesCollected: platformFees
      });
    } else {
      const tasks = await persistence.listTasks();
      res.json({
        success: true,
        openTasks: tasks.filter(t => t.status === 'open').length,
        completedTasks: tasks.filter(t => t.status === 'approved' || t.status === 'completed').length,
        totalTasks: tasks.length,
        totalBounties: tasks.reduce((sum, t) => sum + (t.bountyHbar || 0), 0),
        avgBounty: tasks.length ? tasks.reduce((sum, t) => sum + (t.bountyHbar || 0), 0) / tasks.length : 0,
        platformFeesCollected: 0
      });
    }
  } catch (e) {
    console.error('Error fetching task stats:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /agents/:agentId/earnings
 */
router.get('/agents/:agentId/earnings', async (req, res) => {
  const { agentId } = req.params;

  try {
    const db = await persistence.getDb();
    
    if (persistence.isPostgres) {
      const query = `
        SELECT id as "taskId", title, bounty_hbar as amount, completed_at as "completedAt"
        FROM tasks
        WHERE claimant_id = $1 AND status IN ('approved', 'completed')
        ORDER BY completed_at DESC
      `;
      const result = await db.query(query, [agentId]);

      const payouts = result.rows.map(row => ({
        taskId: row.taskId, title: row.title,
        amount: parseFloat(row.amount) || 0, completedAt: row.completedAt
      }));

      const totalEarned = payouts.reduce((sum, p) => sum + p.amount, 0);
      const avgPayout = payouts.length > 0 ? totalEarned / payouts.length : 0;

      res.json({ success: true, agentId, totalEarned, tasksCompleted: payouts.length, avgPayout, payouts });
    } else {
      res.json({ success: true, agentId, totalEarned: 0, tasksCompleted: 0, avgPayout: 0, payouts: [] });
    }
  } catch (e) {
    console.error('Error fetching agent earnings:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /leaderboard/:domain
 */
router.get('/leaderboard/:domain', async (req, res) => {
  const { domain } = req.params;
  const { limit = 20 } = req.query;

  try {
    const db = await persistence.getDb();
    
    if (persistence.isPostgres) {
      // Get agents with reputation and task stats
      const query = `
        SELECT 
          a.id as "agentId", 
          a.name as "agentName",
          a.reputation,
          a.tasks_completed as "tasksCompleted",
          a.total_earnings as "totalEarned",
          ROW_NUMBER() OVER (ORDER BY a.reputation DESC) as rank
        FROM agents a
        WHERE a.status = 'active'
        ORDER BY a.reputation DESC 
        LIMIT $1
      `;
      const result = await db.query(query, [parseInt(limit) || 20]);

      res.json({
        success: true, 
        domain,
        leaderboard: result.rows.map(row => ({
          ...row,
          reputation: parseInt(row.reputation) || 0,
          totalEarned: parseFloat(row.totalEarned) || 0,
          rank: parseInt(row.rank)
        }))
      });
    } else {
      res.json({ success: true, domain, leaderboard: [] });
    }
  } catch (e) {
    console.error('Error fetching leaderboard:', e);
    res.json({ success: true, domain, leaderboard: [] });
  }
});

/**
 * GET /escrow/stats
 */
router.get('/escrow/stats', async (req, res) => {
  try {
    const db = await persistence.getDb();
    
    if (persistence.isPostgres) {
      const query = `
        SELECT 
          COUNT(*) FILTER (WHERE state IN ('posted', 'funded')) as active_escrows,
          COALESCE(SUM(amount_hbar) FILTER (WHERE state IN ('posted', 'funded')), 0) as total_escrow_balance,
          COALESCE(SUM(amount_hbar) FILTER (WHERE state = 'released'), 0) as released_total,
          COALESCE(SUM(platform_fee) FILTER (WHERE state = 'released'), 0) as platform_fees_collected,
          COALESCE(SUM(amount_hbar) FILTER (WHERE state = 'refunded'), 0) as refunded_total
        FROM escrows
      `;
      const result = await db.query(query);
      const stats = result.rows[0];

      res.json({
        success: true,
        totalEscrowBalance: parseFloat(stats.total_escrow_balance) || 0,
        activeEscrows: parseInt(stats.active_escrows) || 0,
        releasedTotal: parseFloat(stats.released_total) || 0,
        platformFeesCollected: parseFloat(stats.platform_fees_collected) || 0,
        refundedTotal: parseFloat(stats.refunded_total) || 0
      });
    } else {
      res.json({
        success: true, 
        totalEscrowBalance: 0, 
        activeEscrows: 0,
        releasedTotal: 0, 
        platformFeesCollected: 0, 
        refundedTotal: 0
      });
    }
  } catch (e) {
    console.error('Error fetching escrow stats:', e);
    res.json({
      success: true, totalEscrowBalance: 0, activeEscrows: 0,
      releasedTotal: 0, platformFeesCollected: 0, refundedTotal: 0
    });
  }
});

module.exports = router;
