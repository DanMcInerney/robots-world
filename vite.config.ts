import { defineConfig } from 'vite';
import { resolve } from 'node:path';
export default defineConfig({ build: { rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), flight: resolve(import.meta.dirname, 'flight.html'), jev: resolve(import.meta.dirname, 'jev.html') } } } });
