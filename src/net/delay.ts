/**
 * 往返时间测量与逐玩家输入延迟动态调整。
 *
 * 设计要点:
 * - RTT/抖动均为 EWMA,alpha 取 1/4,配合 250ms 探活可在 2 秒内收敛;
 * - 目标延迟 = 单向时延 + 2 倍抖动 + 调度余量,向上取整到帧;
 * - 当前延迟向目标按固定步长爬坡,过渡总时长不超过 40 帧(2 秒),
 *   满足 RTT 50ms→300ms 时 2 秒内调整到位;
 * - 爬坡只改变"新指令"的目标帧,已排队指令不动,因此模拟与渲染均不跳帧。
 */

import { FRAME_MS } from '../core/types';

/** 爬坡最长占用的帧数:2s / 50ms */
export const MAX_RAMP_FRAMES = 40;
export const MIN_DELAY_FRAMES = 2;
export const MAX_DELAY_FRAMES = 18;
/** 调度余量 ms:覆盖帧边界对齐与房间排队 */
const MARGIN_MS = 40;
/** EWMA 平滑系数:1/4,兼顾毛刺抑制与收敛速度 */
const ALPHA = 1 / 4;

export class RttTracker {
  rttEwmaMs = 0;
  jitterEwmaMs = 0;
  rttLatestMs = 0;
  private count = 0;

  sample(rttMs: number): void {
    this.rttLatestMs = rttMs;
    if (this.count === 0) {
      this.rttEwmaMs = rttMs;
      this.jitterEwmaMs = 0;
    } else {
      const delta = rttMs - this.rttEwmaMs;
      this.rttEwmaMs += delta * ALPHA;
      this.jitterEwmaMs += (Math.abs(delta) - this.jitterEwmaMs) * ALPHA;
    }
    this.count++;
  }

  get sampleCount(): number {
    return this.count;
  }
}

export class DelayController {
  readonly playerId: number;
  private readonly rtt: RttTracker;
  delayFrames: number;
  targetDelayFrames: number;
  /** 距离下一次增减 1 帧还剩多少帧 */
  private rampCounter = 0;
  /** 上一次发出 delay-change 事件时的值,用于去重 */
  private lastEventedDelay: number;
  /**
   * 固定爬坡节拍:每多少个关闭帧变化 1 帧。
   * 按最大可能跨度(MAX-MIN)反推,保证任何幅度的调整都在 MAX_RAMP_FRAMES 内完成,
   * 且节拍不随目标的小幅抖动重置 —— 否则 EWMA 波动会让爬坡永远走不动。
   */
  private static readonly STEP_EVERY = Math.max(
    1,
    Math.floor(MAX_RAMP_FRAMES / (MAX_DELAY_FRAMES - MIN_DELAY_FRAMES))
  );

  constructor(playerId: number, rtt: RttTracker, initialDelay = 4) {
    this.playerId = playerId;
    this.rtt = rtt;
    this.delayFrames = initialDelay;
    this.targetDelayFrames = initialDelay;
    this.lastEventedDelay = initialDelay;
  }

  /** 根据当前 RTT 重新计算目标延迟(帧)。只更新目标,不影响进行中的爬坡节拍 */
  recomputeTarget(): number {
    const needMs = this.rtt.rttEwmaMs / 2 + this.rtt.jitterEwmaMs * 2 + MARGIN_MS;
    const frames = Math.ceil(needMs / FRAME_MS) + 1;
    this.targetDelayFrames = Math.min(MAX_DELAY_FRAMES, Math.max(MIN_DELAY_FRAMES, frames));
    return this.targetDelayFrames;
  }

  /**
   * 每个关闭帧调用一次,按固定节拍向目标靠拢。
   * @returns 本帧延迟是否发生变化
   */
  ramp(): boolean {
    if (this.delayFrames === this.targetDelayFrames) {
      this.rampCounter = 0;
      return false;
    }
    this.rampCounter++;
    if (this.rampCounter < DelayController.STEP_EVERY) return false;
    this.rampCounter = 0;
    if (this.delayFrames < this.targetDelayFrames) this.delayFrames++;
    else this.delayFrames--;
    return true;
  }

  consumeChangeEvent(): { oldDelay: number; newDelay: number } | null {
    if (this.delayFrames === this.lastEventedDelay) return null;
    const ev = { oldDelay: this.lastEventedDelay, newDelay: this.delayFrames };
    this.lastEventedDelay = this.delayFrames;
    return ev;
  }

  get ewmaMs(): number {
    return this.rtt.rttEwmaMs;
  }
}
