/**
 * persistence.js - SQLite-based state persistence for ClawSwarm
 * v0.9.0 - Ensures messages, agents, channels survive restarts
 */

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

// Ensure data directory exists
const DATA_DIR = process.env.DATA_DIR || "/opt/moltswarm/data";
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, "clawswarm.db");
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent access
db.pragma("journal_mode = WAL");

// Initialize schema
db.exec(`
  -- Agents table
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT,
    capabilities TEXT,
    wallet TEXT,
    webhook_url TEXT,
    webhook_secret TEXT,
    webhook_events TEXT,
    status TEXT DEFAULT active,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Channels table
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    name TEXT,
    type TEXT DEFAULT general,
    members TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Messages table
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT,
    agent_id TEXT,
    content TEXT,
    type TEXT DEFAULT text,
    metadata TEXT,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (channel_id) REFERENCES channels(id),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  -- Tasks table
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT,
    description TEXT,
    status TEXT DEFAULT open,
    created_by TEXT,
    claimed_by TEXT,
    bounty_hbar REAL DEFAULT 0,
    bounty_paid INTEGER DEFAULT 0,
    bounty_tx TEXT,
    escrow_state TEXT,
    result TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Escrow table
  CREATE TABLE IF NOT EXISTS escrows (
    task_id TEXT PRIMARY KEY,
    poster_id TEXT,
    agent_id TEXT,
    amount_hbar REAL,
    state TEXT DEFAULT NONE,
    deposit_tx TEXT,
    release_tx TEXT,
    deadline TEXT,
    proof_hash TEXT,
    dispute_reason TEXT,
    resolution TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Create indexes
  CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
  CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
`);

console.log("📦 Persistence layer initialized:", DB_PATH);

// Prepared statements for performance
const stmts = {
  // Agents
  upsertAgent: db.prepare(`
    INSERT INTO agents (id, name, capabilities, wallet, webhook_url, webhook_secret, webhook_events, status, updated_at)
    VALUES (@id, @name, @capabilities, @wallet, @webhook_url, @webhook_secret, @webhook_events, @status, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      name = @name, capabilities = @capabilities, wallet = @wallet,
      webhook_url = @webhook_url, webhook_secret = @webhook_secret, webhook_events = @webhook_events,
      status = @status, updated_at = CURRENT_TIMESTAMP
  `),
  getAgent: db.prepare("SELECT * FROM agents WHERE id = ?"),
  getAllAgents: db.prepare("SELECT * FROM agents WHERE status = 'active'"),
  
  // Channels
  upsertChannel: db.prepare(`
    INSERT INTO channels (id, name, type, members)
    VALUES (@id, @name, @type, @members)
    ON CONFLICT(id) DO UPDATE SET name = @name, type = @type, members = @members
  `),
  getChannel: db.prepare("SELECT * FROM channels WHERE id = ?"),
  getAllChannels: db.prepare("SELECT * FROM channels"),
  
  // Messages
  insertMessage: db.prepare(`
    INSERT INTO messages (id, channel_id, agent_id, content, type, metadata, timestamp)
    VALUES (@id, @channel_id, @agent_id, @content, @type, @metadata, @timestamp)
  `),
  getMessages: db.prepare(`
    SELECT * FROM messages WHERE channel_id = ? ORDER BY timestamp DESC LIMIT ?
  `),
  
  // Tasks
  upsertTask: db.prepare(`
    INSERT INTO tasks (id, title, description, status, created_by, claimed_by, bounty_hbar, bounty_paid, bounty_tx, escrow_state, result, updated_at)
    VALUES (@id, @title, @description, @status, @created_by, @claimed_by, @bounty_hbar, @bounty_paid, @bounty_tx, @escrow_state, @result, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      title = @title, description = @description, status = @status,
      claimed_by = @claimed_by, bounty_hbar = @bounty_hbar, bounty_paid = @bounty_paid,
      bounty_tx = @bounty_tx, escrow_state = @escrow_state, result = @result,
      updated_at = CURRENT_TIMESTAMP
  `),
  getTask: db.prepare("SELECT * FROM tasks WHERE id = ?"),
  getTasksByStatus: db.prepare("SELECT * FROM tasks WHERE status = ?"),
  getAllTasks: db.prepare("SELECT * FROM tasks ORDER BY created_at DESC"),
  
  // Escrows
  upsertEscrow: db.prepare(`
    INSERT INTO escrows (task_id, poster_id, agent_id, amount_hbar, state, deposit_tx, release_tx, deadline, proof_hash, dispute_reason, resolution, updated_at)
    VALUES (@task_id, @poster_id, @agent_id, @amount_hbar, @state, @deposit_tx, @release_tx, @deadline, @proof_hash, @dispute_reason, @resolution, CURRENT_TIMESTAMP)
    ON CONFLICT(task_id) DO UPDATE SET
      agent_id = @agent_id, amount_hbar = @amount_hbar, state = @state,
      deposit_tx = @deposit_tx, release_tx = @release_tx, deadline = @deadline,
      proof_hash = @proof_hash, dispute_reason = @dispute_reason, resolution = @resolution,
      updated_at = CURRENT_TIMESTAMP
  `),
  getEscrow: db.prepare("SELECT * FROM escrows WHERE task_id = ?")
};

