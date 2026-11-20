/**
 * 确定性地图:固定网格 + 圆形障碍。
 * 由种子生成,所有客户端从同一 seed 得到同一张图,不参与每帧随机。
 */

import { fp, mulberry32 } from './fixed';

export interface Obstacle {
  cx: number;
  cy: number;
  r: number;
}

export class GameMap {
  readonly width: number;
  readonly height: number;
  readonly obstacles: Obstacle[];
  /** 每格边长(Q8),网格用于单位分桶和简单避让 */
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;

  constructor(width: number, height: number, obstacles: Obstacle[], cellSize = fp(4)) {
    this.width = width;
    this.height = height;
    this.obstacles = obstacles;
    this.cellSize = cellSize;
    this.cols = Math.ceil(width / cellSize);
    this.rows = Math.ceil(height / cellSize);
  }

  static generate(seed: number, widthUnits = 128, heightUnits = 128, obstacleCount = 24): GameMap {
    const rand = mulberry32(seed);
    const width = fp(widthUnits);
    const height = fp(heightUnits);
    const obstacles: Obstacle[] = [];
    const margin = fp(8);
    for (let i = 0; i < obstacleCount; i++) {
      const r = fp(1.5 + rand() * 2.5);
      const cx = margin + Math.floor(rand() * ((width - margin * 2) / 256)) * 256 + fp(rand());
      const cy = margin + Math.floor(rand() * ((height - margin * 2) / 256)) * 256 + fp(rand());
      obstacles.push({ cx, cy, r });
    }
    return new GameMap(width, height, obstacles);
  }

  cellIndex(x: number, y: number): number {
    const cx = Math.min(this.cols - 1, Math.max(0, (x / this.cellSize) | 0));
    const cy = Math.min(this.rows - 1, Math.max(0, (y / this.cellSize) | 0));
    return cy * this.cols + cx;
  }

  /** 点是否撞障碍(允许额外半径) */
  hitsObstacle(x: number, y: number, radius: number): boolean {
    for (const o of this.obstacles) {
      const dx = x - o.cx;
      const dy = y - o.cy;
      const rr = o.r + radius;
      if (dx * dx + dy * dy < rr * rr) return true;
    }
    return false;
  }

  clampToBounds(x: number, y: number, radius: number): [number, number] {
    return [
      Math.min(this.width - radius, Math.max(radius, x)),
      Math.min(this.height - radius, Math.max(radius, y))
    ];
  }
}
