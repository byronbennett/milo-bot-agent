import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['app/index.ts', 'app/bin/milo.ts', 'app/orchestrator/worker.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  target: 'node20',
  outDir: 'dist',
  shims: true,
});
