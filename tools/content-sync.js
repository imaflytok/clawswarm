#!/usr/bin/env node
/**
 * Content Sync Tool
 * Manage cross-platform content for consistent messaging
 * 
 * Adapts content for different platform constraints and formats
 */

const fs = require('fs');
const path = require('path');

const CONTENT_DIR = path.join(__dirname, '../memory/content');

// Platform constraints
const PLATFORMS = {
  twitter: {
    maxLength: 280,
    supportsMarkdown: false,
    supportsLinks: true,
    format: 'short'
  },
  telegram: {
    maxLength: 4096,
    supportsMarkdown: true,
    supportsLinks: true,
    format: 'full'
  },
  discord: {
    maxLength: 2000,
    supportsMarkdown: true,
    supportsLinks: true,
    format: 'full'
  },
  moltbook: {
    maxLength: 5000,
    supportsMarkdown: true,
    supportsLinks: true,
    format: 'full'
  },
  clawswarm: {
    maxLength: 10000,
    supportsMarkdown: true,
    supportsLinks: true,
    format: 'full'
  }
};

// Strip markdown for platforms that don't support it
function stripMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')  // bold
    .replace(/\*(.+?)\*/g, '$1')      // italic
    .replace(/__(.+?)__/g, '$1')      // underline
    .replace(/`(.+?)`/g, '$1')        // code
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 $2'); // links
}

// Truncate with ellipsis
function truncate(text, maxLength) {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

// Adapt content for a specific platform
function adaptContent(content, platform) {
  const config = PLATFORMS[platform];
  if (!config) {
    console.log(`Unknown platform: ${platform}`);
    return content;
  }
  
  let adapted = content;
  
  // Strip markdown if not supported
  if (!config.supportsMarkdown) {
    adapted = stripMarkdown(adapted);
  }
  
  // Truncate if too long
  adapted = truncate(adapted, config.maxLength);
  
  return adapted;
}

// Create content variants for all platforms
function createVariants(content) {
  const variants = {};
  
  for (const platform of Object.keys(PLATFORMS)) {
    variants[platform] = adaptContent(content, platform);
  }
  
  return variants;
}

// Save content for later posting
function saveContent(id, content, metadata = {}) {
  if (!fs.existsSync(CONTENT_DIR)) {
    fs.mkdirSync(CONTENT_DIR, { recursive: true });
  }
  
  const item = {
    id: id || `content_${Date.now()}`,
    original: content,
    variants: createVariants(content),
    metadata: {
      ...metadata,
      createdAt: new Date().toISOString()
    },
    posted: {}
  };
  
  const filePath = path.join(CONTENT_DIR, `${item.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(item, null, 2));
  
  console.log(`✅ Saved content: ${item.id}`);
  console.log(`   Original length: ${content.length}`);
  console.log(`   Variants: ${Object.keys(PLATFORMS).join(', ')}`);
  
  return item;
}

// Load saved content
function loadContent(id) {
  const filePath = path.join(CONTENT_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) {
    console.log(`Content not found: ${id}`);
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Mark content as posted to a platform
function markPosted(id, platform, postId) {
  const item = loadContent(id);
  if (!item) return null;
  
  item.posted[platform] = {
    postId,
    timestamp: new Date().toISOString()
  };
  
  const filePath = path.join(CONTENT_DIR, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(item, null, 2));
  
  console.log(`✅ Marked ${id} as posted to ${platform}`);
  return item;
}

// List pending content
function listPending() {
  if (!fs.existsSync(CONTENT_DIR)) {
    console.log('No content saved yet.');
    return [];
  }
  
  const files = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith('.json'));
  const items = files.map(f => {
    const item = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, f), 'utf8'));
    return {
      id: item.id,
      preview: item.original.substring(0, 50) + '...',
      postedTo: Object.keys(item.posted),
      pending: Object.keys(PLATFORMS).filter(p => !item.posted[p])
    };
  });
  
  console.log('\n📋 SAVED CONTENT\n');
  items.forEach(item => {
    console.log(`${item.id}:`);
    console.log(`  Preview: "${item.preview}"`);
    console.log(`  Posted: ${item.postedTo.length ? item.postedTo.join(', ') : 'none'}`);
    console.log(`  Pending: ${item.pending.join(', ')}`);
    console.log('');
  });
  
  return items;
}

// CLI
const [,, command, ...args] = process.argv;

switch (command) {
  case 'adapt':
    const [platform, ...contentParts] = args;
    const content = contentParts.join(' ');
    if (!platform || !content) {
      console.log('Usage: node content-sync.js adapt <platform> "<content>"');
    } else {
      const adapted = adaptContent(content, platform);
      console.log(`\n${platform.toUpperCase()} (${adapted.length}/${PLATFORMS[platform]?.maxLength || '?'}):\n`);
      console.log(adapted);
    }
    break;
    
  case 'save':
    const [id, ...saveParts] = args;
    const saveContent = saveParts.join(' ');
    if (!saveContent) {
      console.log('Usage: node content-sync.js save [id] "<content>"');
    } else {
      saveContent(id !== saveContent ? id : null, saveContent);
    }
    break;
    
  case 'get':
    const [getId, getPlatform] = args;
    if (!getId) {
      console.log('Usage: node content-sync.js get <id> [platform]');
    } else {
      const item = loadContent(getId);
      if (item) {
        if (getPlatform) {
          console.log(item.variants[getPlatform] || 'Platform not found');
        } else {
          console.log(JSON.stringify(item, null, 2));
        }
      }
    }
    break;
    
  case 'list':
    listPending();
    break;
    
  case 'platforms':
    console.log('\n📱 PLATFORM LIMITS\n');
    Object.entries(PLATFORMS).forEach(([name, config]) => {
      console.log(`${name}:`);
      console.log(`  Max length: ${config.maxLength}`);
      console.log(`  Markdown: ${config.supportsMarkdown ? 'Yes' : 'No'}`);
      console.log('');
    });
    break;
    
  default:
    console.log('Content Sync Tool');
    console.log('');
    console.log('Commands:');
    console.log('  adapt <platform> "<content>" - Adapt content for platform');
    console.log('  save [id] "<content>"         - Save content with variants');
    console.log('  get <id> [platform]           - Get saved content');
    console.log('  list                          - List saved content');
    console.log('  platforms                     - Show platform limits');
}

module.exports = { adaptContent, createVariants, saveContent, PLATFORMS };
