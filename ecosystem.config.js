module.exports = {
    apps: [
      {
        name: 'pb-server',
        script: 'dist/main.js',
        instances: 'max', // ใช้ทุก core CPU
        exec_mode: 'cluster', // cluster mode
        env: {
          NODE_ENV: 'development',
        },
        env_production: {
          NODE_ENV: 'production',
        },
      },
    ],
  };