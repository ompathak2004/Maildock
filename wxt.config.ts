import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  imports: false,
  manifest: {
    name: 'Maildock',
    description: 'Bring email verification codes to the tab where you need them.',
    minimum_chrome_version: '120',
    permissions: ['identity', 'storage', 'activeTab', 'scripting', 'sidePanel', 'alarms'],
    host_permissions: ['https://api.resend.com/*'],
    // Granted per site by the user from the panel; never requested at install time.
    optional_host_permissions: ['https://*/*'],
    action: { default_title: 'Open Maildock' },
    icons: { 16: 'icon-16.png', 32: 'icon-32.png', 48: 'icon-48.png', 128: 'icon-128.png' },
    ...(process.env.WXT_EXTENSION_PUBLIC_KEY ? { key: process.env.WXT_EXTENSION_PUBLIC_KEY } : {}),
    content_security_policy: {
      extension_pages:
        "script-src 'self'; object-src 'none'; connect-src https://api.resend.com; base-uri 'none'; frame-ancestors 'none'",
    },
  },
});
