// PM2 Configuration for ChromaDB Server
// App name can be customized via PM2_APP_NAME environment variable
const appName = process.env.PM2_APP_NAME || 'chromadb-server';

module.exports = {
  apps: [{
    name: appName,
    script: './start-chroma-server.sh',
    interpreter: '/bin/bash',
    cwd: './',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    max_memory_restart: '2G',
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_file: './logs/combined.log',
    time: true,
    merge_logs: true,
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
