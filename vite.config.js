import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'autoUpdate', // generates the service worker (app-shell caching) + manifest.webmanifest
    includeAssets: ['apple-touch-icon.png'],
    manifest: { name: 'Lift Log', short_name: 'Lift Log', start_url: '/', display: 'standalone', orientation: 'portrait',
      background_color: '#18181b', theme_color: '#18181b',
      icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }] },
  })],
});
