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
 * Check for verification tweet via Nitter (profile scan)
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
 * Verify via direct tweet URL (preferred method)
 * Accepts: twitter.com/user/status/123 or x.com/user/status/123
 */
async function checkTweetUrlVerification(tweetUrl, expectedCode) {
  // Parse tweet URL
  const urlPatterns = [
    /(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/,
    /(?:nitter\.\w+)\/(\w+)\/status\/(\d+)/
  ];
  
  let username = null;
  let tweetId = null;
  
  for (const pattern of urlPatterns) {
    const match = tweetUrl.match(pattern);
    if (match) {
      username = match[1];
      tweetId = match[2];
      break;
    }
  }
  
  if (!username || !tweetId) {
    return {
      verified: false,
      method: 'tweet_url',
      reason: 'Invalid tweet URL. Use format: twitter.com/username/status/123456'
    };
  }
  
  // Try Nitter instances to fetch the specific tweet
  for (const instance of NITTER_INSTANCES) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      
      const nitterUrl = `${instance}/${username}/status/${tweetId}`;
      const response = await fetch(nitterUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; ClawSwarm/1.0)'
        }
      });
      
      clearTimeout(timeout);
      
      if (!response.ok) continue;
      
      const html = await response.text();
      
      // Check if tweet contains the verification code
      if (html.includes(expectedCode)) {
        console.log(`✅ Tweet URL verification passed for @${username} (tweet ${tweetId})`);
        return {
          verified: true,
          method: 'tweet_url',
          instance,
          username,
          tweetId,
          tweetUrl
        };
      }
      
      return {
        verified: false,
        method: 'tweet_url',
        instance,
        username,
        tweetId,
        reason: 'Verification code not found in tweet'
      };
      
    } catch (e) {
      console.log(`Nitter ${instance} failed for tweet: ${e.message}`);
      continue;
    }
  }
  
  // Fallback: try Twitter's oembed API (public, no auth needed)
  try {
    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(tweetUrl)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(oembedUrl, {
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    if (response.ok) {
      const data = await response.json();
      if (data.html && data.html.includes(expectedCode)) {
        console.log(`✅ Tweet URL verification passed via oembed for @${username}`);
        return {
          verified: true,
          method: 'tweet_url_oembed',
          username,
          tweetId,
          tweetUrl
        };
      }
      
      return {
        verified: false,
        method: 'tweet_url_oembed',
        username,
        tweetId,
        reason: 'Verification code not found in tweet'
      };
    }
  } catch (e) {
    console.log(`oembed fallback failed: ${e.message}`);
  }
  
  return {
    verified: false,
    method: 'tweet_url',
    reason: 'Could not fetch tweet - try again in a moment',
    username,
    tweetId
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
    tweetIntentUrl: tweetUrl,
    methods: [
      {
        id: 'tweet',
        name: 'Tweet Verification (Recommended)',
        description: 'Quick one-click verification via tweet',
        steps: [
          'Click the button below to post a verification tweet',
          'Copy your tweet URL after posting',
          'Paste it here and click Verify',
          'Done! You can delete the tweet after'
        ],
        tweetUrl
      },
      {
        id: 'bio',
        name: 'Bio Verification',
        description: 'Add code to your X bio (no public tweet)',
        steps: [
          `Add this code to your X bio: ${code}`,
          'Enter your X username and click Verify',
          'Done! You can remove the code after verification'
        ]
      }
    ]
  };
}

module.exports = {
  generateVerificationCode,
  generateTweetIntent,
  checkBioVerification,
  checkTweetVerification,
  checkTweetUrlVerification,
  verifyXAccount,
  getVerificationInstructions
};
