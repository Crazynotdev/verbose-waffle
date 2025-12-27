module.exports = {
  apps: [{
    name: "crazy-mini",
    script: "./server.js",
    instances: 1,
    exec_mode: "fork",
    env: {
      NODE_ENV: "production",
      PORT: 3000
    }
  }]
}
