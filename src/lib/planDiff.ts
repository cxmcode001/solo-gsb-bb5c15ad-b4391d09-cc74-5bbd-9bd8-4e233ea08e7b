/**
 * 规划差异报告（只读）。
 *
 * 以「导出 JSON」生成、并通过 parsePlanJsonChecked 完整校验的规划为基线，
 * 与当前规划按分配 id 逐项对比：
 *  - 新增 / 删除：id 仅存在于一侧；
 *  - 重命名：同 id 名称变化；
 *  - 类型变化：同 id kind（子网 / 保留段）变化；
 *  - 迁移：同 id 落位网络地址变化；
 *  - 容量变化：同 id 前缀（prefix）变化。
 * 同一项可同时带多个标签（如迁移 + 容量变化）。
 *
 * 地址差异：取两版全部分配所占地址（闭区间）的并集做集合差，
 * 将差集区间贪心压缩为<strong>最少</strong>的对齐 CIDR 列表，
 * 分别给出当前相对基线「新增占用」与「释放」的地址。
 *
 * 纯本地计算，不修改规划、不产生撤销/重做历史。
 */
import { Allocation, Plan } from './model';
import { Cidr, blockSize, cidrToString, parseCidr } from './ip';

export type DiffTag = 'added' | 'removed' | 'renamed' | 'kind-changed' | 'migrated' | 'resized';

export const DIFF_TAGS: DiffTag[] = [
  'added',
  'removed',
  'renamed',
  'kind-changed',
  'migrated',
  'resized',
];

export const DIFF_TAG_LABEL: Record<DiffTag, string> = {
  added: '新增',
  removed: '删除',
  renamed: '重命名',
  'kind-changed': '类型变化',
  migrated: '迁移',
  resized: '容量变化',
};

export interface DiffItem {
  id: string;
  tags: DiffTag[];
  baseline: Allocation | null;
  current: Allocation | null;
}

export interface AddressBlock {
  cidr: Cidr;
  /** 块内地址总数 */
  size: number;
}

export interface PlanDiff {
  baseline: Plan;
  current: Plan;
  /** 逐项明细，按（基线优先的）落位地址升序 */
  items: DiffItem[];
  /** 当前相对基线新占用的地址（最少 CIDR，地址升序） */
  addedAddresses: AddressBlock[];
  /** 基线占用而当前不再占用的地址（最少 CIDR，地址升序） */
  releasedAddresses: AddressBlock[];
  addedAddressCount: number;
  releasedAddressCount: number;
  /** 带各标签的项数（同一项可计入多个标签） */
  counts: Record<DiffTag, number>;
  /** 两侧均存在且无任何变化标签的项数 */
  unchangedCount: number;
}

/** 闭区间 [lo, hi]，端点为 uint32（hi 最大 2^32−1，无需 uint32 截断） */
interface Interval {
  lo: number;
  hi: number;
}

function allocationIntervals(plan: Plan): Interval[] {
  const out: Interval[] = [];
  for (const alloc of plan.allocations) {
    const c = parseCidr(alloc.cidr);
    if (!c) continue; // 已通过完整校验，这里仅作防御
    out.push({ lo: c.base, hi: c.base + blockSize(c.prefix) - 1 });
  }
  return out.sort((a, b) => a.lo - b.lo);
}

/** 合并相交 / 端点相接的区间。输入按 lo 升序。 */
function mergeIntervals(list: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const iv of list) {
    const last = out[out.length - 1];
    if (last && iv.lo <= last.hi + 1) {
      last.hi = Math.max(last.hi, iv.hi);
    } else {
      out.push({ ...iv });
    }
  }
  return out;
}

/** 区间集合差 a − b（两侧均已合并、升序、内部互不相交）。 */
function intervalDifference(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) {
    let parts: Interval[] = [{ ...x }];
    for (const y of b) {
      if (y.hi < x.lo) continue;
      if (y.lo > x.hi) break;
      const next: Interval[] = [];
      for (const p of parts) {
        if (y.hi < p.lo || y.lo > p.hi) {
          next.push(p);
          continue;
        }
        if (y.lo > p.lo) next.push({ lo: p.lo, hi: y.lo - 1 });
        if (y.hi < p.hi) next.push({ lo: y.hi + 1, hi: p.hi });
      }
      parts = next;
    }
    out.push(...parts);
  }
  return out;
}

