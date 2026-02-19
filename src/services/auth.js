/**
 * ClawSwarm Auth Service — JWT, API Keys, Refresh Tokens, 2FA
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// JWT secret (generate once, persist in env)
if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET environment variable is required");
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_TTL = '24h';
const REFRESH_TTL_DAYS = 30;

/**
 * Generate a prefixed API key
 */
function generateApiKey() {
  return 'csk_' + crypto.randomBytes(24).toString('base64url');
}

/**
 * Generate a refresh token
 */
function generateRefreshToken() {
  return 'csr_' + crypto.randomBytes(32).toString('base64url');
}

/**
 * Hash a token for storage (never store raw keys)
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Issue a JWT for an agent
 */
function issueJwt(agentId, scopes = ['*']) {
  return jwt.sign(
    { sub: agentId, scopes, type: 'access' },
    JWT_SECRET,
    { expiresIn: JWT_TTL }
  );
}

/**
 * Verify a JWT
 */
function verifyJwt(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

/**
 * Create auth credentials for a new agent
 */
async function createCredentials(agentId, scopes = ['*']) {
  const apiKey = generateApiKey();
  const refreshToken = generateRefreshToken();
  const jwtToken = issueJwt(agentId, scopes);

  const refreshExpires = new Date();
  refreshExpires.setDate(refreshExpires.getDate() + REFRESH_TTL_DAYS);

  return {
    apiKey,               // Show to user ONCE
    apiKeyHash: hashToken(apiKey),
    refreshToken,         // Show to user ONCE
    refreshTokenHash: hashToken(refreshToken),
    refreshTokenExpires: refreshExpires.toISOString(),
    jwt: jwtToken,
    scopes
  };
}

/**
 * Validate an API key against stored hash
 */
function validateApiKey(providedKey, storedHash) {
  const providedHash = hashToken(providedKey);
  return crypto.timingSafeEqual(
    Buffer.from(providedHash, "hex"),
    Buffer.from(storedHash, "hex")
  );
}

/**
 * Refresh JWT using refresh token
 */
function refreshJwt(agentId, scopes) {
  return issueJwt(agentId, scopes);
}

/**
 * Generate TOTP secret for 2FA setup
 */
function generateTotpSecret() {
  // Simple TOTP implementation using HMAC-based OTP
  // Generate base32 secret for TOTP (Google Authenticator compatible)
  const bytes = crypto.randomBytes(20);
  const base32chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let secret = "";
  for (let i = 0; i < bytes.length; i += 5) {
    let chunk = 0;
    for (let j = 0; j < 5 && i + j < bytes.length; j++) {
      chunk = (chunk << 8) | bytes[i + j];
    }
    for (let k = 0; k < 8; k++) {
      secret += base32chars[(chunk >> (35 - k * 5)) & 31];
    }
  }
  return {
    secret,
    uri: `otpauth://totp/ClawSwarm?secret=${secret}&issuer=ClawSwarm`
  };
}

/**
 * Verify TOTP code
 */
function verifyTotp(secret, code) {
  // Time-based: 30-second windows, check current + ±1 window
  const time = Math.floor(Date.now() / 30000);
  for (let offset = -1; offset <= 1; offset++) {
    const expected = generateTotpCode(secret, time + offset);
    if (expected === code) return true;
  }
  return false;
}

/**
 * Generate TOTP code for a time step
 */
function generateTotpCode(secret, timeStep) {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(0, 0);
  buffer.writeUInt32BE(timeStep, 4);

  const hmac = crypto.createHmac('sha1', Buffer.from(secret, 'hex'));
  hmac.update(buffer);
  const hash = hmac.digest();

  const offset = hash[hash.length - 1] & 0x0f;
  const code = (
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff)
  ) % 1000000;

  return code.toString().padStart(6, '0');
}

/**
 * Sign a webhook payload
 */
function signWebhook(body, secret) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = timestamp + '.' + (typeof body === 'string' ? body : JSON.stringify(body));
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { signature: `sha256=${signature}`, timestamp };
}

module.exports = {
  generateApiKey,
  generateRefreshToken,
  hashToken,
  issueJwt,
  verifyJwt,
  createCredentials,
  validateApiKey,
  refreshJwt,
  generateTotpSecret,
  verifyTotp,
  signWebhook,
};
