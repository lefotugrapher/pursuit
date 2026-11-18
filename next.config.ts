import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Engine code uses Node built-ins (node:sqlite, child_process) and native-ish libs; keep them out of the bundle.
  serverExternalPackages: ['imapflow', 'mailparser', 'nodemailer', 'playwright-core', 'unpdf'],
  devIndicators: false,
};

export default nextConfig;