/** addr 处对齐约束允许的最大 CIDR 块（2 的幂，上限 2^32）。 */
function alignmentSize(addr: number): number {
  if (addr === 0) return 0x100000000; // 2^32，double 精确可表示
  // addr & -addr 为最低位 1 所在的幂（≤ 2^31）
  return addr & -addr;
}

/**
 * 将互不相交的闭区间集合压缩为<strong>最少</strong>的对齐 CIDR：
 * 每段从最低地址开始，每次取「不越出区间」且「在该地址对齐」的最大块。
 * 贪心最大块即最少块数（标准 CIDR 区间覆盖最优性）。
 */
function compressIntervals(intervals: Interval[]): Cidr[] {
  const out: Cidr[] = [];
  for (const iv of intervals) {
    let cur = iv.lo;
    while (cur <= iv.hi) {
      const remaining = iv.hi - cur + 1;
      const k = Math.min(
        Math.log2(alignmentSize(cur)),
        Math.floor(Math.log2(remaining)),
      );
      const size = 2 ** k;
      out.push({ base: cur >>> 0, prefix: 32 - k });
      cur += size;
    }
  }
  return out.sort((a, b) => a.base - b.base || a.prefix - b.prefix);
}

function toBlocks(cidrs: Cidr[]): AddressBlock[] {
  return cidrs.map((c) => ({ cidr: c, size: blockSize(c.prefix) }));
}

function sumSize(blocks: AddressBlock[]): number {
  return blocks.reduce((n, b) => n + b.size, 0);
}

/** 计算基线与当前规划的差异。两侧假定均已通过 Plan 完整校验。 */
export function diffPlans(baseline: Plan, current: Plan): PlanDiff {
  const baseMap = new Map<string, Allocation>();
  for (const a of baseline.allocations) baseMap.set(a.id, a);
  const curMap = new Map<string, Allocation>();
  for (const a of current.allocations) curMap.set(a.id, a);

  const items: DiffItem[] = [];
  const counts = Object.fromEntries(DIFF_TAGS.map((t) => [t, 0])) as Record<DiffTag, number>;
  let unchangedCount = 0;

  for (const id of new Set([...baseMap.keys(), ...curMap.keys()])) {
    const b = baseMap.get(id) ?? null;
    const c = curMap.get(id) ?? null;
    const tags: DiffTag[] = [];
    if (!b && c) {
      tags.push('added');
    } else if (b && !c) {
      tags.push('removed');
    } else if (b && c) {
      if (b.name !== c.name) tags.push('renamed');
      if (b.kind !== c.kind) tags.push('kind-changed');
      const bc = parseCidr(b.cidr)!;
      const cc = parseCidr(c.cidr)!;
      if (bc.base !== cc.base) tags.push('migrated');
      if (b.prefix !== c.prefix) tags.push('resized');
      if (tags.length === 0) unchangedCount += 1;
    }
    for (const t of tags) counts[t] += 1;
    items.push({ id, tags, baseline: b, current: c });
  }

  items.sort((x, y) => {
    const xc = x.baseline ?? x.current!;
    const yc = y.baseline ?? y.current!;
    const xb = parseCidr(xc.cidr)!.base;
    const yb = parseCidr(yc.cidr)!.base;
    if (xb !== yb) return xb - yb;
    // 同址时删除项排在前
    const xr = x.tags.includes('removed') ? 0 : 1;
    const yr = y.tags.includes('removed') ? 0 : 1;
    return xr - yr || x.id.localeCompare(y.id);
  });

  const baseRanges = mergeIntervals(allocationIntervals(baseline));
  const curRanges = mergeIntervals(allocationIntervals(current));
  const addedCidrs = compressIntervals(intervalDifference(curRanges, baseRanges));
  const releasedCidrs = compressIntervals(intervalDifference(baseRanges, curRanges));
  const addedAddresses = toBlocks(addedCidrs);
  const releasedAddresses = toBlocks(releasedCidrs);

  return {
    baseline,
    current,
    items,
    addedAddresses,
    releasedAddresses,
    addedAddressCount: sumSize(addedAddresses),
    releasedAddressCount: sumSize(releasedAddresses),
    counts,
    unchangedCount,
  };
}

