import { describe, expect, it } from 'vitest';
import { Allocation, Plan, emptyPlan } from './model';
import { AddressBlock, DIFF_TAG_LABEL, diffPlans, formatDiffReport } from './planDiff';

function mk(
  id: string,
  name: string,
  cidr: string,
  kind: Allocation['kind'] = 'subnet',
): Allocation {
  return { id, name, kind, prefix: Number(cidr.split('/')[1]), cidr };
}

function plan(roots: [string, string][], allocs: Allocation[]): Plan {
  return {
    version: 1,
    roots: roots.map(([id, cidr]) => ({ id, name: id, cidr })),
    allocations: allocs,
  };
}

function cidrs(blocks: AddressBlock[]): string[] {
  return blocks.map((b) => {
    const a = b.cidr.base;
    const ip = [(a >>> 24) & 255, (a >>> 16) & 255, (a >>> 8) & 255, a & 255].join('.');
    return `${ip}/${b.cidr.prefix}`;
  });
}

describe('diffPlans — 按 id 的逐项分类', () => {
  it('识别新增、删除、未变化', () => {
    const base = plan([['r', '10.0.0.0/8']], [mk('a', 'A', '10.0.0.0/24'), mk('b', 'B', '10.0.1.0/24')]);
    const cur = plan([['r', '10.0.0.0/8']], [mk('a', 'A', '10.0.0.0/24'), mk('c', 'C', '10.0.2.0/24')]);
    const d = diffPlans(base, cur);
    const byId = Object.fromEntries(d.items.map((i) => [i.id, i]));
    expect(byId.b.tags).toEqual(['removed']);
    expect(byId.c.tags).toEqual(['added']);
    expect(byId.a.tags).toEqual([]);
    expect(d.unchangedCount).toBe(1);
    expect(d.counts.added).toBe(1);
    expect(d.counts.removed).toBe(1);
  });

  it('同一项可同时带迁移与容量变化标签', () => {
    const base = plan([['r', '10.0.0.0/8']], [mk('x', 'X', '10.0.0.0/24')]);
    const cur = plan([['r', '10.0.0.0/8']], [mk('x', 'X', '10.1.0.0/20')]);
    const d = diffPlans(base, cur);
    const item = d.items[0];
    expect(item.tags).toContain('migrated');
    expect(item.tags).toContain('resized');
    expect(d.counts.migrated).toBe(1);
    expect(d.counts.resized).toBe(1);
  });

  it('原地容量变化只带容量标签；同位移动（base 不变）不算迁移', () => {
    const base = plan([['r', '10.0.0.0/8']], [mk('x', 'X', '10.0.0.0/24')]);
    const cur = plan([['r', '10.0.0.0/8']], [mk('x', 'X', '10.0.0.0/20')]);
    const tags = diffPlans(base, cur).items[0].tags;
    expect(tags).toEqual(['resized']);
  });

  it('重命名与类型变化', () => {
    const base = plan([['r', '10.0.0.0/8']], [mk('x', '旧', '10.0.0.0/24', 'subnet')]);
    const cur = plan([['r', '10.0.0.0/8']], [mk('x', '新', '10.0.0.0/24', 'reserved')]);
    const tags = diffPlans(base, cur).items[0].tags;
    expect(tags).toEqual(['renamed', 'kind-changed']);
  });

  it('空对空', () => {
    const d = diffPlans(emptyPlan(), emptyPlan());
    expect(d.items).toHaveLength(0);
    expect(d.addedAddresses).toEqual([]);
    expect(d.releasedAddresses).toEqual([]);
  });
});

