/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * MP4 转码工具
 * 使用 mux.js 将 TS 片段转换为 MP4 格式
 * 基于 https://github.com/videojs/mux.js
 */

/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-expect-error - mux.js 没有完整的 TypeScript 类型定义
import muxjs from 'mux.js';
/* eslint-enable @typescript-eslint/ban-ts-comment */

/**
 * TS 转 MP4 转码器
 * 使用 mux.js 的 Transmuxer 进行转码
 */
export class TSToMP4Transmuxer {
  private transmuxer: any;
  private mp4Segments: Uint8Array[] = [];
  private isInitialized = false;
  private duration: number;

  constructor(duration?: number) {
    this.duration = duration || 0;
    this.transmuxer = new muxjs.mp4.Transmuxer({
      keepOriginalTimestamps: true,
      duration: this.duration,
    });

    // 监听数据事件
    this.transmuxer.on('data', (segment: any) => {
      let initData = segment.initSegment;
      if (initData.byteLength > 0 && !this.isInitialized) {
        initData = patchMp4InitDuration(new Uint8Array(initData), this.duration);
      }
      const data = new Uint8Array(initData.byteLength + segment.data.byteLength);
      data.set(initData, 0);
      data.set(segment.data, initData.byteLength);
      this.mp4Segments.push(data);
    });

    // 监听完成事件
    this.transmuxer.on('done', () => {
      this.isInitialized = true;
    });
  }

  /**
   * 推送 TS 数据进行转码
   * @param tsData - TS 格式的数据
   */
  push(tsData: Uint8Array): void {
    this.transmuxer.push(tsData);
  }

  /**
   * 刷新转码器，完成转码
   */
  flush(): void {
    this.transmuxer.flush();
  }

  /**
   * 获取转码后的 MP4 数据
   * @returns MP4 格式的 Blob
   */
  getMP4Blob(): Blob {
    if (this.mp4Segments.length === 0) {
      throw new Error('没有可用的 MP4 数据');
    }

    // 合并所有 MP4 片段
    const totalLength = this.mp4Segments.reduce((acc, segment) => acc + segment.byteLength, 0);
    const mp4Data = new Uint8Array(totalLength);
    
    let offset = 0;
    for (const segment of this.mp4Segments) {
      mp4Data.set(segment, offset);
      offset += segment.byteLength;
    }

    return new Blob([mp4Data], { type: 'video/mp4' });
  }

  /**
   * 重置转码器
   */
  reset(): void {
    this.mp4Segments = [];
    this.isInitialized = false;
    // 创建新的 transmuxer 实例
    this.transmuxer = new muxjs.mp4.Transmuxer({
      keepOriginalTimestamps: true,
      duration: this.duration,
    });

    // 重新绑定事件
    this.transmuxer.on('data', (segment: any) => {
      let initData = segment.initSegment;
      if (initData.byteLength > 0 && !this.isInitialized) {
        initData = patchMp4InitDuration(new Uint8Array(initData), this.duration);
      }
      const data = new Uint8Array(initData.byteLength + segment.data.byteLength);
      data.set(initData, 0);
      data.set(segment.data, initData.byteLength);
      this.mp4Segments.push(data);
    });

    this.transmuxer.on('done', () => {
      this.isInitialized = true;
    });
  }

  /**
   * 检查是否已初始化
   */
  isReady(): boolean {
    return this.isInitialized;
  }
}

/**
 * 批量转码 TS 片段为 MP4
 * @param tsSegments - TS 片段数组
 * @param duration - 视频时长（秒）
 * @returns MP4 格式的 Blob
 */
/**
 * 批量转码 TS 片段为 MP4
 * @param tsSegments - TS 片段数组
 * @param duration - 视频总时长（秒，可选）
 * @returns MP4 格式的 Blob
 */
export function transmuxTSToMP4(tsSegments: ArrayBuffer[], duration?: number): Blob {
  const transmuxer = new TSToMP4Transmuxer(duration);

  // 推送所有 TS 片段
  for (const segment of tsSegments) {
    transmuxer.push(new Uint8Array(segment));
  }

  // 完成转码
  transmuxer.flush();

  // 返回 MP4 数据
  return transmuxer.getMP4Blob();
}

/**
 * 流式转码器（用于边下边存场景）
 * 支持增量转码，适合大文件下载
 */
export class StreamingTransmuxer {
  private transmuxer: any;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private segmentCount = 0;
  private isFirstSegment = true;
  private duration: number;
  private writeError: Error | null = null; // 跟踪写入错误
  private pendingWrites: Promise<void>[] = []; // 跟踪待完成的写入操作

  constructor(writer?: WritableStreamDefaultWriter<Uint8Array>, duration?: number) {
    this.writer = writer || null;
    this.duration = duration || 0;
    this.transmuxer = new muxjs.mp4.Transmuxer({
      keepOriginalTimestamps: true,
      duration: this.duration,
    });

    // 监听数据事件 - 直接写入流
    this.transmuxer.on('data', async (segment: any) => {
      // 如果已经有写入错误，不再处理新的数据
      if (this.writeError) {
        return;
      }

      try {
        // 对于第一个片段，需要写入初始化段（修补时长元数据）
        if (this.isFirstSegment && segment.initSegment) {
          if (this.writer) {
            const patched = patchMp4InitDuration(
              new Uint8Array(segment.initSegment),
              this.duration
            );
            await this.writer.write(patched);
          }
          this.isFirstSegment = false;
        }

        // 写入数据段
        if (segment.data && this.writer) {
          await this.writer.write(new Uint8Array(segment.data));
        }

        this.segmentCount++;
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('写入 MP4 数据失败:', error);
        this.writeError = error instanceof Error ? error : new Error(String(error));
        throw error;
      }
    });
  }

