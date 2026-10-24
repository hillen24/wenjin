/**
 * @wenjin/ui · 共享 UI 资产
 *
 * 只放两端都要用的东西：设计 token、图标精灵、通用组件。
 * 布局相关的组件留在各自的 apps 里 —— 电脑端是侧栏，手机端是底部导航，
 * 硬抽成「一套自适应组件」只会让两边都别扭。
 */

export { default as Icon } from './Icon.vue';
export { default as WenjinSprite } from './WenjinSprite.vue';
