/**
 * tasks.js - Task Management Service
 * ClawSwarm - Phase 3: Agent Collaboration
 * 
 * Enables agents to post tasks, claim them, and complete for reputation
 */

const crypto = require('crypto');
const persistence = require('./db');
let reputation;
try {
  reputation = require('./reputation');
} catch (e) {
  console.log('Reputation service not available');
}

// Task statuses
const STATUS = {
  OPEN: 'open',
  CLAIMED: 'claimed', 
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled'
};

/**
 * Initialize tasks table
 */
async function initialize() {
  const db = await persistence.getDb();
  
  if (persistence.isPostgres) {
    await db.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        required_capabilities JSONB DEFAULT '[]',
        bounty_hbar REAL DEFAULT 0,
        escrow_tx TEXT,
        status TEXT DEFAULT 'open',
        claimant_id TEXT,
        claimed_at TIMESTAMP,
        submission TEXT,
        submitted_at TIMESTAMP,
        result TEXT,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        required_capabilities TEXT DEFAULT '[]',
        bounty_hbar REAL DEFAULT 0,
        escrow_tx TEXT,
        status TEXT DEFAULT 'open',
        claimant_id TEXT,
        claimed_at TEXT,
        submission TEXT,
        submitted_at TEXT,
        result TEXT,
        completed_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }
  
  console.log('📋 Tasks table initialized');
}

/**
 * Generate task ID
 */
function generateId() {
  return 'task_' + crypto.randomBytes(8).toString('hex');
}

/**
 * Create a new task
 */
