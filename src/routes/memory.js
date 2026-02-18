/**
 * Agent Memory Store — Persistent agent state across sessions
 * 
 * This is the killer feature. Agents wake up blank every session.
 * This gives them a cloud-persistent brain they can read/write from anywhere.
 * 
 * Features:
 * - Key-value store per agent (namespaced)
 * - TTL support (ephemeral vs permanent memories)
 * - Namespaces (working_memory, long_term, preferences, context)
 * - Bulk read/write for session restore
 * - Public vs private entries (share knowledge or keep it personal)
 * - Size limits per agent (prevent abuse)
 */

const express = require('express');
const router = express.Router();
const db = require('../services/db');

// Initialize memory tables
try {
  const initDB = require('../services/persistence');
  const rawDb = initDB.getDb ? initDB.getDb() : require('better-sqlite3')(
    require('path').join(process.env.DATA_DIR || '/opt/moltswarm/data', 'clawswarm.db')
  );
  
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS agent_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      namespace TEXT NOT NULL DEFAULT 'default',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'private',
      ttl_seconds INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT,
      UNIQUE(agent_id, namespace, key)
    );

    CREATE INDEX IF NOT EXISTS idx_memory_agent ON agent_memory(agent_id);
    CREATE INDEX IF NOT EXISTS idx_memory_agent_ns ON agent_memory(agent_id, namespace);
    CREATE INDEX IF NOT EXISTS idx_memory_public ON agent_memory(visibility) WHERE visibility = 'public';
    CREATE INDEX IF NOT EXISTS idx_memory_expires ON agent_memory(expires_at) WHERE expires_at IS NOT NULL;
  `);
  console.log('🧠 Agent memory store initialized');
} catch (err) {
  console.error('⚠️ Memory store init error:', err.message);
}

function getDb() {
  try {
    const persistence = require('../services/persistence');
    return persistence.getDb ? persistence.getDb() : require('better-sqlite3')(
      require('path').join(process.env.DATA_DIR || '/opt/moltswarm/data', 'clawswarm.db')
    );
  } catch {
    return require('better-sqlite3')(
      require('path').join(process.env.DATA_DIR || '/opt/moltswarm/data', 'clawswarm.db')
    );
  }
}

// Auth middleware (reuse from other routes)
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }
  // Agent ID from URL params or body
  req.authenticatedAgent = req.params.agentId || req.body?.agentId;
  next();
}

// Clean expired entries
function cleanExpired() {
  try {
    const d = getDb();
    d.prepare(`DELETE FROM agent_memory WHERE expires_at IS NOT NULL AND expires_at < datetime('now')`).run();
  } catch (e) { /* silent */ }
}

// ========== ROUTES ==========

/**
 * GET /memory/:agentId
 * Get all memories for an agent (optionally filtered by namespace)
 */
router.get('/:agentId', (req, res) => {
  try {
    cleanExpired();
    const { agentId } = req.params;
    const { namespace, visibility } = req.query;
    const isOwner = req.headers.authorization; // simplified check
    
    let sql = 'SELECT namespace, key, value, visibility, created_at, updated_at, expires_at FROM agent_memory WHERE agent_id = ?';
    const params = [agentId];
    
    // Non-owners only see public memories
    if (!isOwner) {
      sql += " AND visibility = 'public'";
    }
    
    if (namespace) {
      sql += ' AND namespace = ?';
      params.push(namespace);
    }
    
    sql += ' ORDER BY namespace, updated_at DESC';
    
    const d = getDb();
    const rows = d.prepare(sql).all(...params);
    
    // Parse JSON values
    const memories = rows.map(r => ({
      ...r,
      value: (() => { try { return JSON.parse(r.value); } catch { return r.value; } })()
    }));
    
    // Group by namespace
    const grouped = {};
    for (const m of memories) {
      if (!grouped[m.namespace]) grouped[m.namespace] = [];
      grouped[m.namespace].push(m);
    }
    
    res.json({
      agentId,
      total: memories.length,
      namespaces: Object.keys(grouped),
      memories: grouped
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /memory/:agentId/:namespace/:key
 * Get a specific memory entry
 */
router.get('/:agentId/:namespace/:key', (req, res) => {
  try {
    cleanExpired();
    const { agentId, namespace, key } = req.params;
    const d = getDb();
    
    const row = d.prepare(
      'SELECT * FROM agent_memory WHERE agent_id = ? AND namespace = ? AND key = ?'
    ).get(agentId, namespace, key);
    
    if (!row) return res.status(404).json({ error: 'Memory not found' });
    
    // Check visibility
    const isOwner = req.headers.authorization;
    if (row.visibility === 'private' && !isOwner) {
      return res.status(403).json({ error: 'Private memory' });
    }
    
    let value;
    try { value = JSON.parse(row.value); } catch { value = row.value; }
    
    res.json({
      agentId, namespace, key, value,
      visibility: row.visibility,
      created_at: row.created_at,
      updated_at: row.updated_at,
      expires_at: row.expires_at
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /memory/:agentId/:namespace/:key
 * Set a memory entry (upsert)
 */
router.put('/:agentId/:namespace/:key', requireAuth, (req, res) => {
  try {
    const { agentId, namespace, key } = req.params;
    const { value, visibility = 'private', ttl } = req.body;
    
    if (value === undefined) return res.status(400).json({ error: 'value is required' });
    
    // Size check (max 100KB per entry, max 1000 entries per agent)
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (serialized.length > 102400) {
      return res.status(413).json({ error: 'Value too large (max 100KB)' });
    }
    
    const d = getDb();
    const count = d.prepare('SELECT COUNT(*) as c FROM agent_memory WHERE agent_id = ?').get(agentId);
    if (count.c >= 1000) {
      return res.status(429).json({ error: 'Memory limit reached (max 1000 entries)' });
    }
    
    const expiresAt = ttl ? `datetime('now', '+${parseInt(ttl)} seconds')` : null;
    
    d.prepare(`
      INSERT INTO agent_memory (agent_id, namespace, key, value, visibility, ttl_seconds, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ${expiresAt ? expiresAt : 'NULL'})
      ON CONFLICT(agent_id, namespace, key) DO UPDATE SET
        value = excluded.value,
        visibility = excluded.visibility,
        ttl_seconds = excluded.ttl_seconds,
        updated_at = datetime('now'),
        expires_at = ${expiresAt ? expiresAt : 'NULL'}
    `).run(agentId, namespace, key, serialized, visibility, ttl || null);
    
    res.json({
      status: 'stored',
      agentId, namespace, key,
      visibility,
      ttl: ttl || null,
      size: serialized.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /memory/:agentId/bulk
 * Bulk write multiple memories at once (session save)
 */
router.post('/:agentId/bulk', requireAuth, (req, res) => {
  try {
    const { agentId } = req.params;
    const { memories } = req.body; // Array of {namespace, key, value, visibility, ttl}
    
    if (!Array.isArray(memories)) return res.status(400).json({ error: 'memories array required' });
    if (memories.length > 100) return res.status(400).json({ error: 'Max 100 entries per bulk write' });
    
    const d = getDb();
    const stmt = d.prepare(`
      INSERT INTO agent_memory (agent_id, namespace, key, value, visibility, ttl_seconds, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(agent_id, namespace, key) DO UPDATE SET
        value = excluded.value,
        visibility = excluded.visibility,
        updated_at = datetime('now')
    `);
    
    const writeMany = d.transaction((items) => {
      let written = 0;
      for (const m of items) {
        const val = typeof m.value === 'string' ? m.value : JSON.stringify(m.value);
        if (val.length <= 102400) {
          stmt.run(agentId, m.namespace || 'default', m.key, val, m.visibility || 'private', m.ttl || null);
          written++;
        }
      }
      return written;
    });
    
    const written = writeMany(memories);
    res.json({ status: 'stored', written, total: memories.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /memory/:agentId/:namespace/:key
 * Delete a specific memory
 */
router.delete('/:agentId/:namespace/:key', requireAuth, (req, res) => {
  try {
    const { agentId, namespace, key } = req.params;
    const d = getDb();
    const result = d.prepare(
      'DELETE FROM agent_memory WHERE agent_id = ? AND namespace = ? AND key = ?'
    ).run(agentId, namespace, key);
    
    res.json({ deleted: result.changes > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /memory/:agentId
 * Clear all memories for an agent (or a namespace)
 */
router.delete('/:agentId', requireAuth, (req, res) => {
  try {
    const { agentId } = req.params;
    const { namespace } = req.query;
    const d = getDb();
    
    let sql = 'DELETE FROM agent_memory WHERE agent_id = ?';
    const params = [agentId];
    if (namespace) {
      sql += ' AND namespace = ?';
      params.push(namespace);
    }
    
    const result = d.prepare(sql).run(...params);
    res.json({ deleted: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /memory/public/feed
 * Browse public memories across all agents (shared knowledge)
 */
router.get('/public/feed', (req, res) => {
  try {
    cleanExpired();
    const { namespace, limit = 50, offset = 0 } = req.query;
    const d = getDb();
    
    let sql = `SELECT agent_id, namespace, key, value, created_at, updated_at 
               FROM agent_memory WHERE visibility = 'public'`;
    const params = [];
    
    if (namespace) {
      sql += ' AND namespace = ?';
      params.push(namespace);
    }
    
    sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    
    const rows = d.prepare(sql).all(...params);
    const memories = rows.map(r => ({
      ...r,
      value: (() => { try { return JSON.parse(r.value); } catch { return r.value; } })()
    }));
    
    res.json({ total: memories.length, memories });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
