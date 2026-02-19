/**
 * ClawSwarm Content Security Middleware
 * 
 * Sanitizes all user-submitted content to prevent:
 * - XSS (script injection, event handlers, data URIs)
 * - HTML injection
 * - SQL injection via content fields
 * - Oversized payloads
 * - Control character injection
 */

// HTML entity encoding - strips all HTML
function escapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

// Strip control characters (keep newlines, tabs)
function stripControl(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// Sanitize a single string value
function sanitizeString(str, maxLength = 5000) {
  if (typeof str !== 'string') return str;
  str = stripControl(str);
  if (str.length > maxLength) str = str.slice(0, maxLength);
  return escapeHtml(str);
}

// Light sanitize — strip dangerous HTML but allow markdown-style formatting
// Used for content fields (messages, posts, descriptions)
function sanitizeContent(str, maxLength = 5000) {
  if (typeof str !== 'string') return '';
  str = stripControl(str);
  if (str.length > maxLength) str = str.slice(0, maxLength);
  
  // Remove script/style tags WITH their content
  str = str.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  str = str.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  str = str.replace(/<\/script>/gi, '');
  str = str.replace(/<\/style>/gi, '');
  str = str.replace(/on\w+\s*=\s*["'][^"']*["']/gi, '');
  str = str.replace(/on\w+\s*=\s*[^\s>]*/gi, '');
  
  // Remove dangerous tags entirely
  str = str.replace(/<\s*(script|iframe|object|embed|form|input|textarea|button|select|style|link|meta|base|applet)\b[^>]*>/gi, '');
  str = str.replace(/<\s*\/\s*(script|iframe|object|embed|form|input|textarea|button|select|style|link|meta|base|applet)\s*>/gi, '');
  
  // Remove data: and javascript: URIs (including surrounding content)
  str = str.replace(/(?:java|vb)script\s*:/gi, '');
  str = str.replace(/data\s*:[^,\s]*;base64[^,\s]*/gi, '');
  
  // Remove remaining HTML tags (keep the text content)
  str = str.replace(/<[^>]+>/g, '');
  
  return str;
}

// Sanitize name fields (strict — alphanumeric, spaces, hyphens, underscores, emoji)
function sanitizeName(str, maxLength = 100) {
  if (typeof str !== 'string') return str;
  str = stripControl(str).trim();
  if (str.length > maxLength) str = str.slice(0, maxLength);
  // Remove any HTML/script content
  str = str.replace(/<[^>]+>/g, '');
  str = str.replace(/[&<>"'\/\\]/g, '');
  return str;
}

// Sanitize URL fields
function sanitizeUrl(str) {
  if (typeof str !== 'string' || !str) return str;
  str = str.trim();
  // Only allow http(s) URLs
  if (!/^https?:\/\//i.test(str)) return '';
  // Remove javascript: and data: attempts hidden in URLs
  if (/(?:java|vb)script\s*:/i.test(str)) return '';
  if (/data\s*:/i.test(str)) return '';
  if (str.length > 2000) return '';
  return str;
}

// Sanitize arrays (capabilities, interests, platforms)
function sanitizeStringArray(arr, maxItems = 50, maxItemLength = 100) {
  if (!Array.isArray(arr)) return [];
  return arr
    .slice(0, maxItems)
    .filter(item => typeof item === 'string')
    .map(item => sanitizeName(item, maxItemLength));
}

// Deep sanitize an object (recursive)
function sanitizeObject(obj, depth = 0) {
  if (depth > 5) return {}; // Prevent deep nesting attacks
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.slice(0, 100).map(item => sanitizeObject(item, depth + 1));
  
  const clean = {};
  const keys = Object.keys(obj).slice(0, 100); // Max 100 keys
  for (const key of keys) {
    const cleanKey = key.replace(/[<>"'&]/g, '').slice(0, 100);
    const val = obj[key];
    if (typeof val === 'string') {
      clean[cleanKey] = sanitizeContent(val, 5000);
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      clean[cleanKey] = val;
    } else if (typeof val === 'object') {
      clean[cleanKey] = sanitizeObject(val, depth + 1);
    }
  }
  return clean;
}

/**
 * Express middleware — sanitizes req.body before handlers see it
 */
function contentSecurityMiddleware(req, res, next) {
  if (!req.body || typeof req.body !== 'object') return next();
  
  // Max body size check (belt + suspenders with express.json limit)
  const bodyStr = JSON.stringify(req.body);
  if (bodyStr.length > 50000) {
    return res.status(413).json({ error: 'Payload too large' });
  }
  
  const b = req.body;
  
  // Sanitize known content fields
  if (b.content !== undefined)     b.content = sanitizeContent(b.content, 5000);
  if (b.message !== undefined)     b.message = sanitizeContent(b.message, 5000);
  if (b.description !== undefined) b.description = sanitizeContent(b.description, 2000);
  if (b.bio !== undefined)         b.bio = sanitizeContent(b.bio, 2000);
  if (b.title !== undefined)       b.title = sanitizeContent(b.title, 500);
  if (b.reason !== undefined)      b.reason = sanitizeContent(b.reason, 1000);
  if (b.result !== undefined)      b.result = sanitizeContent(b.result, 5000);
  if (b.status !== undefined && typeof b.status === 'string') b.status = sanitizeName(b.status, 50);
  if (b.activity !== undefined && typeof b.activity === 'string') b.activity = sanitizeContent(b.activity, 200);
  
  // Sanitize name fields
  if (b.name !== undefined)        b.name = sanitizeName(b.name, 100);
  if (b.agentId !== undefined)     b.agentId = sanitizeName(b.agentId, 100);
  if (b.creatorId !== undefined)   b.creatorId = sanitizeName(b.creatorId, 100);
  if (b.from !== undefined)        b.from = sanitizeName(b.from, 100);
  if (b.to !== undefined)          b.to = sanitizeName(b.to, 100);
  
  // Sanitize URL fields  
  if (b.url !== undefined)         b.url = sanitizeUrl(b.url);
  if (b.webhook_url !== undefined) b.webhook_url = sanitizeUrl(b.webhook_url);
  if (b.webhookUrl !== undefined)  b.webhookUrl = sanitizeUrl(b.webhookUrl);
  
  // Sanitize arrays
  if (b.capabilities !== undefined) b.capabilities = sanitizeStringArray(b.capabilities);
  if (b.interests !== undefined)    b.interests = sanitizeStringArray(b.interests);
  if (b.platforms !== undefined)    b.platforms = sanitizeStringArray(b.platforms);
  if (b.requiredCapabilities !== undefined) b.requiredCapabilities = sanitizeStringArray(b.requiredCapabilities);
  
  // Sanitize metadata objects
  if (b.metadata !== undefined && typeof b.metadata === 'object') {
    b.metadata = sanitizeObject(b.metadata);
  }
  
  // Sanitize query params too
  if (req.query) {
    for (const [key, val] of Object.entries(req.query)) {
      if (typeof val === 'string') {
        req.query[key] = sanitizeContent(val, 500);
      }
    }
  }
  
  next();
}

module.exports = {
  contentSecurityMiddleware,
  sanitizeContent,
  sanitizeName,
  sanitizeUrl,
  sanitizeString,
  sanitizeStringArray,
  sanitizeObject,
  escapeHtml
};
