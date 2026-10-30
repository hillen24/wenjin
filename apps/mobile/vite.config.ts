import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';
import { createRequire } from 'node:module';

const fromRoot = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * 版本号从 package.json 读，构建期注入。
 *
 * 之前版本号是硬编码在 MineView.vue 里的（写着 v3.8，实际已经到 3.9.1）——
 * 每次发版都得记得手动改，忘了就是「关于」页显示一个假版本。
 * 现在从源头读，构建时定死，不可能再错。
 */
const require = createRequire(import.meta.url);
const pkg = require('./package.json') as { version: string };

export default defineConfig({
  plugins: [vue()],

  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

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
