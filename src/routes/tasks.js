/**
 * Task Routes - Task Marketplace and Routing
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const escrow = require('../services/escrow');
const { agents } = require('./agents');
const hedera = require('../services/hedera');

// In-memory task storage (will move to Redis/DB later)
const tasks = new Map();

function generateTaskId() {
  return 'task_' + crypto.randomBytes(8).toString('hex');
}

/**
 * POST /tasks
 * Create a new task for agents
 */
router.post('/', (req, res) => {
  const { 
    title, 
    description, 
    requiredCapabilities,
    preferredAgents,
    priority,
    deadline,
    reward,
    bounty_hbar, // NEW: HBAR bounty amount
    payload
  } = req.body;
  
  if (!title || !description) {
    return res.status(400).json({
      success: false,
      error: 'Title and description are required'
    });
  }
  
  // Validate bounty if provided
  if (bounty_hbar !== undefined && (isNaN(bounty_hbar) || bounty_hbar < 0)) {
    return res.status(400).json({
      success: false,
      error: 'bounty_hbar must be a positive number'
    });
  }
  
  const taskId = generateTaskId();
  
  const task = {
    id: taskId,
    title,
    description,
    requiredCapabilities: requiredCapabilities || [],
    preferredAgents: preferredAgents || [],
    priority: priority || 'normal', // low, normal, high, urgent
    deadline: deadline || null,
    reward: reward || null,
    bounty_hbar: bounty_hbar || 0, // HBAR bounty for completion
    bounty_paid: false, // Track if bounty was paid
    bounty_tx: null, // Transaction ID when paid
    payload: payload || {},
    status: 'open', // open, claimed, in_progress, completed, failed
    createdAt: new Date().toISOString(),
    createdBy: req.headers['x-agent-id'] || 'anonymous',
    claimedBy: null,
    completedAt: null,
    result: null
  };
  
  tasks.set(taskId, task);
  
  const bountyInfo = bounty_hbar ? ` 💰 ${bounty_hbar} HBAR` : '';
  console.log(`📋 New task created: ${title} (${taskId})${bountyInfo}`);
  
  // Find matching agents
  const matchingAgents = findMatchingAgents(task);
  
  res.status(201).json({
    success: true,
    task: {
      id: taskId,
      title,
      status: 'open',
      bounty_hbar: bounty_hbar || 0,
      matchingAgents: matchingAgents.length,
      endpoints: {
        status: `/api/v1/tasks/${taskId}`,
        claim: `/api/v1/tasks/${taskId}/claim`,
        complete: `/api/v1/tasks/${taskId}/complete`
      }
    }
  });
});

/**
 * Find agents that match task requirements
 */
function findMatchingAgents(task) {
  return Array.from(agents.values())
    .filter(agent => {
      // Must be online
      if (agent.status !== 'online') return false;
      
      // Check required capabilities
      if (task.requiredCapabilities.length > 0) {
        const agentCaps = agent.capabilities.map(c => 
          typeof c === 'string' ? c.toLowerCase() : c.name?.toLowerCase()
        );
        const hasAllCaps = task.requiredCapabilities.every(req =>
          agentCaps.some(cap => cap?.includes(req.toLowerCase()))
        );
        if (!hasAllCaps) return false;
      }
      
      return true;
    })
    .map(a => ({
      id: a.id,
      name: a.name,
      reputation: a.reputation
    }));
}

/**
 * GET /tasks
 * List all tasks
 */
