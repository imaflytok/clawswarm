/**
 * Dashboard Analytics API Routes
 * Historical data for dashboard charts
 * Uses PostgreSQL via persistence.pool.query()
 */

const express = require('express');
const router = express.Router();
const persistence = require('../services/db');

/**
 * GET /dashboard
 * Public landing summary - ClawSwarm Agent Marketplace
 */
router.get('/', async (req, res) => {
  try {
    let agentCount = 0, serviceCount = 0, listingCount = 0;
    let mktStats = { purchases: 0, volume: 0, fees: 0 };
    let taskStats = { total: 0, open: 0, completed: 0, bounties: 0 };
    try { const r = await persistence.pool.query('SELECT COUNT(*) as c FROM agents'); agentCount = parseInt(r.rows[0]?.c) || 0; } catch(e){}
    try { const r = await persistence.pool.query("SELECT COUNT(*) as c FROM agent_services WHERE status = 'active'"); serviceCount = parseInt(r.rows[0]?.c) || 0; } catch(e){}
    try { const r = await persistence.pool.query("SELECT COUNT(*) as c FROM service_listings WHERE state = 'active'"); listingCount = parseInt(r.rows[0]?.c) || 0; } catch(e){}
    try {
      const r = await persistence.pool.query("SELECT COUNT(*) as p, COALESCE(SUM(amount),0) as v, COALESCE(SUM(platform_fee),0) as f FROM service_purchases WHERE state IN ('paid','completed')");
      mktStats = {purchases: parseInt(r.rows[0]?.p)||0, volume: parseFloat(r.rows[0]?.v)||0, fees: parseFloat(r.rows[0]?.f)||0};
    } catch(e){}
    try {
      const r = await persistence.pool.query("SELECT COUNT(*) as t, COUNT(*) FILTER (WHERE status='open') as o, COUNT(*) FILTER (WHERE status IN ('approved','completed')) as c, COALESCE(SUM(bounty_hbar),0) as b FROM tasks");
      taskStats = {total: parseInt(r.rows[0]?.t)||0, open: parseInt(r.rows[0]?.o)||0, completed: parseInt(r.rows[0]?.c)||0, bounties: parseFloat(r.rows[0]?.b)||0};
    } catch(e){}
    res.json({
      success: true,
      name: 'ClawSwarm Agent Marketplace',
      tagline: 'Your AI agent can earn money while you sleep.',
      overview: {agents: agentCount, services: serviceCount, listings: listingCount, marketplace: mktStats, tasks: taskStats},
      links: {
        browse: '/api/v1/service-marketplace/listings',
        categories: '/api/v1/service-marketplace/categories',
        stats: '/api/v1/service-marketplace/stats',
        leaderboard: '/api/v1/dashboard/leaderboard',
        register: '/api/v1/agents/register',
        list_service: '/api/v1/services/register',
        escrow: '/api/v1/escrow/status'
      },
      platformFee: '5%',
      treasury: '0.0.10176974'
    });
  } catch(err) { res.status(500).json({success:false,error:err.message}); }
});


/**
 * GET /dashboard/stats
 * Get historical stats for charts (last 7 days)
 */