async function createTask(creatorId, { title, description, requiredCapabilities = [], bountyHbar = 0 }) {
  const db = await persistence.getDb();
  const id = generateId();
  const now = new Date().toISOString();
  
  const task = {
    id,
    creator_id: creatorId,
    title,
    description: description || '',
    required_capabilities: requiredCapabilities,
    bounty_hbar: bountyHbar,
    status: STATUS.OPEN,
    created_at: now
  };
  
  if (persistence.isPostgres) {
    await db.query(`
      INSERT INTO tasks (id, creator_id, title, description, required_capabilities, bounty_hbar, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [id, creatorId, title, task.description, JSON.stringify(requiredCapabilities), bountyHbar, STATUS.OPEN, now]);
  } else {
    db.prepare(`
      INSERT INTO tasks (id, creator_id, title, description, required_capabilities, bounty_hbar, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, creatorId, title, task.description, JSON.stringify(requiredCapabilities), bountyHbar, STATUS.OPEN, now);
  }
  
  console.log(`📋 Task created: ${title} (${id}) by ${creatorId}`);
  return task;
}

/**
 * Get task by ID
 */
async function getTask(taskId) {
  const db = await persistence.getDb();
  let task;
  
  if (persistence.isPostgres) {
    const result = await db.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
    task = result.rows[0];
  } else {
    task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  }
  
  if (task && typeof task.required_capabilities === 'string') {
    task.required_capabilities = JSON.parse(task.required_capabilities);
  }
  
  return task;
}

/**
 * List tasks with filters
 */
async function listTasks({ status, capability, creatorId, claimantId, limit = 50 } = {}) {
  const db = await persistence.getDb();
  let tasks;
  
  // Build query based on filters
  let where = [];
  let params = [];
  let paramIndex = 1;
  
  if (status) {
    where.push(persistence.isPostgres ? `status = $${paramIndex++}` : 'status = ?');
    params.push(status);
  }
  if (creatorId) {
    where.push(persistence.isPostgres ? `creator_id = $${paramIndex++}` : 'creator_id = ?');
    params.push(creatorId);
  }
  if (claimantId) {
    where.push(persistence.isPostgres ? `claimant_id = $${paramIndex++}` : 'claimant_id = ?');
    params.push(claimantId);
  }
  
  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const limitClause = persistence.isPostgres ? `LIMIT $${paramIndex}` : 'LIMIT ?';
  params.push(limit);
  
  const query = `SELECT * FROM tasks ${whereClause} ORDER BY created_at DESC ${limitClause}`;
  
  if (persistence.isPostgres) {
    const result = await db.query(query, params);
    tasks = result.rows;
  } else {
    tasks = db.prepare(query).all(...params);
  }
  
  // Parse JSON fields
  return tasks.map(t => ({
    ...t,
    required_capabilities: typeof t.required_capabilities === 'string' 
      ? JSON.parse(t.required_capabilities) 
      : t.required_capabilities
  }));
}

/**
 * Claim a task
 */
async function claimTask(taskId, claimantId) {
  const task = await getTask(taskId);
  
  if (!task) throw new Error('Task not found');
  if (task.status !== STATUS.OPEN) throw new Error(`Task is ${task.status}, cannot claim`);
  if (task.creator_id === claimantId) throw new Error('Cannot claim your own task');
  
  const db = await persistence.getDb();
  const now = new Date().toISOString();
  
  if (persistence.isPostgres) {
    await db.query(`
      UPDATE tasks SET status = $1, claimant_id = $2, claimed_at = $3 WHERE id = $4
    `, [STATUS.CLAIMED, claimantId, now, taskId]);
  } else {
    db.prepare(`
      UPDATE tasks SET status = ?, claimant_id = ?, claimed_at = ? WHERE id = ?
    `).run(STATUS.CLAIMED, claimantId, now, taskId);
  }
  
  console.log(`📋 Task claimed: ${taskId} by ${claimantId}`);
  return { ...task, status: STATUS.CLAIMED, claimant_id: claimantId, claimed_at: now };
}

/**
 * Submit work for a task
 */
async function submitTask(taskId, claimantId, submission) {
  const task = await getTask(taskId);
  
  if (!task) throw new Error('Task not found');
  if (task.status !== STATUS.CLAIMED) throw new Error(`Task is ${task.status}, cannot submit`);
  if (task.claimant_id !== claimantId) throw new Error('Only the claimant can submit');
  
  const db = await persistence.getDb();
  const now = new Date().toISOString();
  
  if (persistence.isPostgres) {
    await db.query(`
      UPDATE tasks SET status = $1, submission = $2, submitted_at = $3 WHERE id = $4
    `, [STATUS.SUBMITTED, submission, now, taskId]);
  } else {
    db.prepare(`
      UPDATE tasks SET status = ?, submission = ?, submitted_at = ? WHERE id = ?
    `).run(STATUS.SUBMITTED, submission, now, taskId);
  }
  
  console.log(`📋 Task submitted: ${taskId}`);
  return { ...task, status: STATUS.SUBMITTED, submission, submitted_at: now };
}

/**
 * Approve task submission
 */
async function approveTask(taskId, creatorId, result = '') {
  const task = await getTask(taskId);
  
  if (!task) throw new Error('Task not found');
  if (task.status !== STATUS.SUBMITTED) throw new Error(`Task is ${task.status}, cannot approve`);
  if (task.creator_id !== creatorId) throw new Error('Only the creator can approve');
  
  const db = await persistence.getDb();
  const now = new Date().toISOString();
  
  if (persistence.isPostgres) {
    await db.query(`
      UPDATE tasks SET status = $1, result = $2, completed_at = $3 WHERE id = $4
    `, [STATUS.APPROVED, result, now, taskId]);
  } else {
    db.prepare(`
      UPDATE tasks SET status = ?, result = ?, completed_at = ? WHERE id = ?
    `).run(STATUS.APPROVED, result, now, taskId);
  }
  
  // Update reputation for claimant
  if (reputation) {
    try {
      // Determine domain from task capabilities or default to 'ops'
      const domain = task.required_capabilities?.[0] || 'ops';
      const validDomains = ['code', 'research', 'creative', 'ops', 'review'];
      const repDomain = validDomains.includes(domain) ? domain : 'ops';
      
      await reputation.recordTaskComplete(task.claimant_id, repDomain, 'medium');
      console.log(`⭐ Reputation +15 for ${task.claimant_id} in ${repDomain}`);
    } catch (e) {
      console.log('Reputation update failed:', e.message);
    }
  }
  
  // TODO: Release HBAR escrow if applicable
  
  console.log(`📋 Task approved: ${taskId}`);
  return { ...task, status: STATUS.APPROVED, result, completed_at: now };
}

/**
 * Reject task submission
 */
async function rejectTask(taskId, creatorId, reason = '') {
  const task = await getTask(taskId);
  
  if (!task) throw new Error('Task not found');
  if (task.status !== STATUS.SUBMITTED) throw new Error(`Task is ${task.status}, cannot reject`);
  if (task.creator_id !== creatorId) throw new Error('Only the creator can reject');
  
  const db = await persistence.getDb();
  
  // Reset to claimed so claimant can resubmit
  if (persistence.isPostgres) {
    await db.query(`
      UPDATE tasks SET status = $1, submission = NULL, submitted_at = NULL, result = $2 WHERE id = $3
    `, [STATUS.CLAIMED, reason, taskId]);
  } else {
    db.prepare(`
      UPDATE tasks SET status = ?, submission = NULL, submitted_at = NULL, result = ? WHERE id = ?
    `).run(STATUS.CLAIMED, reason, taskId);
  }
  
  console.log(`📋 Task rejected: ${taskId} - ${reason}`);
  return { ...task, status: STATUS.CLAIMED, result: reason };
}

/**
 * Cancel task (creator only, must be open or claimed)
 */
async function cancelTask(taskId, creatorId) {
  const task = await getTask(taskId);
  
  if (!task) throw new Error('Task not found');
  if (![STATUS.OPEN, STATUS.CLAIMED].includes(task.status)) {
    throw new Error(`Task is ${task.status}, cannot cancel`);
  }
  if (task.creator_id !== creatorId) throw new Error('Only the creator can cancel');
  
  const db = await persistence.getDb();
  
  if (persistence.isPostgres) {
    await db.query(`UPDATE tasks SET status = $1 WHERE id = $2`, [STATUS.CANCELLED, taskId]);
  } else {
    db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(STATUS.CANCELLED, taskId);
  }
  
  // TODO: Refund HBAR escrow if applicable
  
  console.log(`📋 Task cancelled: ${taskId}`);
  return { ...task, status: STATUS.CANCELLED };
}

module.exports = {
  STATUS,
  initialize,
  createTask,
  getTask,
  listTasks,
  claimTask,
  submitTask,
  approveTask,
  rejectTask,
  cancelTask
};
