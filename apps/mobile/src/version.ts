/**
 * 构建期注入的全局常量。
 *
 * 版本号由 vite define 注入（见 vite.config.ts），
 * 从 package.json 读，构建时定死 —— 不会像以前那样在页面里手写、然后忘了改。
 */

declare const __APP_VERSION__: string;

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
