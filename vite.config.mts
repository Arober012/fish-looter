import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const overlayPort = Number(process.env.VITE_PORT ?? '5180');
const target = process.env.VITE_TARGET ?? 'both'; // 'overlay' | 'panel' | 'both'
const outDir = path.resolve(__dirname, process.env.VITE_OUTDIR ?? 'dist/overlay');

const inputs = target === 'overlay'
  ? { index: path.resolve(__dirname, 'overlay.html') }
  : target === 'panel'
    ? { panel: path.resolve(__dirname, 'panel.html') }
    : { index: path.resolve(__dirname, 'overlay.html'), panel: path.resolve(__dirname, 'panel.html') };

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    rollupOptions: {
      input: inputs,
    },
    outDir,
    emptyOutDir: true,
  },
  define: {
    'import.meta.env.VITE_PANEL_DEV': JSON.stringify(process.env.PANEL_DEV_MODE || ''),
  },
  server: {
    port: overlayPort,
  },
});
