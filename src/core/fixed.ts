/**
 * Q8 定点运算与确定性整数工具。
 * 模拟层只允许使用这里的数学函数,禁止直接调用 Math.random / Date.now /
 * 浮点三角函数等跨环境可能不一致的 API。
 */

import { FP } from './types';

export const fp = (v: number): number => Math.round(v * FP);

export const toFloat = (v: number): number => v / FP;

export const fpMul = (a: number, b: number): number => Math.imul(a, b) >> 8;

export const fpDiv = (a: number, b: number): number => (a << 8) / b;

/** 定点绝对值 */
export const fpAbs = (v: number): number => (v < 0 ? -v : v);

/** 定点 clamp */
export const fpClamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/**
 * 确定性整数平方根(牛顿迭代),返回 floor(sqrt(n))。
 * 用于距离比较时尽量改用距离平方比较,减少调用。
 */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let x = n;
  // 初始估计:浮点 sqrt 仅用于取整数初值,迭代结果与初值无关,仍然确定。
  let y = (Math.sqrt(n) | 0) + 1;
  while (y < x) {
    x = y;
    y = ((y + Math.floor(n / y)) >> 1);
  }
  return x;
}

/** 两点距离平方(定点),避免开方 */
export const distSq = (ax: number, ay: number, bx: number, by: number): number => {
  const dx = ax - bx;
  const dy = ay - by;
  // 定点坐标平方后是 Q16,调用方按 Q16 比较即可
  return dx * dx + dy * dy;
};

/**
 * mulberry32 — 确定性 32 位 PRNG。
 * 每个需要随机的子系统持有自己的状态(并写入世界快照),按固定顺序步进,
 * 从而保证所有客户端逐帧一致。
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从 u32 派生一个新的非零种子 */
export function deriveSeed(parent: number, salt: number): number {
  let h = (parent ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0;
  if (h === 0) h = 0x2545f4;
  return h;
}

/** 32 位 FNV 风格滚动哈希,用于世界状态校验和 */
export class RollingHash {
  private h = 0x811c9dc5;

  pushInt(v: number): this {
    this.h = Math.imul(this.h ^ (v | 0), 0x01000193) >>> 0;
    return this;
  }

  pushBytes(bytes: ArrayLike<number>): this {
    for (let i = 0; i < bytes.length; i++) {
      this.h = Math.imul(this.h ^ bytes[i], 0x01000193) >>> 0;
    }
    return this;
  }

  value(): number {
    // fmix32 收尾
    let h = this.h;
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
  }
}
