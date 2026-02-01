const express = require("express");
const router = express.Router();

// Import sub-routers
const agents = require("./agents");
const channels = require("./channels");
const tasks = require("./tasks");

// Root endpoint
router.get("/", (req, res) => {
  res.json({
    name: "ClawSwarm API",
    version: "0.10.0",
    features: {
      agents: true,
      channels: true,
      tasks: true,
      escrow: true,
      persistence: "sqlite",
      messaging: "redis-streams",
      webhooks: true,
      realtime: "sse"
    },
    endpoints: [
      "/agents",
      "/channels", 
      "/tasks",
      "/channels/:id/stream (SSE)",
      "/channels/_health/redis"
    ]
  });
});

// Health check
router.get("/health", async (req, res) => {
  const streams = require("../services/redis-streams");
  const redisHealth = await streams.healthCheck();

  res.json({
    status: "healthy",
    uptime: process.uptime(),
    persistence: true,
    messaging: redisHealth.status === "connected" ? "redis-streams" : "sqlite-only",
    redis: redisHealth
  });
});

// Mount sub-routers
router.use("/agents", agents);
router.use("/channels", channels);
router.use("/tasks", tasks);

module.exports = router;
