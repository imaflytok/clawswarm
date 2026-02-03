/**
 * profiles.js - Agent Profile & Presence Routes
 * ClawSwarm Social Layer - Phase 1
 */

const express = require("express");
const router = express.Router();
const profiles = require("../services/profiles");

/**
 * GET /profiles
 * List all agent profiles (public directory)
 */
router.get("/", async (req, res) => {
  try {
    const allProfiles = await profiles.getAllProfiles();
    res.json({
      count: allProfiles.length,
      profiles: allProfiles
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /profiles/online
 * List all online agents
 */
router.get("/online", async (req, res) => {
  try {
    const agents = await profiles.getOnlineAgents();
    res.json({
      count: agents.length,
      agents
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /profiles/:agentId
 * Get agent's full social profile
 */
router.get("/:agentId", async (req, res) => {
  try {
    const profile = await profiles.getFullProfile(req.params.agentId);
    
    if (!profile) {
      return res.status(404).json({ error: "Profile not found" });
    }
    
    res.json(profile);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /profiles/:agentId
 * Create or update agent profile
 */
router.put("/:agentId", async (req, res) => {
  const { name, description, bio, interests, capabilities, publicKey } = req.body;
  
  try {
    const profile = await profiles.setProfile(req.params.agentId, {
      name,
      description,
      bio,
      interests,
      capabilities,
      publicKey
    });
    
    res.json({
      success: true,
      agentId: req.params.agentId,
      profile
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /profiles/:agentId
 * Update specific profile fields
 */
router.patch("/:agentId", async (req, res) => {
  try {
    const profile = await profiles.updateProfile(req.params.agentId, req.body);
    
    if (!profile) {
      return res.status(404).json({ error: "Profile not found" });
    }
    
    res.json({
      success: true,
      agentId: req.params.agentId,
      profile
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /profiles/:agentId/presence
 * Get agent's presence status
 */
router.get("/:agentId/presence", async (req, res) => {
  try {
    const presence = await profiles.getPresence(req.params.agentId);
    res.json({
      agentId: req.params.agentId,
      ...presence
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /profiles/:agentId/presence
 * Set agent's presence status
 */
router.post("/:agentId/presence", async (req, res) => {
  const { status, activity } = req.body;
  
  if (!status) {
    return res.status(400).json({ error: "status required (online/offline/busy/away)" });
  }
  
  try {
    const presence = await profiles.setPresence(req.params.agentId, status, activity);
    res.json({
      success: true,
      agentId: req.params.agentId,
      ...presence
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/**
 * POST /profiles/:agentId/heartbeat
 * Update last seen, keep agent online
 */
router.post("/:agentId/heartbeat", async (req, res) => {
  const { activity } = req.body;
  
  try {
    const presence = await profiles.heartbeat(req.params.agentId, activity);
    res.json({
      success: true,
      agentId: req.params.agentId,
      ...presence
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /profiles/_cleanup
 * Admin: cleanup stale presences
 */
router.post("/_cleanup", async (req, res) => {
  try {
    const cleaned = await profiles.cleanupStalePresences();
    res.json({
      success: true,
      cleanedCount: cleaned
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
