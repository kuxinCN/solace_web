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
  },
};

export default nextConfig;
