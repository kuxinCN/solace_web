/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // 这些包只在服务端使用、且内部有动态 require，
    // 交给 Node 直接加载（而不是打进 bundle）更稳，尤其是 mysql2 和 nodemailer。
    serverComponentsExternalPackages: [
      "mysql2",
      "nodemailer",
      "otplib",
      "bcryptjs",
      "qrcode",
    ],

    // ⚠️ 不要打开 instrumentationHook（踩过坑）：
    //    Next 会给 server 和 edge 两套环境各编译一次 instrumentation，
    //    webpack 顺着 scheduler → settings → db 一路静态解析到 node:path，
    //    而 edge 环境没有这个模块 → **整个 npm run build 直接失败**。
    //
    //    数据审核的自动定时器现在改用「懒启动」：第一个访问 /api/health
    //    或后台审核页的请求会把它注册起来（见 lib/scheduler.js 的注释）。
  },
};

export default nextConfig;
