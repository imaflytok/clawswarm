/**
 * Unit + Integration tests for SwarmIRC WebSocket Gateway
 * Run: node tests/test-swarmirc.js
 * 
 * Tests the IRC-style protocol for AI agent communication.
 */

const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const EventEmitter = require('events');

// ============================================================
// Test infrastructure
// ============================================================

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

// ============================================================
// Mock dependencies
// ============================================================

function createMockAgents() {
  const agents = new Map();
  agents.set('agent_test1', {
    id: 'agent_test1',
    name: 'TestBot1',
    apiKey: 'test_key_1',
    status: 'offline',
    lastSeen: new Date().toISOString(),
    description: 'Test bot 1',
    capabilities: ['chat', 'search']
  });
  agents.set('agent_test2', {
    id: 'agent_test2',
    name: 'TestBot2',
    apiKey: 'test_key_2',
    status: 'offline',
    lastSeen: new Date().toISOString(),
    description: 'Test bot 2',
    capabilities: ['code', 'analysis']
  });
  agents.set('agent_test3', {
    id: 'agent_test3',
    name: 'TestBot3',
    apiKey: 'test_key_3',
    status: 'offline',
    lastSeen: new Date().toISOString(),
    description: 'Banned test bot',
    capabilities: []
  });
  return agents;
}

function createMockChannels() {
  const channels = new Map();
  channels.set('channel_general', {
    id: 'channel_general',
    name: 'general',
    type: 'public',
    members: ['agent_test1'],
    createdBy: 'agent_test1',
    createdAt: new Date().toISOString()
  });
  channels.set('channel_warroom', {
    id: 'channel_warroom',
    name: 'warroom',
    type: 'public',
    members: [],
    createdBy: 'system',
    createdAt: new Date().toISOString()
  });
  return channels;
}

function createMockStreams() {
  return {
    publishToChannel: async (channelId, message) => {
      // Mock — just record calls
      return true;
    },
    getChannelHistory: async (channelId, limit) => [],
    readChannel: async (channelId, opts) => [],
    initStreams: async () => {}
  };
}

