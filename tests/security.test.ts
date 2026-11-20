import { describe, expect, it } from 'vitest';
import { SimHarness } from '../src/net/harness';
import { CommandValidator } from '../src/net/validator';
import { OrderType } from '../src/core/types';
import { fp } from '../src/core/fixed';

describe('指令校验:只能操作自己的单位', () => {
  it('越权操作别人的单位会被拒绝', () => {
    const h = new SimHarness({ autoInput: false });
    h.advance(500);
    const enemy = h.clients[1].world.units.find((u) => u.alive && u.owner === 1)!;
    h.issue(0, [
      { unitId: enemy.id, order: { type: OrderType.Move, x: fp(1), y: fp(1), targetId: 0 } }
    ]);
    h.advance(1000);
    const rejected = h.events.filter((e) => e.kind === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);
    if (rejected[0].kind === 'rejected') expect(rejected[0].reason).toContain('越权');
  });

  it('操作不存在单位被拒绝', () => {
    const h = new SimHarness({ autoInput: false });
    h.advance(500);
    h.issue(0, [
      { unitId: 999999, order: { type: OrderType.Move, x: fp(1), y: fp(1), targetId: 0 } }
    ]);
    h.advance(1000);
    expect(h.events.some((e) => e.kind === 'rejected')).toBe(true);
  });

  it('validator 直接校验:合法指令通过', () => {
    const h = new SimHarness({ autoInput: false });
    const v = new CommandValidator(h.room.world, 2);
    const own = h.room.world.units.find((u) => u.alive && u.owner === 0)!;
    const ok = v.validate(
      {
        playerId: 0,
        seq: 1,
        targetFrame: h.room.frame + 3,
        orders: [{ unitId: own.id, order: { type: OrderType.Stop, x: 0, y: 0, targetId: 0 } }]
      },
      h.room.frame
    );
    expect(ok.ok).toBe(true);
  });

  it('seq 回退与过期帧被拒绝', () => {
    const h = new SimHarness({ autoInput: false });
    h.advance(500);
    const own = h.room.world.units.find((u) => u.alive && u.owner === 0)!;
    const make = (seq: number, targetFrame: number) => ({
      playerId: 0,
      seq,
      targetFrame,
      orders: [{ unitId: own.id, order: { type: OrderType.Stop, x: 0, y: 0, targetId: 0 } }]
    });
    h.room.handle({ kind: 'command', batch: make(5, h.room.frame + 2) });
    h.room.handle({ kind: 'command', batch: make(4, h.room.frame + 3) });
    h.room.handle({ kind: 'command', batch: make(6, h.room.frame - 1) });
    const reasons = h.events
      .filter((e) => e.kind === 'rejected')
      .map((e) => (e.kind === 'rejected' ? e.reason : ''));
    expect(reasons.some((r) => r.includes('seq'))).toBe(true);
    expect(reasons.some((r) => r.includes('过期'))).toBe(true);
  });
});

describe('脚本行为检测', () => {
  it('持续超过人手极限的指令频率会被标记', () => {
    const h = new SimHarness({ autoInput: false });
    h.advance(500);
    const before = h.room.validator.flagCount(0);
    h.scriptBurst(0);
    expect(h.room.validator.flagCount(0)).toBeGreaterThan(before);
    expect(h.events.some((e) => e.kind === 'script-flag')).toBe(true);
  });

  it('正常自动输入的玩家不会被误判', () => {
    const h = new SimHarness({ autoInput: true });
    h.advance(15000);
    for (const s of h.room.stats()) expect(s.scriptFlags).toBe(0);
  });

  it('同一单位单帧两条指令被拒绝', () => {
    const h = new SimHarness({ autoInput: false });
    h.advance(500);
    const own = h.room.world.units.find((u) => u.alive && u.owner === 0)!;
    h.room.handle({
      kind: 'command',
      batch: {
        playerId: 0,
        seq: 1,
        targetFrame: h.room.frame + 2,
        orders: [
          { unitId: own.id, order: { type: OrderType.Stop, x: 0, y: 0, targetId: 0 } },
          { unitId: own.id, order: { type: OrderType.Move, x: fp(1), y: fp(1), targetId: 0 } }
        ]
      }
    });
    expect(h.events.some((e) => e.kind === 'rejected')).toBe(true);
  });
});
