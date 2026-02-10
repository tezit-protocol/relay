/**
 * PM2 ecosystem config for tezit-relay.
 * Single instance (SQLite — no cluster mode).
 */
module.exports = {
  apps: [
    {
      name: "tezit-relay",
      script: "dist/index.js",
      cwd: "/var/tezit-relay/app",
      node_args: "--experimental-specifier-resolution=node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      env_file: "/var/tezit-relay/app/.env",

      // Logging
      error_file: "/var/log/tezit-relay/error.log",
      out_file: "/var/log/tezit-relay/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,

      // Restart policy
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 3000,

      // Health check
      listen_timeout: 10000,

      // Run as service user
      uid: "svc-relay",
      gid: "svc-relay",
    },
  ],
};
