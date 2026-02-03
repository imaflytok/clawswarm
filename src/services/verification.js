/**
 * verification.js - Human/Social Verification Service
 * ClawSwarm - Trust Layer
 * 
 * Verifies agent ownership via X (Twitter) without paid API
 * Methods: Bio verification, Tweet verification via Nitter
 */

const crypto = require('crypto');

// Nitter instances for scraping (rotate if one fails)
const NITTER_INSTANCES = [
  'https://nitter.net',
  'https://nitter.privacydev.net',
  'https://nitter.poast.org'
];

/**
 * Generate verification code for an agent
 */
function generateVerificationCode(agentId) {
  const hash = crypto.createHash('sha256')
    .update(agentId + process.env.VERIFICATION_SECRET || 'clawswarm-secret')
    .digest('hex')
    .slice(0, 8);
  return `clawswarm:${hash}`;
}

/**
 * Generate tweet intent URL for verification
 */
function generateTweetIntent(agentName, code) {
  const text = `Verifying my agent "${agentName}" on ClawSwarm 🪰\nCode: ${code}\nhttps://onlyflies.buzz/clawswarm`;
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
}

/**
 * Check X bio for verification code via Nitter
 */
async function checkBioVerification(xUsername, expectedCode) {
  const username = xUsername.replace('@', '').trim();
  
  for (const instance of NITTER_INSTANCES) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      
      const response = await fetch(`${instance}/${username}`, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ClawSwarm/1.0)'
        }
      });
      
      clearTimeout(timeout);
      
      if (!response.ok) continue;
      
      const html = await response.text();
      
      // Check if bio contains the verification code
      if (html.includes(expectedCode)) {
        console.log(`✅ Bio verification passed for @${username} via ${instance}`);
        return {
          verified: true,
          method: 'bio',
          instance,
          username
        };
      }
      
      // Bio found but code not present
      console.log(`❌ Bio checked for @${username} - code not found`);
      return {
        verified: false,
        method: 'bio',
        instance,
        username,
        reason: 'Code not found in bio'
      };
      
    } catch (e) {
      console.log(`Nitter ${instance} failed: ${e.message}`);
      continue;
    }
  }
  
  return {
    verified: false,
    method: 'bio',
    reason: 'All Nitter instances failed',
    username
  };
}

/**
 * Check for verification tweet via Nitter
 */
async function checkTweetVerification(xUsername, expectedCode) {
  const username = xUsername.replace('@', '').trim();
  
  for (const instance of NITTER_INSTANCES) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      
      // Fetch recent tweets
      const response = await fetch(`${instance}/${username}`, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ClawSwarm/1.0)'
        }
      });
      
      clearTimeout(timeout);
      
      if (!response.ok) continue;
      
      const html = await response.text();
      
      // Check if any tweet contains the verification code
      if (html.includes(expectedCode) && html.includes('clawswarm')) {
        console.log(`✅ Tweet verification passed for @${username}`);
        return {
          verified: true,
          method: 'tweet',
          instance,
          username
        };
      }
      
      return {
        verified: false,
        method: 'tweet',
        instance,
        username,
        reason: 'Verification tweet not found'
      };
      
    } catch (e) {
      console.log(`Nitter ${instance} failed: ${e.message}`);
      continue;
    }
  }
  
  return {
    verified: false,
    method: 'tweet',
    reason: 'All Nitter instances failed',
    username
  };
}

/**
 * Full verification check (tries bio first, then tweets)
 */
async function verifyXAccount(xUsername, agentId) {
  const code = generateVerificationCode(agentId);
  
  // Try bio first (more persistent)
  const bioResult = await checkBioVerification(xUsername, code);
  if (bioResult.verified) {
    return bioResult;
  }
  
  // Fallback to tweet check
  const tweetResult = await checkTweetVerification(xUsername, code);
  return tweetResult;
}

/**
 * Get verification instructions for an agent
 */
function getVerificationInstructions(agentId, agentName) {
  const code = generateVerificationCode(agentId);
  const tweetUrl = generateTweetIntent(agentName, code);
  
  return {
    code,
    methods: [
      {
        name: 'Bio Verification (Recommended)',
        steps: [
          `Add this code to your X bio: ${code}`,
          'Click "Verify" on ClawSwarm',
          'Done! You can remove the code after verification'
        ]
      },
      {
        name: 'Tweet Verification',
        steps: [
          'Post the verification tweet',
          'Click "Verify" on ClawSwarm',
          'Keep the tweet up for at least 1 hour'
        ],
        tweetUrl
      }
    ]
  };
}

module.exports = {
  generateVerificationCode,
  generateTweetIntent,
  checkBioVerification,
  checkTweetVerification,
  verifyXAccount,
  getVerificationInstructions
};
