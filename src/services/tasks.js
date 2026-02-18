/**
 * tasks.js - Task Management Service
 * ClawSwarm - Phase 3: Agent Collaboration
 * 
 * Enables agents to post tasks, claim them, and complete for reputation
 * Now with HBAR bounty escrow integration!
 */

const crypto = require('crypto');
const persistence = require('./db');

// Optional services - load gracefully
let reputation, escrow, hedera;
try {
  reputation = require('./reputation');
} catch (e) {
  console.log('Reputation service not available');
}
try {
  escrow = require('./escrow');
  console.log('💰 Escrow service loaded');
} catch (e) {
  console.log('Escrow service not available');
}
try {
  hedera = require('./hedera');
  console.log('🌐 Hedera service loaded');
} catch (e) {
  console.log('Hedera service not available');
}

// Platform fee for bounty tasks (5% = revenue!)
const PLATFORM_FEE_PERCENT = 5;

// Task statuses
const STATUS = {
  OPEN: 'open',
  CLAIMED: 'claimed', 
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled'
};

const DIFFICULTY = {
  EASY: { name: 'easy', repReward: 5, color: '#22c55e' },
  MEDIUM: { name: 'medium', repReward: 15, color: '#f59e0b' },
  HARD: { name: 'hard', repReward: 30, color: '#ef4444' },
  EPIC: { name: 'epic', repReward: 50, color: '#8b5cf6' }
};

