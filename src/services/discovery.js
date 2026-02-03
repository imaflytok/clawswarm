/**
 * discovery.js - Agent Discovery & Matching Service
 * ClawSwarm - Phase 2
 * 
 * Provides fuzzy capability matching and scored agent search
 */

// Capability lexicon - canonical terms and their aliases
const CAPABILITY_LEXICON = {
  code: ['coding', 'programming', 'dev', 'development', 'software'],
  research: ['analysis', 'investigation', 'study', 'exploring'],
  data: ['analytics', 'data-analysis', 'statistics', 'metrics'],
  architecture: ['design', 'system-design', 'planning', 'specs'],
  deployment: ['devops', 'infrastructure', 'ops', 'shipping'],
  writing: ['content', 'copywriting', 'documentation', 'docs'],
  coordination: ['management', 'organizing', 'planning', 'leading'],
  trading: ['finance', 'markets', 'defi', 'trading-analysis'],
  security: ['audit', 'pentesting', 'vulnerability', 'infosec'],
  ai: ['ml', 'machine-learning', 'llm', 'neural']
};

// Build reverse index: alias -> canonical
const ALIAS_TO_CANONICAL = {};
for (const [canonical, aliases] of Object.entries(CAPABILITY_LEXICON)) {
  ALIAS_TO_CANONICAL[canonical] = canonical;
  for (const alias of aliases) {
    ALIAS_TO_CANONICAL[alias.toLowerCase()] = canonical;
  }
}

/**
 * Normalize a capability string to its canonical form
 */
function normalizeCapability(cap) {
  const lower = cap.toLowerCase().trim();
  return ALIAS_TO_CANONICAL[lower] || lower;
}

/**
 * Check if agent has a capability (fuzzy match)
 */
function hasCapability(agentCaps, searchCap) {
  const normalizedSearch = normalizeCapability(searchCap);
  return agentCaps.some(cap => {
    const normalizedCap = normalizeCapability(cap);
    return normalizedCap === normalizedSearch;
  });
}

/**
 * Calculate capability match score
 * @param {string[]} agentCaps - Agent's capabilities
 * @param {string[]} searchCaps - Capabilities to search for
 * @param {string} mode - 'all' (AND) or 'any' (OR)
 * @returns {number} Score between 0 and 1
 */
function capabilityScore(agentCaps, searchCaps, mode = 'any') {
  if (!searchCaps || searchCaps.length === 0) return 1;
  
  const matches = searchCaps.filter(sc => hasCapability(agentCaps, sc));
  
  if (mode === 'all') {
    // Must match ALL - binary score
    return matches.length === searchCaps.length ? 1 : 0;
  } else {
    // Match ANY - proportional score
    return matches.length / searchCaps.length;
  }
}

/**
 * Calculate availability score
 */
function availabilityScore(status) {
  switch (status) {
    case 'online': return 1.0;
    case 'busy': return 0.5;
    case 'away': return 0.3;
    case 'offline': 
    default: return 0.1;
  }
}

/**
 * Calculate overall agent score for search
 * @param {Object} agent - Agent record
 * @param {string[]} searchCaps - Capabilities to search for
 * @param {string} mode - 'all' or 'any'
 * @returns {number} Final score
 */
function calculateScore(agent, searchCaps, mode = 'any') {
  const capScore = capabilityScore(agent.capabilities || [], searchCaps, mode);
  const repScore = (agent.reputation || 100) / 100;
  const availScore = availabilityScore(agent.status);
  
  // Weighted combination
  const score = (capScore * 0.5) + (repScore * 0.3) + (availScore * 0.2);
  
  return Math.round(score * 1000) / 1000; // 3 decimal places
}

/**
 * Search agents by capabilities
 * @param {Map} agents - Agent registry
 * @param {Object} options - Search options
 * @returns {Object[]} Sorted results with scores
 */
function searchAgents(agents, options = {}) {
  const { 
    capabilities = [], 
    mode = 'any',
    minScore = 0,
    limit = 20,
    excludeOffline = false
  } = options;
  
  const results = [];
  
  for (const [id, agent] of agents) {
    // Skip offline if requested
    if (excludeOffline && agent.status === 'offline') continue;
    
    const score = calculateScore(agent, capabilities, mode);
    
    // Skip below threshold
    if (score < minScore) continue;
    
    results.push({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      capabilities: agent.capabilities,
      status: agent.status,
      reputation: agent.reputation,
      score
    });
  }
  
  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  
  // Apply limit
  return results.slice(0, limit);
}

module.exports = {
  CAPABILITY_LEXICON,
  normalizeCapability,
  hasCapability,
  capabilityScore,
  availabilityScore,
  calculateScore,
  searchAgents
};
