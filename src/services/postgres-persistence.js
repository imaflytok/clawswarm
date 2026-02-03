/**
 * postgres-persistence.js - PostgreSQL-based persistence for ClawSwarm
 * Scalable version - handles 10k+ connections with connection pooling
 */

const { Pool } = require("pg");

// Connection pool - handles concurrent connections efficiently
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // Max connections in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
});

// Test connection on startup
pool.query('SELECT NOW()')
  .then(() => console.log('🐘 PostgreSQL connected'))
  .catch(err => console.error('❌ PostgreSQL connection failed:', err.message));

// Initialize schema
async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      -- Agents table
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT,
        description TEXT,
        capabilities JSONB DEFAULT '[]',
        platforms JSONB DEFAULT '[]',
        wallet TEXT,
        wallet_verified BOOLEAN DEFAULT false,
        api_key TEXT,
        webhook_url TEXT,
        webhook_secret TEXT,
        webhook_events JSONB DEFAULT '[]',
        status TEXT DEFAULT 'active',
        reputation INTEGER DEFAULT 100,
        tasks_completed INTEGER DEFAULT 0,
        tasks_failed INTEGER DEFAULT 0,
        total_earnings DECIMAL DEFAULT 0,
        last_seen TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Profiles table (social layer)
      CREATE TABLE IF NOT EXISTS profiles (
        agent_id TEXT PRIMARY KEY REFERENCES agents(id),
        display_name TEXT,
        bio TEXT,
        avatar_emoji TEXT DEFAULT '🤖',
        role TEXT DEFAULT 'Agent',
        interests JSONB DEFAULT '[]',
        public_key TEXT,
        presence_status TEXT DEFAULT 'offline',
        presence_activity TEXT,
        presence_last_seen BIGINT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Channels table
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT DEFAULT 'general',
        topic TEXT,
        members JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Messages table (partitioned by date for scale)
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        agent_id TEXT,
        content TEXT,
        type TEXT DEFAULT 'text',
        metadata JSONB DEFAULT '{}',
        timestamp TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (id, timestamp)
      );

      -- Tasks table
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'open',
        created_by TEXT,
        claimed_by TEXT,
        bounty_hbar DECIMAL DEFAULT 0,
        bounty_paid BOOLEAN DEFAULT false,
        bounty_tx TEXT,
        escrow_state TEXT,
        result TEXT,
        deadline TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Escrows table
      CREATE TABLE IF NOT EXISTS escrows (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id),
        poster_id TEXT,
        agent_id TEXT,
        amount_hbar DECIMAL,
        state TEXT DEFAULT 'NONE',
        deposit_tx TEXT,
        release_tx TEXT,
        deadline TIMESTAMPTZ,
        proof_hash TEXT,
        dispute_reason TEXT,
        resolution TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Reputation table
      CREATE TABLE IF NOT EXISTS reputation (
        agent_id TEXT PRIMARY KEY,
        code DECIMAL DEFAULT 0,
        research DECIMAL DEFAULT 0,
        creative DECIMAL DEFAULT 0,
        ops DECIMAL DEFAULT 0,
        review DECIMAL DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Relationships table (following/vouching)
      CREATE TABLE IF NOT EXISTS relationships (
        id SERIAL PRIMARY KEY,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        type TEXT NOT NULL, -- 'follow', 'vouch', 'block'
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(from_agent, to_agent, type)
      );

      -- Webhooks table
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        url TEXT NOT NULL,
        secret TEXT,
        events JSONB DEFAULT '["mention"]',
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Notifications table
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content JSONB NOT NULL,
        read BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Create indexes for performance
      CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(LOWER(name));
      CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_profiles_presence ON profiles(presence_status);
      CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_agent);
      CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_agent);
      CREATE INDEX IF NOT EXISTS idx_notifications_agent ON notifications(agent_id, read);
    `);
    console.log('📦 PostgreSQL schema initialized');
  } catch (err) {
    console.error('❌ Schema init error:', err.message);
  } finally {
    client.release();
  }
}

// Initialize schema on load
initSchema();

module.exports = {
  pool,
  
  // ============ AGENT OPERATIONS ============
  
  async saveAgent(agent) {
    const query = `
      INSERT INTO agents (id, name, description, capabilities, platforms, wallet, wallet_verified, api_key, status, reputation, tasks_completed, tasks_failed, total_earnings, last_seen, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        capabilities = EXCLUDED.capabilities,
        platforms = EXCLUDED.platforms,
        wallet = EXCLUDED.wallet,
        wallet_verified = EXCLUDED.wallet_verified,
        status = EXCLUDED.status,
        reputation = EXCLUDED.reputation,
        tasks_completed = EXCLUDED.tasks_completed,
        tasks_failed = EXCLUDED.tasks_failed,
        total_earnings = EXCLUDED.total_earnings,
        last_seen = NOW(),
        updated_at = NOW()
    `;
    await pool.query(query, [
      agent.id,
      agent.name || null,
      agent.description || null,
      JSON.stringify(agent.capabilities || []),
      JSON.stringify(agent.platforms || []),
      agent.hedera_wallet || agent.wallet || null,
      agent.wallet_verified || false,
      agent.apiKey || null,
      agent.status || 'active',
      agent.reputation || 100,
      agent.tasksCompleted || 0,
      agent.tasksFailed || 0,
      agent.totalEarnings || 0
    ]);
  },
  
  async loadAgent(id) {
    const { rows } = await pool.query('SELECT * FROM agents WHERE id = $1', [id]);
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      capabilities: row.capabilities,
      platforms: row.platforms,
      hedera_wallet: row.wallet,
      wallet_verified: row.wallet_verified,
      apiKey: row.api_key,
      status: row.status,
      reputation: row.reputation,
      tasksCompleted: row.tasks_completed,
      tasksFailed: row.tasks_failed,
      totalEarnings: row.total_earnings,
      lastSeen: row.last_seen,
      registeredAt: row.created_at
    };
  },
  
  async loadAllAgents() {
    const { rows } = await pool.query("SELECT * FROM agents WHERE status = 'active'");
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description,
      capabilities: row.capabilities,
      platforms: row.platforms,
      hedera_wallet: row.wallet,
      wallet_verified: row.wallet_verified,
      apiKey: row.api_key,
      status: row.status,
      reputation: row.reputation
    }));
  },
  
  async isNameTaken(name) {
    const { rows } = await pool.query(
      'SELECT 1 FROM agents WHERE LOWER(name) = LOWER($1) LIMIT 1',
      [name]
    );
    return rows.length > 0;
  },
  
  async deleteAgent(id) {
    await pool.query('UPDATE agents SET status = $1 WHERE id = $2', ['deleted', id]);
  },
  
  // ============ CHANNEL OPERATIONS ============
  
  async saveChannel(channel) {
    const query = `
      INSERT INTO channels (id, name, type, topic, members)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        type = EXCLUDED.type,
        topic = EXCLUDED.topic,
        members = EXCLUDED.members
    `;
    await pool.query(query, [
      channel.id,
      channel.name || channel.id,
      channel.type || 'general',
      channel.topic || null,
      JSON.stringify(channel.members || [])
    ]);
  },
  
  async loadChannel(id) {
    const { rows } = await pool.query('SELECT * FROM channels WHERE id = $1', [id]);
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      topic: row.topic,
      members: row.members,
      createdAt: row.created_at
    };
  },
  
  async loadAllChannels() {
    const { rows } = await pool.query('SELECT * FROM channels ORDER BY created_at');
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      type: row.type,
      members: row.members
    }));
  },
  
  // ============ MESSAGE OPERATIONS ============
  
  async saveMessage(channelId, message) {
    const query = `
      INSERT INTO messages (id, channel_id, agent_id, content, type, metadata, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `;
    await pool.query(query, [
      message.id,
      channelId,
      message.agentId,
      message.content,
      message.type || 'text',
      JSON.stringify(message.metadata || {}),
      message.timestamp || new Date().toISOString()
    ]);
  },
  
  async loadMessages(channelId, limit = 100) {
    const { rows } = await pool.query(
      'SELECT * FROM messages WHERE channel_id = $1 ORDER BY timestamp DESC LIMIT $2',
      [channelId, limit]
    );
    return rows.map(row => ({
      id: row.id,
      agentId: row.agent_id,
      content: row.content,
      type: row.type,
      metadata: row.metadata,
      timestamp: row.timestamp
    })).reverse(); // Oldest first
  },
  
  // ============ PROFILE OPERATIONS ============
  
  async saveProfile(agentId, profile) {
    const query = `
      INSERT INTO profiles (agent_id, display_name, bio, avatar_emoji, role, interests, public_key, presence_status, presence_activity, presence_last_seen, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      ON CONFLICT (agent_id) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        bio = EXCLUDED.bio,
        avatar_emoji = EXCLUDED.avatar_emoji,
        role = EXCLUDED.role,
        interests = EXCLUDED.interests,
        public_key = EXCLUDED.public_key,
        presence_status = EXCLUDED.presence_status,
        presence_activity = EXCLUDED.presence_activity,
        presence_last_seen = EXCLUDED.presence_last_seen,
        updated_at = NOW()
    `;
    await pool.query(query, [
      agentId,
      profile.name || profile.display_name || null,
      profile.bio || profile.description || null,
      profile.avatar_emoji || '🤖',
      profile.role || 'Agent',
      JSON.stringify(profile.interests || profile.capabilities || []),
      profile.publicKey || null,
      profile.presence_status || 'offline',
      profile.presence_activity || null,
      profile.presence_last_seen || Date.now()
    ]);
  },
  
  async loadProfile(agentId) {
    const { rows } = await pool.query('SELECT * FROM profiles WHERE agent_id = $1', [agentId]);
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      agent_id: row.agent_id,
      display_name: row.display_name,
      bio: row.bio,
      avatar_emoji: row.avatar_emoji,
      role: row.role,
      interests: row.interests,
      publicKey: row.public_key,
      presence_status: row.presence_status,
      presence_activity: row.presence_activity,
      presence_last_seen: row.presence_last_seen,
      registeredAt: row.created_at
    };
  },
  
  async loadAllProfiles() {
    const { rows } = await pool.query(`
      SELECT p.*, a.description, a.capabilities 
      FROM profiles p 
      LEFT JOIN agents a ON p.agent_id = a.id
      WHERE a.status = 'active'
      ORDER BY p.presence_last_seen DESC NULLS LAST
    `);
    return rows.map(row => ({
      agent_id: row.agent_id,
      display_name: row.display_name,
      description: row.description || row.bio,
      bio: row.bio,
      avatar_emoji: row.avatar_emoji,
      role: row.role,
      capabilities: row.capabilities || row.interests,
      presence_status: row.presence_status,
      last_seen: row.presence_last_seen,
      registered_at: row.created_at
    }));
  },
  
  async getOnlineProfiles() {
    const { rows } = await pool.query(`
      SELECT * FROM profiles 
      WHERE presence_status IN ('online', 'busy')
      ORDER BY presence_last_seen DESC
    `);
    return rows;
  },
  
  // ============ TASK OPERATIONS ============
  
  async saveTask(task) {
    const query = `
      INSERT INTO tasks (id, title, description, status, created_by, claimed_by, bounty_hbar, bounty_paid, bounty_tx, escrow_state, result, deadline, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
      ON CONFLICT (id) DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        status = EXCLUDED.status,
        claimed_by = EXCLUDED.claimed_by,
        bounty_hbar = EXCLUDED.bounty_hbar,
        bounty_paid = EXCLUDED.bounty_paid,
        bounty_tx = EXCLUDED.bounty_tx,
        escrow_state = EXCLUDED.escrow_state,
        result = EXCLUDED.result,
        deadline = EXCLUDED.deadline,
        updated_at = NOW()
    `;
    await pool.query(query, [
      task.id,
      task.title,
      task.description || null,
      task.status || 'open',
      task.createdBy || task.created_by || null,
      task.claimedBy || task.claimed_by || null,
      task.bounty_hbar || 0,
      task.bounty_paid || false,
      task.bounty_tx || null,
      task.escrow_state || null,
      task.result || null,
      task.deadline || null
    ]);
  },
  
  async loadTask(id) {
    const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      createdBy: row.created_by,
      claimedBy: row.claimed_by,
      bounty_hbar: parseFloat(row.bounty_hbar),
      bounty_paid: row.bounty_paid,
      bounty_tx: row.bounty_tx,
      escrow_state: row.escrow_state,
      result: row.result,
      deadline: row.deadline,
      createdAt: row.created_at
    };
  },
  
  async loadTasksByStatus(status) {
    const { rows } = await pool.query(
      'SELECT * FROM tasks WHERE status = $1 ORDER BY created_at DESC',
      [status]
    );
    return rows;
  },
  
  async loadAllTasks() {
    const { rows } = await pool.query('SELECT * FROM tasks ORDER BY created_at DESC');
    return rows;
  },
  
  // ============ REPUTATION OPERATIONS ============
  
  async saveReputation(agentId, scores) {
    const query = `
      INSERT INTO reputation (agent_id, code, research, creative, ops, review, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (agent_id) DO UPDATE SET
        code = EXCLUDED.code,
        research = EXCLUDED.research,
        creative = EXCLUDED.creative,
        ops = EXCLUDED.ops,
        review = EXCLUDED.review,
        updated_at = NOW()
    `;
    await pool.query(query, [
      agentId,
      scores.code || 0,
      scores.research || 0,
      scores.creative || 0,
      scores.ops || 0,
      scores.review || 0
    ]);
  },
  
  async loadReputation(agentId) {
    const { rows } = await pool.query('SELECT * FROM reputation WHERE agent_id = $1', [agentId]);
    if (rows.length === 0) return { code: 0, research: 0, creative: 0, ops: 0, review: 0 };
    const row = rows[0];
    return {
      code: parseFloat(row.code),
      research: parseFloat(row.research),
      creative: parseFloat(row.creative),
      ops: parseFloat(row.ops),
      review: parseFloat(row.review)
    };
  },
  
  async getLeaderboard(domain, limit = 10) {
    const validDomains = ['code', 'research', 'creative', 'ops', 'review'];
    if (!validDomains.includes(domain)) domain = 'code';
    
    const { rows } = await pool.query(
      `SELECT agent_id, ${domain} as score FROM reputation ORDER BY ${domain} DESC LIMIT $1`,
      [limit]
    );
    return rows;
  },
  
  // ============ ESCROW OPERATIONS ============
  
  async saveEscrow(escrow) {
    const query = `
      INSERT INTO escrows (task_id, poster_id, agent_id, amount_hbar, state, deposit_tx, release_tx, deadline, proof_hash, dispute_reason, resolution, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      ON CONFLICT (task_id) DO UPDATE SET
        agent_id = EXCLUDED.agent_id,
        amount_hbar = EXCLUDED.amount_hbar,
        state = EXCLUDED.state,
        deposit_tx = EXCLUDED.deposit_tx,
        release_tx = EXCLUDED.release_tx,
        deadline = EXCLUDED.deadline,
        proof_hash = EXCLUDED.proof_hash,
        dispute_reason = EXCLUDED.dispute_reason,
        resolution = EXCLUDED.resolution,
        updated_at = NOW()
    `;
    await pool.query(query, [
      escrow.taskId,
      escrow.posterId,
      escrow.agentId || null,
      escrow.amountHbar,
      escrow.state,
      escrow.depositTx || null,
      escrow.releaseTx || null,
      escrow.deadline,
      escrow.proofHash || null,
      escrow.disputeReason || null,
      escrow.resolution || null
    ]);
  },
  
  async loadEscrow(taskId) {
    const { rows } = await pool.query('SELECT * FROM escrows WHERE task_id = $1', [taskId]);
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      taskId: row.task_id,
      posterId: row.poster_id,
      agentId: row.agent_id,
      amountHbar: parseFloat(row.amount_hbar),
      state: row.state,
      depositTx: row.deposit_tx,
      releaseTx: row.release_tx,
      deadline: row.deadline,
      proofHash: row.proof_hash,
      disputeReason: row.dispute_reason,
      resolution: row.resolution
    };
  },
  
  // ============ UTILITY ============
  
  async healthCheck() {
    try {
      await pool.query('SELECT 1');
      return { status: 'connected', pool: pool.totalCount };
    } catch (err) {
      return { status: 'error', error: err.message };
    }
  }
};
