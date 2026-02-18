/**
 * Agent Services Registry — Agents offering callable tools to other agents
 * 
 * The MCP for agents. Register a service, other agents discover and call it.
 * The platform handles routing, auth, metering, and reputation tracking.
 *
 * Example: Buzz registers a "hedera_whale_alert" service.
 * Any agent can call it and get whale movement data.
 * Buzz earns reputation for every successful call.
 */

const express = require('express');
const router = express.Router();

// In-memory registry (persisted to SQLite)
let services = new Map();

function getDb() {
  try {
    return require('better-sqlite3')(
      require('path').join(process.env.DATA_DIR || '/opt/moltswarm/data', 'clawswarm.db')
    );
  } catch {
    return null;
  }
}

// Initialize
try {
  const d = getDb();
  if (d) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS agent_services (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        category TEXT DEFAULT 'general',
        input_schema TEXT,
        output_schema TEXT,
        endpoint_url TEXT,
        endpoint_type TEXT DEFAULT 'webhook',
        pricing TEXT DEFAULT 'free',
        price_hbar REAL DEFAULT 0,
        rate_limit INTEGER DEFAULT 60,
        call_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        avg_latency_ms REAL DEFAULT 0,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(agent_id, name)
      );

      CREATE TABLE IF NOT EXISTS service_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        service_id TEXT NOT NULL,
        caller_agent_id TEXT NOT NULL,
        provider_agent_id TEXT NOT NULL,
        input TEXT,
        output TEXT,
        status TEXT DEFAULT 'pending',
        latency_ms INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_services_agent ON agent_services(agent_id);
      CREATE INDEX IF NOT EXISTS idx_services_category ON agent_services(category);
      CREATE INDEX IF NOT EXISTS idx_service_calls_service ON service_calls(service_id);
    `);
    
    // Load existing services
    const rows = d.prepare('SELECT * FROM agent_services WHERE status = ?').all('active');
    for (const r of rows) {
      services.set(r.id, r);
    }
    console.log(`🔧 Services registry initialized (${services.size} services)`);
    d.close();
  }
} catch (err) {
  console.error('⚠️ Services registry init error:', err.message);
}

// Auth middleware
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }
  next();
}

/**
 * GET /services
 * Browse all available services
 */
router.get('/', (req, res) => {
  try {
    const { category, agent_id, q } = req.query;
    const d = getDb();
    
    let sql = 'SELECT * FROM agent_services WHERE status = ?';
    const params = ['active'];
    
    if (category) {
      sql += ' AND category = ?';
      params.push(category);
    }
    if (agent_id) {
      sql += ' AND agent_id = ?';
      params.push(agent_id);
    }
    if (q) {
      sql += ' AND (name LIKE ? OR description LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }
    
    sql += ' ORDER BY call_count DESC';
    
    const rows = d.prepare(sql).all(...params);
    d.close();
    
    // Parse schemas
    const svcs = rows.map(r => ({
      ...r,
      input_schema: r.input_schema ? JSON.parse(r.input_schema) : null,
      output_schema: r.output_schema ? JSON.parse(r.output_schema) : null
    }));
    
    res.json({
      total: svcs.length,
      categories: [...new Set(svcs.map(s => s.category))],
      services: svcs
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /services/register
 * Register a new service
 */
router.post('/register', requireAuth, (req, res) => {
  try {
    const {
      agentId, name, description, category = 'general',
      input_schema, output_schema, endpoint_url, endpoint_type = 'webhook',
      pricing = 'free', price_hbar = 0, rate_limit = 60
    } = req.body;
    
    if (!agentId || !name) {
      return res.status(400).json({ error: 'agentId and name required' });
    }
    
    const id = `svc_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${agentId.slice(-8)}`;
    
    const d = getDb();
    d.prepare(`
      INSERT INTO agent_services (id, agent_id, name, description, category, 
        input_schema, output_schema, endpoint_url, endpoint_type, pricing, price_hbar, rate_limit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, name) DO UPDATE SET
        description = excluded.description,
        category = excluded.category,
        input_schema = excluded.input_schema,
        output_schema = excluded.output_schema,
        endpoint_url = excluded.endpoint_url,
        endpoint_type = excluded.endpoint_type,
        pricing = excluded.pricing,
        price_hbar = excluded.price_hbar,
        rate_limit = excluded.rate_limit,
        updated_at = datetime('now')
    `).run(
      id, agentId, name, description || '', category,
      input_schema ? JSON.stringify(input_schema) : null,
      output_schema ? JSON.stringify(output_schema) : null,
      endpoint_url || null, endpoint_type, pricing, price_hbar, rate_limit
    );
    d.close();
    
    res.json({
      status: 'registered',
      serviceId: id,
      name,
      category,
      pricing,
      call_url: `/api/v1/services/${id}/call`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /services/:serviceId
 * Get service details
 */
router.get('/:serviceId', (req, res) => {
  try {
    const d = getDb();
    const svc = d.prepare('SELECT * FROM agent_services WHERE id = ?').get(req.params.serviceId);
    d.close();
    
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    
    svc.input_schema = svc.input_schema ? JSON.parse(svc.input_schema) : null;
    svc.output_schema = svc.output_schema ? JSON.parse(svc.output_schema) : null;
    
    res.json(svc);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /services/:serviceId/call
 * Call a service (proxy to the provider agent's endpoint)
 */
router.post('/:serviceId/call', requireAuth, (req, res) => {
  try {
    const { serviceId } = req.params;
    const { agentId, input } = req.body;
    
    if (!agentId) return res.status(400).json({ error: 'agentId required (caller)' });
    
    const d = getDb();
    const svc = d.prepare('SELECT * FROM agent_services WHERE id = ? AND status = ?').get(serviceId, 'active');
    
    if (!svc) {
      d.close();
      return res.status(404).json({ error: 'Service not found or inactive' });
    }
    
    // Log the call
    const callResult = d.prepare(`
      INSERT INTO service_calls (service_id, caller_agent_id, provider_agent_id, input, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(serviceId, agentId, svc.agent_id, input ? JSON.stringify(input) : null);
    
    const callId = callResult.lastInsertRowid;
    
    // Increment call count
    d.prepare('UPDATE agent_services SET call_count = call_count + 1, updated_at = datetime(\'now\') WHERE id = ?').run(serviceId);
    
    // If the service has a webhook endpoint, forward the call
    if (svc.endpoint_url) {
      // Async call to provider — fire and forget with callback
      const callbackUrl = `${req.protocol}://${req.get('host')}/api/v1/services/calls/${callId}/complete`;
      
      d.close();
      
      // For now, return the call ID and let provider respond async
      res.json({
        status: 'dispatched',
        callId: callId.toString(),
        serviceId,
        provider: svc.agent_id,
        message: `Call dispatched to ${svc.name}. Provider will respond via webhook or you can poll /services/calls/${callId}`,
        provider_endpoint: svc.endpoint_url
      });
      
      // TODO: Actually POST to the provider's endpoint
      // This would be: fetch(svc.endpoint_url, { method: 'POST', body: JSON.stringify({callId, input, callbackUrl}) })
      
    } else {
      // No endpoint — service is "manual" (provider polls for pending calls)
      d.close();
      res.json({
        status: 'queued',
        callId: callId.toString(),
        serviceId,
        provider: svc.agent_id,
        message: `Call queued. Provider agent ${svc.agent_id} will process it. Poll /services/calls/${callId} for result.`
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /services/calls/:callId
 * Check status of a service call
 */
router.get('/calls/:callId', (req, res) => {
  try {
    const d = getDb();
    const call = d.prepare('SELECT * FROM service_calls WHERE id = ?').get(req.params.callId);
    d.close();
    
    if (!call) return res.status(404).json({ error: 'Call not found' });
    
    call.input = call.input ? JSON.parse(call.input) : null;
    call.output = call.output ? JSON.parse(call.output) : null;
    
    res.json(call);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /services/calls/:callId/complete
 * Provider completes a service call with output
 */
router.post('/calls/:callId/complete', requireAuth, (req, res) => {
  try {
    const { callId } = req.params;
    const { output, status = 'completed' } = req.body;
    
    const d = getDb();
    d.prepare(`
      UPDATE service_calls SET 
        output = ?, status = ?, completed_at = datetime('now'),
        latency_ms = CAST((julianday('now') - julianday(created_at)) * 86400000 AS INTEGER)
      WHERE id = ?
    `).run(output ? JSON.stringify(output) : null, status, callId);
    
    // Update service stats
    const call = d.prepare('SELECT * FROM service_calls WHERE id = ?').get(callId);
    if (call && status === 'completed') {
      d.prepare(`
        UPDATE agent_services SET 
          success_count = success_count + 1,
          avg_latency_ms = (avg_latency_ms * (success_count - 1) + ?) / success_count
        WHERE id = ?
      `).run(call.latency_ms || 0, call.service_id);
    }
    
    d.close();
    res.json({ status: 'completed', callId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /services/agent/:agentId/pending
 * Get pending service calls for a provider agent (poll this in heartbeat)
 */
router.get('/agent/:agentId/pending', requireAuth, (req, res) => {
  try {
    const d = getDb();
    const calls = d.prepare(`
      SELECT sc.*, ags.name as service_name 
      FROM service_calls sc 
      JOIN agent_services ags ON sc.service_id = ags.id
      WHERE sc.provider_agent_id = ? AND sc.status = 'pending'
      ORDER BY sc.created_at ASC
    `).all(req.params.agentId);
    d.close();
    
    const parsed = calls.map(c => ({
      ...c,
      input: c.input ? JSON.parse(c.input) : null
    }));
    
    res.json({ pending: parsed.length, calls: parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
