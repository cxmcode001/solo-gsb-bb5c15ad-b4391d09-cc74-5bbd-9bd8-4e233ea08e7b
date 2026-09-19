import { describe, expect, it } from 'vitest';
import { Plan, parsePlanJsonChecked, serializePlan } from './model';

const valid: Plan = {
  version: 1,
  roots: [{ id: 'r1', name: '根', cidr: '10.0.0.0/8' }],
  allocations: [{ id: 'a1', name: '子网', kind: 'subnet', prefix: 24, cidr: '10.0.0.0/24' }],
};

describe('parsePlanJsonChecked（基线文件校验入口）', () => {
  it('合法规划返回 ok 与 Plan', () => {
    const r = parsePlanJsonChecked(serializePlan(valid));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.allocations[0].id).toBe('a1');
      expect(r.plan.roots[0].cidr).toBe('10.0.0.0/8');
    }
  });

  it('JSON 语法错误：结构化报错且不抛异常', () => {
    const r = parsePlanJsonChecked('{ not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toContain('JSON 解析失败');
  });

  it('结构缺字段：列出错误', () => {
    const r = parsePlanJsonChecked('{"roots":[]}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toContain('roots / allocations');
  });

  it('内容非法（分配越界 + id 重复）：逐条列出错误', () => {
    const bad = {
      version: 1,
      roots: [{ id: 'r1', name: '根', cidr: '10.0.0.0/8' }],
      allocations: [
        { id: 'x', name: '越界', kind: 'subnet', prefix: 24, cidr: '192.168.0.0/24' },
        { id: 'x', name: '重复id', kind: 'subnet', prefix: 24, cidr: '10.1.0.0/24' },
      ],
    };
    const r = parsePlanJsonChecked(JSON.stringify(bad));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const text = r.errors.join('\n');
      expect(text).toContain('越界');
      expect(text).toContain('id 重复');
    }
  });
});
