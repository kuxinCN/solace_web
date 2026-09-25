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

      // ⚠️ 内存这块有个坑，别乱改：
      //    V8 默认堆上限是「物理内存的一半」（3.6G 机器 ≈ 1.8G）——
      //    也就是 Node 自己觉得"我还能用 1.8G"，但 PM2 一到 max_memory_restart 就直接杀。
      //    两者不匹配的结果就是「应用还在正常跑，却被 PM2 反复重启」。
      //
      //    这个坑已经踩过：之前只有 max_memory_restart: "600M" 而没有 node_args，
      //    线上累计重启 208 次（平均每 21 分钟一次），用户偶尔会撞上"打不开"的一瞬间。
      //
      //    现在两头都设：
      //      --max-old-space-size=450   → 堆到 450MB 就让 GC 积极回收，尽量不冲到阈值
      //      max_memory_restart: "700M" → GC 也压不住时的安全网
      node_args: "--max-old-space-size=450",
      max_memory_restart: "700M",

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
