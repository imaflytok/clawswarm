/**
 * tasks.js - Task Management Routes
 * ClawSwarm - Agent Collaboration
 */

const express = require('express');
const router = express.Router();
const tasks = require('../services/tasks');

// Initialize tasks table on load
tasks.initialize().catch(console.error);

/**
 * GET /tasks/open
 * Get open tasks sorted by bounty (for Marketplace UI)
 * MUST come before /:taskId to avoid route conflict
 */
router.get('/open', async (req, res) => {
  try {
    const taskList = await tasks.listTasks({
      status: 'open',
      limit: 100
    });
    
    // Sort by bounty (highest first)
    const sorted = taskList.sort((a, b) => {
      const bountyA = parseFloat(a.bounty_hbar || 0);
      const bountyB = parseFloat(b.bounty_hbar || 0);
      return bountyB - bountyA;
    });
    
    res.json({
      success: true,
      count: sorted.length,
      tasks: sorted
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /tasks/stats
 * Get task statistics (for Dashboard)
 */
router.get('/stats', async (req, res) => {
  try {
    const allTasks = await tasks.listTasks({ limit: 1000 });
    
    const stats = {
      total: allTasks.length,
      open: 0,
      claimed: 0,
      submitted: 0,
      completed: 0,
      cancelled: 0,
      totalBountyHbar: 0,
      paidBountyHbar: 0,
      avgBountyHbar: 0
    };
    
    for (const task of allTasks) {
      const bounty = parseFloat(task.bounty_hbar || 0);
      stats.totalBountyHbar += bounty;
      
      switch (task.status) {
        case 'open': stats.open++; break;
        case 'claimed': stats.claimed++; break;
        case 'submitted': stats.submitted++; break;
        case 'approved':
        case 'completed': 
          stats.completed++; 
          if (task.bounty_paid) stats.paidBountyHbar += bounty;
          break;
        case 'cancelled': stats.cancelled++; break;
      }
    }
    
    stats.avgBountyHbar = stats.total > 0 ? stats.totalBountyHbar / stats.total : 0;
    
    res.json({
      success: true,
      stats,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /tasks
 * Create a new task
 */
router.post('/', async (req, res) => {
  const { creatorId, title, description, requiredCapabilities, bountyHbar, difficulty } = req.body;

  if (!creatorId || !title) {
    return res.status(400).json({
      success: false,
      error: 'creatorId and title are required'
    });
  }

  try {
    const task = await tasks.createTask(creatorId, {
      title,
      description,
      requiredCapabilities,
      bountyHbar,
      difficulty: difficulty || 'medium'
    });

    res.status(201).json({
      success: true,
      task
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /tasks
 * List tasks with filters
 */
router.get('/', async (req, res) => {
  const { status, capability, creator, claimant, limit } = req.query;

  try {
    const taskList = await tasks.listTasks({
      status,
      capability,
      creatorId: creator,
      claimantId: claimant,
      limit: limit ? parseInt(limit) : 50
    });

    res.json({
      success: true,
      count: taskList.length,
      tasks: taskList
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /tasks/:taskId
 * Get task details
 */
router.get('/:taskId', async (req, res) => {
  try {
    const task = await tasks.getTask(req.params.taskId);

    if (!task) {
      return res.status(404).json({ success: false, error: 'Task not found' });
    }

    res.json({ success: true, task });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /tasks/:taskId/claim
 * Claim a task
 */
router.post('/:taskId/claim', async (req, res) => {
  const { agentId } = req.body;

  if (!agentId) {
    return res.status(400).json({ success: false, error: 'agentId is required' });
  }

  try {
    const task = await tasks.claimTask(req.params.taskId, agentId);
    res.json({ success: true, task });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

/**
 * POST /tasks/:taskId/submit
 * Submit work for a task
 */
router.post('/:taskId/submit', async (req, res) => {
  const { agentId, submission } = req.body;

  if (!agentId || !submission) {
    return res.status(400).json({ success: false, error: 'agentId and submission are required' });
  }

  try {
    const task = await tasks.submitTask(req.params.taskId, agentId, submission);
    res.json({ success: true, task });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

/**
 * POST /tasks/:taskId/approve
 * Approve task submission
 */
router.post('/:taskId/approve', async (req, res) => {
  const { agentId, result } = req.body;

  if (!agentId) {
    return res.status(400).json({ success: false, error: 'agentId (creator) is required' });
  }

  try {
    const task = await tasks.approveTask(req.params.taskId, agentId, result);
    res.json({ success: true, task, message: 'Task approved! Reputation updated.' });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

/**
 * POST /tasks/:taskId/reject
 * Reject task submission
 */
router.post('/:taskId/reject', async (req, res) => {
  const { agentId, reason } = req.body;

  if (!agentId) {
    return res.status(400).json({ success: false, error: 'agentId (creator) is required' });
  }

  try {
    const task = await tasks.rejectTask(req.params.taskId, agentId, reason);
    res.json({ success: true, task, message: 'Submission rejected. Claimant can resubmit.' });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

/**
 * POST /tasks/:taskId/cancel
 * Cancel a task
 */
router.post('/:taskId/cancel', async (req, res) => {
  const { agentId } = req.body;

  if (!agentId) {
    return res.status(400).json({ success: false, error: 'agentId (creator) is required' });
  }

  try {
    const task = await tasks.cancelTask(req.params.taskId, agentId);
    res.json({ success: true, task, message: 'Task cancelled.' });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

module.exports = router;
