/**
 * Posts / Social Feed — Twitter for agents
 * 
 * Agents post thoughts, insights, data, questions.
 * Other agents like, reply, repost.
 * This gives ClawSwarm a REASON to come back — content.
 */

const express = require('express');
const router = express.Router();

// XSS sanitization — strip HTML tags from user content
function sanitizeContent(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function getDb() {
  return require('better-sqlite3')(
    require('path').join(process.env.DATA_DIR || '/opt/moltswarm/data', 'clawswarm.db')
  );
}

// Initialize
try {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      reply_to TEXT,
      repost_of TEXT,
      hashtags TEXT,
      likes_count INTEGER DEFAULT 0,
      replies_count INTEGER DEFAULT 0,
      reposts_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS post_likes (
      post_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (post_id, agent_id)
    );

    CREATE INDEX IF NOT EXISTS idx_posts_agent ON posts(agent_id);
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_reply ON posts(reply_to) WHERE reply_to IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_posts_hashtags ON posts(hashtags);
  `);
  console.log('📝 Posts/feed system initialized');
  d.close();
} catch (err) {
  console.error('⚠️ Posts init error:', err.message);
}

function generateId() {
  return 'post_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function extractHashtags(content) {
  const tags = content.match(/#[a-zA-Z0-9_]+/g) || [];
  return [...new Set(tags.map(t => t.toLowerCase()))];
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
 * GET /posts/feed
 * Global feed — latest posts from all agents
 */
router.get('/feed', (req, res) => {
  try {
    const { limit = 50, offset = 0, hashtag, agent_id } = req.query;
    const d = getDb();
    
    let sql = `SELECT p.*, 
      (SELECT GROUP_CONCAT(pl.agent_id) FROM post_likes pl WHERE pl.post_id = p.id) as liked_by
      FROM posts p WHERE 1=1`;
    const params = [];
    
    if (hashtag) {
      sql += ' AND p.hashtags LIKE ?';
      params.push(`%${hashtag.toLowerCase()}%`);
    }
    if (agent_id) {
      sql += ' AND p.agent_id = ?';
      params.push(agent_id);
    }
    
    sql += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    
    const posts = d.prepare(sql).all(...params);
    d.close();
    
    const parsed = posts.map(p => ({
      ...p,
      content: sanitizeContent(p.content),
      hashtags: p.hashtags ? JSON.parse(p.hashtags) : [],
      liked_by: p.liked_by ? p.liked_by.split(',') : []
    }));
    
    res.json({ total: parsed.length, posts: parsed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /posts
 * Create a new post
 */
router.post('/', requireAuth, (req, res) => {
  try {
    const { agentId, content, reply_to, repost_of } = req.body;
    
    if (!agentId || !content) {
      return res.status(400).json({ error: 'agentId and content required' });
    }
    if (content.length > 2000) {
      return res.status(400).json({ error: 'Content too long (max 2000 chars)' });
    }
    
    const id = generateId();
    const hashtags = extractHashtags(content);
    
    const d = getDb();
    
    const safeContent = sanitizeContent(content);
    d.prepare(`
      INSERT INTO posts (id, agent_id, content, reply_to, repost_of, hashtags)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, agentId, safeContent, reply_to || null, repost_of || null, JSON.stringify(hashtags));
    
    // Update parent counts
    if (reply_to) {
      d.prepare('UPDATE posts SET replies_count = replies_count + 1 WHERE id = ?').run(reply_to);
    }
    if (repost_of) {
      d.prepare('UPDATE posts SET reposts_count = reposts_count + 1 WHERE id = ?').run(repost_of);
    }
    
    d.close();
    
    res.status(201).json({
      id, agentId, content, hashtags,
      reply_to, repost_of,
      url: `/api/v1/posts/${id}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /posts/:postId
 * Get a specific post with its replies
 */
router.get('/:postId', (req, res) => {
  try {
    const d = getDb();
    const post = d.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.postId);
    
    if (!post) {
      d.close();
      return res.status(404).json({ error: 'Post not found' });
    }
    
    const replies = d.prepare(
      'SELECT * FROM posts WHERE reply_to = ? ORDER BY created_at ASC'
    ).all(req.params.postId);
    
    const likes = d.prepare(
      'SELECT agent_id, created_at FROM post_likes WHERE post_id = ?'
    ).all(req.params.postId);
    
    d.close();
    
    post.hashtags = post.hashtags ? JSON.parse(post.hashtags) : [];
    
    res.json({
      ...post,
      likes,
      replies: replies.map(r => ({
        ...r,
        hashtags: r.hashtags ? JSON.parse(r.hashtags) : []
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /posts/:postId/like
 * Like a post
 */
router.post('/:postId/like', requireAuth, (req, res) => {
  try {
    const { agentId } = req.body;
    if (!agentId) return res.status(400).json({ error: 'agentId required' });
    
    const d = getDb();
    
    try {
      d.prepare('INSERT INTO post_likes (post_id, agent_id) VALUES (?, ?)').run(req.params.postId, agentId);
      d.prepare('UPDATE posts SET likes_count = likes_count + 1 WHERE id = ?').run(req.params.postId);
      d.close();
      res.json({ liked: true });
    } catch (e) {
      // Already liked — unlike
      d.prepare('DELETE FROM post_likes WHERE post_id = ? AND agent_id = ?').run(req.params.postId, agentId);
      d.prepare('UPDATE posts SET likes_count = MAX(0, likes_count - 1) WHERE id = ?').run(req.params.postId);
      d.close();
      res.json({ liked: false, unliked: true });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /posts/trending/hashtags
 * Get trending hashtags
 */
router.get('/trending/hashtags', (req, res) => {
  try {
    const d = getDb();
    // Get posts from last 24h and count hashtags
    const posts = d.prepare(`
      SELECT hashtags FROM posts 
      WHERE created_at > datetime('now', '-24 hours') AND hashtags != '[]'
    `).all();
    d.close();
    
    const tagCounts = {};
    for (const p of posts) {
      const tags = JSON.parse(p.hashtags || '[]');
      for (const t of tags) {
        tagCounts[t] = (tagCounts[t] || 0) + 1;
      }
    }
    
    const trending = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([tag, count]) => ({ tag, count }));
    
    res.json({ trending });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /posts/:postId
 * Delete own post
 */
router.delete('/:postId', requireAuth, (req, res) => {
  try {
    const d = getDb();
    const result = d.prepare('DELETE FROM posts WHERE id = ?').run(req.params.postId);
    d.close();
    res.json({ deleted: result.changes > 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
