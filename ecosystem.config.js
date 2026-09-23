/**
 * PM2 启动配置。
 *
 * 用法（在项目根目录）：
 *   pm2 start ecosystem.config.js     # 启动
 *   pm2 reload solace                 # 改了代码重新构建后平滑重启
 *   pm2 logs solace                   # 看日志
 *   pm2 stop solace                   # 停止
 *   pm2 delete solace                 # 移除
 *
 * 说明：直接执行 next 的入口脚本，比 `npm start` 少一层进程，
 * PM2 发送重启信号时更可靠。
 *
 * 注意：只有单实例（instances: 1）。后台会话与配置缓存是进程内的，
 * 多实例会出现"登录时好时坏"的问题。
 */
module.exports = {
  apps: [
    {
      name: "solace",
      cwd: __dirname,
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "600M",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
      },
      error_file: "logs/pm2-error.log",
      out_file: "logs/pm2-out.log",
      time: true,
    },
  ],
};
