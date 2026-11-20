import { describe, expect, it } from 'vitest';
import { SimHarness } from '../src/net/harness';
import { RoomService } from '../src/net/room';
import { GameMap } from '../src/core/map';
import { World } from '../src/core/world';
import { FRAME_MS, OrderType } from '../src/core/types';
import { fp } from '../src/core/fixed';

describe('房间:收齐再广播 + 等待/补空', () => {
  it('所有客户端与房间逐帧同状态(哈希一致)', () => {
    const h = new SimHarness({ autoInput: true });
    h.advance(10000);
    expect(h.room.frame).toBeGreaterThan(150);
    expect(h.allHashesMatch()).toBe(true);
    for (const c of h.clients) expect(c.authoritativeFrame).toBe(h.room.frame);
  });

  it('有人卡顿时房间先等待,超过 stallFrames 才补空并继续推进', () => {
    const h = new SimHarness({ autoInput: true, stallFrames: 6, disconnectFrames: 100000 });
    h.advance(3000);
    const frameAtStall = h.room.frame;

    h.disconnect(1);
    // 等待窗口 = 6 个房间 tick;只跑 4 个 tick 时不应补空
    h.advance(FRAME_MS * 4);
    expect(h.events.some((e) => e.kind === 'backfill')).toBe(false);

    // 越过窗口后补空,对局继续
    h.advance(FRAME_MS * 10);
    const backfills = h.events.filter((e) => e.kind === 'backfill');
    expect(backfills.length).toBeGreaterThan(0);
    expect(h.room.frame).toBeGreaterThan(frameAtStall);
    expect(h.room.stats()[1].backfillCount).toBeGreaterThan(0);
  });

  it('恢复连接后玩家重新跟上,世界仍一致', () => {
    const h = new SimHarness({ autoInput: true, disconnectFrames: 100000 });
    h.advance(2000);
    h.disconnect(0);
    h.advance(2000);
    h.reconnect(0);
    h.advance(6000);
    expect(h.allHashesMatch()).toBe(true);
  });

  it('三人房各客户端帧同步(允许最多 1 帧在途差异)', () => {
    const h = new SimHarness({ playerCount: 3, autoInput: true });
    h.advance(2000);
    expect(h.room.frame).toBeGreaterThan(20);
    for (const c of h.clients) {
      expect(h.room.frame - c.authoritativeFrame).toBeLessThanOrEqual(1);
    }
  });

  it('丢包链路下可靠重传,对局仍能持续推进且状态一致', () => {
    const h = new SimHarness({ autoInput: true });
    h.setLink(1, { baseLatencyMs: 40, jitterMs: 8, lossRate: 0.15 });
    h.advance(15000);
    expect(h.room.frame).toBeGreaterThan(200);
    expect(h.allHashesMatch()).toBe(true);
  });
});

describe('确定性:同种子独立构建的世界逐帧一致', () => {
  it('两个 World 从同一种子生成的初始状态相同', () => {
    const mk = () =>
      new World(GameMap.generate(7, 96, 96, 16), 7, { playerCount: 2, unitsPerPlayer: 100 });
    expect(mk().hash()).toBe(mk().hash());
  });

  it('喂相同帧指令序列,两世界哈希保持一致', () => {
    const mk = () =>
      new World(GameMap.generate(11, 64, 64, 10), 11, { playerCount: 2, unitsPerPlayer: 60 });
    const a = mk();
    const b = mk();
    for (let f = 0; f < 120; f++) {
      const slots = [0, 1].map((p) => ({
        playerId: p,
        backfilled: false,
        orders:
          f % 17 === 0
            ? a.units
                .filter((u) => u.owner === p && u.alive)
                .slice(0, 5)
                .map((u) => ({
                  unitId: u.id,
                  order: {
                    type: OrderType.Move,
                    x: fp(2 + ((f * 7 + p) % 60)),
                    y: fp(2 + (f % 60)),
                    targetId: 0
                  }
                }))
            : []
      }));
      a.step(slots);
      b.step(slots);
      expect(a.hash()).toBe(b.hash());
    }
  });

  it('RoomService 不依赖真实时钟:注入虚拟 now 可全速复现', () => {
    let t = 0;
    // stallFrames=0:缺指令立即补空,保证每次 tick 都关闭一帧
    const room = new RoomService(
      { playerCount: 2, seed: 1, unitsPerPlayer: 10, stallFrames: 0, now: () => t },
      () => {}
    );
    t = 100;
    const b1 = room.tick();
    t = 150;
    const b2 = room.tick();
    expect(RoomService.isClosed(b1)).toBe(true);
    expect(RoomService.isClosed(b2)).toBe(true);
    expect(b2.frame).toBe(b1.frame + 1);
  });
});
