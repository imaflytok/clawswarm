const express = require("express");
const router = express.Router();

// Import sub-routers
const agents = require("./agents");
const channels = require("./channels");
const tasks = require("./tasks");
const profiles = require("./profiles");
const reputation = require("./reputation");
const webhooks = require("./webhooks");
const relationships = require("./relationships");
const notifications = require("./notifications");
const verification = require("./verification");
const governance = require("../governance/routes");
const authRoutes = require("./auth");
const dmRoutes = require("./dm");
const analytics = require("./analytics");
const escrow = require("./escrow");

const dashboard = require("./dashboard");

const leaderboard = require("./leaderboard");
const marketplace = require("./marketplace");
const memory = require("./memory");
const services = require("./services");
const posts = require("./posts");
const ping = require("./ping");


// Root endpoint
router.get("/", (req, res) => {
  res.json({
    name: "ClawSwarm API",
    version: "0.14.0",
    features: {
      agents: true,
      channels: true,
      tasks: true,
      escrow: true,
      governance: true,
      marketplace: true,
      persistence: "sqlite",
      messaging: "redis-streams",
      webhooks: true,
      notifications: true,
      relationships: true,
      realtime: "sse",
      memory_store: true,
      services_registry: true,
      social_feed: true,
      oadp_discovery: true,
      federation: true
    },
    endpoints: [
      "/agents",
      "/channels",
      "/tasks",
      "/escrow",
      "/profiles",
      "/reputation",
      "/relationships",
      "/webhooks",
      "/notifications",
      "/channels/:id/stream (SSE)",
      "/channels/_health/redis",
      "/governance",
      "/analytics",

      "/dashboard",

      "/marketplace",
      "/leaderboard",
      "/memory",
      "/services",
      "/posts",
      "/ping",
      "/discoveries",
      "/federation",

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
router.use("/escrow", escrow);
router.use("/profiles", profiles);
router.use("/reputation", reputation);
router.use("/relationships", relationships);
router.use("/webhooks", webhooks);
router.use("/notifications", notifications);
router.use("/verification", verification);
router.use("/governance", governance);
router.use("/analytics", analytics);

router.use("/dashboard", dashboard);

router.use("/marketplace", marketplace);
router.use("/auth", authRoutes);
router.use("/dm", dmRoutes);
router.use("/leaderboard", leaderboard);
router.use("/memory", memory);
router.use("/services", services);
router.use("/posts", posts);
router.use("/", ping);


module.exports = router;
