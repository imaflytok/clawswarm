/**
 * Auth Routes — Login, token refresh, 2FA, key management
 */

const express = require('express');
const router = express.Router();
const authService = require('../services/auth');
const { requireAuth, require2FA, auditLog } = require('../middleware/auth');
const persistence = require('../services/db');

/**
 * Login with API key → get fresh JWT
 * POST /api/v1/auth/login
 */
router.post('/login', async (req, res) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey) return res.status(400).json({ error: 'apiKey required' });

    const hash = authService.hashToken(apiKey);
    const result = await persistence.query(
      'SELECT id, scopes, totp_enabled FROM agents WHERE api_key_hash =  AND status = ',
      [hash, 'active']
    );

    if (!result?.rows?.length) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const agent = result.rows[0];
    const scopes = agent.scopes || ['*'];
    const jwt = authService.issueJwt(agent.id, scopes);

    // Update last_seen
    await persistence.query(
      'UPDATE agents SET last_seen = NOW() WHERE id = ',
      [agent.id]
    );

    res.json({
      agentId: agent.id,
      jwt,
      scopes,
      totpEnabled: agent.totp_enabled || false
    });
  } catch (e) {
    console.error('Login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * Refresh JWT using refresh token
 * POST /api/v1/auth/refresh
 */
router.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });

    const hash = authService.hashToken(refreshToken);
    const result = await persistence.query(
      'SELECT id, scopes FROM agents WHERE refresh_token_hash =  AND refresh_token_expires > NOW() AND status = ',
      [hash, 'active']
    );

    if (!result?.rows?.length) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const agent = result.rows[0];
    const jwt = authService.refreshJwt(agent.id, agent.scopes || ['*']);

    res.json({ agentId: agent.id, jwt });
  } catch (e) {
    console.error('Refresh error:', e);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

/**
 * Setup 2FA
 * POST /api/v1/auth/2fa/setup
 */
router.post('/2fa/setup', requireAuth, auditLog('2fa_setup'), async (req, res) => {
  try {
    const agentId = req.agent.agentId;
    const { secret, uri } = authService.generateTotpSecret();

    // Store secret (not enabled until verified)
    await persistence.query(
      'UPDATE agents SET totp_secret =  WHERE id = ',
      [secret, agentId]
    );

    res.json({
      secret,
      uri,
      message: 'Verify with POST /api/v1/auth/2fa/verify to enable 2FA'
    });
  } catch (e) {
    res.status(500).json({ error: '2FA setup failed' });
  }
});

/**
 * Verify 2FA setup (confirm with first code)
 * POST /api/v1/auth/2fa/verify
 */
router.post('/2fa/verify', requireAuth, async (req, res) => {
  try {
    const agentId = req.agent.agentId;
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'code required' });

    const result = await persistence.query(
      'SELECT totp_secret FROM agents WHERE id = ',
      [agentId]
    );

    if (!result?.rows?.length || !result.rows[0].totp_secret) {
      return res.status(400).json({ error: 'Run 2FA setup first' });
    }

    const valid = authService.verifyTotp(result.rows[0].totp_secret, code);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid 2FA code' });
    }

    await persistence.query(
      'UPDATE agents SET totp_enabled = true WHERE id = ',
      [agentId]
    );

    res.json({ enabled: true, message: '2FA is now active' });
  } catch (e) {
    res.status(500).json({ error: '2FA verification failed' });
  }
});

/**
 * Rotate API key (requires 2FA if enabled)
 * POST /api/v1/auth/rotate-key
 */
router.post('/rotate-key', requireAuth, require2FA, auditLog('key_rotate'), async (req, res) => {
  try {
    const agentId = req.agent.agentId;

    // If 2FA enabled, verify the code
    if (req._2faCode) {
      const agent = await persistence.query(
        'SELECT totp_secret FROM agents WHERE id = ',
        [agentId]
      );
      if (agent?.rows?.[0]?.totp_secret) {
        const valid = authService.verifyTotp(agent.rows[0].totp_secret, req._2faCode);
        if (!valid) return res.status(401).json({ error: 'Invalid 2FA code' });
      }
    }

    const newKey = authService.generateApiKey();
    const newHash = authService.hashToken(newKey);

    await persistence.query(
      'UPDATE agents SET api_key_hash = , updated_at = NOW() WHERE id = ',
      [newHash, agentId]
    );

    res.json({
      apiKey: newKey,
      message: 'Store this key securely — it will not be shown again'
    });
  } catch (e) {
    res.status(500).json({ error: 'Key rotation failed' });
  }
});

module.exports = router;