const KIND_LABEL: Record<Allocation['kind'], string> = {
  subnet: '子网',
  reserved: '保留段',
};

function kindOf(a: Allocation | null): string {
  return a ? KIND_LABEL[a.kind] : '—';
}

function formatTags(tags: DiffTag[]): string {
  return tags.length > 0 ? tags.map((t) => DIFF_TAG_LABEL[t]).join(' / ') : '未变化';
}

/** 生成可复制的纯文本差异报告。 */
export function formatDiffReport(diff: PlanDiff): string {
  const lines: string[] = [];
  lines.push('规划差异报告');
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push(
    `基线：根网段 ${diff.baseline.roots.length} 个、分配 ${diff.baseline.allocations.length} 项；` +
      `当前：根网段 ${diff.current.roots.length} 个、分配 ${diff.current.allocations.length} 项`,
  );
  lines.push('');
  lines.push('== 汇总 ==');
  lines.push(
    DIFF_TAGS.map((t) => `${DIFF_TAG_LABEL[t]} ${diff.counts[t]}`).join(' · ') +
      ` · 未变化 ${diff.unchangedCount}`,
  );
  lines.push(
    `新增占用地址 ${diff.addedAddressCount} 个（${diff.addedAddresses.length} 个 CIDR 段）；` +
      `释放地址 ${diff.releasedAddressCount} 个（${diff.releasedAddresses.length} 个 CIDR 段）`,
  );
  lines.push('');
  lines.push('== 逐项明细（按分配 id 对比）==');
  for (const it of diff.items) {
    const tagText = `[${formatTags(it.tags)}]`;
    if (it.tags.includes('added') && it.current) {
      lines.push(
        `${tagText} ${it.current.name}（${kindOf(it.current)}）${it.current.cidr} id=${it.id}`,
      );
    } else if (it.tags.includes('removed') && it.baseline) {
      lines.push(
        `${tagText} ${it.baseline.name}（${kindOf(it.baseline)}）${it.baseline.cidr} id=${it.id}`,
      );
    } else if (it.baseline && it.current) {
      const parts: string[] = [];
      if (it.baseline.name !== it.current.name)
        parts.push(`名称 ${it.baseline.name} → ${it.current.name}`);
      if (it.baseline.kind !== it.current.kind)
        parts.push(`类型 ${kindOf(it.baseline)} → ${kindOf(it.current)}`);
      const bc = parseCidr(it.baseline.cidr)!;
      const cc = parseCidr(it.current.cidr)!;
      if (bc.base !== cc.base) parts.push(`迁移 ${it.baseline.cidr} → ${it.current.cidr}`);
      if (it.baseline.prefix !== it.current.prefix)
        parts.push(`容量 /${it.baseline.prefix} → /${it.current.prefix}`);
      lines.push(`${tagText} ${it.current.name}（${kindOf(it.current)}）id=${it.id}`);
      for (const p of parts) lines.push(`    · ${p}`);
      if (parts.length === 0) lines.push(`    ${it.current.cidr}`);
    }
  }
  lines.push('');
  lines.push('== 地址差异：新增占用（当前占用、基线不占用，最少 CIDR）==');
  if (diff.addedAddresses.length === 0) {
    lines.push('（无）');
  } else {
    for (const b of diff.addedAddresses) lines.push(`${cidrToString(b.cidr)}  # ${b.size} 个地址`);
  }
  lines.push('');
  lines.push('== 地址差异：释放（基线占用、当前不再占用，最少 CIDR）==');
  if (diff.releasedAddresses.length === 0) {
    lines.push('（无）');
  } else {
    for (const b of diff.releasedAddresses) lines.push(`${cidrToString(b.cidr)}  # ${b.size} 个地址`);
  }
  return lines.join('\n');
}
