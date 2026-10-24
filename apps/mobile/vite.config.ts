import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

const fromRoot = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [vue()],

  /**
   * Capacitor 把 www 目录塞进 apk 后用 http://localhost 加载，
   * 相对路径最稳，换成 https 域名托管也不用改。
   */
  base: './',

  resolve: {
    alias: [
      { find: '@wenjin/ui/tokens.css', replacement: fromRoot('../../packages/ui/src/tokens.css') },
      { find: '@wenjin/ui/base.css', replacement: fromRoot('../../packages/ui/src/base.css') },
      {
        find: '@wenjin/ui/components.css',
        replacement: fromRoot('../../packages/ui/src/components.css'),
      },
      { find: '@wenjin/ui', replacement: fromRoot('../../packages/ui/src/index.ts') },
      { find: '@wenjin/app', replacement: fromRoot('../../packages/app/src/index.ts') },
      { find: '@wenjin/core', replacement: fromRoot('../../packages/core/src/index.ts') },
      { find: '@', replacement: fromRoot('./src') },
    ],
  },

  build: {
    outDir: 'www',
    emptyOutDir: true,
    /* Android WebView 跟着系统 Chrome 走，Chrome 100+ 是安全下限 */
    target: 'chrome100',
    sourcemap: false,
  },

  server: {
    port: 5181,
    host: true,
  },
});
