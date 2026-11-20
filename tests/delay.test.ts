import { describe, expect, it } from 'vitest';
import { SimHarness } from '../src/net/harness';
import {
  DelayController,
  MAX_RAMP_FRAMES,
  MIN_DELAY_FRAMES,
  MAX_DELAY_FRAMES,
  RttTracker
} from '../src/net/delay';
import { FRAME_MS, OrderType } from '../src/core/types';
import { fp } from '../src/core/fixed';

const TWO_SECONDS_MS = 2000;

describe('RTT 50ms -> 300ms 的输入延迟动态调整', () => {
  it('好网下延迟收敛到低位(约 2~3 帧)', () => {
    const h = new SimHarness({ autoInput: true });
    // 单向 25ms:本模拟里房间时钟测到的 RTT 量级即单向延迟(见 README 拓扑说明)
    h.setLink(1, { baseLatencyMs: 25, jitterMs: 2, lossRate: 0 });
    h.advance(5000);
    const s = h.room.stats()[1];
    expect(s.rttEwmaMs).toBeGreaterThan(10);
    expect(s.rttEwmaMs).toBeLessThan(80);
    expect(s.delayFrames).toBeLessThanOrEqual(4);
    expect(s.delayFrames).toBeGreaterThanOrEqual(MIN_DELAY_FRAMES);
  });

  it('链路变差后 2 秒内调整到位且过程中不跳帧', () => {
    const h = new SimHarness({ autoInput: true });
    // 从 RTT≈50 场景起步(单向 50ms)
    h.setLink(1, { baseLatencyMs: 50, jitterMs: 2 });
    h.advance(5000);
    const startFrame = h.room.frame;
    const startDelay = h.room.stats()[1].delayFrames;

    // 链路切到单向 300ms 量级,测量 RTT 应同步抬升
    h.setLink(1, { baseLatencyMs: 300, jitterMs: 10 });
    h.advance(TWO_SECONDS_MS);

    const stats = h.room.stats()[1];
    expect(stats.rttEwmaMs).toBeGreaterThan(180);
    // 2 秒内已到达目标延迟
    expect(stats.delayFrames).toBe(stats.targetDelayFrames);
    expect(stats.delayFrames).toBeGreaterThan(startDelay);
    expect(stats.delayFrames).toBeLessThanOrEqual(MAX_DELAY_FRAMES);

    // 关键:延迟爬坡期间帧号持续关闭,没有跳帧(允许少量等待停顿)
    expect(h.room.frame - startFrame).toBeGreaterThanOrEqual(TWO_SECONDS_MS / FRAME_MS - 8);

    // delay-change 事件应逐帧发出,且每次只变 1 帧
    const changes = h.events.filter(
      (e) => e.kind === 'delay-change' && e.playerId === 1
    );
    expect(changes.length).toBeGreaterThan(0);
    for (const e of changes) {
      if (e.kind === 'delay-change') expect(Math.abs(e.newDelay - e.oldDelay)).toBe(1);
    }
  });

  it('爬坡总时长不超过 MAX_RAMP_FRAMES(2 秒)的设计上限', () => {
    const rtt = new RttTracker();
    rtt.sample(50);
    const ctl = new DelayController(0, rtt, MIN_DELAY_FRAMES);
    ctl.recomputeTarget();
    // 直接把 RTT 拉满到 300ms
    for (let i = 0; i < 12; i++) rtt.sample(300);
    ctl.recomputeTarget();
    const gap = ctl.targetDelayFrames - ctl.delayFrames;
    let steps = 0;
    while (ctl.delayFrames !== ctl.targetDelayFrames) {
      ctl.ramp();
      steps++;
    }
    expect(steps).toBeLessThanOrEqual(MAX_RAMP_FRAMES);
    expect(steps).toBeGreaterThanOrEqual(gap);
  });

  it('延迟变化只影响新指令,已排队指令的目标帧不被改写(画面不跳)', () => {
    const h = new SimHarness({ autoInput: false });
    h.advance(2000);
    const client = h.clients[0];
    const unit = client.world.units.find((u) => u.alive && u.owner === 0)!;
    const batch = client.issueOrders([
      { unitId: unit.id, order: { type: OrderType.Move, x: fp(20), y: fp(20), targetId: 0 } }
    ])!;
    const lockedFrame = batch.targetFrame;

    // 网络变差导致延迟拉长
    h.setLink(0, { baseLatencyMs: 150, jitterMs: 10 });
    h.advance(2500);

    // 旧指令仍以原目标帧到达房间并被消费
    expect(lockedFrame).toBeLessThan(h.room.frame);
    // 且没有任何客户端出现世界分叉
    expect(h.allHashesMatch()).toBe(true);
  });
});
