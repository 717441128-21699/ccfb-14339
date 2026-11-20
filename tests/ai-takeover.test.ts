import { describe, expect, it } from 'vitest';
import { SimHarness } from '../src/net/harness';
import { ContinuityAI } from '../src/core/ai';
import { OrderType } from '../src/core/types';
import { World } from '../src/core/world';
import { GameMap } from '../src/core/map';
import { fp } from '../src/core/fixed';

describe('掉线玩家由电脑接管', () => {
  it('掉线后产生 dropped 事件且该玩家进入 AI 控制', () => {
    const h = new SimHarness({ autoInput: true });
    h.advance(3000);
    h.disconnect(1);
    h.advance(4000);
    const drop = h.events.find((e) => e.kind === 'player-dropped');
    expect(drop).toBeDefined();
    const s = h.room.stats()[1];
    expect(s.dropped).toBe(true);
    expect(s.aiControlled).toBe(true);
  });

  it('接管后 AI 持续产出指令,单位不会原地发呆', () => {
    const h = new SimHarness({ autoInput: true });
    h.advance(2000);
    // 先记录玩家 1 单位的起始位置
    const units = h.room.world.units.filter((u) => u.alive && u.owner === 1);
    const positionsBefore = new Map(units.map((u) => [u.id, { x: u.x, y: u.y }]));
    h.disconnect(1);
    h.advance(6000);

    const moved = units.filter((u) => {
      const before = positionsBefore.get(u.id)!;
      const now = h.room.world.byId[u.id];
      return now.alive && (now.x !== before.x || now.y !== before.y);
    });
    // 大多数存活单位在 6 秒内发生过位移或战斗
    const alive = units.filter((u) => h.room.world.byId[u.id].alive);
    expect(moved.length).toBeGreaterThan(alive.length * 0.6);
  });

  it('AI 不打断掉线前尚未执行完的命令', () => {
    const h = new SimHarness({ autoInput: false });
    h.advance(1000);
    const u = h.room.world.units.find((x) => x.alive && x.owner === 1)!;
    const startX = u.x;
    const targetX = h.room.world.map.width - fp(2);
    h.issue(1, [
      { unitId: u.id, order: { type: OrderType.Move, x: targetX, y: u.y, targetId: 0 } }
    ]);
    h.advance(500);
    h.disconnect(1);
    h.advance(3000);
    const after = h.room.world.byId[u.id];
    // 仍朝原目标移动(目标坐标保持到命令完成)
    expect(after.x).not.toBe(startX);
  });

  it('ContinuityAI 纯函数确定性:同一世界状态两次产出完全相同', () => {
    const mk = () =>
      new World(GameMap.generate(42, 64, 64, 8), 42, { playerCount: 2, unitsPerPlayer: 50 });
    const ai1 = new ContinuityAI(0, 0);
    const ai2 = new ContinuityAI(0, 0);
    const b1 = ai1.produce(mk(), 10);
    const b2 = ai2.produce(mk(), 10);
    expect(b1.orders).toEqual(b2.orders);
  });
});
