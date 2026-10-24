/**
 * 问津共享应用层
 *
 * 这里放的是「不管跑在电脑还是手机上，行为都该一模一样」的东西：
 * 七个视图、跨视图导航、依赖注入。
 *
 * 各端只负责外壳 —— 电脑端是左侧竖排导航，手机端是顶部状态栏 + 底部标签栏。
 * 外壳差异属于布局，不属于逻辑，所以不下沉到这里。
 */

export * from './nav';
export * from './providers';
export * from './useNarrow';
export * from './sync/lan';
export * from './sync/desktopBridge';

export { default as StarView } from './views/StarView.vue';
export { default as ReaderView } from './views/ReaderView.vue';
export { default as MethodsView } from './views/MethodsView.vue';
export { default as GewuView } from './views/GewuView.vue';
export { default as DebateView } from './views/DebateView.vue';
export { default as BookView } from './views/BookView.vue';
export { default as SettingsView } from './views/SettingsView.vue';