router.get('/', (req, res) => {
  const { status, capability } = req.query;
  
  let taskList = Array.from(tasks.values());
  
  if (status) {
    taskList = taskList.filter(t => t.status === status);
  }
  
  if (capability) {
    taskList = taskList.filter(t =>
      t.requiredCapabilities.some(c => 
        c.toLowerCase().includes(capability.toLowerCase())
      )
    );
  }
  
  // Sort by priority and creation time
  const priorityOrder = { urgent: 0, high: 1, normal: 2, low: 3 };
  taskList.sort((a, b) => {
    const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (pDiff !== 0) return pDiff;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
  
  res.json({
    success: true,
    count: taskList.length,
    tasks: taskList.map(t => ({
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      bounty_hbar: t.bounty_hbar || 0,
      bounty_paid: t.bounty_paid || false,
      requiredCapabilities: t.requiredCapabilities,
      createdAt: t.createdAt,
      claimedBy: t.claimedBy
    }))
  });
});

/**
 * GET /tasks/:taskId
 * Get specific task details
 */
router.get('/:taskId', (req, res) => {
  const { taskId } = req.params;
  const task = tasks.get(taskId);
  
  if (!task) {
    return res.status(404).json({
      success: false,
      error: 'Task not found'
    });
  }
  
  res.json({
    success: true,
    task
  });
});

/**
 * POST /tasks/:taskId/claim
 * Claim a task
 */
router.post('/:taskId/claim', (req, res) => {
  const { taskId } = req.params;
  const agentId = req.headers['x-agent-id'] || req.body.agentId;
  
  if (!agentId) {
    return res.status(400).json({
      success: false,
      error: 'Agent ID required (x-agent-id header or agentId in body)'
    });
  }
  
  const task = tasks.get(taskId);
  
  if (!task) {
    return res.status(404).json({
      success: false,
      error: 'Task not found'
    });
  }
  
  if (task.status !== 'open') {
    return res.status(409).json({
      success: false,
      error: `Task is already ${task.status}`
    });
  }
  
  task.status = 'claimed';
  task.claimedBy = agentId;
  task.claimedAt = new Date().toISOString();
  tasks.set(taskId, task);
  
  console.log(`📋 Task claimed: ${task.title} by ${agentId}`);
  
  res.json({
    success: true,
    message: 'Task claimed successfully',
    task: {
      id: taskId,
      title: task.title,
      payload: task.payload,
      deadline: task.deadline
    }
  });
});

/**
 * POST /tasks/:taskId/start
 * Mark task as in progress
 */
router.post('/:taskId/start', (req, res) => {
  const { taskId } = req.params;
  const agentId = req.headers['x-agent-id'] || req.body.agentId;
  
  const task = tasks.get(taskId);
  
  if (!task) {
    return res.status(404).json({ success: false, error: 'Task not found' });
  }
  
  if (task.claimedBy !== agentId) {
    return res.status(403).json({ success: false, error: 'Task not claimed by this agent' });
  }
  
  task.status = 'in_progress';
  task.startedAt = new Date().toISOString();
  tasks.set(taskId, task);
  
  res.json({
    success: true,
    message: 'Task started',
    task: { id: taskId, status: 'in_progress' }
  });
});

/**
 * POST /tasks/:taskId/complete
 * Mark task as completed and pay bounty if applicable
 */
router.post('/:taskId/complete', async (req, res) => {
  const { taskId } = req.params;
  const agentId = req.headers['x-agent-id'] || req.body.agentId;
  const { result } = req.body;
  
  const task = tasks.get(taskId);
  
  if (!task) {
    return res.status(404).json({ success: false, error: 'Task not found' });
  }
  
  if (task.claimedBy !== agentId) {
    return res.status(403).json({ success: false, error: 'Task not claimed by this agent' });
  }
  
  task.status = 'completed';
  task.completedAt = new Date().toISOString();
  task.result = result || null;
  
  // Update agent stats
  const agent = agents.get(agentId);
  if (agent) {
    agent.tasksCompleted = (agent.tasksCompleted || 0) + 1;
    agent.reputation = Math.min(1000, agent.reputation + 5);
  }
  
  // Pay bounty if task has one and agent has a wallet
  let bountyResult = null;
  if (task.bounty_hbar > 0) {
    if (agent && agent.hedera_wallet) {
      bountyResult = await hedera.payBounty(
        agent.hedera_wallet,
        task.bounty_hbar,
        `ClawSwarm:${taskId}`
      );
      
      if (bountyResult.success) {
        task.bounty_paid = true;
        task.bounty_tx = bountyResult.transactionId;
        agent.totalEarnings = (agent.totalEarnings || 0) + task.bounty_hbar;
        console.log(`💰 Bounty paid: ${task.bounty_hbar} HBAR to ${agent.name} (${agent.hedera_wallet})`);
      } else {
        console.log(`⚠️ Bounty payment failed: ${bountyResult.error}`);
      }
    } else {
      bountyResult = {
        success: false,
        error: 'Agent has no Hedera wallet configured',
        bounty_hbar: task.bounty_hbar
      };
      console.log(`⚠️ Bounty pending: Agent ${agentId} has no wallet`);
    }
  }
  
  if (agent) agents.set(agentId, agent);
  tasks.set(taskId, task);
  
  console.log(`✅ Task completed: ${task.title} by ${agentId}`);
  
  res.json({
    success: true,
    message: 'Task completed successfully',
    task: { 
      id: taskId, 
      status: 'completed',
      bounty_hbar: task.bounty_hbar || 0,
      bounty_paid: task.bounty_paid || false,
      bounty_tx: task.bounty_tx || null
    },
    payment: bountyResult
  });
});

/**
 * POST /tasks/:taskId/fail
 * Mark task as failed
 */
router.post('/:taskId/fail', (req, res) => {
  const { taskId } = req.params;
  const agentId = req.headers['x-agent-id'] || req.body.agentId;
  const { reason } = req.body;
  
  const task = tasks.get(taskId);
  
  if (!task) {
    return res.status(404).json({ success: false, error: 'Task not found' });
  }
  
  task.status = 'failed';
  task.failedAt = new Date().toISOString();
  task.failReason = reason || 'Unknown';
  tasks.set(taskId, task);
  
  // Update agent stats
  const agent = agents.get(agentId);
  if (agent && task.claimedBy === agentId) {
    agent.tasksFailed = (agent.tasksFailed || 0) + 1;
    agent.reputation = Math.max(0, agent.reputation - 10);
    agents.set(agentId, agent);
  }
  
  console.log(`❌ Task failed: ${task.title} - ${reason}`);
  
  res.json({
    success: true,
    message: 'Task marked as failed',
    task: { id: taskId, status: 'failed' }
  });
});

/**
 * POST /tasks/route
 * Route a task to the best available agent
 */
router.post('/route', (req, res) => {
  const { 
    task: taskDescription,
    requiredCapabilities,
    preferredAgents,
    autoAssign
  } = req.body;
  
  // Find matching agents
  const matchingAgents = Array.from(agents.values())
    .filter(agent => {
      if (agent.status !== 'online') return false;
      
      if (requiredCapabilities && requiredCapabilities.length > 0) {
        const agentCaps = agent.capabilities.map(c => 
          typeof c === 'string' ? c.toLowerCase() : c.name?.toLowerCase()
        );
        return requiredCapabilities.some(req =>
          agentCaps.some(cap => cap?.includes(req.toLowerCase()))
        );
      }
      
      return true;
    })
    .sort((a, b) => b.reputation - a.reputation); // Best reputation first
  
  // Check preferred agents first
  if (preferredAgents && preferredAgents.length > 0) {
    const preferred = matchingAgents.filter(a => 
      preferredAgents.includes(a.id) || preferredAgents.includes(a.name)
    );
    if (preferred.length > 0) {
      matchingAgents.unshift(...preferred.filter(p => !matchingAgents.includes(p)));
    }
  }
  
  if (matchingAgents.length === 0) {
    return res.status(404).json({
      success: false,
      error: 'No matching agents available',
      suggestion: 'Try again later or reduce requirements'
    });
  }
  
  const bestMatch = matchingAgents[0];
  
  res.json({
    success: true,
    routing: {
      recommendedAgent: {
        id: bestMatch.id,
        name: bestMatch.name,
        url: bestMatch.url,
        reputation: bestMatch.reputation
      },
      alternatives: matchingAgents.slice(1, 4).map(a => ({
        id: a.id,
        name: a.name,
        reputation: a.reputation
      })),
      totalMatches: matchingAgents.length
    }
  });
});

module.exports = router;
module.exports.tasks = tasks;

/**
 * POST /tasks/:taskId/escrow
 * Create escrow for a bounty task
 */
router.post("/:taskId/escrow", (req, res) => {
  const { taskId } = req.params;
  const { amount_hbar, deadline } = req.body;
  const posterId = req.headers["x-agent-id"];

  if (!posterId) {
    return res.status(401).json({ success: false, error: "Agent ID required" });
  }

  const task = tasks.get(taskId);
  if (!task) {
    return res.status(404).json({ success: false, error: "Task not found" });
  }

  if (task.createdBy !== posterId) {
    return res.status(403).json({ success: false, error: "Only task creator can escrow" });
  }

  try {
    const amount = amount_hbar || task.bounty_hbar;
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, error: "Bounty amount required" });
    }

    const escrowRecord = escrow.create(taskId, posterId, amount, deadline);
    task.bounty_hbar = amount;
    task.escrow_state = escrowRecord.state;

    res.json({
      success: true,
      message: "Escrow created",
      escrow: escrowRecord,
      next_step: "Deposit HBAR to treasury and call POST /tasks/:id/deposit with transaction ID"
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /tasks/:taskId/deposit
 * Record HBAR deposit to escrow
 */
router.post("/:taskId/deposit", (req, res) => {
  const { taskId } = req.params;
  const { transaction_id } = req.body;
  const posterId = req.headers["x-agent-id"];

  if (!transaction_id) {
    return res.status(400).json({ success: false, error: "Transaction ID required" });
  }

  try {
    const escrowRecord = escrow.recordDeposit(taskId, transaction_id);
    const task = tasks.get(taskId);
    if (task) task.escrow_state = escrowRecord.state;

    res.json({
      success: true,
      message: "Deposit recorded - task now available for claim",
      escrow: escrowRecord
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /tasks/:taskId/submit-work
 * Agent submits proof of completed work
 */
router.post("/:taskId/submit-work", (req, res) => {
  const { taskId } = req.params;
  const { proof_hash, result } = req.body;
  const agentId = req.headers["x-agent-id"];

  if (!agentId) {
    return res.status(401).json({ success: false, error: "Agent ID required" });
  }

  if (!proof_hash) {
    return res.status(400).json({ success: false, error: "Proof hash required" });
  }

  try {
    const escrowRecord = escrow.submit(taskId, agentId, proof_hash);
    
    const task = tasks.get(taskId);
    if (task) {
      task.status = "submitted";
      task.result = result || null;
      task.escrow_state = escrowRecord.state;
    }

    res.json({
      success: true,
      message: "Work submitted - awaiting approval",
      escrow: escrowRecord
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /tasks/:taskId/release
 * Release escrowed funds to agent
 */
router.post("/:taskId/release", async (req, res) => {
  const { taskId } = req.params;
  const { transaction_id } = req.body;
  const posterId = req.headers["x-agent-id"];

  if (!posterId) {
    return res.status(401).json({ success: false, error: "Agent ID required" });
  }

  try {
    const escrowRecord = escrow.release(taskId, posterId, transaction_id);
    
    const task = tasks.get(taskId);
    if (task) {
      task.status = "completed";
      task.completedAt = new Date().toISOString();
      task.bounty_paid = true;
      task.bounty_tx = transaction_id;
      task.escrow_state = escrowRecord.state;
    }

    res.json({
      success: true,
      message: "Funds released to agent",
      escrow: escrowRecord,
      agent_wallet: escrowRecord.agentWallet,
      amount_hbar: escrowRecord.amountHbar
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * POST /tasks/:taskId/dispute
 * Open a dispute on submitted work
 */
router.post("/:taskId/dispute", (req, res) => {
  const { taskId } = req.params;
  const { reason } = req.body;
  const disputerId = req.headers["x-agent-id"];

  if (!disputerId) {
    return res.status(401).json({ success: false, error: "Agent ID required" });
  }

  if (!reason) {
    return res.status(400).json({ success: false, error: "Dispute reason required" });
  }

  try {
    const escrowRecord = escrow.dispute(taskId, disputerId, reason);
    
    const task = tasks.get(taskId);
    if (task) {
      task.status = "disputed";
      task.escrow_state = escrowRecord.state;
    }

    res.json({
      success: true,
      message: "Dispute opened - awaiting arbitration",
      escrow: escrowRecord
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * GET /tasks/:taskId/escrow
 * Get escrow status for a task
 */
router.get("/:taskId/escrow", (req, res) => {
  const { taskId } = req.params;
  
  const escrowRecord = escrow.get(taskId);
  
  if (!escrowRecord) {
    return res.json({
      success: true,
      has_escrow: false
    });
  }

  res.json({
    success: true,
    has_escrow: true,
    escrow: escrowRecord
  });
});
