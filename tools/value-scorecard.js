#!/usr/bin/env node
/**
 * Value Scorecard - Track actual outcomes, not just activity
 * Codex recommendation: "You track activity not outcomes. Need value scorecard."
 * 
 * Metrics that matter:
 * - Engagement received (not posts made)
 * - Tools shipped and working
 * - Learnings documented
 * - Traffic/conversions (when measurable)
 */

const fs = require('fs');
const path = require('path');

const SCORECARD_PATH = path.join(__dirname, '../memory/value-scorecard.json');

// Initialize or load scorecard
function loadScorecard() {
  try {
    return JSON.parse(fs.readFileSync(SCORECARD_PATH, 'utf8'));
  } catch {
    return {
      created: new Date().toISOString(),
      days: {},
      totals: {
        engagementReceived: 0,
        toolsShipped: 0,
        learningsDocumented: 0,
        postsWithEngagement: 0,
        totalPosts: 0
      }
    };
  }
}

function saveScorecard(data) {
  fs.writeFileSync(SCORECARD_PATH, JSON.stringify(data, null, 2));
}

function today() {
  return new Date().toISOString().split('T')[0];
}

function ensureDay(scorecard, date) {
  if (!scorecard.days[date]) {
    scorecard.days[date] = {
      posts: [],
      tools: [],
      learnings: [],
      engagement: { upvotes: 0, comments: 0, replies: 0 }
    };
  }
  return scorecard.days[date];
}

// Commands
const commands = {
  // Log a post with its engagement
  post: (platform, engagement = 0, notes = '') => {
    const scorecard = loadScorecard();
    const day = ensureDay(scorecard, today());
    day.posts.push({
      platform,
      engagement: parseInt(engagement),
      notes,
      time: new Date().toISOString()
    });
    scorecard.totals.totalPosts++;
    if (engagement > 0) scorecard.totals.postsWithEngagement++;
    scorecard.totals.engagementReceived += parseInt(engagement);
    saveScorecard(scorecard);
    console.log(`✓ Logged post on ${platform} (engagement: ${engagement})`);
  },

  // Log a tool shipped
  tool: (name, description = '') => {
    const scorecard = loadScorecard();
    const day = ensureDay(scorecard, today());
    day.tools.push({ name, description, time: new Date().toISOString() });
    scorecard.totals.toolsShipped++;
    saveScorecard(scorecard);
    console.log(`✓ Logged tool: ${name}`);
  },

  // Log a learning
  learn: (topic, insight = '') => {
    const scorecard = loadScorecard();
    const day = ensureDay(scorecard, today());
    day.learnings.push({ topic, insight, time: new Date().toISOString() });
    scorecard.totals.learningsDocumented++;
    saveScorecard(scorecard);
    console.log(`✓ Logged learning: ${topic}`);
  },

  // Update engagement for today
  engagement: (upvotes = 0, comments = 0, replies = 0) => {
    const scorecard = loadScorecard();
    const day = ensureDay(scorecard, today());
    day.engagement.upvotes += parseInt(upvotes);
    day.engagement.comments += parseInt(comments);
    day.engagement.replies += parseInt(replies);
    scorecard.totals.engagementReceived += parseInt(upvotes) + parseInt(comments) + parseInt(replies);
    saveScorecard(scorecard);
    console.log(`✓ Updated engagement: +${upvotes} upvotes, +${comments} comments, +${replies} replies`);
  },

  // Show summary
  summary: () => {
    const scorecard = loadScorecard();
    const todayData = scorecard.days[today()] || { posts: [], tools: [], learnings: [], engagement: {} };
    
    console.log('\n📊 VALUE SCORECARD');
    console.log('═'.repeat(40));
    
    console.log('\n📅 TODAY:');
    console.log(`  Posts: ${todayData.posts.length}`);
    console.log(`  Tools shipped: ${todayData.tools.length}`);
    console.log(`  Learnings: ${todayData.learnings.length}`);
    console.log(`  Engagement: ${JSON.stringify(todayData.engagement)}`);
    
    console.log('\n📈 ALL TIME:');
    console.log(`  Total posts: ${scorecard.totals.totalPosts}`);
    console.log(`  Posts with engagement: ${scorecard.totals.postsWithEngagement}`);
    console.log(`  Engagement rate: ${scorecard.totals.totalPosts ? ((scorecard.totals.postsWithEngagement / scorecard.totals.totalPosts) * 100).toFixed(1) : 0}%`);
    console.log(`  Tools shipped: ${scorecard.totals.toolsShipped}`);
    console.log(`  Learnings documented: ${scorecard.totals.learningsDocumented}`);
    console.log(`  Total engagement: ${scorecard.totals.engagementReceived}`);
    
    // Value score calculation
    const valueScore = (
      scorecard.totals.engagementReceived * 1 +
      scorecard.totals.toolsShipped * 10 +
      scorecard.totals.learningsDocumented * 2
    );
    console.log(`\n⭐ VALUE SCORE: ${valueScore}`);
    console.log('  (engagement×1 + tools×10 + learnings×2)\n');
  },

  // Show recent activity
  recent: (days = 7) => {
    const scorecard = loadScorecard();
    const dates = Object.keys(scorecard.days).sort().reverse().slice(0, days);
    
    console.log(`\n📅 LAST ${days} DAYS:`);
    console.log('─'.repeat(40));
    
    for (const date of dates) {
      const day = scorecard.days[date];
      const eng = day.engagement;
      console.log(`${date}: ${day.posts.length} posts, ${day.tools.length} tools, ${eng.upvotes || 0}↑ ${eng.comments || 0}💬`);
    }
    console.log('');
  }
};

// CLI
const [,, cmd, ...args] = process.argv;

if (!cmd || cmd === 'help') {
  console.log(`
Value Scorecard - Track outcomes, not activity

Commands:
  post <platform> [engagement] [notes]  - Log a post
  tool <name> [description]             - Log a tool shipped
  learn <topic> [insight]               - Log a learning
  engagement <upvotes> [comments] [replies] - Update today's engagement
  summary                               - Show scorecard summary
  recent [days]                         - Show recent activity

Examples:
  node value-scorecard.js post moltbook 5 "TIL post about quiet hours"
  node value-scorecard.js tool value-scorecard "Tracks real outcomes"
  node value-scorecard.js learn "proactive-mode" "Don't wait for permission"
  node value-scorecard.js summary
`);
} else if (commands[cmd]) {
  commands[cmd](...args);
} else {
  console.log(`Unknown command: ${cmd}. Use 'help' for usage.`);
}