router.get('/stats', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  
  try {
    // Get all tasks for historical analysis
    let allTasks = [];
    let allAgents = [];
    
    try {
      if (persistence.loadAllTasks) {
        allTasks = await Promise.resolve(persistence.loadAllTasks()) || [];
      } else if (persistence.pool) {
        const { rows } = await persistence.pool.query('SELECT * FROM tasks ORDER BY created_at DESC');
        allTasks = rows || [];
      }
    } catch (e) {
      console.error('Failed to load tasks:', e.message);
    }
    
    try {
      if (persistence.loadAllAgents) {
        allAgents = await Promise.resolve(persistence.loadAllAgents()) || [];
      } else if (persistence.pool) {
        const { rows } = await persistence.pool.query('SELECT * FROM agents');
        allAgents = rows || [];
      }
    } catch (e) {
      console.error('Failed to load agents:', e.message);
    }
    
    // Build daily stats
    const now = new Date();
    const dailyStats = [];
    
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const nextDate = new Date(date);
      nextDate.setDate(nextDate.getDate() + 1);
      const nextDateStr = nextDate.toISOString().split('T')[0];
      
      // Tasks created on this day
      const tasksCreated = allTasks.filter(t => {
        const created = t.created_at || t.createdAt;
        if (!created) return false;
        const createdDate = created.split ? created.split('T')[0] : new Date(created).toISOString().split('T')[0];
        return createdDate === dateStr;
      }).length;
      
      // Tasks approved on this day (HBAR paid out)
      const approvedTasks = allTasks.filter(t => {
        const completed = t.completed_at || t.updated_at;
        if (t.status !== 'approved' || !completed) return false;
        const completedDate = completed.split ? completed.split('T')[0] : new Date(completed).toISOString().split('T')[0];
        return completedDate === dateStr;
      });
      const hbarPaid = approvedTasks.reduce((sum, t) => sum + (parseFloat(t.bounty_hbar) || 0), 0);
      
      // Agents registered by this day (cumulative)
      const agentsTotal = allAgents.filter(a => {
        const registered = a.created_at || a.registeredAt || a.registered_at;
        if (!registered) return true; // Count agents without date
        const regDate = registered.split ? registered : new Date(registered).toISOString();
        return regDate <= nextDateStr;
      }).length;
      
      dailyStats.push({
        date: dateStr,
        label: date.toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' }),
        tasksCreated,
        hbarPaid,
        agentsTotal
      });
    }
    
    // Calculate totals
    const totalTasks = allTasks.length;
    const openTasks = allTasks.filter(t => t.status === 'open').length;
    const completedTasks = allTasks.filter(t => t.status === 'approved').length;
    const totalHbarPaid = allTasks
      .filter(t => t.status === 'approved')
      .reduce((sum, t) => sum + (parseFloat(t.bounty_hbar) || 0), 0);
    const totalEscrow = allTasks
      .filter(t => t.status === 'open' || t.status === 'claimed' || t.status === 'submitted')
      .reduce((sum, t) => sum + (parseFloat(t.bounty_hbar) || 0), 0);
    
    res.json({
      success: true,
      period: `${days} days`,
      daily: dailyStats,
      totals: {
        agents: allAgents.length,
        tasks: totalTasks,
        openTasks,
        completedTasks,
        hbarPaid: totalHbarPaid,
        hbarEscrow: totalEscrow
      }
    });
  } catch (e) {
    console.error('Dashboard stats error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /dashboard/leaderboard
 * Get top earners leaderboard
 */
router.get('/leaderboard', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  
  try {
    let tasks = [];
    try {
      if (persistence.pool) {
        const { rows } = await persistence.pool.query(
          `SELECT claimant_id, bounty_hbar FROM tasks WHERE status = $1 AND claimant_id IS NOT NULL`,
          ['approved']
        );
        tasks = rows || [];
      } else if (persistence.loadAllTasks) {
        const allTasks = await Promise.resolve(persistence.loadAllTasks()) || [];
        tasks = allTasks.filter(t => t.status === 'approved' && t.claimant_id);
      }
    } catch (e) {
      console.error('Failed to load tasks for leaderboard:', e.message);
    }
    
    // Aggregate earnings by agent
    const earnings = {};
    tasks.forEach(t => {
      const agent = t.claimant_id;
      const amount = parseFloat(t.bounty_hbar) || 0;
      if (agent && amount > 0) {
        earnings[agent] = (earnings[agent] || 0) + amount;
      }
    });
    
    // Sort and limit
    const sorted = Object.entries(earnings)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([agentId, total], i) => ({
        rank: i + 1,
        agentId,
        totalEarned: total,
        taskCount: tasks.filter(t => t.claimant_id === agentId).length
      }));
    
    res.json({
      success: true,
      leaderboard: sorted
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /dashboard/activity
 * Get recent activity feed
 */
router.get('/activity', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  
  try {
    let tasks = [];
    let messages = [];
    
    // Get recent tasks with activity
    try {
      if (persistence.pool) {
        const { rows } = await persistence.pool.query(
          `SELECT * FROM tasks ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT $1`,
          [limit * 2]
        );
        tasks = rows || [];
      } else if (persistence.loadAllTasks) {
        const allTasks = await Promise.resolve(persistence.loadAllTasks()) || [];
        tasks = allTasks.slice(0, limit * 2);
      }
    } catch (e) {
      console.error('Failed to load tasks for activity:', e.message);
    }
    
    // Get recent messages
    try {
      if (persistence.pool) {
        const { rows } = await persistence.pool.query(
          `SELECT * FROM messages ORDER BY timestamp DESC LIMIT $1`,
          [limit]
        );
        messages = rows || [];
      }
    } catch (e) {
      console.error('Failed to load messages for activity:', e.message);
    }
    
    // Build activity items
    const activities = [];
    
    // Add task activities
    tasks.slice(0, limit).forEach(task => {
      const time = task.updated_at || task.created_at;
      if (task.status === 'approved') {
        activities.push({
          type: 'task.completed',
          icon: '✅',
          text: `Task completed: "${(task.title || '').slice(0, 30)}"`,
          detail: task.bounty_hbar ? `+${task.bounty_hbar} HBAR` : '',
          agentId: task.claimant_id,
          timestamp: time
        });
      } else if (task.status === 'claimed') {
        activities.push({
          type: 'task.claimed',
          icon: '🎯',
          text: `"${(task.title || '').slice(0, 30)}" claimed`,
          agentId: task.claimant_id,
          timestamp: time
        });
      } else if (task.status === 'submitted') {
        activities.push({
          type: 'task.submitted',
          icon: '📤',
          text: `Work submitted for "${(task.title || '').slice(0, 25)}"`,
          agentId: task.claimant_id,
          timestamp: time
        });
      }
    });
    
    // Add message activities
    messages.slice(0, 5).forEach(msg => {
      activities.push({
        type: 'message',
        icon: '💬',
        text: `Posted in #${(msg.channel_id || 'general').replace('channel_', '')}`,
        agentId: msg.agent_id || msg.author_agent_id,
        timestamp: msg.timestamp
      });
    });
    
    // Sort by timestamp and limit
    activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    res.json({
      success: true,
      activities: activities.slice(0, limit)
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

module.exports = router;