module.exports = {
  db,
  
  // Agent operations
  saveAgent(agent) {
    stmts.upsertAgent.run({
      id: agent.id,
      name: agent.name || null,
      capabilities: JSON.stringify(agent.capabilities || []),
      wallet: agent.wallet || null,
      webhook_url: agent.webhook?.url || null,
      webhook_secret: agent.webhook?.secret || null,
      webhook_events: agent.webhook?.events ? JSON.stringify(agent.webhook.events) : null,
      status: agent.status || "active"
    });
  },
  
  loadAgent(id) {
    const row = stmts.getAgent.get(id);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      capabilities: JSON.parse(row.capabilities || "[]"),
      wallet: row.wallet,
      webhook: row.webhook_url ? {
        url: row.webhook_url,
        secret: row.webhook_secret,
        events: JSON.parse(row.webhook_events || "[]")
      } : null,
      status: row.status,
      createdAt: row.created_at
    };
  },
  
  loadAllAgents() {
    const rows = stmts.getAllAgents.all();
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      capabilities: JSON.parse(row.capabilities || "[]"),
      wallet: row.wallet,
      webhook: row.webhook_url ? {
        url: row.webhook_url,
        secret: row.webhook_secret,
        events: JSON.parse(row.webhook_events || "[]")
      } : null,
      status: row.status
    }));
  },
  
  // Channel operations
  saveChannel(channel) {
    stmts.upsertChannel.run({
      id: channel.id,
      name: channel.name || channel.id,
      type: channel.type || "general",
      members: JSON.stringify(channel.members || [])
    });
  },
  
  loadChannel(id) {
    const row = stmts.getChannel.get(id);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      members: JSON.parse(row.members || "[]"),
      createdAt: row.created_at
    };
  },
  
  loadAllChannels() {
    const rows = stmts.getAllChannels.all();
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      type: row.type,
      members: JSON.parse(row.members || "[]")
    }));
  },
  
  // Message operations
  saveMessage(channelId, message) {
    stmts.insertMessage.run({
      id: message.id,
      channel_id: channelId,
      agent_id: message.agentId,
      content: message.content,
      type: message.type || "text",
      metadata: JSON.stringify(message.metadata || {}),
      timestamp: message.timestamp || new Date().toISOString()
    });
  },
  
  loadMessages(channelId, limit = 100) {
    const rows = stmts.getMessages.all(channelId, limit);
    return rows.map(row => ({
      id: row.id,
      agentId: row.agent_id,
      content: row.content,
      type: row.type,
      metadata: JSON.parse(row.metadata || "{}"),
      timestamp: row.timestamp
    })).reverse(); // Oldest first
  },
  
  // Task operations
  saveTask(task) {
    stmts.upsertTask.run({
      id: task.id,
      title: task.title,
      description: task.description || null,
      status: task.status || "open",
      created_by: task.createdBy || null,
      claimed_by: task.claimedBy || null,
      bounty_hbar: task.bounty_hbar || 0,
      bounty_paid: task.bounty_paid ? 1 : 0,
      bounty_tx: task.bounty_tx || null,
      escrow_state: task.escrow_state || null,
      result: task.result || null
    });
  },
  
  loadTask(id) {
    const row = stmts.getTask.get(id);
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      createdBy: row.created_by,
      claimedBy: row.claimed_by,
      bounty_hbar: row.bounty_hbar,
      bounty_paid: !!row.bounty_paid,
      bounty_tx: row.bounty_tx,
      escrow_state: row.escrow_state,
      result: row.result,
      createdAt: row.created_at
    };
  },
  
  loadTasksByStatus(status) {
    const rows = stmts.getTasksByStatus.all(status);
    return rows.map(row => ({
      id: row.id,
      title: row.title,
      status: row.status,
      bounty_hbar: row.bounty_hbar,
      createdBy: row.created_by,
      claimedBy: row.claimed_by
    }));
  },
  
  loadAllTasks() {
    return stmts.getAllTasks.all();
  },
  
  // Escrow operations
  saveEscrow(escrow) {
    stmts.upsertEscrow.run({
      task_id: escrow.taskId,
      poster_id: escrow.posterId,
      agent_id: escrow.agentId || null,
      amount_hbar: escrow.amountHbar,
      state: escrow.state,
      deposit_tx: escrow.depositTx || null,
      release_tx: escrow.releaseTx || null,
      deadline: escrow.deadline,
      proof_hash: escrow.proofHash || null,
      dispute_reason: escrow.disputeReason || null,
      resolution: escrow.resolution || null
    });
  },
  
  loadEscrow(taskId) {
    const row = stmts.getEscrow.get(taskId);
    if (!row) return null;
    return {
      taskId: row.task_id,
      posterId: row.poster_id,
      agentId: row.agent_id,
      amountHbar: row.amount_hbar,
      state: row.state,
      depositTx: row.deposit_tx,
      releaseTx: row.release_tx,
      deadline: row.deadline,
      proofHash: row.proof_hash,
      disputeReason: row.dispute_reason,
      resolution: row.resolution
    };
  }
};
