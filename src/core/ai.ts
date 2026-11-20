/**
 * 掉线接管 AI —— "把还没做完的事做完,不原地发呆"。
 *
 * 策略(全部通过普通指令通道产出,房间按该玩家身份鉴权):
 * 1. 接管时不清除任何单位的现有命令,单位继续执行掉线前下发的 Move/Attack;
 * 2. 命令完成后进入 Idle 的单位,优先攻击最近敌人(守卫半径内),否则向
 *    队伍质心聚拢;聚拢路上遇到敌人同样转火;
 * 3. 每帧产出受频率上限约束,模拟人类节奏,避免被自身的脚本检测误判。
 *
 * AI 不使用浮点随机:所有选择只依赖世界状态(id 最小平局优先),
 * 因此所有客户端独立运行也会得到逐帧一致的结果。
 */

import { fp } from './fixed';
import { World, Unit } from './world';
import { OrderType } from './types';
import type { CommandBatch, Order } from './types';

/** AI 每帧最多改写多少个单位(约人手节奏,远低于脚本阈值) */
const AI_ORDERS_PER_FRAME = 24;
/** 守卫/索敌半径 */
const GUARD_RANGE = fp(9);
/** 聚拢半径(距离质心超过该值才往回走) */
const RALLY_RANGE = fp(14);

export class ContinuityAI {
  readonly playerId: number;
  /** 接管生效帧 */
  readonly sinceFrame: number;
  private budget = AI_ORDERS_PER_FRAME;
  private nextSeq = 1;

  constructor(playerId: number, sinceFrame: number) {
    this.playerId = playerId;
    this.sinceFrame = sinceFrame;
  }

  /**
   * 在世界 step 之前调用,产出本帧 AI 指令帧。
   * @returns CommandBatch(可能 orders 为空)
   */
  produce(world: World, targetFrame: number): CommandBatch {
    this.budget = AI_ORDERS_PER_FRAME;
    const orders: Array<{ unitId: number; order: Order }> = [];
    const units = world.units;

    let cx = 0;
    let cy = 0;
    let own = 0;
    for (const u of units) {
      if (u.alive && u.owner === this.playerId) {
        cx += u.x;
        cy += u.y;
        own++;
      }
    }
    const centroidX = own > 0 ? Math.round(cx / own) : 0;
    const centroidY = own > 0 ? Math.round(cy / own) : 0;

    // 按 id 升序处理,保证确定
    for (const u of units) {
      if (this.budget <= 0) break;
      if (!u.alive || u.owner !== this.playerId) continue;

      // 1. 掉线前的命令没做完 -> 原样保留,不打断
      if (!u.isIdle(world.byId)) continue;

      const enemy = world.findNearestEnemy(u.x, u.y, this.playerId, GUARD_RANGE);
      if (enemy) {
        orders.push({
          unitId: u.id,
          order: { type: OrderType.Attack, x: enemy.x, y: enemy.y, targetId: enemy.id }
        });
        this.budget--;
        continue;
      }

      // 2. 无敌人且偏离质心过远 -> 向队伍质心移动(不发呆)
      const dx = centroidX - u.x;
      const dy = centroidY - u.y;
      if (dx * dx + dy * dy > RALLY_RANGE * RALLY_RANGE) {
        orders.push({
          unitId: u.id,
          order: { type: OrderType.Move, x: centroidX, y: centroidY, targetId: 0 }
        });
        this.budget--;
      }
      // 其余单位保持 Stop 警戒,下一帧重新评估
    }

    return {
      playerId: this.playerId,
      seq: this.nextSeq++,
      targetFrame,
      orders
    };
  }
}
