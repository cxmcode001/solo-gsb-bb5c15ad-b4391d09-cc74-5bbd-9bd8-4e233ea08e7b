import { useRef, useState } from 'react';
import { Plan, parsePlanJsonChecked } from '../lib/model';
import {
  AddressBlock,
  DIFF_TAG_LABEL,
  DIFF_TAGS,
  DiffItem,
  DiffTag,
  PlanDiff,
  diffPlans,
  formatDiffReport,
} from '../lib/planDiff';
import { cidrToString } from '../lib/ip';

interface Props {
  plan: Plan;
  onClose: () => void;
}

const TAG_CLASS: Record<DiffTag, string> = {
  added: 'diff-added',
  removed: 'diff-removed',
  renamed: 'diff-renamed',
  'kind-changed': 'diff-kind',
  migrated: 'diff-migrated',
  resized: 'diff-resized',
};

/**
 * 规划差异报告弹窗：导入由「导出 JSON」生成的基线文件（先经与导入完全相同的
 * Plan 完整校验，非法则逐条列出错误、不生成结果），再按分配 id 与当前规划对比，
 * 输出分类标签明细与地址并集差集的最少 CIDR。
 * 纯本地只读：不修改规划、不产生修订历史，冲突锁定期间仍可使用。
 */
export default function PlanDiffModal({ plan, onClose }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [baseline, setBaseline] = useState<Plan | null>(null);
  const [baselineName, setBaselineName] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<PlanDiff | null>(null);
  const [copied, setCopied] = useState(false);

  const loadText = (text: string, name: string) => {
    const parsed = parsePlanJsonChecked(text);
    setCopied(false);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      setBaseline(null);
      setBaselineName('');
      setResult(null);
      return;
    }
    setErrors([]);
    setBaseline(parsed.plan);
    setBaselineName(name);
    setResult(diffPlans(parsed.plan, plan));
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    loadText(text, file.name);
    if (fileRef.current) fileRef.current.value = '';
  };

  const rerun = () => {
    if (!baseline) return;
    setCopied(false);
    setResult(diffPlans(baseline, plan));
  };

  const report = result ? formatDiffReport(result) : '';

  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report);
    } catch {
      // 剪贴板 API 不可用（如非安全上下文）时回退
      const ta = document.createElement('textarea');
      ta.value = report;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
  };

  const changedItems = result ? result.items.filter((i) => i.tags.length > 0) : [];
  const stale = baseline !== null && result !== null && result.current !== plan;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h3>规划差异报告</h3>
        <p className="muted">
          导入由工具栏「<strong>导出 JSON</strong>」生成的基线文件，按<strong>分配 id</strong>
          与当前规划逐项对比：新增、删除、重命名、类型变化（子网/保留段）、迁移（落位变化）、
          容量变化（前缀变化），同一项可带多个标签；同时对两版全部分配的<strong>地址并集做差集</strong>，
          精确压缩为<strong>最少 CIDR</strong>，分别列出新增占用与释放地址。
          基线文件先经与「导入 JSON」完全相同的完整校验，非法时只列出错误、不生成结果。
          纯本地只读计算，不修改规划与历史，冲突锁定期间仍可使用。
        </p>

        <div className="dhcp-result-head">
          <span>
            {baseline ? (
              <>
                基线文件：<code>{baselineName || '(粘贴文本)'}</code>
                <span className="muted">
                  {' '}
                  （根网段 {baseline.roots.length} 个 · 分配 {baseline.allocations.length} 项）
                </span>
              </>
            ) : (
              <span className="muted">尚未载入基线文件</span>
            )}
          </span>
          <span>
            <button className="btn small" onClick={() => fileRef.current?.click()}>
              {baseline ? '重新选择基线文件' : '选择基线文件…'}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => void handleFile(e.target.files?.[0])}
            />
          </span>
        </div>

        <details>
          <summary className="muted">或直接粘贴基线 JSON 文本</summary>
          <PasteForm onSubmit={(text) => loadText(text, '')} />
        </details>

        {errors.length > 0 && (
          <div className="diff-errors">
            <strong>基线文件非法，未生成结果：</strong>
            <ul className="errors">
              {errors.map((er, i) => (
                <li key={i}>{er}</li>
              ))}
            </ul>
          </div>
        )}

        {result && (
          <div className="dhcp-result">
            {stale && (
              <div className="diff-stale">
                当前规划在报告生成后又有变化，
                <button className="btn small" onClick={rerun}>
                  重新对比
                </button>
              </div>
            )}
            <div className="dhcp-result-head">
              <span>
                {DIFF_TAGS.map((t) => (
                  <span key={t} className={`diff-count ${TAG_CLASS[t]}`}>
                    {DIFF_TAG_LABEL[t]} {result.counts[t]}
                  </span>
                ))}
                <span className="diff-count">未变化 {result.unchangedCount}</span>
              </span>
              <button className="btn small" onClick={copyReport}>
                {copied ? '已复制 ✓' : '复制文本报告'}
              </button>
            </div>
            <div className="diff-addr-summary">
              <span className="diff-added">
                新增占用 {result.addedAddressCount} 个地址（{result.addedAddresses.length} 个 CIDR）
              </span>
              <span className="diff-removed">
                释放 {result.releasedAddressCount} 个地址（{result.releasedAddresses.length} 个 CIDR）
              </span>
            </div>

            <h4>逐项明细</h4>
            {changedItems.length === 0 ? (
              <p className="muted">按分配 id 对比无任何变化（{result.unchangedCount} 项完全一致）。</p>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>变化</th>
                      <th>名称 / id</th>
                      <th>基线</th>
                      <th>当前</th>
                    </tr>
                  </thead>
                  <tbody>
                    {changedItems.map((item) => (
                      <DiffRow key={item.id} item={item} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <h4>地址差异</h4>
            <div className="diff-addr-cols">
              <AddressList
                title="新增占用"
                tone="added"
                blocks={result.addedAddresses}
                count={result.addedAddressCount}
              />
              <AddressList
                title="释放"
                tone="removed"
                blocks={result.releasedAddresses}
                count={result.releasedAddressCount}
              />
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

function PasteForm({ onSubmit }: { onSubmit: (text: string) => void }) {
  const [text, setText] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onSubmit(text);
      }}
    >
      <label className="field">
        <textarea
          rows={7}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='{"version":1,"roots":[...],"allocations":[...]}'
          spellCheck={false}
        />
      </label>
      <button className="btn small primary" type="submit" disabled={!text.trim()}>
        载入并对比
      </button>
    </form>
  );
}

function AllocCell({ alloc }: { alloc: DiffItem['baseline'] }) {
  if (!alloc) return <span className="muted">—</span>;
  return (
    <div>
      <span className={`badge ${alloc.kind === 'reserved' ? 'reserved' : 'subnet'}`}>
        {alloc.kind === 'reserved' ? '保留段' : '子网'}
      </span>{' '}
      <strong>{alloc.name}</strong> <code>{alloc.cidr}</code>
      <div className="muted">/{alloc.prefix}</div>
    </div>
  );
}

function DiffRow({ item }: { item: DiffItem }) {
  return (
    <tr className={`diff-row ${item.tags.map((t) => TAG_CLASS[t]).join(' ')}`}>
      <td>
        {item.tags.map((t) => (
          <span key={t} className={`diff-tag ${TAG_CLASS[t]}`}>
            {DIFF_TAG_LABEL[t]}
          </span>
        ))}
      </td>
      <td>
        {item.current ? <strong>{item.current.name}</strong> : item.baseline && <strong>{item.baseline.name}</strong>}
        <div className="muted">
          <code>{item.id}</code>
        </div>
      </td>
      <td>
        <AllocCell alloc={item.baseline} />
      </td>
      <td>
        <AllocCell alloc={item.current} />
      </td>
    </tr>
  );
}

function AddressList({
  title,
  tone,
  blocks,
  count,
}: {
  title: string;
  tone: 'added' | 'removed';
  blocks: AddressBlock[];
  count: number;
}) {
  return (
    <div className={`diff-addr-list ${tone === 'added' ? 'diff-added' : 'diff-removed'}`}>
      <h5>
        {title} <span className="muted">（{count} 个地址 · {blocks.length} 个 CIDR）</span>
      </h5>
      {blocks.length === 0 ? (
        <p className="muted">（无）</p>
      ) : (
        <ul>
          {blocks.map((b) => (
            <li key={`${b.cidr.base}-${b.cidr.prefix}`}>
              <code>{cidrToString(b.cidr)}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