describe('diffPlans — 地址并集差集与最少 CIDR 压缩', () => {
  it('整体新增 / 删除一个块', () => {
    const base = plan([['r', '10.0.0.0/8']], []);
    const cur = plan([['r', '10.0.0.0/8']], [mk('a', 'A', '10.0.0.0/24')]);
    const d = diffPlans(base, cur);
    expect(cidrs(d.addedAddresses)).toEqual(['10.0.0.0/24']);
    expect(d.addedAddressCount).toBe(256);
    expect(d.releasedAddresses).toEqual([]);
    const d2 = diffPlans(cur, base);
    expect(cidrs(d2.releasedAddresses)).toEqual(['10.0.0.0/24']);
    expect(d2.addedAddresses).toEqual([]);
  });

  it('原位扩容（/25 → /24）：新增与释放各为精确的半块', () => {
    const base = plan([['r', '10.0.0.0/8']], [mk('a', 'A', '10.0.0.0/25')]);
    const cur = plan([['r', '10.0.0.0/8']], [mk('a', 'A', '10.0.0.0/24')]);
    const d = diffPlans(base, cur);
    expect(cidrs(d.addedAddresses)).toEqual(['10.0.0.128/25']);
    expect(d.releasedAddresses).toEqual([]);
  });

  it('原位缩容（/24 → /25）：释放精确半块', () => {
    const base = plan([['r', '10.0.0.0/8']], [mk('a', 'A', '10.0.0.0/24')]);
    const cur = plan([['r', '10.0.0.0/8']], [mk('a', 'A', '10.0.0.0/25')]);
    const d = diffPlans(base, cur);
    expect(cidrs(d.releasedAddresses)).toEqual(['10.0.0.128/25']);
    expect(d.addedAddresses).toEqual([]);
  });

  it('迁移到不相交位置：新增与释放各为整段', () => {
    const base = plan([['r', '10.0.0.0/8']], [mk('a', 'A', '10.0.0.0/24')]);
    const cur = plan([['r', '10.0.0.0/8']], [mk('a', 'A', '10.9.0.0/24')]);
    const d = diffPlans(base, cur);
    expect(cidrs(d.addedAddresses)).toEqual(['10.9.0.0/24']);
    expect(cidrs(d.releasedAddresses)).toEqual(['10.0.0.0/24']);
    expect(d.addedAddressCount).toBe(256);
    expect(d.releasedAddressCount).toBe(256);
  });

  it('多个新增小块合并为最少 CIDR（两个伙伴 /25 → 一个 /24）', () => {
    const base = plan([['r', '10.0.0.0/8']], []);
    const cur = plan([['r', '10.0.0.0/8']], [
      mk('a', 'A', '10.1.0.0/25'),
      mk('b', 'B', '10.1.0.128/25'),
    ]);
    const d = diffPlans(base, cur);
    expect(cidrs(d.addedAddresses)).toEqual(['10.1.0.0/24']);
  });

  it('重叠迁移：/25 从 .0 移到 .128，差集为两个不相交 /25', () => {
    const base = plan([['r', '10.0.0.0/8']], [mk('a', 'A', '10.0.0.0/25')]);
    const cur = plan([['r', '10.0.0.0/8']], [mk('a', 'A', '10.0.0.128/25')]);
    const d = diffPlans(base, cur);
    expect(cidrs(d.addedAddresses)).toEqual(['10.0.0.128/25']);
    expect(cidrs(d.releasedAddresses)).toEqual(['10.0.0.0/25']);
  });

  it('跨根网段的地址并集统一做差', () => {
    const base = plan(
      [
        ['r1', '10.0.0.0/8'],
        ['r2', '192.168.0.0/16'],
      ],
      [mk('a', 'A', '192.168.0.0/24')],
    );
    const cur = plan(
      [
        ['r1', '10.0.0.0/8'],
        ['r2', '192.168.0.0/16'],
      ],
      [mk('a', 'A', '10.0.0.0/24')],
    );
    const d = diffPlans(base, cur);
    expect(cidrs(d.addedAddresses)).toEqual(['10.0.0.0/24']);
    expect(cidrs(d.releasedAddresses)).toEqual(['192.168.0.0/24']);
  });

  it('不规则差集压缩为最少 CIDR：释放 10.0.0.0/24 后新增 10.0.0.1', () => {
    // 释放段 .0/24 中仅 .1 仍被占用 → 释放 = {.0} ∪ [.2..255]
    const base = plan([['r', '10.0.0.0/8']], [mk('a', 'A', '10.0.0.0/24')]);
    const cur = plan([['r', '10.0.0.0/8']], [mk('a', 'A', '10.0.0.1/32')]);
    const d = diffPlans(base, cur);
    expect(cidrs(d.addedAddresses)).toEqual([]);
    // 最少覆盖：10.0.0.0/32、10.0.0.2/31、10.0.0.4/30、10.0.0.8/29、
    // 10.0.0.16/28、10.0.0.32/27、10.0.0.64/26、10.0.0.128/25
    expect(cidrs(d.releasedAddresses)).toEqual([
      '10.0.0.0/32',
      '10.0.0.2/31',
      '10.0.0.4/30',
      '10.0.0.8/29',
      '10.0.0.16/28',
      '10.0.0.32/27',
      '10.0.0.64/26',
      '10.0.0.128/25',
    ]);
    expect(d.releasedAddressCount).toBe(255);
  });

  it('/0 边界：0.0.0.0/0 与空集之差仍为 /0', () => {
    const base = plan([['r', '0.0.0.0/0']], [mk('a', 'A', '0.0.0.0/0')]);
    const cur = plan([['r', '0.0.0.0/0']], []);
    const d = diffPlans(base, cur);
    expect(cidrs(d.releasedAddresses)).toEqual(['0.0.0.0/0']);
    expect(d.releasedAddressCount).toBe(2 ** 32);
  });

  it('全部地址恒常：新增与释放均为空', () => {
    const base = plan([['r', '10.0.0.0/24']], [mk('a', 'A', '10.0.0.0/25'), mk('b', 'B', '10.0.0.128/25')]);
    const cur = plan([['r', '10.0.0.0/24']], [mk('c', 'C', '10.0.0.0/24')]);
    const d = diffPlans(base, cur);
    expect(d.addedAddresses).toEqual([]);
    expect(d.releasedAddresses).toEqual([]);
    expect(d.addedAddressCount).toBe(0);
  });
});

describe('formatDiffReport', () => {
  it('包含汇总、逐项标签与地址段', () => {
    const base = plan([['r', '10.0.0.0/8']], [mk('a', '旧名', '10.0.0.0/24')]);
    const cur = plan([['r', '10.0.0.0/8']], [mk('a', '新名', '10.1.0.0/24'), mk('b', 'B', '10.2.0.0/24')]);
    const text = formatDiffReport(diffPlans(base, cur));
    expect(text).toContain('规划差异报告');
    expect(text).toContain(`重命名 1`);
    expect(text).toContain(`迁移 1`);
    expect(text).toContain(`新增 1`);
    expect(text).toContain('10.1.0.0/24');
    expect(text).toContain('10.0.0.0/24');
    expect(text).toContain(DIFF_TAG_LABEL.renamed);
  });
});
