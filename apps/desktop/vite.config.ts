import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

const fromRoot = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [vue()],

  /**
   * base 必须是相对路径。
   * 打包后 Electron 用 file:// 加载 index.html，
   * 绝对路径 /assets/xxx.js 会被解析到磁盘根目录，直接 404 白屏。
   */
  base: './',

  /**
   * 直接把 @wenjin/core / @wenjin/ui 指到源码，不走 node_modules。
   * 这两个包发布的是 .ts，Vite 需要按源码编译；
   * 走软链容易踩 optimizeDeps 与 symlink 的坑，alias 最省事也最快。
   * 注意顺序：带子路径的规则必须排在包名前面。
   */
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
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
    sourcemap: false,
  },

  server: {
    port: 5180,
  },
});
