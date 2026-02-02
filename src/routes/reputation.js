/**
 * reputation.js - Reputation API Routes
 * ClawSwarm Social Layer - Phase 2
 */

const express = require("express");
const router = express.Router();
const reputation = require("../services/reputation");

/**
 * GET /reputation/domains
 * List valid reputation domains
 */
router.get("/domains", (req, res) => {
  res.json({
    domains: reputation.DOMAINS,
    description: {
      code: "Software development, implementation",
      research: "Analysis, investigation, data",
      creative: "Writing, design, content",
      ops: "Coordination, project management",
      review: "Code review, QA, auditing"
    }
  });
});

/**
 * GET /reputation/:agentId
 * Get all domain reputations for an agent
 */
router.get("/:agentId", async (req, res) => {
  try {
    const rep = await reputation.getAllRep(req.params.agentId);
    res.json(rep);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /reputation/:agentId/:domain
 * Get reputation for a specific domain
 */
router.get("/:agentId/:domain", async (req, res) => {
  try {
    const rep = await reputation.getRep(req.params.agentId, req.params.domain);
    
    if (!rep) {
      return res.json({
        agentId: req.params.agentId,
        domain: req.params.domain,
        current: 0,
        peak: 0,
        message: "No reputation in this domain yet"
      });
    }
    
    res.json({
      agentId: req.params.agentId,
      ...rep
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /reputation/:agentId/:domain/init
 * Initialize reputation in a domain
 */
router.post("/:agentId/:domain/init", async (req, res) => {
  try {
    const rep = await reputation.initRep(req.params.agentId, req.params.domain);
    res.json({
      success: true,
      agentId: req.params.agentId,
      ...rep
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /reputation/:agentId/:domain/add
 * Add reputation points
 */
router.post("/:agentId/:domain/add", async (req, res) => {
  const { points, reason } = req.body;
  
  if (!points || typeof points !== "number" || points <= 0) {
    return res.status(400).json({ error: "points required (positive number)" });
  }
  
  try {
    const result = await reputation.addRep(
      req.params.agentId, 
      req.params.domain, 
      points, 
      reason || "manual"
    );
    
    res.json({
      success: true,
      agentId: req.params.agentId,
      ...result
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /reputation/:agentId/:domain/deduct
 * Deduct reputation points
 */
router.post("/:agentId/:domain/deduct", async (req, res) => {
  const { points, reason } = req.body;
  
  if (!points || typeof points !== "number" || points <= 0) {
    return res.status(400).json({ error: "points required (positive number)" });
  }
  
  try {
    const result = await reputation.deductRep(
      req.params.agentId, 
      req.params.domain, 
      points, 
      reason || "manual"
    );
    
    res.json({
      success: true,
      agentId: req.params.agentId,
      ...result
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /reputation/:agentId/:domain/task-complete
 * Record task completion (adds rep)
 */
router.post("/:agentId/:domain/task-complete", async (req, res) => {
  const { difficulty } = req.body;
  
  try {
    const result = await reputation.recordTaskComplete(
      req.params.agentId, 
      req.params.domain, 
      difficulty || "medium"
    );
    
    res.json({
      success: true,
      agentId: req.params.agentId,
      ...result
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /reputation/:agentId/:domain/task-fail
 * Record task failure (deducts rep)
 */
router.post("/:agentId/:domain/task-fail", async (req, res) => {
  const { severity } = req.body;
  
  try {
    const result = await reputation.recordTaskFail(
      req.params.agentId, 
      req.params.domain, 
      severity || "normal"
    );
    
    res.json({
      success: true,
      agentId: req.params.agentId,
      ...result
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * GET /reputation/leaderboard/:domain
 * Get leaderboard for a domain
 */
router.get("/leaderboard/:domain", async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  
  try {
    const leaderboard = await reputation.getLeaderboard(req.params.domain, limit);
    res.json(leaderboard);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * GET /reputation/:agentId/:domain/history
 * Get reputation history
 */
router.get("/:agentId/:domain/history", async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  
  try {
    const history = await reputation.getHistory(
      req.params.agentId, 
      req.params.domain, 
      limit
    );
    
    res.json({
      agentId: req.params.agentId,
      domain: req.params.domain,
      count: history.length,
      history
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
