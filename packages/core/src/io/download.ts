/**
 * 文件导出
 *
 * 旧版 `download()` 直接摸 document / Blob / Body.appendChild。
 * 这段逻辑在 Electron 里也能用，但混在业务函数里意味着：想给移动端换一种保存方式，
 * 得改到所有调用点。
 *
 * 这里收成一个函数，并让它在无 DOM 环境（单测、未来的 Node 端）安全退化。
 */

/** 导出文本文件。返回是否真的触发了下载。 */
export function downloadText(filename: string, text: string): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return false;

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();

  // 立刻 revoke 会让某些浏览器下载失败，延迟一会儿
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* 已经回收了 */
    }
  }, 4000);

  return true;
}

/** 文件名里不能出现的东西，统一换成下划线 */
export function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\n\r]/g, '_').slice(0, 120);
}