function sanitizeContent(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// ============================================================
// Helper: create server + SwarmIRC + connect clients
// ============================================================

const SwarmIRC = require('../src/swarmirc');

function createTestServer() {
  const agents = createMockAgents();
  const channels = createMockChannels();
  const streams = createMockStreams();
  
  const server = http.createServer();
  const swarmirc = new SwarmIRC(server, {
    agents,
    streams,
    channels,
    sanitize: sanitizeContent
  });
  swarmirc.initialize();
  
  return { server, swarmirc, agents, channels };
}

function connectClient(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/clawswarm/ws`);
    const messages = [];
    
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('message', (data) => messages.push(data.toString().trim()));
    ws.on('error', reject);
  });
}

function waitForMessage(client, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const found = client.messages.find(predicate);
      if (found) return resolve(found);
    };
    
    // Check existing
    check();
    
    const interval = setInterval(() => {
      check();
    }, 50);
    
    setTimeout(() => {
      clearInterval(interval);
      check();
      const found = client.messages.find(predicate);
      if (found) resolve(found);
      else reject(new Error(`Timeout waiting for message. Got: ${JSON.stringify(client.messages.slice(-5))}`));
    }, timeoutMs);
  });
}

function waitMs(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// TESTS
// ============================================================

async function runTests() {
  console.log('\n🔌 SwarmIRC Unit + Integration Tests\n');
  
  // --------------------------------------------------------
  // Unit Tests: Protocol Parsing & State
  // --------------------------------------------------------
  console.log('📋 Unit Tests: Constructor & Initialization');
  
  test('SwarmIRC constructor creates valid instance', () => {
    const server = http.createServer();
    const irc = new SwarmIRC(server, {
      agents: new Map(),
      streams: createMockStreams(),
      channels: new Map(),
      sanitize: sanitizeContent
    });
    assert.ok(irc);
    assert.equal(irc.SERVER_NAME, 'clawswarm');
    assert.ok(irc.clients instanceof Map);
    assert.ok(irc.agentSockets instanceof Map);
    assert.ok(irc.channelTopics instanceof Map);
    assert.ok(irc.channelOps instanceof Map);
    assert.ok(irc.channelBans instanceof Map);
    assert.ok(irc.registeredCommands instanceof Map);
  });

  test('Stats initialized correctly', () => {
    const server = http.createServer();
    const irc = new SwarmIRC(server, {
      agents: new Map(),
      streams: createMockStreams(),
      channels: new Map()
    });
    assert.equal(irc.stats.totalConnections, 0);
    assert.equal(irc.stats.totalMessages, 0);
    assert.ok(irc.stats.startedAt > 0);
  });

  test('getStats returns valid structure', () => {
    const server = http.createServer();
    const irc = new SwarmIRC(server, {
      agents: new Map(),
      streams: createMockStreams(),
      channels: new Map()
    });
    const stats = irc.getStats();
    assert.equal(typeof stats.totalConnections, 'number');
    assert.equal(typeof stats.totalMessages, 'number');
    assert.equal(typeof stats.onlineAgents, 'number');
    assert.equal(typeof stats.totalClients, 'number');
    assert.ok(Array.isArray(stats.registeredCommands));
  });

  test('onlineCount returns 0 with no clients', () => {
    const server = http.createServer();
    const irc = new SwarmIRC(server, {
      agents: new Map(),
      streams: createMockStreams(),
      channels: new Map()
    });
    assert.equal(irc.onlineCount(), 0);
  });

  // --------------------------------------------------------
  // Integration Tests: WebSocket Protocol
  // --------------------------------------------------------
  console.log('\n📡 Integration Tests: WebSocket Protocol');
  
  const { server, swarmirc, agents, channels } = createTestServer();
  
  await new Promise((resolve) => {
    server.listen(0, () => resolve());
  });
  const port = server.address().port;
  console.log(`   Test server on port ${port}\n`);

  // --- Connection ---
  await asyncTest('Client receives welcome notice on connect', async () => {
    const client = await connectClient(port);
    await waitForMessage(client, m => m.includes('Welcome to ClawSwarm'));
    client.ws.close();
  });

  await asyncTest('Connection increments totalConnections', async () => {
    const before = swarmirc.stats.totalConnections;
    const client = await connectClient(port);
    await waitMs(100);
    assert.ok(swarmirc.stats.totalConnections > before);
    client.ws.close();
  });

  // --- PING/PONG ---
  await asyncTest('PING returns PONG (unauthenticated)', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('PING :test123');
    await waitForMessage(client, m => m.includes('PONG') && m.includes('test123'));
    client.ws.close();
  });

  // --- Auth gate ---
  await asyncTest('Commands blocked before auth (JOIN)', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('JOIN #general');
    await waitForMessage(client, m => m.includes('464') && m.includes('authenticate'));
    client.ws.close();
  });

  await asyncTest('Commands blocked before auth (LIST)', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('LIST');
    await waitForMessage(client, m => m.includes('464'));
    client.ws.close();
  });

  await asyncTest('Commands blocked before auth (PRIVMSG)', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('PRIVMSG #general :hello');
    await waitForMessage(client, m => m.includes('464'));
    client.ws.close();
  });

  // --- Authentication ---
  await asyncTest('AUTH with invalid key returns 464', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH invalid_key_xyz');
    await waitForMessage(client, m => m.includes('464') && m.includes('Authentication failed'));
    client.ws.close();
  });

  await asyncTest('AUTH with empty key returns 461', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH');
    await waitForMessage(client, m => m.includes('461'));
    client.ws.close();
  });

  await asyncTest('AUTH with valid key returns welcome sequence', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('001') && m.includes('Welcome'));
    await waitForMessage(client, m => m.includes('376') || m.includes('End of /MOTD'));
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('AUTH sets agent status to online', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('001'));
    assert.equal(agents.get('agent_test1').status, 'online');
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('AUTH welcome includes server info numerics (001-004)', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('001'));
    await waitForMessage(client, m => m.includes('002'));
    await waitForMessage(client, m => m.includes('003'));
    await waitForMessage(client, m => m.includes('004'));
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('AUTH welcome includes MOTD', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('375')); // MOTD start
    await waitForMessage(client, m => m.includes('372')); // MOTD body
    await waitForMessage(client, m => m.includes('376')); // MOTD end
    client.ws.close();
    await waitMs(200);
  });

  // --- JOIN ---
  await asyncTest('JOIN existing channel succeeds', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('JOIN #general');
    await waitForMessage(client, m => m.includes('JOIN') && m.includes('#general'));
    // Should also get NAMES
    await waitForMessage(client, m => m.includes('366')); // End of NAMES
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('JOIN auto-creates new channel', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('JOIN #newchannel');
    await waitForMessage(client, m => m.includes('JOIN') && m.includes('#newchannel'));
    assert.ok(channels.has('channel_newchannel'));
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('JOIN creator gets ops', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_2');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('JOIN #opstest2');
    await waitForMessage(client, m => m.includes('JOIN') && m.includes('#opstest2'));
    await waitMs(100);
    const ops = swarmirc.channelOps.get('channel_opstest2');
    assert.ok(ops, 'Channel ops map should exist');
    assert.ok(ops.has('agent_test2'), 'Creator should have ops');
    client.ws.close();
    await waitMs(300);
  });

  // --- PART ---
  await asyncTest('PART leaves channel', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('JOIN #parttest');
    await waitForMessage(client, m => m.includes('JOIN'));
    client.ws.send('PART #parttest :goodbye');
    await waitForMessage(client, m => m.includes('PART') && m.includes('#parttest'));
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('PART from unjoined channel returns 442', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('PART #neverjoined');
    await waitForMessage(client, m => m.includes('442'));
    client.ws.close();
    await waitMs(200);
  });

  // --- PRIVMSG ---
  await asyncTest('PRIVMSG to channel works', async () => {
    // Use unique channel to avoid cross-test interference
    const c1 = await connectClient(port);
    await waitMs(200);
    c1.ws.send('AUTH test_key_1');
    await waitForMessage(c1, m => m.includes('376'));
    
    const c2 = await connectClient(port);
    await waitMs(200);
    c2.ws.send('AUTH test_key_2');
    await waitForMessage(c2, m => m.includes('376'));
    
    // Both join same channel
    c1.ws.send('JOIN #msgtest2');
    await waitForMessage(c1, m => m.includes('366') && m.includes('#msgtest2'));
    await waitMs(100);
    
    c2.ws.send('JOIN #msgtest2');
    await waitForMessage(c2, m => m.includes('366') && m.includes('#msgtest2'));
    await waitMs(100);
    
    // Clear c2's message buffer so we only look for new messages
    const beforeCount = c2.messages.length;
    
    c1.ws.send('PRIVMSG #msgtest2 :Hello from TestBot1!');
    
    // Wait for new message to arrive at c2
    await waitForMessage(c2, m => m.includes('PRIVMSG') && m.includes('Hello from TestBot1'));
    
    c1.ws.close();
    c2.ws.close();
    await waitMs(300);
  });

  await asyncTest('PRIVMSG increments message counter', async () => {
    const before = swarmirc.stats.totalMessages;
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('JOIN #counttest');
    await waitForMessage(client, m => m.includes('JOIN'));
    client.ws.send('PRIVMSG #counttest :test message');
    await waitMs(200);
    assert.ok(swarmirc.stats.totalMessages > before);
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('PRIVMSG to unjoined channel returns 404', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('PRIVMSG #notjoined :hello');
    await waitForMessage(client, m => m.includes('404'));
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('PRIVMSG DM to online agent works', async () => {
    const c1 = await connectClient(port);
    await waitMs(100);
    c1.ws.send('AUTH test_key_1');
    await waitForMessage(c1, m => m.includes('376'));
    
    const c2 = await connectClient(port);
    await waitMs(100);
    c2.ws.send('AUTH test_key_2');
    await waitForMessage(c2, m => m.includes('376'));
    
    c1.ws.send('PRIVMSG TestBot2 :Hello DM!');
    await waitForMessage(c2, m => m.includes('PRIVMSG') && m.includes('Hello DM'));
    
    c1.ws.close();
    c2.ws.close();
    await waitMs(200);
  });

  await asyncTest('PRIVMSG DM to offline agent returns 401', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('PRIVMSG NonExistent :hello');
    await waitForMessage(client, m => m.includes('401'));
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('PRIVMSG without params returns 461', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('PRIVMSG');
    await waitForMessage(client, m => m.includes('461'));
    client.ws.close();
    await waitMs(200);
  });

  // --- Content Sanitization ---
  await asyncTest('PRIVMSG sanitizes HTML/XSS content', async () => {
    const c1 = await connectClient(port);
    await waitMs(200);
    c1.ws.send('AUTH test_key_1');
    await waitForMessage(c1, m => m.includes('376'));
    
    const c2 = await connectClient(port);
    await waitMs(200);
    c2.ws.send('AUTH test_key_2');
    await waitForMessage(c2, m => m.includes('376'));
    
    c1.ws.send('JOIN #xsstest2');
    await waitForMessage(c1, m => m.includes('366') && m.includes('#xsstest2'));
    await waitMs(100);
    
    c2.ws.send('JOIN #xsstest2');
    await waitForMessage(c2, m => m.includes('366') && m.includes('#xsstest2'));
    await waitMs(100);
    
    c1.ws.send('PRIVMSG #xsstest2 :<script>alert("xss")</script>');
    const msg = await waitForMessage(c2, m => m.includes('PRIVMSG') && m.includes('xsstest2') && m.includes('script'));
    assert.ok(!msg.includes('<script>'), 'Script tags should be sanitized');
    assert.ok(msg.includes('&lt;script&gt;') || msg.includes('script'), 'Content should be escaped');
    
    c1.ws.close();
    c2.ws.close();
    await waitMs(300);
  });

  // --- LIST ---
  await asyncTest('LIST returns channel list', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('LIST');
    await waitForMessage(client, m => m.includes('321')); // LIST header
    await waitForMessage(client, m => m.includes('323')); // End of LIST
    // Should have at least one channel entry (322)
    const hasChannel = client.messages.some(m => m.includes('322'));
    assert.ok(hasChannel, 'LIST should include channel entries');
    client.ws.close();
    await waitMs(200);
  });

  // --- WHO ---
  await asyncTest('WHO returns channel members', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('JOIN #whotest');
    await waitForMessage(client, m => m.includes('JOIN'));
    client.ws.send('WHO #whotest');
    await waitForMessage(client, m => m.includes('315')); // End of WHO
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('WHO on non-existent channel returns 403', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('WHO #nonexistent');
    await waitForMessage(client, m => m.includes('403'));
    client.ws.close();
    await waitMs(200);
  });

  // --- WHOIS ---
  await asyncTest('WHOIS returns agent info', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('WHOIS TestBot2');
    await waitForMessage(client, m => m.includes('311') && m.includes('TestBot2'));
    await waitForMessage(client, m => m.includes('318')); // End of WHOIS
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('WHOIS includes capabilities', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('WHOIS TestBot2');
    await waitForMessage(client, m => m.includes('313') && m.includes('code'));
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('WHOIS on non-existent nick returns 401', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('WHOIS Nobody');
    await waitForMessage(client, m => m.includes('401'));
    client.ws.close();
    await waitMs(200);
  });

  // --- NAMES ---
  await asyncTest('NAMES returns nick list', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('JOIN #namestest');
    await waitForMessage(client, m => m.includes('JOIN'));
    client.ws.send('NAMES #namestest');
    await waitForMessage(client, m => m.includes('353')); // NAMES reply
    await waitForMessage(client, m => m.includes('366')); // End of NAMES
    client.ws.close();
    await waitMs(200);
  });

  // --- TOPIC ---
  await asyncTest('TOPIC sets channel topic', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('JOIN #topictest');
    await waitForMessage(client, m => m.includes('JOIN'));
    client.ws.send('TOPIC #topictest :This is the topic');
    await waitForMessage(client, m => m.includes('TOPIC') && m.includes('This is the topic'));
    assert.equal(swarmirc.channelTopics.get('channel_topictest'), 'This is the topic');
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('TOPIC query returns current topic', async () => {
    // Set a topic first
    swarmirc.channelTopics.set('channel_topicquery', 'Pre-set topic');
    channels.set('channel_topicquery', {
      id: 'channel_topicquery', name: 'topicquery', type: 'public',
      members: [], createdBy: 'system', createdAt: new Date().toISOString()
    });
    
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('JOIN #topicquery');
    await waitForMessage(client, m => m.includes('JOIN'));
    client.ws.send('TOPIC #topicquery');
    await waitForMessage(client, m => m.includes('332') && m.includes('Pre-set topic'));
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('TOPIC on unjoined channel returns 442', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('TOPIC #notjoinedtopic :test');
    await waitForMessage(client, m => m.includes('442'));
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('TOPIC sanitizes XSS in topic text', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('JOIN #topicxss');
    await waitForMessage(client, m => m.includes('JOIN'));
    client.ws.send('TOPIC #topicxss :<img onerror=alert(1)>');
    await waitMs(200);
    const topic = swarmirc.channelTopics.get('channel_topicxss');
    assert.ok(!topic.includes('<img'), 'Topic should be sanitized');
    client.ws.close();
    await waitMs(200);
  });

  // --- REGISTER / COMMANDS / CMD ---
  await asyncTest('REGISTER registers a bot command', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('REGISTER search :Search the web for information');
    await waitForMessage(client, m => m.includes('Registered command'));
    assert.ok(swarmirc.registeredCommands.has('agent_test1'));
    assert.ok(swarmirc.registeredCommands.get('agent_test1').has('search'));
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('COMMANDS lists all registered commands', async () => {
    // Register a command first
    swarmirc.registeredCommands.set('agent_test2', new Map([['analyze', 'Analyze data']]));
    
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('COMMANDS');
    await waitForMessage(client, m => m.includes('End of commands'));
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('CMD to online agent forwards command', async () => {
    const c1 = await connectClient(port);
    await waitMs(100);
    c1.ws.send('AUTH test_key_1');
    await waitForMessage(c1, m => m.includes('376'));
    
    const c2 = await connectClient(port);
    await waitMs(100);
    c2.ws.send('AUTH test_key_2');
    await waitForMessage(c2, m => m.includes('376'));
    
    c1.ws.send('CMD TestBot2 analyze some data here');
    await waitForMessage(c2, m => m.includes('CMD') && m.includes('analyze'));
    
    c1.ws.close();
    c2.ws.close();
    await waitMs(200);
  });

  await asyncTest('CMD to offline agent returns 401', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('CMD OfflineBot doStuff args');
    await waitForMessage(client, m => m.includes('401'));
    client.ws.close();
    await waitMs(200);
  });

  // --- QUERY ---
  await asyncTest('QUERY CAPABILITIES on offline agent returns static caps', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('QUERY TestBot2 CAPABILITIES');
    // TestBot2 might not be online, should return static capabilities
    await waitForMessage(client, m => 
      (m.includes('QUERY-REPLY') && m.includes('code')) || 
      (m.includes('QUERY') && m.includes('CAPABILITIES'))
    );
    client.ws.close();
    await waitMs(200);
  });

  // --- MODE ---
  await asyncTest('MODE +o grants ops to another agent', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('JOIN #modetest');
    await waitForMessage(client, m => m.includes('JOIN'));
    
    // Creator has ops, give ops to TestBot2
    client.ws.send('MODE #modetest +o TestBot2');
    await waitForMessage(client, m => m.includes('MODE') && m.includes('+o'));
    
    const ops = swarmirc.channelOps.get('channel_modetest');
    assert.ok(ops && ops.has('agent_test2'));
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('MODE -o removes ops', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('JOIN #moderemove');
    await waitForMessage(client, m => m.includes('JOIN'));
    client.ws.send('MODE #moderemove +o TestBot2');
    await waitMs(100);
    client.ws.send('MODE #moderemove -o TestBot2');
    await waitForMessage(client, m => m.includes('-o'));
    
    const ops = swarmirc.channelOps.get('channel_moderemove');
    assert.ok(!ops || !ops.has('agent_test2'));
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('MODE +b bans agent from channel', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('JOIN #bantest');
    await waitForMessage(client, m => m.includes('JOIN'));
    client.ws.send('MODE #bantest +b TestBot3');
    await waitForMessage(client, m => m.includes('+b'));
    
    const bans = swarmirc.channelBans.get('channel_bantest');
    assert.ok(bans && bans.has('agent_test3'));
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('Banned agent cannot join channel', async () => {
    // TestBot3 was banned from #bantest above
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_3');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('JOIN #bantest');
    await waitForMessage(client, m => m.includes('474')); // Cannot join (+b)
    client.ws.close();
    await waitMs(200);
  });

  await asyncTest('MODE without ops returns 482', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_2');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('JOIN #general');
    await waitForMessage(client, m => m.includes('JOIN'));
    client.ws.send('MODE #general +o TestBot3');
    await waitForMessage(client, m => m.includes('482'));
    client.ws.close();
    await waitMs(200);
  });

  // --- KICK ---
  await asyncTest('KICK removes agent from channel', async () => {
    const c1 = await connectClient(port);
    await waitMs(200);
    c1.ws.send('AUTH test_key_1');
    await waitForMessage(c1, m => m.includes('376'));
    
    const c2 = await connectClient(port);
    await waitMs(200);
    c2.ws.send('AUTH test_key_2');
    await waitForMessage(c2, m => m.includes('376'));
    
    c1.ws.send('JOIN #kicktest2');
    await waitForMessage(c1, m => m.includes('366') && m.includes('#kicktest2'));
    await waitMs(100);
    
    c2.ws.send('JOIN #kicktest2');
    await waitForMessage(c2, m => m.includes('366') && m.includes('#kicktest2'));
    await waitMs(100);
    
    c1.ws.send('KICK #kicktest2 TestBot2 :Testing kick');
    await waitForMessage(c2, m => m.includes('KICK') && m.includes('Testing kick'));
    
    c1.ws.close();
    c2.ws.close();
    await waitMs(300);
  });

  await asyncTest('KICK without ops returns 482', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_2');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('JOIN #general');
    await waitMs(100);
    client.ws.send('KICK #general TestBot1 :nope');
    await waitForMessage(client, m => m.includes('482'));
    client.ws.close();
    await waitMs(200);
  });

  // --- HELP ---
  await asyncTest('HELP returns command reference', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('HELP');
    await waitForMessage(client, m => m.includes('SwarmIRC Command Reference'));
    client.ws.close();
    await waitMs(200);
  });

  // --- Unknown command ---
  await asyncTest('Unknown command returns 421', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    client.ws.send('FOOBAR');
    await waitForMessage(client, m => m.includes('421') && m.includes('FOOBAR'));
    client.ws.close();
    await waitMs(200);
  });

  // --- QUIT ---
  await asyncTest('QUIT closes connection', async () => {
    const client = await connectClient(port);
    await waitMs(100);
    client.ws.send('AUTH test_key_1');
    await waitForMessage(client, m => m.includes('376'));
    
    const closePromise = new Promise(resolve => {
      client.ws.on('close', resolve);
    });
    
    client.ws.send('QUIT');
    await closePromise;
    // If we get here, the connection was closed
    assert.ok(true);
    await waitMs(200);
  });

  // --- Disconnect/Presence ---
  await asyncTest('Disconnect broadcasts QUIT to channels', async () => {
    const c1 = await connectClient(port);
    await waitMs(100);
    c1.ws.send('AUTH test_key_1');
    await waitForMessage(c1, m => m.includes('376'));
    
    const c2 = await connectClient(port);
    await waitMs(100);
    c2.ws.send('AUTH test_key_2');
    await waitForMessage(c2, m => m.includes('376'));
    
    c1.ws.send('JOIN #quitbroadcast');
    await waitForMessage(c1, m => m.includes('JOIN'));
    c2.ws.send('JOIN #quitbroadcast');
    await waitForMessage(c2, m => m.includes('JOIN'));
    
    c1.ws.close();
    await waitForMessage(c2, m => m.includes('QUIT'));
    
    c2.ws.close();
    await waitMs(200);
  });

  // --- Duplicate connection replaces old ---
  await asyncTest('Second AUTH replaces first connection', async () => {
    const c1 = await connectClient(port);
    await waitMs(100);
    c1.ws.send('AUTH test_key_1');
    await waitForMessage(c1, m => m.includes('376'));
    
    const closePromise = new Promise(resolve => {
      c1.ws.on('close', resolve);
    });
    
    const c2 = await connectClient(port);
    await waitMs(100);
    c2.ws.send('AUTH test_key_1');
    await waitForMessage(c2, m => m.includes('376'));
    
    // First connection should be closed
    await closePromise;
    assert.ok(true);
    
    c2.ws.close();
    await waitMs(200);
  });

  // --- Multi-message broadcast ---
  await asyncTest('Messages broadcast to all channel members except sender', async () => {
    const c1 = await connectClient(port);
    const c2 = await connectClient(port);
    const c3 = await connectClient(port);
    await waitMs(100);
    
    c1.ws.send('AUTH test_key_1');
    await waitForMessage(c1, m => m.includes('376'));
    c2.ws.send('AUTH test_key_2');
    await waitForMessage(c2, m => m.includes('376'));
    c3.ws.send('AUTH test_key_3');
    await waitForMessage(c3, m => m.includes('376'));
    
    c1.ws.send('JOIN #broadcast');
    await waitMs(100);
    c2.ws.send('JOIN #broadcast');
    await waitMs(100);
    c3.ws.send('JOIN #broadcast');
    await waitMs(100);
    
    c1.ws.send('PRIVMSG #broadcast :Hello everyone!');
    
    // c2 and c3 should receive, c1 should NOT
    await waitForMessage(c2, m => m.includes('Hello everyone'));
    await waitForMessage(c3, m => m.includes('Hello everyone'));
    
    // Verify c1 didn't get its own message echoed (check after the others received)
    await waitMs(200);
    const c1GotEcho = c1.messages.some(m => 
      m.includes('PRIVMSG') && m.includes('Hello everyone') && m.includes(':TestBot1')
    );
    assert.ok(!c1GotEcho, 'Sender should not receive echo of own message');
    
    c1.ws.close();
    c2.ws.close();
    c3.ws.close();
    await waitMs(200);
  });

  // --------------------------------------------------------
  // Cleanup
  // --------------------------------------------------------
  
  server.close();
  
  // --------------------------------------------------------
  // Results
  // --------------------------------------------------------
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🔌 SwarmIRC Test Results: ${passed} passed, ${failed} failed`);
  
  if (failures.length > 0) {
    console.log('\n❌ Failures:');
    for (const f of failures) {
      console.log(`   ${f.name}: ${f.error}`);
    }
  }
  
  console.log(`${'='.repeat(50)}\n`);
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
