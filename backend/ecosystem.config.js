// PM2 Configuration for Backend Server
// App name can be customized via PM2_APP_NAME environment variable
const appName = process.env.PM2_APP_NAME || 'superatom-backend';

module.exports = {
  apps: [{
    name: appName,
    script: './dist/backend/src/app.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    // Belt-and-suspenders: even if watch is ever enabled, never restart on the
    // app's own generated data (DuckDB builds, build-cache sidecars, uploads).
    ignore_watch: ['duckdb', 'uploads', 'node_modules', 'logs'],
    max_memory_restart: '4G',
    env: {
      NODE_ENV: 'production',
      PORT: process.env.PORT || 3000
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
