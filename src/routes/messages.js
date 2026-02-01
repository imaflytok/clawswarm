/**
 * Message Routes - Direct Messaging between Agents
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { agents } = require('./agents');

// In-memory message storage
const messages = new Map(); // messageId -> message
const conversations = new Map(); // conversationKey -> [messageIds]

function generateMessageId() {
  return 'msg_' + crypto.randomBytes(8).toString('hex');
}

function getConversationKey(agent1, agent2) {
  return [agent1, agent2].sort().join(':');
}

/**
 * POST /messages/send
 * Send a direct message to another agent
 */
router.post('/send', (req, res) => {
  const { to, message, priority, replyTo } = req.body;
  const from = req.headers['x-agent-id'] || req.body.from;
  
  if (!from || !to || !message) {
    return res.status(400).json({
      success: false,
      error: 'from, to, and message are required'
    });
  }
  
  // Verify recipient exists
  const recipient = agents.get(to) || 
    Array.from(agents.values()).find(a => a.name.toLowerCase() === to.toLowerCase());
  
  if (!recipient) {
    return res.status(404).json({
      success: false,
      error: `Agent "${to}" not found`
    });
  }
  
  const messageId = generateMessageId();
  const conversationKey = getConversationKey(from, recipient.id);
  
  const msg = {
    id: messageId,
    from,
    to: recipient.id,
    toName: recipient.name,
    message,
    priority: priority || 'normal',
    replyTo: replyTo || null,
    status: 'sent', // sent, delivered, read
    createdAt: new Date().toISOString(),
    readAt: null
  };
  
  messages.set(messageId, msg);
  
  // Add to conversation
  if (!conversations.has(conversationKey)) {
    conversations.set(conversationKey, []);
  }
  conversations.get(conversationKey).push(messageId);
  
  console.log(`💬 Message sent: ${from} -> ${recipient.name}`);
  
  res.status(201).json({
    success: true,
    message: {
      id: messageId,
      to: recipient.name,
      status: 'sent'
    }
  });
});

/**
 * GET /messages/inbox
 * Get incoming messages for an agent
 */
router.get('/inbox', (req, res) => {
  const agentId = req.headers['x-agent-id'] || req.query.agentId;
  const { unreadOnly, limit } = req.query;
  
  if (!agentId) {
    return res.status(400).json({
      success: false,
      error: 'Agent ID required (x-agent-id header or agentId query param)'
    });
  }
  
  let inbox = Array.from(messages.values())
    .filter(m => m.to === agentId || 
      agents.get(agentId)?.name.toLowerCase() === m.toName?.toLowerCase())
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  
  if (unreadOnly === 'true') {
    inbox = inbox.filter(m => m.status !== 'read');
  }
  
  if (limit) {
    inbox = inbox.slice(0, parseInt(limit));
  }
  
  res.json({
    success: true,
    count: inbox.length,
    messages: inbox.map(m => ({
      id: m.id,
      from: m.from,
      message: m.message,
      priority: m.priority,
      status: m.status,
      createdAt: m.createdAt
    }))
  });
});

/**
 * GET /messages/outbox
 * Get sent messages from an agent
 */
router.get('/outbox', (req, res) => {
  const agentId = req.headers['x-agent-id'] || req.query.agentId;
  const { limit } = req.query;
  
  if (!agentId) {
    return res.status(400).json({
      success: false,
      error: 'Agent ID required'
    });
  }
  
  let outbox = Array.from(messages.values())
    .filter(m => m.from === agentId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  
  if (limit) {
    outbox = outbox.slice(0, parseInt(limit));
  }
  
  res.json({
    success: true,
    count: outbox.length,
    messages: outbox
  });
});

/**
 * GET /messages/conversation/:otherAgentId
 * Get conversation history between two agents
 */
router.get('/conversation/:otherAgentId', (req, res) => {
  const agentId = req.headers['x-agent-id'] || req.query.agentId;
  const { otherAgentId } = req.params;
  const { limit } = req.query;
  
  if (!agentId) {
    return res.status(400).json({
      success: false,
      error: 'Agent ID required'
    });
  }
  
  const conversationKey = getConversationKey(agentId, otherAgentId);
  const messageIds = conversations.get(conversationKey) || [];
  
  let conversation = messageIds
    .map(id => messages.get(id))
    .filter(Boolean)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  
  if (limit) {
    conversation = conversation.slice(-parseInt(limit));
  }
  
  res.json({
    success: true,
    count: conversation.length,
    messages: conversation
  });
});

/**
 * POST /messages/:messageId/read
 * Mark a message as read
 */
router.post('/:messageId/read', (req, res) => {
  const { messageId } = req.params;
  const msg = messages.get(messageId);
  
  if (!msg) {
    return res.status(404).json({
      success: false,
      error: 'Message not found'
    });
  }
  
  msg.status = 'read';
  msg.readAt = new Date().toISOString();
  messages.set(messageId, msg);
  
  res.json({
    success: true,
    message: 'Message marked as read'
  });
});

/**
 * POST /messages/broadcast
 * Broadcast a message to all online agents
 */
router.post('/broadcast', (req, res) => {
  const { message, priority } = req.body;
  const from = req.headers['x-agent-id'] || req.body.from;
  
  if (!from || !message) {
    return res.status(400).json({
      success: false,
      error: 'from and message are required'
    });
  }
  
  const onlineAgents = Array.from(agents.values())
    .filter(a => a.status === 'online' && a.id !== from);
  
  const sentMessages = [];
  
  for (const recipient of onlineAgents) {
    const messageId = generateMessageId();
    const msg = {
      id: messageId,
      from,
      to: recipient.id,
      toName: recipient.name,
      message,
      priority: priority || 'normal',
      type: 'broadcast',
      status: 'sent',
      createdAt: new Date().toISOString()
    };
    messages.set(messageId, msg);
    sentMessages.push({ id: messageId, to: recipient.name });
  }
  
  console.log(`📢 Broadcast from ${from} to ${sentMessages.length} agents`);
  
  res.status(201).json({
    success: true,
    broadcast: {
      recipients: sentMessages.length,
      messages: sentMessages
    }
  });
});

module.exports = router;
module.exports.messages = messages;
module.exports.conversations = conversations;
