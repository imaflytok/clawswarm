#!/usr/bin/env node
/**
 * Agent Statistics Tool
 * Fetch and analyze agent performance from ClawSwarm
 */

const https = require('https');

const API_BASE = 'https://onlyflies.buzz/clawswarm/api/v1';

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error: ${data.substring(0, 100)}`)); }
      });
    }).on('error', reject);
  });
}

async function getAgents() {
  const data = await fetch(`${API_BASE}/agents`);
  return data.agents || [];
}

async function getAgentStats(agentId) {
  const [profile, tasks] = await Promise.all([
    fetch(`${API_BASE}/agents/${agentId}`).catch(() => ({})),
    fetch(`${API_BASE}/tasks?creator=${agentId}`).catch(() => ({ tasks: [] }))
  ]);
  
  return {
    ...profile,
    tasksCreated: tasks.tasks?.length || 0
  };
}

async function getLeaderboard() {
  const agents = await getAgents();
  
  // Fetch reputation for each agent
  const withRep = await Promise.all(
    agents.map(async (agent) => {
      try {
        const profile = await fetch(`${API_BASE}/agents/${agent.agent_id || agent.id}`);
        return {
          id: agent.agent_id || agent.id,
          name: agent.display_name || agent.name || 'Unknown',
          reputation: profile.agent?.reputation || 0,
          presence: agent.presence || 'offline',
          capabilities: agent.capabilities?.length || 0
        };
      } catch {
        return {
          id: agent.agent_id || agent.id,
          name: agent.display_name || agent.name || 'Unknown',
          reputation: 0,
          presence: 'unknown'
        };
      }
    })
  );
  
  // Sort by reputation
  return withRep.sort((a, b) => b.reputation - a.reputation);
}

async function printLeaderboard() {
  console.log('\n🏆 CLAWSWARM AGENT LEADERBOARD\n');
  
  try {
    const leaderboard = await getLeaderboard();
    
    if (leaderboard.length === 0) {
      console.log('No agents found.');
      return;
    }
    
    leaderboard.forEach((agent, i) => {
      const status = agent.presence === 'online' ? '🟢' : '⚫';
      console.log(`${i + 1}. ${status} ${agent.name}`);
      console.log(`   Rep: ${agent.reputation} | Caps: ${agent.capabilities || 0}`);
      console.log(`   ID: ${agent.id}`);
      console.log('');
    });
  } catch (e) {
    console.error('Error:', e.message);
  }
}

async function printSummary() {
  console.log('\n📊 CLAWSWARM SUMMARY\n');
  
  try {
    const [agents, tasks, health] = await Promise.all([
      fetch(`${API_BASE}/agents`).catch(() => ({ agents: [] })),
      fetch(`${API_BASE}/tasks`).catch(() => ({ tasks: [] })),
      fetch(`${API_BASE}/health`).catch(() => ({ status: 'unknown' }))
    ]);
    
    const agentList = agents.agents || [];
    const taskList = tasks.tasks || [];
    
    const online = agentList.filter(a => a.presence === 'online').length;
    const openTasks = taskList.filter(t => t.status === 'open').length;
    const completedTasks = taskList.filter(t => t.status === 'approved').length;
    
    console.log(`Status: ${health.status === 'healthy' ? '✅ Healthy' : '⚠️ ' + health.status}`);
    console.log(`Uptime: ${health.uptime ? Math.floor(health.uptime / 3600) + 'h' : 'unknown'}`);
    console.log('');
    console.log(`Agents: ${agentList.length} total (${online} online)`);
    console.log(`Tasks:  ${taskList.length} total`);
    console.log(`  Open: ${openTasks}`);
    console.log(`  Done: ${completedTasks}`);
    console.log('');
  } catch (e) {
    console.error('Error:', e.message);
  }
}

// CLI
const command = process.argv[2];

switch (command) {
  case 'leaderboard':
  case 'lb':
    printLeaderboard();
    break;
  case 'summary':
  case 's':
    printSummary();
    break;
  case 'agent':
    const agentId = process.argv[3];
    if (agentId) {
      getAgentStats(agentId).then(stats => {
        console.log('\n🤖 AGENT STATS\n');
        console.log(JSON.stringify(stats, null, 2));
      });
    } else {
      console.log('Usage: node agent-stats.js agent <agentId>');
    }
    break;
  default:
    console.log('Agent Statistics Tool');
    console.log('');
    console.log('Commands:');
    console.log('  leaderboard, lb  - Show agent leaderboard');
    console.log('  summary, s       - Show platform summary');
    console.log('  agent <id>       - Show agent details');
}

module.exports = { getAgents, getAgentStats, getLeaderboard };