  /**
   * 设置写入流
   */
  setWriter(writer: WritableStreamDefaultWriter<Uint8Array>): void {
    this.writer = writer;
  }

  /**
   * 推送 TS 数据并立即转码
   */
  async pushAndTransmux(tsData: Uint8Array): Promise<void> {
    // 如果已经有写入错误，立即抛出
    if (this.writeError) {
      throw this.writeError;
    }

    this.transmuxer.push(tsData);
    this.transmuxer.flush();
    
    // 等待一小段时间，让 data 事件有机会执行并捕获错误
    // 注意：这是一个折中方案，因为 muxjs 的 data 事件是异步的
    await new Promise(resolve => setTimeout(resolve, 0));
    
    // 再次检查是否有写入错误
    if (this.writeError) {
      throw this.writeError;
    }
  }

  /**
   * 完成转码并关闭流
   */
  async finish(): Promise<void> {
    this.transmuxer.flush();
    
    if (this.writer) {
      try {
        await this.writer.close();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('关闭写入流失败:', error);
      }
    }
  }

  /**
   * 获取已转码的片段数量
   */
  getSegmentCount(): number {
    return this.segmentCount;
  }

  /**
   * 重置转码器
   */
  reset(): void {
    this.segmentCount = 0;
    this.isFirstSegment = true;
    this.transmuxer = new muxjs.mp4.Transmuxer({
      keepOriginalTimestamps: true,
      duration: this.duration,
    });

    // 重新绑定事件
    this.transmuxer.on('data', async (segment: any) => {
      try {
        if (this.isFirstSegment && segment.initSegment) {
          if (this.writer) {
            const patched = patchMp4InitDuration(
              new Uint8Array(segment.initSegment),
              this.duration
            );
            await this.writer.write(patched);
          }
          this.isFirstSegment = false;
        }

        if (segment.data && this.writer) {
          await this.writer.write(new Uint8Array(segment.data));
        }

        this.segmentCount++;
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('写入 MP4 数据失败:', error);
        throw error;
      }
    });
  }
}

/**
 * 修正 mux.js 生成的 fMP4 init segment 时长元数据。
 * 某些版本会把 mvhd/tkhd/mdhd duration 留为 0xffffffff，部分播放器
 * 会把它显示成约 13:15:24。这里使用当前单集 media playlist 的 EXTINF
 * 总时长修正容器元数据，不重新编码音视频。
 */
function patchMp4InitDuration(init: Uint8Array, durationSeconds: number): Uint8Array {
  if (init.byteLength < 128) return init;
  const out = new Uint8Array(init);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let movieTimescale = 90000;
  const safeDuration = Math.max(0, durationSeconds);

  const readSize = (offset: number): number => {
    if (offset + 8 > out.byteLength) return 0;
    const size32 = view.getUint32(offset, false);
    if (size32 === 1) {
      if (offset + 16 > out.byteLength) return 0;
      const high = view.getUint32(offset + 8, false);
      const low = view.getUint32(offset + 12, false);
      const size = high * 4294967296 + low;
      return size > Number.MAX_SAFE_INTEGER ? 0 : size;
    }
    return size32 === 0 ? out.byteLength - offset : size32;
  };

  const boxType = (offset: number): string =>
    String.fromCharCode(out[offset + 4], out[offset + 5], out[offset + 6], out[offset + 7]);

  const walk = (start: number, end: number): void => {
    let offset = start;
    while (offset + 8 <= end) {
      const size = readSize(offset);
      if (size < 8 || offset + size > end) break;
      const type = boxType(offset);
      const payload = offset + 8;

      if (type === 'mvhd' && payload + 20 <= offset + size && out[payload] === 0) {
        movieTimescale = view.getUint32(payload + 12, false) || 90000;
        const duration = Math.min(0xffffffff, Math.round(safeDuration * movieTimescale));
        view.setUint32(payload + 16, duration >>> 0, false);
      } else if (type === 'mdhd' && payload + 20 <= offset + size && out[payload] === 0) {
        const timescale = view.getUint32(payload + 12, false) || 1;
        const duration = Math.min(0xffffffff, Math.round(safeDuration * timescale));
        view.setUint32(payload + 16, duration >>> 0, false);
      } else if (type === 'tkhd' && payload + 24 <= offset + size && out[payload] === 0) {
        const duration = Math.min(0xffffffff, Math.round(safeDuration * movieTimescale));
        view.setUint32(payload + 20, duration >>> 0, false);
      }

      if (
        type === 'moov' || type === 'trak' || type === 'mdia' ||
        type === 'minf' || type === 'stbl' || type === 'edts'
      ) {
        walk(payload, offset + size);
      }
      offset += size;
    }
  };

  walk(0, out.byteLength);
  return out;
}
export function isTSFormat(data: Uint8Array): boolean {
  // TS 文件以 0x47 (sync byte) 开头
  // 通常每 188 字节有一个 sync byte
  if (data.length < 188) {
    return false;
  }

  // 检查前几个 sync byte
  return data[0] === 0x47 && (data.length < 188 || data[188] === 0x47);
}

/**
 * 估算转码后的 MP4 文件大小
 * @param tsSize - TS 文件大小（字节）
 * @returns 预估的 MP4 文件大小（字节）
 */
export function estimateMP4Size(tsSize: number): number {
  // MP4 容器通常比 TS 容器稍小（TS 有额外的包头开销）
  // 经验值：MP4 约为 TS 的 95-98%
  return Math.round(tsSize * 0.96);
}
