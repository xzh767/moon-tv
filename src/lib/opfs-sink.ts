/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * OPFS (Origin Private File System) 流式写入模式。
 *
 * 与 showDirectoryPicker / showSaveFilePicker 不同，这里不请求用户对真实目录的写权限，
 * 而是写入浏览器站点私有存储。下载完成后再把 OPFS 文件交给浏览器下载管理器。
 * 优势：
 *   - 不弹目录选择器，不受 Windows Controlled Folder Access 拦截
 *   - 不把整部电影堆进 RAM（Blob fallback 会）
 *   - PWA / iOS standalone 场景下也能正常触发下载
 */

export type OpfsSinkMode = 'opfs' | 'blob-fallback';

export interface OpfsFileSink {
  write(data: ArrayBuffer | Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
  getFile(): Promise<File>;
  cleanup(): Promise<void>;
}

function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  return (cleaned || 'video').slice(0, 180);
}

function isStandaloneDisplayMode(): boolean {
  const mediaStandalone =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(display-mode: standalone)').matches;
  const iosStandalone =
    'standalone' in navigator && Boolean((navigator as any).standalone);
  return mediaStandalone || iosStandalone;
}

function isIOSLike(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

async function triggerFileDownload(file: File, fileName: string): Promise<void> {
  const safeName = `${safeFileName(fileName)}.mp4`;

  // iOS PWA 下 WebKit 对 blob: + <a download> 有兼容问题，优先用 share
  if (isStandaloneDisplayMode() && isIOSLike() && navigator.share) {
    try {
      if (!navigator.canShare || navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: safeName });
        return;
      }
    } catch (error) {
      if ((error as DOMException)?.name !== 'AbortError') {
        console.warn('iOS PWA 文件分享失败，将尝试标准下载：', error);
      }
    }
  }

  const url = URL.createObjectURL(file);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = safeName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 给浏览器下载管理器足够时间读取文件
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeFileName(fileName)}.mp4`;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * 创建 OPFS 流式写入 sink。
 * 返回 null 表示浏览器不支持 OPFS，调用方应 fallback 到 Blob。
 */
export async function createOpfsSink(
  fileName: string,
): Promise<OpfsFileSink | null> {
  const storage = (navigator as any).storage;
  if (!storage?.getDirectory) return null;

  const root = await storage.getDirectory();
  const safeName = `${safeFileName(fileName)}-${Date.now()}.mp4`;
  const handle = await root.getFileHandle(safeName, { create: true });
  const writable = await handle.createWritable();

  return {
    write: async (data) => writable.write(data),
    close: async () => writable.close(),
    abort: async (reason) => {
      try {
        await writable.abort(reason);
      } catch {
        /* 已关闭/已中止时忽略 */
      }
    },
    getFile: async () => handle.getFile(),
    cleanup: async () => {
      try {
        await root.removeEntry(safeName);
      } catch {
        /* 文件已被清理 */
      }
    },
  };
}

/**
 * 将已完成的 OPFS 文件触发浏览器下载，并延迟清理 OPFS 临时文件。
 */
export async function finalizeOpfsDownload(
  sink: OpfsFileSink,
  fileName: string,
): Promise<void> {
  await sink.close();
  const file = await sink.getFile();
  await triggerFileDownload(file, fileName);
  // 延迟 1 小时清理，确保浏览器下载管理器已读取完
  setTimeout(() => {
    void sink.cleanup();
  }, 60 * 60 * 1000);
}

export { triggerBlobDownload, safeFileName };
