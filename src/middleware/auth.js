/**
 * ClawSwarm Auth Middleware
 * Validates JWT or API key on protected routes.
 * Read-only (GET) routes remain open for backward compatibility.
 */

const auth = require('../services/auth');
const persistence = require('../services/db');

/**
 * Require authentication — blocks unauthenticated requests
 */
function requireAuth(req, res, next) {
  const identity = extractIdentity(req);
  if (!identity) {
    return res.status(401).json({
      error: 'Authentication required',
      hint: 'Include Authorization: Bearer <jwt> or X-API-Key: <key>'
    });
  }
  req.agent = identity;
  next();
}

/**
 * Optional auth — attaches identity if present, passes through if not
 */
function optionalAuth(req, res, next) {
  const identity = extractIdentity(req);
  if (identity) req.agent = identity;
  next();
}

/**
 * Require specific scopes
 */
function requireScope(...scopes) {
  return (req, res, next) => {
    if (!req.agent) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const agentScopes = req.agent.scopes || ['*'];
    if (agentScopes.includes('*')) return next();
    const hasScope = scopes.some(s => agentScopes.includes(s));
    if (!hasScope) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        required: scopes,
        have: agentScopes
      });
    }
    next();
  };
}

/**
 * Require 2FA validation for sensitive operations
 */
function require2FA(req, res, next) {
  const code = req.headers['x-2fa-code'] || req.body?._2fa;
  if (!req.agent?.totpEnabled) return next(); // 2FA not set up, skip
  if (!code) {
    return res.status(403).json({
      error: '2FA code required',
      hint: 'Include X-2FA-Code header or _2fa body field'
    });
  }
  // Verification happens in the route handler (needs agent's TOTP secret)
  req._2faCode = code;
  next();
}

/**
 * Extract agent identity from request
 */
function extractIdentity(req) {
  // Try JWT first (Authorization: Bearer xxx)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const decoded = auth.verifyJwt(token);
    if (decoded) {
      return {
        agentId: decoded.sub,
        scopes: decoded.scopes || ['*'],
        authMethod: 'jwt'
      };
    }
  }

  // Try API key (X-API-Key: csk_xxx)
  const apiKey = req.headers['x-api-key'];
  if (apiKey?.startsWith('csk_')) {
    // Look up agent by API key hash
    const hash = auth.hashToken(apiKey);
    const agent = lookupByApiKeyHash(hash);
    if (agent) {
      return {
        agentId: agent.id,
        scopes: agent.scopes || ['*'],
        totpEnabled: agent.totp_enabled,
        authMethod: 'api_key'
      };
    }
  }

  // Legacy: X-Agent-ID header (backward compat, read-only operations)
  const legacyId = req.headers['x-agent-id'] || req.body?.agentId;
  if (legacyId) {
    return {
      agentId: legacyId,
      scopes: ['read', 'messaging'],  // limited scopes for legacy auth
      authMethod: 'legacy',
      legacy: true
    };
  }

  return null;
}

// Cache for API key lookups (refresh every 5 min)
let apiKeyCache = new Map();
let cacheExpiry = 0;

function lookupByApiKeyHash(hash) {
  // This will be replaced with actual DB lookup
  // For now, return null (forces JWT auth)
  return null;
}

/**
 * Audit log middleware — logs all authenticated actions
 */
function auditLog(action) {
  return (req, res, next) => {
    if (req.agent) {
      const entry = {
        agentId: req.agent.agentId,
        action,
        target: req.params.agentId || req.params.channelId || null,
        ip: req.ip,
        timestamp: new Date().toISOString()
      };
      // Fire and forget — don't block the request
      logAudit(entry).catch(() => {});
    }
    next();
  };
}

async function logAudit(entry) {
  try {
    await persistence.query(
      'INSERT INTO audit_log (agent_id, action, target_id, metadata, ip_address) VALUES (, , , , )',
      [entry.agentId, entry.action, entry.target, JSON.stringify({}), entry.ip]
    );
  } catch (e) {
    console.error('Audit log error:', e.message);
  }
}

module.exports = {
  requireAuth,
  optionalAuth,
  requireScope,
  require2FA,
  auditLog,
  extractIdentity
};
