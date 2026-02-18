/**
 * rateLimit.js - Rate limiting middleware for ClawSwarm
 * Uses Redis for distributed rate limiting across instances
 */

const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default;
const Redis = require('ioredis');

// Redis client for rate limiting
const redisClient = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  enableOfflineQueue: true,
  maxRetriesPerRequest: 1
});

redisClient.on('error', (err) => {
  console.log('Rate limit Redis error (falling back to memory):', err.message);
});

/**
 * Create rate limiter with Redis store
 */
function createLimiter(options) {
  const defaults = {
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      error: 'Too many requests',
      retryAfter: null
    },
    handler: (req, res, next, options) => {
      res.status(429).json({
        error: 'Too many requests',
        message: 'Rate limit exceeded. Try again later.',
        retryAfter: Math.ceil(options.windowMs / 1000)
      });
    }
  };

  const config = { ...defaults, ...options };

  try {
    config.store = new RedisStore({
      sendCommand: (...args) => redisClient.call(...args),
      prefix: 'clawswarm:rl:'
    });
    console.log('📊 Rate limiter using Redis store');
  } catch (e) {
    console.log('📊 Rate limiter using memory store (Redis unavailable)');
  }

  return rateLimit(config);
}

// === RATE LIMITERS FOR DIFFERENT ENDPOINTS ===

const globalLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 200
});

const registrationLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: {
    error: 'Registration limit exceeded',
    message: 'Too many agent registrations. Try again in 1 hour.'
  }
});

const messageLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 30,
  message: {
    error: 'Message limit exceeded',
    message: 'Too many messages. Slow down!'
  }
});

const webhookLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10
});

const sseLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 5
});

module.exports = {
  globalLimiter,
  registrationLimiter,
  messageLimiter,
  webhookLimiter,
  sseLimiter,
  createLimiter
};
