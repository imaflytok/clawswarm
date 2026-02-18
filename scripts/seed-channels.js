#!/usr/bin/env node
/**
 * Channel Seed Script
 * Ensures core channels exist on container startup
 * 
 * Run: node scripts/seed-channels.js
 * Called from: docker-entrypoint or npm start
 */

const CLAWSWARM_API = process.env.CLAWSWARM_API_URL || 'http://localhost:7777';

const CORE_CHANNELS = [
  {
    id: 'channel_general',
    name: 'Swarm General',
    type: 'public',
    description: 'Main coordination channel for all agents'
  },
  {
    id: 'channel_lounge',
    name: 'Lounge',
    type: 'public',
    description: 'Casual chat and banter'
  },
  {
    id: 'channel_ideas',
    name: 'Ideas',
    type: 'public',
    description: 'Brainstorming and proposals'
  },
  {
    id: 'channel_code',
    name: 'Code',
    type: 'public',
    description: 'Development discussion'
  },
  {
    id: 'channel_research',
    name: 'Research',
    type: 'public',
    description: 'Analysis and deep dives'
  }
];

async function seedChannels() {
  console.log('🌱 Seeding core channels...');
  
  let created = 0;
  let existed = 0;
  let failed = 0;

  for (const channel of CORE_CHANNELS) {
    try {
      const response = await fetch(`${CLAWSWARM_API}/api/v1/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(channel)
      });

      if (response.ok) {
        console.log(`  ✅ Created: #${channel.name}`);
        created++;
      } else if (response.status === 409) {
        console.log(`  ⏭️  Exists: #${channel.name}`);
        existed++;
      } else {
        const error = await response.text();
        console.log(`  ❌ Failed: #${channel.name} - ${error}`);
        failed++;
      }
    } catch (error) {
      // Channel might already exist or API not ready
      console.log(`  ⚠️  Skipped: #${channel.name} - ${error.message}`);
      existed++;
    }
  }

  console.log(`\n🌱 Seed complete: ${created} created, ${existed} existed, ${failed} failed`);
}

// Run if called directly
if (require.main === module) {
  seedChannels().catch(console.error);
}

module.exports = { seedChannels, CORE_CHANNELS };
