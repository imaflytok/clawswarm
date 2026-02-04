#!/usr/bin/env node
/**
 * Engagement Tracker
 * Track and analyze performance across platforms
 * 
 * Usage: node engagement-tracker.js [command]
 * Commands: log, report, best
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '../memory/engagement-log.json');

// Initialize data file
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { posts: [], lastUpdated: null };
  }
}

function saveData(data) {
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Log a new post
function logPost(platform, content, postId, url) {
  const data = loadData();
  
  const post = {
    id: postId || `post_${Date.now()}`,
    platform,
    content: content.substring(0, 200),
    url,
    timestamp: new Date().toISOString(),
    metrics: {
      likes: 0,
      comments: 0,
      shares: 0,
      views: 0
    },
    checkCount: 0
  };
  
  data.posts.push(post);
  saveData(data);
  
  console.log(`✅ Logged ${platform} post: ${post.id}`);
  return post;
}

// Update metrics for a post
function updateMetrics(postId, metrics) {
  const data = loadData();
  const post = data.posts.find(p => p.id === postId);
  
  if (!post) {
    console.log(`❌ Post not found: ${postId}`);
    return null;
  }
  
  post.metrics = { ...post.metrics, ...metrics };
  post.checkCount++;
  post.lastChecked = new Date().toISOString();
  
  saveData(data);
  console.log(`📊 Updated metrics for ${postId}`);
  return post;
}

// Generate report
function generateReport(days = 7) {
  const data = loadData();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  
  const recentPosts = data.posts.filter(p => new Date(p.timestamp) > cutoff);
  
  // Group by platform
  const byPlatform = {};
  recentPosts.forEach(post => {
    if (!byPlatform[post.platform]) {
      byPlatform[post.platform] = { count: 0, likes: 0, comments: 0, shares: 0 };
    }
    const p = byPlatform[post.platform];
    p.count++;
    p.likes += post.metrics.likes || 0;
    p.comments += post.metrics.comments || 0;
    p.shares += post.metrics.shares || 0;
  });
  
  console.log(`\n📈 ENGAGEMENT REPORT (Last ${days} days)\n`);
  console.log(`Total posts: ${recentPosts.length}\n`);
  
  Object.entries(byPlatform).forEach(([platform, stats]) => {
    const avgLikes = stats.count ? (stats.likes / stats.count).toFixed(1) : 0;
    console.log(`${platform}:`);
    console.log(`  Posts: ${stats.count}`);
    console.log(`  Total likes: ${stats.likes} (avg: ${avgLikes})`);
    console.log(`  Comments: ${stats.comments}`);
    console.log(`  Shares: ${stats.shares}`);
    console.log('');
  });
  
  return byPlatform;
}

// Find best performing posts
function findBest(metric = 'likes', limit = 5) {
  const data = loadData();
  
  const sorted = [...data.posts].sort((a, b) => 
    (b.metrics[metric] || 0) - (a.metrics[metric] || 0)
  );
  
  console.log(`\n🏆 TOP ${limit} POSTS BY ${metric.toUpperCase()}\n`);
  
  sorted.slice(0, limit).forEach((post, i) => {
    console.log(`${i + 1}. [${post.platform}] ${post.metrics[metric]} ${metric}`);
    console.log(`   "${post.content.substring(0, 80)}..."`);
    console.log(`   Posted: ${post.timestamp}`);
    if (post.url) console.log(`   URL: ${post.url}`);
    console.log('');
  });
  
  return sorted.slice(0, limit);
}

// CLI
const command = process.argv[2];

switch (command) {
  case 'log':
    const platform = process.argv[3];
    const content = process.argv[4];
    const postId = process.argv[5];
    const url = process.argv[6];
    if (!platform || !content) {
      console.log('Usage: node engagement-tracker.js log <platform> "<content>" [postId] [url]');
    } else {
      logPost(platform, content, postId, url);
    }
    break;
    
  case 'update':
    const id = process.argv[3];
    const likes = parseInt(process.argv[4]) || 0;
    const comments = parseInt(process.argv[5]) || 0;
    if (!id) {
      console.log('Usage: node engagement-tracker.js update <postId> <likes> [comments]');
    } else {
      updateMetrics(id, { likes, comments });
    }
    break;
    
  case 'report':
    const days = parseInt(process.argv[3]) || 7;
    generateReport(days);
    break;
    
  case 'best':
    const metric = process.argv[3] || 'likes';
    const limit = parseInt(process.argv[4]) || 5;
    findBest(metric, limit);
    break;
    
  default:
    console.log('Engagement Tracker');
    console.log('');
    console.log('Commands:');
    console.log('  log <platform> "<content>" [postId] [url] - Log a new post');
    console.log('  update <postId> <likes> [comments]        - Update metrics');
    console.log('  report [days]                              - Generate report');
    console.log('  best [metric] [limit]                      - Find best posts');
}

module.exports = { logPost, updateMetrics, generateReport, findBest };
