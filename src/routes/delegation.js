/**
 * Task Delegation Routes — Direct agent-to-agent task assignment
 * 
 * Unlike marketplace tasks (posted for anyone to claim), delegated tasks
 * go directly to a specific agent. The target can accept or reject.
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, auditLog } = require('../middleware/auth');
const persistence = require('../services/db');

/**
 * POST /delegate
 * Delegate a task directly to another agent
 */
router.post('/', requireAuth, auditLog('task_delegate'), async (req, res) => {
  try {
    const fromAgent = req.agent.agentId;
    const {
      targetAgent,
      title,
      description,
      bountyHbar,
      difficulty,
      priority,
      deadline,
      requiredCapabilities
    } = req.body;

    if (!targetAgent || !title) {
      return res.status(400).json({
        error: 'targetAgent and title are required'
      });
    }

    if (fromAgent === targetAgent) {
      return res.status(400).json({ error: 'Cannot delegate a task to yourself' });
    }

    // Verify target exists
    const target = await persistence.query(
      'SELECT id, name, status FROM agents WHERE id = ',
      [targetAgent]
    );
    if (!target?.rows?.length) {
      return res.status(404).json({ error: 'Target agent not found' });
    }
    if (target.rows[0].status !== 'active') {
      return res.status(400).json({ error: 'Target agent is not active' });
    }

    const taskId = 'task_' + crypto.randomBytes(8).toString('hex');
    const autoRejectAt = new Date(Date.now() + 3600000); // 1 hour auto-reject

    await persistence.query(
      `INSERT INTO tasks (
        id, title, description, status, creator_id, created_by,
        assigned_to, delegation_type, priority, difficulty,
        bounty_hbar, deadline, auto_reject_at, created_at, updated_at
      ) VALUES (, , , 'pending', , , , 'direct', , , , , 0, NOW(), NOW())`,
      [
        taskId, title, description || '',
        fromAgent, targetAgent,
        priority || 'normal', difficulty || 'medium',
        bountyHbar || 0, deadline || null, autoRejectAt
      ]
    );

    // Send DM notification to target agent
    const dmId = 'dm_' + crypto.randomBytes(8).toString('hex');
    await persistence.query(
      `INSERT INTO direct_messages (id, from_agent, to_agent, content, created_at)
       VALUES (, , , , NOW())`,
      [dmId, fromAgent, targetAgent,
       `📋 New task delegated to you: **${title}**\n\nPriority: ${priority || 'normal'}\nDifficulty: ${difficulty || 'medium'}\nBounty: ${bountyHbar || 0} HBAR\n\nAccept: POST /api/v1/delegate/${taskId}/accept\nReject: POST /api/v1/delegate/${taskId}/reject\n\nAuto-rejects in 1 hour if no response.`]
    );

    res.status(201).json({
      taskId,
      from: fromAgent,
      to: targetAgent,
      title,
      priority: priority || 'normal',
      difficulty: difficulty || 'medium',
      bountyHbar: bountyHbar || 0,
      status: 'pending',
      autoRejectAt: autoRejectAt.toISOString(),
      message: 'Task delegated. Target agent has been notified via DM.'
    });
  } catch (e) {
    console.error('Delegation error:', e);
    res.status(500).json({ error: 'Failed to delegate task' });
  }
});

/**
 * POST /delegate/:taskId/accept
 * Accept a delegated task
 */
router.post('/:taskId/accept', requireAuth, auditLog('task_accept'), async (req, res) => {
  try {
    const agentId = req.agent.agentId;
    const { taskId } = req.params;

    const result = await persistence.query(
      'SELECT * FROM tasks WHERE id =  AND assigned_to =  AND status = ',
      [taskId, agentId, 'pending']
    );

    if (!result?.rows?.length) {
      return res.status(404).json({ error: 'No pending delegated task found for you' });
    }

    await persistence.query(
      `UPDATE tasks SET
        status = 'claimed',
        claimed_by = ,
        claimant_id = ,
        claimed_at = NOW(),
        accepted_at = NOW(),
        updated_at = NOW()
       WHERE id = `,
      [agentId, taskId]
    );

    const task = result.rows[0];

    // Notify the creator
    const dmId = 'dm_' + crypto.randomBytes(8).toString('hex');
    await persistence.query(
      `INSERT INTO direct_messages (id, from_agent, to_agent, content, created_at)
       VALUES (, , , , NOW())`,
      [dmId, agentId, task.creator_id,
       `✅ Task accepted: **${task.title}**\n\nI'm on it.`]
    );

    res.json({
      taskId,
      status: 'claimed',
      message: 'Task accepted. Creator has been notified.'
    });
  } catch (e) {
    console.error('Accept error:', e);
    res.status(500).json({ error: 'Failed to accept task' });
  }
});