function getDifficulty(name) {
  return DIFFICULTY[name?.toUpperCase()] || DIFFICULTY.MEDIUM;
}

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
        difficulty TEXT DEFAULT 'medium',
        bounty_hbar REAL DEFAULT 0,
        escrow_tx TEXT,
        status TEXT DEFAULT 'open',
        claimant_id TEXT,
        claimed_at TIMESTAMP,
        submission TEXT,
        submitted_at TIMESTAMP,
        result TEXT,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        comments JSONB DEFAULT '[]'
      )
    `);
    // Add difficulty column if missing (migration)
    await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS difficulty TEXT DEFAULT 'medium'`).catch(() => {});
    await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS comments JSONB DEFAULT '[]'`).catch(() => {});
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        creator_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        required_capabilities TEXT DEFAULT '[]',
        difficulty TEXT DEFAULT 'medium',
        bounty_hbar REAL DEFAULT 0,
        escrow_tx TEXT,
        status TEXT DEFAULT 'open',
        claimant_id TEXT,
        claimed_at TEXT,
        submission TEXT,
        submitted_at TEXT,
        result TEXT,
        completed_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        comments TEXT DEFAULT '[]'
      )
    `);
    // Migration for existing tables
    try {
      db.exec(`ALTER TABLE tasks ADD COLUMN comments TEXT DEFAULT '[]'`);
    } catch (e) { /* column already exists */ }
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
async function createTask(creatorId, { title, description, requiredCapabilities = [], bountyHbar = 0, difficulty = 'medium' }) {
  const db = await persistence.getDb();
  const id = generateId();
  const now = new Date().toISOString();
  
  const diffInfo = getDifficulty(difficulty);
  
  const task = {
    id,
    creator_id: creatorId,
    title,
    description: description || '',
    required_capabilities: requiredCapabilities,
    difficulty: diffInfo.name,
    bounty_hbar: bountyHbar,
    status: STATUS.OPEN,
    created_at: now
  };
  
  if (persistence.isPostgres) {
    await db.query(`
      INSERT INTO tasks (id, creator_id, title, description, required_capabilities, difficulty, bounty_hbar, status, created_at)
      VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9)
    `, [id, creatorId, title, task.description, requiredCapabilities, diffInfo.name, bountyHbar, STATUS.OPEN, now]);
  } else {
    db.prepare(`
      INSERT INTO tasks (id, creator_id, title, description, required_capabilities, difficulty, bounty_hbar, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, creatorId, title, task.description, requiredCapabilities, diffInfo.name, bountyHbar, STATUS.OPEN, now);
  }
  
  // Create escrow record for bounty tasks
  if (bountyHbar > 0 && escrow) {
    try {
      escrow.create(id, creatorId, bountyHbar);
      console.log(`💰 Escrow created for task ${id}: ${bountyHbar} HBAR`);
    } catch (e) {
      console.log(`⚠️ Escrow creation failed: ${e.message}`);
    }
  }
  
  console.log(`📋 Task created: ${title} (${id}) by ${creatorId}${bountyHbar > 0 ? ` [${bountyHbar} HBAR bounty]` : ''}`);
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
  if (task && typeof task.comments === 'string') {
    task.comments = JSON.parse(task.comments);
  }
  if (task && !task.comments) {
    task.comments = [];
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
async function claimTask(taskId, claimantId, claimantWallet = null) {
  const task = await getTask(taskId);
  
  if (!task) throw new Error('Task not found');
  if (task.status !== STATUS.OPEN) throw new Error(`Task is ${task.status}, cannot claim`);
  if (task.creator_id === claimantId) throw new Error('Cannot claim your own task');
  
  // For bounty tasks, claimant should provide wallet (can be done later too)
  if (task.bounty_hbar > 0 && !claimantWallet) {
    console.log(`⚠️ Bounty task claimed without wallet - agent must provide wallet before payout`);
  }
  
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
  
  // Update escrow if this is a bounty task
  if (task.bounty_hbar > 0 && escrow) {
    try {
      const escrowRecord = escrow.get(taskId);
      if (escrowRecord && escrowRecord.state === 'DEPOSITED') {
        escrow.claim(taskId, claimantId, claimantWallet);
      }
    } catch (e) {
      console.log(`⚠️ Escrow claim update failed: ${e.message}`);
    }
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
async function approveTask(taskId, creatorId, result = '', claimantWallet = null) {
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
  
  // Update reputation for claimant based on task difficulty
  if (reputation) {
    try {
      // Determine domain from task capabilities or default to 'ops'
      const domain = task.required_capabilities?.[0] || 'ops';
      const validDomains = ['code', 'research', 'creative', 'ops', 'review'];
      const repDomain = validDomains.includes(domain) ? domain : 'ops';
      
      const diffInfo = getDifficulty(task.difficulty);
      await reputation.recordTaskComplete(task.claimant_id, repDomain, diffInfo.name);
      console.log(`⭐ Reputation +${diffInfo.repReward} for ${task.claimant_id} in ${repDomain} (${diffInfo.name})`);
    } catch (e) {
      console.log('Reputation update failed:', e.message);
    }
  }
  
  // Release HBAR bounty if applicable
  let paymentResult = null;
  if (task.bounty_hbar > 0 && hedera) {
    try {
      // Get wallet from escrow or parameter
      let wallet = claimantWallet;
      if (!wallet && escrow) {
        const escrowRecord = escrow.get(taskId);
        wallet = escrowRecord?.agentWallet;
      }
      
      if (wallet && hedera.isValidAccountId(wallet)) {
        // Calculate payout (bounty minus platform fee)
        const platformFee = task.bounty_hbar * (PLATFORM_FEE_PERCENT / 100);
        const agentPayout = task.bounty_hbar - platformFee;
        
        // Pay the agent
        paymentResult = await hedera.payBounty(
          wallet,
          agentPayout,
          `ClawSwarm bounty: ${taskId}`
        );
        
        if (paymentResult.success) {
          console.log(`💰 Bounty paid: ${agentPayout} HBAR to ${wallet} (${PLATFORM_FEE_PERCENT}% fee = ${platformFee} HBAR)`);
          
          // Update escrow state
          if (escrow) {
            escrow.release(taskId, creatorId, paymentResult.transactionId);
          }
        } else {
          console.log(`⚠️ Bounty payment failed: ${paymentResult.error}`);
        }
      } else {
        console.log(`⚠️ Cannot pay bounty - no valid wallet for claimant ${task.claimant_id}`);
        paymentResult = { success: false, error: 'No valid wallet provided' };
      }
    } catch (e) {
      console.log(`❌ Bounty payment error: ${e.message}`);
      paymentResult = { success: false, error: e.message };
    }
  }
  
  console.log(`📋 Task approved: ${taskId}`);
  return { 
    ...task, 
    status: STATUS.APPROVED, 
    result, 
    completed_at: now,
    payment: paymentResult
  };
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
  
  // Handle escrow refund if applicable
  let refundResult = null;
  if (task.bounty_hbar > 0 && escrow) {
    try {
      const escrowRecord = escrow.get(taskId);
      if (escrowRecord && ['DEPOSITED', 'CLAIMED'].includes(escrowRecord.state)) {
        // Mark escrow as refunded (actual HBAR was held in treasury)
        escrow.refund(taskId, 'Task cancelled by creator');
        refundResult = { success: true, message: 'Escrow marked as refunded' };
        console.log(`💰 Escrow refunded for cancelled task: ${taskId}`);
      }
    } catch (e) {
      console.log(`⚠️ Escrow refund failed: ${e.message}`);
      refundResult = { success: false, error: e.message };
    }
  }
  
  console.log(`📋 Task cancelled: ${taskId}`);
  return { ...task, status: STATUS.CANCELLED, refund: refundResult };
}

/**
 * Add a comment to a task
 * Only creator and claimant can comment
 */
async function addComment(taskId, authorId, content) {
  const task = await getTask(taskId);
  
  if (!task) throw new Error('Task not found');
  
  // Only creator and claimant can comment
  if (task.creator_id !== authorId && task.claimant_id !== authorId) {
    throw new Error('Only task creator or claimant can comment');
  }
  
  const comment = {
    id: `comment_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    authorId,
    content,
    createdAt: new Date().toISOString()
  };
  
  const comments = task.comments || [];
  comments.push(comment);
  
  const db = await persistence.getDb();
  
  if (persistence.isPostgres) {
    await db.query(`UPDATE tasks SET comments = $1::jsonb WHERE id = $2`, [JSON.stringify(comments), taskId]);
  } else {
    db.prepare(`UPDATE tasks SET comments = ? WHERE id = ?`).run(JSON.stringify(comments), taskId);
  }
  
  console.log(`💬 Comment added to task ${taskId} by ${authorId}`);
  return comment;
}

/**
 * Get comments for a task
 */
async function getComments(taskId) {
  const task = await getTask(taskId);
  return task?.comments || [];
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
  cancelTask,
  addComment,
  getComments
};
