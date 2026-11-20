import { describe, expect, it } from 'vitest';
import { GameMap } from '../src/core/map';
import { World } from '../src/core/world';
import { SimHarness } from '../src/net/harness';
import { OrderType } from '../src/core/types';
import type { PlayerFrameSlot } from '../src/core/types';
import { fp } from '../src/core/fixed';

/**
 * 性能验收:2000 单位时每帧逻辑 < 8ms。
 * 取 300 个稳定帧的平均与 p95,避免热身/JIT 抖动干扰。
 */
describe('性能:2000 单位每帧逻辑耗时', () => {
  it('world.step 平均 < 8ms,p95 < 10ms', () => {
    const world = new World(GameMap.generate(99, 128, 128, 24), 99, {
      playerCount: 2,
      unitsPerPlayer: 1000
    });
    expect(world.aliveCount()).toBe(2000);

    // 热身,让 JIT 充分优化
    for (let f = 0; f < 30; f++) world.step(emptySlots(2));

    const samples: number[] = [];
    for (let f = 0; f < 300; f++) {
      // 每 10 帧给一部分单位下移动令,覆盖热路径
      const slots = f % 10 === 0 ? noisySlots(world) : emptySlots(2);
      const t0 = performance.now();
      world.step(slots);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    const p95 = samples[Math.floor(samples.length * 0.95)];
    console.log(
      `step 平均 ${avg.toFixed(3)}ms, p95 ${p95.toFixed(3)}ms, 峰值 ${samples[samples.length - 1].toFixed(3)}ms`
    );

    expect(avg).toBeLessThan(8);
    expect(p95).toBeLessThan(10);
  });

  it('完整线束(房间+链路+2 客户端,2000 单位)可持续推进且哈希一致', () => {
    const h = new SimHarness({ playerCount: 2, unitsPerPlayer: 1000, autoInput: true });
    const t0 = performance.now();
    h.advance(5000);
    const elapsed = performance.now() - t0;
    console.log(
      `线束推进 ${h.closedFrameCount} 帧,虚拟 5000ms 实际耗时 ${elapsed.toFixed(1)}ms`
    );
    // 2000 单位下房间等待/补空会带来少量停顿,留网络余量:5s 内至少 60 帧
    expect(h.closedFrameCount).toBeGreaterThan(60);
    expect(h.allHashesMatch()).toBe(true);
  });
});

function emptySlots(playerCount: number): PlayerFrameSlot[] {
  return Array.from({ length: playerCount }, (_, p) => ({
    playerId: p,
    orders: [],
    backfilled: false
  }));
}

function fpClamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function noisySlots(world: World): PlayerFrameSlot[] {
  return [0, 1].map((p) => ({
    playerId: p,
    backfilled: false,
    orders: world.units
      .filter((u) => u.owner === p && u.alive)
      .slice(0, 40)
      .map((u) => ({
        unitId: u.id,
        order: {
          type: OrderType.Move,
          x: fpClamp(u.x + fp(4) - (u.id % 9) * 64, fp(1), world.map.width - fp(1)),
          y: fpClamp(u.y + (u.id % 7) * 64 - fp(3), fp(1), world.map.height - fp(1)),
          targetId: 0
        }
      }))
  }));
}