/**
 * POST /delegate/:taskId/reject
 * Reject a delegated task
 */
router.post('/:taskId/reject', requireAuth, auditLog('task_reject'), async (req, res) => {
  try {
    const agentId = req.agent.agentId;
    const { taskId } = req.params;
    const { reason } = req.body;

    const result = await persistence.query(
      'SELECT * FROM tasks WHERE id =  AND assigned_to =  AND status = ',
      [taskId, agentId, 'pending']
    );

    if (!result?.rows?.length) {
      return res.status(404).json({ error: 'No pending delegated task found for you' });
    }

    await persistence.query(
      `UPDATE tasks SET
        status = 'rejected',
        rejected_at = NOW(),
        rejection_reason = ,
        updated_at = NOW()
       WHERE id = `,
      [reason || 'No reason given', taskId]
    );

    const task = result.rows[0];

    // Notify the creator
    const dmId = 'dm_' + crypto.randomBytes(8).toString('hex');
    await persistence.query(
      `INSERT INTO direct_messages (id, from_agent, to_agent, content, created_at)
       VALUES (, , , , NOW())`,
      [dmId, agentId, task.creator_id,
       `❌ Task rejected: **${task.title}**\n\nReason: ${reason || 'No reason given'}`]
    );

    res.json({
      taskId,
      status: 'rejected',
      reason: reason || 'No reason given',
      message: 'Task rejected. Creator has been notified.'
    });
  } catch (e) {
    console.error('Reject error:', e);
    res.status(500).json({ error: 'Failed to reject task' });
  }
});

/**
 * POST /delegate/:taskId/submit
 * Submit work for a delegated task
 */
router.post('/:taskId/submit', requireAuth, auditLog('task_submit'), async (req, res) => {
  try {
    const agentId = req.agent.agentId;
    const { taskId } = req.params;
    const { result: submission } = req.body;

    if (!submission) {
      return res.status(400).json({ error: 'result (submission) is required' });
    }

    const task = await persistence.query(
      'SELECT * FROM tasks WHERE id =  AND claimant_id =  AND status = ',
      [taskId, agentId, 'claimed']
    );

    if (!task?.rows?.length) {
      return res.status(404).json({ error: 'No claimed task found for you' });
    }

    await persistence.query(
      `UPDATE tasks SET
        status = 'submitted',
        submission = ,
        submitted_at = NOW(),
        updated_at = NOW()
       WHERE id = `,
      [submission, taskId]
    );

    // Notify creator
    const dmId = 'dm_' + crypto.randomBytes(8).toString('hex');
    await persistence.query(
      `INSERT INTO direct_messages (id, from_agent, to_agent, content, created_at)
       VALUES (, , , , NOW())`,
      [dmId, agentId, task.rows[0].creator_id,
       `📦 Work submitted for: **${task.rows[0].title}**\n\nReview: POST /api/v1/delegate/${taskId}/approve or /reject`]
    );

    res.json({
      taskId,
      status: 'submitted',
      message: 'Work submitted. Creator has been notified for review.'
    });
  } catch (e) {
    console.error('Submit error:', e);
    res.status(500).json({ error: 'Failed to submit work' });
  }
});

/**
 * GET /delegate/inbox
 * Get all tasks assigned to the authenticated agent
 */
router.get('/inbox', requireAuth, async (req, res) => {
  try {
    const agentId = req.agent.agentId;
    const status = req.query.status;

    let query = 'SELECT * FROM tasks WHERE assigned_to = ';
    const params = [agentId];

    if (status) {
      query += ' AND status = ';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT 50';

    const result = await persistence.query(query, params);

    res.json({
      tasks: result?.rows || [],
      count: result?.rows?.length || 0
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch task inbox' });
  }
});

/**
 * GET /delegate/outbox
 * Get all tasks created/delegated by the authenticated agent
 */
router.get('/outbox', requireAuth, async (req, res) => {
  try {
    const agentId = req.agent.agentId;
    const status = req.query.status;

    let query = "SELECT * FROM tasks WHERE creator_id =  AND delegation_type = 'direct'";
    const params = [agentId];

    if (status) {
      query += ' AND status = ';
      params.push(status);
    }

    query += ' ORDER BY created_at DESC LIMIT 50';

    const result = await persistence.query(query, params);

    res.json({
      tasks: result?.rows || [],
      count: result?.rows?.length || 0
    });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch task outbox' });
  }
});

module.exports = router;
