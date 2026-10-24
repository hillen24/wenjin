<template>
  <!--
    图标精灵图 · 36 个 symbol（29 个界面图标 + 1 个 logo + 6 个哲人剪影）

    由 scripts/extract-sprite.py 从 v2.1 抽取，改图标请改本文件。
    用法：<Icon name="i-star" /> 或直接 <svg><use href="#i-star" /></svg>
    所有图标使用 currentColor，颜色由父级 color 决定。
  -->
  <svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display: none">
    <symbol id="i-star" viewBox="0 0 24 24"><path d="M12 3l2.1 6.9L21 12l-6.9 2.1L12 21l-2.1-6.9L3 12l6.9-2.1Z"/></symbol>
    <symbol id="i-book" viewBox="0 0 24 24"><path d="M12 6.4C10.4 4.9 8.3 4.3 4 4.3v14.4c4.3 0 6.4.6 8 2.1 1.6-1.5 3.7-2.1 8-2.1V4.3c-4.3 0-6.4.6-8 2.1Z"/><path d="M12 6.4v14.4"/></symbol>
    <symbol id="i-compass" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.8"/><path d="M15.5 8.5l-2.2 5.3-5.3 2.2 2.2-5.3Z"/></symbol>
    <symbol id="i-moon" viewBox="0 0 24 24"><path d="M20.2 14.2A8.6 8.6 0 0 1 9.8 3.8a8.6 8.6 0 1 0 10.4 10.4Z"/></symbol>
    <symbol id="i-scale" viewBox="0 0 24 24"><path d="M12 4v15M8.5 19.5h7M4.5 8h15M7 8L4.2 14a2.9 2.9 0 0 0 5.6 0ZM17 8l-2.8 6a2.9 2.9 0 0 0 5.6 0Z"/></symbol>
    <symbol id="i-pen" viewBox="0 0 24 24"><path d="M4 20l1.2-4L17 4.2a2.05 2.05 0 0 1 2.9 2.9L8 19Z"/><path d="M14.8 6.4l2.9 2.9"/></symbol>
    <symbol id="i-gear" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.08a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.08a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.08a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></symbol>
    <symbol id="i-sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.1 5.1l1.6 1.6M17.3 17.3l1.6 1.6M18.9 5.1l-1.6 1.6M6.7 17.3l-1.6 1.6"/></symbol>
    <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
    <symbol id="i-minus" viewBox="0 0 24 24"><path d="M5 12h14"/></symbol>
    <symbol id="i-close" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></symbol>
    <symbol id="i-check" viewBox="0 0 24 24"><path d="M4.5 12.6l5 5 10-11.2"/></symbol>
    <symbol id="i-warn" viewBox="0 0 24 24"><path d="M12 4L2.8 20h18.4Z"/><path d="M12 10v4.6M12 17.4v.4"/></symbol>
    <symbol id="i-send" viewBox="0 0 24 24"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4Z"/></symbol>
    <symbol id="i-refresh" viewBox="0 0 24 24"><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1M20.5 4v4.4h-4.4"/></symbol>
    <symbol id="i-download" viewBox="0 0 24 24"><path d="M12 3.5v11.5M7.5 10.5L12 15l4.5-4.5M4.5 20.5h15"/></symbol>
    <symbol id="i-upload" viewBox="0 0 24 24"><path d="M12 15V3.5M7.5 8L12 3.5 16.5 8M4.5 20.5h15"/></symbol>
    <symbol id="i-trash" viewBox="0 0 24 24"><path d="M4 6.5h16M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5M6.5 6.5l.9 13.1a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-13.1M10 10.5v6M14 10.5v6"/></symbol>
    <symbol id="i-chevron" viewBox="0 0 24 24"><path d="M9.5 6l6 6-6 6"/></symbol>
    <symbol id="i-list" viewBox="0 0 24 24"><path d="M4 6.5h16M4 12h16M4 17.5h10"/></symbol>
    <symbol id="i-key" viewBox="0 0 24 24"><circle cx="8" cy="10" r="3.5"/><path d="M10.5 12.5L20 22M16 18l2.5-2.5M13 15l2.5-2.5"/></symbol>
    <symbol id="i-link" viewBox="0 0 24 24"><path d="M10 14a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.7 1.7M14 10a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.7-1.7"/></symbol>
    <symbol id="i-target" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.5"/></symbol>
    <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></symbol>
    <symbol id="i-file" viewBox="0 0 24 24"><path d="M6 3.5h8L19 8.5V20.5H6Z"/><path d="M13.5 3.5v5.5H19M9 13h6M9 16.5h6"/></symbol>
    <symbol id="i-devices" viewBox="0 0 24 24"><rect x="2.5" y="5" width="12.5" height="9" rx="1.8"/><path d="M5.8 17.6h6"/><rect x="17" y="8.5" width="4.5" height="9" rx="1.5"/></symbol>
    <symbol id="i-sparkle" viewBox="0 0 24 24"><path d="M12 3.5l1.5 4.7 4.7 1.5-4.7 1.5L12 16l-1.5-4.8L5.8 9.7l4.7-1.5Z"/><path d="M18.6 15.2l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7Z"/></symbol>
    <symbol id="i-volume" viewBox="0 0 24 24"><path d="M11 5L6.5 9H3v6h3.5L11 19Z"/><path d="M15.5 8.8a4.8 4.8 0 0 1 0 6.4M18.3 5.8a9 9 0 0 1 0 12.4"/></symbol>
    <symbol id="i-stop" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2.5"/></symbol>
    <symbol id="i-logo" viewBox="0 0 24 24"><path d="M6.4 20.2V11a5.6 5.6 0 0 1 11.2 0v9.2"/><path d="M4.2 20.4h15.6"/><circle cx="12" cy="12.4" r="1.7" fill="currentColor" stroke="none"/></symbol>
    <symbol id="i-ph-socrates" viewBox="0 0 40 40"><ellipse cx="20" cy="15.2" rx="6.8" ry="7.2"/><path d="M12.8 16.4c-.4 6.4 2.6 11.4 7.2 11.4s7.6-5 7.2-11.4c-1.8 2.6-4.2 3.8-7.2 3.8s-5.4-1.2-7.2-3.8Z"/><path d="M6.2 34.4c1.2-5.6 6.2-9 13.8-9s12.6 3.4 13.8 9Z"/></symbol>
    <symbol id="i-ph-epictetus" viewBox="0 0 40 40"><ellipse cx="20" cy="15.6" rx="6.6" ry="7"/><circle cx="14.2" cy="10.6" r="2.6"/><circle cx="19.4" cy="8.2" r="2.9"/><circle cx="24.8" cy="10.4" r="2.5"/><path d="M14.6 18.4c.6 4.4 2.6 6.8 5.4 6.8s4.8-2.4 5.4-6.8c-1.6 1.6-3.4 2.2-5.4 2.2s-3.8-.6-5.4-2.2Z"/><path d="M6.4 34.4c1.2-5.4 6-8.6 13.6-8.6s12.4 3.2 13.6 8.6Z"/></symbol>
    <symbol id="i-ph-kant" viewBox="0 0 40 40"><path d="M11.2 10.2 20 5.4l8.8 4.8Z"/><ellipse cx="20" cy="16.2" rx="6.4" ry="6.8"/><path d="M16.4 22.4h7.2l-1.4 3.2-2.2 1.6-2.2-1.6Z"/><path d="M6.6 34.4c1.2-5.2 5.8-8.4 13.4-8.4s12.2 3.2 13.4 8.4Z"/></symbol>
    <symbol id="i-ph-nietzsche" viewBox="0 0 40 40"><ellipse cx="20" cy="14.6" rx="6.6" ry="7.2"/><path d="M20 19.2c-2.8-1-5.4.2-6.9 2.9-.6 1.1.3 2 1.4 1.5 2.1-1 3.9-2.3 5.1-4Z"/><path d="M20 19.2c2.8-1 5.4.2 6.9 2.9.6 1.1-.3 2-1.4 1.5-2.1-1-3.9-2.3-5.1-4Z"/><path d="M18.4 18.4h3.2v2h-3.2Z"/><path d="M6.4 34.4c1.2-5.4 6-8.6 13.6-8.6s12.4 3.2 13.6 8.6Z"/></symbol>
    <symbol id="i-ph-zhuangzi" viewBox="0 0 40 40"><circle cx="20" cy="8.6" r="2.9"/><ellipse cx="20" cy="16" rx="6.6" ry="7.2"/><path d="M14.4 19.6c.4 5.6 2.6 8.6 5.6 8.6s5.2-3 5.6-8.6c-1.8 1.8-3.6 2.4-5.6 2.4s-3.8-.6-5.6-2.4Z"/><path d="M6.4 34.4c1.2-5.4 6-8.6 13.6-8.6s12.4 3.2 13.6 8.6Z"/></symbol>
    <symbol id="i-ph-wangym" viewBox="0 0 40 40"><path d="M13.4 9.8h13.2v4.4H13.4Z"/><path d="M20 9.8V6.2"/><ellipse cx="20" cy="16.8" rx="6.4" ry="6.6"/><path d="M14.8 20.2c.6 5.4 2.6 8.4 5.2 8.4s4.6-3 5.2-8.4c-1.6 1.8-3.4 2.4-5.2 2.4s-3.6-.6-5.2-2.4Z"/><path d="M6.6 34.4c1.2-5.2 5.8-8.4 13.4-8.4s12.2 3.2 13.4 8.4Z"/></symbol>
  </svg>
</template>

<script setup lang="ts">
// 纯展示组件，无逻辑。挂到根组件一次即可全站可用。
</script>
