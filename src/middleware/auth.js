/**
 * ClawSwarm Auth Middleware
 * Validates JWT or API key on protected routes.
 */

const auth = require('../services/auth');
const persistence = require('../services/db');

/**
 * Require authentication — blocks unauthenticated requests
 */
function requireAuth(req, res, next) {
  extractIdentity(req).then(identity => {
    if (!identity) {
      return res.status(401).json({
        error: 'Authentication required',
        hint: 'Include Authorization: Bearer <jwt> or X-API-Key: <key>'
      });
    }
    req.agent = identity;
    next();
  }).catch(e => {
    console.error('Auth error:', e);
    res.status(500).json({ error: 'Authentication error' });
  });
}

/**
 * Optional auth — attaches identity if present, passes through if not
 */
function optionalAuth(req, res, next) {
  extractIdentity(req).then(identity => {
    if (identity) req.agent = identity;
    next();
  }).catch(() => next());
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
  if (!req.agent?.totpEnabled) return next();
  if (!code) {
    return res.status(403).json({
      error: '2FA code required',
      hint: 'Include X-2FA-Code header or _2fa body field'
    });
  }
  req._2faCode = code;
  next();
}

/**
 * Extract agent identity from request (async — does DB lookup for API keys)
 */
async function extractIdentity(req) {
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
    const hash = auth.hashToken(apiKey);
    try {
      const result = await persistence.query(
        'SELECT id, scopes, totp_enabled, roles FROM agents WHERE api_key_hash =  AND status = ',
        [hash, 'active']
      );
      if (result?.rows?.length) {
        const agent = result.rows[0];
        return {
          agentId: agent.id,
          scopes: agent.scopes || ['*'],
          roles: agent.roles || ['member'],
          totpEnabled: agent.totp_enabled,
          authMethod: 'api_key'
        };
      }
    } catch (e) {
      console.error('API key lookup error:', e.message);
    }
  }

  // Legacy: X-Agent-ID header (backward compat)
  const legacyId = req.headers['x-agent-id'] || req.body?.agentId;
  if (legacyId) {
    return {
      agentId: legacyId,
      scopes: ['read', 'messaging'],
      authMethod: 'legacy',
      legacy: true
    };
  }

  return null;
}

/**
 * Audit log middleware
 */
function auditLog(action) {
  return (req, res, next) => {
    if (req.agent) {
      logAudit({
        agentId: req.agent.agentId,
        action,
        target: req.params.agentId || req.params.targetAgentId || req.params.taskId || null,
        ip: req.ip
      }).catch(() => {});
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
    // Silent fail — audit shouldn't block operations
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
