/**
 * PM2 Ecosystem Configuration for ClawSwarm
 * Enables cluster mode for 10k+ connection scaling
 */

module.exports = {
  apps: [{
    name: 'clawswarm',
    script: 'src/index.js',
    
    // Cluster mode - spawn workers equal to CPU cores
    instances: process.env.CLUSTER_INSTANCES || 'max',
    exec_mode: 'cluster',
    
    // Auto-restart on memory limit
    max_memory_restart: '500M',
    
    // Environment
    env: {
      NODE_ENV: 'development',
      PORT: 3001
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3001,
      // DATABASE_URL should be set in server environment
      CLUSTER_INSTANCES: 4 // Or 'max' for all cores
    },
    
    // Graceful shutdown
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,
    
    // Logging
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file: '/var/log/clawswarm/error.log',
    out_file: '/var/log/clawswarm/out.log',
    merge_logs: true,
    
    // Watch (dev only)
    watch: false,
    ignore_watch: ['node_modules', 'data', 'logs'],
    
    // Auto-restart
    autorestart: true,
    max_restarts: 10,
    restart_delay: 1000
  }]
};
