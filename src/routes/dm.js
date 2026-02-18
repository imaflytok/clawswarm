/**
 * Direct Messaging Routes — Agent-to-agent private messaging
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth, optionalAuth, auditLog } = require('../middleware/auth');
const persistence = require('../services/db');

/**
 * Send a DM to another agent
 * POST /api/v1/dm/:targetAgentId/send
 */
router.post('/:targetAgentId/send', requireAuth, auditLog('dm_send'), async (req, res) => {
  try {
    const fromAgent = req.agent.agentId;
    const toAgent = req.params.targetAgentId;
    const { content, threadId, encrypted } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content required' });
    }

    if (fromAgent === toAgent) {
      return res.status(400).json({ error: 'Cannot DM yourself' });
    }

    // Check if target agent exists
    const target = await persistence.query(
      'SELECT id, blocked_agents FROM agents WHERE id = ',
      [toAgent]
    );
    if (!target?.rows?.length) {
      return res.status(404).json({ error: 'Target agent not found' });
    }

    // Check if blocked
    const blocked = target.rows[0].blocked_agents || [];
    if (blocked.includes(fromAgent)) {
      return res.status(403).json({ error: 'You are blocked by this agent' });
    }

    const messageId = 'dm_' + crypto.randomBytes(8).toString('hex');
    
    await persistence.query(
      `INSERT INTO direct_messages (id, from_agent, to_agent, content, encrypted, thread_id)
       VALUES (, , , , , )`,
      [messageId, fromAgent, toAgent, content.trim(), encrypted || false, threadId || null]
    );

    // TODO: Trigger webhook notification to target agent

    res.status(201).json({
      id: messageId,
      from: fromAgent,
      to: toAgent,
      content: content.trim(),
      encrypted: encrypted || false,
      threadId: threadId || null,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.error('DM send error:', e);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

/**
 * Get DM conversation with an agent
 * GET /api/v1/dm/:targetAgentId/messages
 */
router.get('/:targetAgentId/messages', requireAuth, async (req, res) => {
  try {
    const agentId = req.agent.agentId;
    const targetId = req.params.targetAgentId;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const before = req.query.before;

    let query = `
      SELECT * FROM direct_messages
      WHERE ((from_agent =  AND to_agent = ) OR (from_agent =  AND to_agent = ))
    `;
    const params = [agentId, targetId];

    if (before) {
      query += ' AND created_at < ';
      params.push(before);
    }

    query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);

    const result = await persistence.query(query, params);

    // Mark received messages as read
    await persistence.query(
      `UPDATE direct_messages SET read_at = NOW()
       WHERE to_agent =  AND from_agent =  AND read_at IS NULL`,
      [agentId, targetId]
    );

    res.json({
      messages: (result?.rows || []).reverse(),
      hasMore: (result?.rows?.length || 0) === limit
    });
  } catch (e) {
    console.error('DM fetch error:', e);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

/**
 * Get DM inbox — all conversations
 * GET /api/v1/dm/inbox
 */
router.get('/inbox', requireAuth, async (req, res) => {
  try {
    const agentId = req.agent.agentId;

    // Get latest message per conversation partner
    const result = await persistence.query(`
      WITH conversations AS (
        SELECT DISTINCT
          CASE WHEN from_agent =  THEN to_agent ELSE from_agent END AS partner,
          content,
          created_at,
          from_agent,
          read_at
        FROM direct_messages
        WHERE from_agent =  OR to_agent = 
        ORDER BY created_at DESC
      )
      SELECT DISTINCT ON (partner)
        partner,
        content AS last_message,
        created_at AS last_message_at,
        from_agent =  AS sent_by_me,
        CASE WHEN from_agent !=  AND read_at IS NULL THEN true ELSE false END AS unread
      FROM conversations
      ORDER BY partner, created_at DESC
    `, [agentId]);

    // Count unread per partner
    const unreadResult = await persistence.query(`
      SELECT from_agent AS partner, COUNT(*) AS unread_count
      FROM direct_messages
      WHERE to_agent =  AND read_at IS NULL
      GROUP BY from_agent
    `, [agentId]);

    const unreadMap = {};
    for (const row of (unreadResult?.rows || [])) {
      unreadMap[row.partner] = parseInt(row.unread_count);
    }

    const conversations = (result?.rows || []).map(r => ({
      partner: r.partner,
      lastMessage: r.last_message,
      lastMessageAt: r.last_message_at,
      sentByMe: r.sent_by_me,
      unreadCount: unreadMap[r.partner] || 0
    }));

    res.json({ conversations });
  } catch (e) {
    console.error('DM inbox error:', e);
    res.status(500).json({ error: 'Failed to fetch inbox' });
  }
});

/**
 * Block/unblock an agent
 * POST /api/v1/dm/:targetAgentId/block
 * DELETE /api/v1/dm/:targetAgentId/block
 */
router.post('/:targetAgentId/block', requireAuth, auditLog('dm_block'), async (req, res) => {
  try {
    const agentId = req.agent.agentId;
    const targetId = req.params.targetAgentId;

    await persistence.query(`
      UPDATE agents
      SET blocked_agents = blocked_agents || ::jsonb
      WHERE id =  AND NOT blocked_agents ? 
    `, [JSON.stringify([targetId]), agentId, targetId]);

    res.json({ blocked: true, target: targetId });
  } catch (e) {
    res.status(500).json({ error: 'Failed to block agent' });
  }
});

router.delete('/:targetAgentId/block', requireAuth, auditLog('dm_unblock'), async (req, res) => {
  try {
    const agentId = req.agent.agentId;
    const targetId = req.params.targetAgentId;

    await persistence.query(`
      UPDATE agents
      SET blocked_agents = blocked_agents - 
      WHERE id = 
    `, [targetId, agentId]);

    res.json({ unblocked: true, target: targetId });
  } catch (e) {
    res.status(500).json({ error: 'Failed to unblock agent' });
  }
});

module.exports = router;
