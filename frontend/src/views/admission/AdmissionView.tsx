import { useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries } from '@/api/local-service'
import {
  admitBatch,
  admitBatches,
  ensureAdmissionState,
  exportAdmissionBundle,
  loadAdmissionSnapshot,
  refreshAdmission,
  resetAdmission,
  reviewConflict,
  startBatch,
  syncBundle,
  verifyAdmission,
  type AdmissionSnapshot,
  type VerificationResult,
} from '@/api/admission-service'
import type { EntryRow } from '@/data/types'

const columns = [
  '批次编号',
  '目标站点',
  '配置编号',
  '每秒请求上限',
  '令牌桶容量',
  '申请令牌数',
  '已分配令牌数',
  '配置版本',
  '准入结果',
  '等待原因',
  '下一可用时间',
  '复核状态',
]

const configPresets = [
  { configNo: 'RATE-0003', limitPerSecond: 1, bucketCapacity: 1, label: 'SITE-0003 下调为 1 次/秒' },
  { configNo: 'RATE-0003', limitPerSecond: 2, bucketCapacity: 2, label: 'SITE-0003 恢复为 2 次/秒' },
  { configNo: 'RATE-0003', limitPerSecond: 0, bucketCapacity: 0, label: 'SITE-0003 提交非法上限（0）' },
]

function emptySnapshot(): AdmissionSnapshot {
  return {
    revision: 0,
    ledger: {
      revision: 0,
      seq: 0,
      sites: {},
      traces: [],
      conflicts: [],
      receipts: {},
      lastVerification: null,
    },
    rows: [],
    sites: [],
    waiting: [],
    conflicts: [],
    decisions: [],
    traces: [],
    verification: null,
    stats: [],
  }
}

function downloadText(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function formatTime(ms: number): string {
  if (!ms) return '—'
  const date = new Date(ms)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export default function AdmissionView() {
  const [snapshot, setSnapshot] = useState<AdmissionSnapshot>(() => emptySnapshot())
  const [message, setMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [verification, setVerification] = useState<VerificationResult | null>(null)
  const [siteFilter, setSiteFilter] = useState('')
  const [configNo, setConfigNo] = useState('RATE-0003')
  const [limitPerSecond, setLimitPerSecond] = useState(1)
  const [bucketCapacity, setBucketCapacity] = useState(1)

  const reload = useCallback(() => {
    try {
      ensureAdmissionState()
      setSnapshot(loadAdmissionSnapshot())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '限速准入数据读取失败')
    }
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  // 任务编排侧同步进新批次后，准入页跟随刷新；切回页面时再对一次账。
  useEffect(() => {
    const refresh = () => reload()
    window.addEventListener('focus', refresh)
    const timer = window.setInterval(refresh, 5000)
    return () => {
      window.removeEventListener('focus', refresh)
      window.clearInterval(timer)
    }
  }, [reload])

  function act(work: () => { ok: boolean; message: string }) {
    setMessage('')
    setErrorMessage('')
    try {
      const result = work()
      if (result.ok) {
        setMessage(result.message)
      } else {
        setErrorMessage(result.message)
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '限速准入处理失败')
    }
    reload()
  }

  const visibleRows = useMemo(() => {
    const keyword = siteFilter.trim()
    if (!keyword) return snapshot.rows
    return snapshot.rows.filter(
      (row) => String(row['目标站点'] ?? '').includes(keyword) || String(row['批次编号'] ?? '').includes(keyword),
    )
  }, [snapshot.rows, siteFilter])

  function runVerify() {
    setMessage('')
    setErrorMessage('')
    try {
      const outcome = verifyAdmission()
      setVerification(outcome.result)
      if (outcome.ok) {
        setMessage(outcome.message)
      } else {
        setErrorMessage(outcome.message)
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '限速准入核对失败')
    }
    reload()
  }

  function applyConfigPreset(index: number) {
    const preset = configPresets[index]
    setConfigNo(preset.configNo)
    setLimitPerSecond(preset.limitPerSecond)
    setBucketCapacity(preset.bucketCapacity)
  }

  const today = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const todayText = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`

  return (
    <section className="page" data-module="admission">
      <header className="page-head">
        <div>
          <h2>限速准入管理</h2>
          <p className="page-desc">
            读取站点限速配置与待执行请求批次，按每秒上限计算令牌额度并写入采集准入记录，生成限速准入批次清单。令牌额度与批次准入同一次提交，失败不放行也不扣令牌。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => act(admitBatches)}>
            执行限速准入
          </button>
          <button className="btn" type="button" onClick={() => act(refreshAdmission)}>
            刷新限速准入批次清单
          </button>
          <button className="btn" type="button" onClick={() => act(syncBundle)}>
            同步待执行批次
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => downloadText(exportAdmissionBundle().filename, exportAdmissionBundle().content)}
          >
            导出准入批次清单
          </button>
          <button
            className="btn ghost"
            type="button"
            onClick={() => act(() => {
              resetAdmission()
              setVerification(null)
              return { ok: true, message: '限速准入数据已重置为初始状态' }
            })}
          >
            重置准入数据
          </button>
        </div>
      </header>

      <div className="stat-row">
        {snapshot.stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <section className="panel">
        <header className="panel-head">
          <h3>站点限额</h3>
          <span className="panel-hint">令牌额度 = min(每秒请求上限 × 并发窗口, 令牌桶容量)</span>
        </header>
        <table className="data-table">
          <thead>
            <tr>
              <th>站点</th>
              <th>配置编号</th>
              <th>配置版本</th>
              <th>每秒上限</th>
              <th>窗口(秒)</th>
              <th>令牌桶</th>
              <th>窗口额度</th>
              <th>已用令牌</th>
              <th>可用令牌</th>
              <th>已分配批次</th>
              <th>等待批次</th>
              <th>下一窗口</th>
              <th>上一版本 / 额度</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.sites.map((site) => (
              <tr key={site.site}>
                <td>{site.site}</td>
                <td>{site.configNo}</td>
                <td>{site.configVersion}</td>
                <td>{site.limitPerSecond}</td>
                <td>{site.windowSeconds}</td>
                <td>{site.bucketCapacity}</td>
                <td>{site.quota}</td>
                <td>{site.usedTokens}</td>
                <td>{site.availableTokens}</td>
                <td>{site.allocatedCount}</td>
                <td>{site.waitingCount}</td>
                <td>{site.nextWindowAt || '—'}</td>
                <td>{site.previousVersion === '无' ? '无' : `${site.previousVersion} / ${site.previousQuota}`}</td>
                <td className="row-actions">
                  <button
                    className="link"
                    type="button"
                    onClick={() => act(() => admitBatches({ site: site.site }))}
                  >
                    站点准入
                  </button>
                </td>
              </tr>
            ))}
            {snapshot.sites.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={14}>
                  暂无已确认的站点限速配置，请先在限速调节里启用配置
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <header className="panel-head">
          <h3>限速调节与并发冲突</h3>
          <span className="panel-hint">
            同一站点两个批次同时命中配置更新时，按业务规定判定边界；失败时不保存矛盾配置
          </span>
        </header>
        <form
          className="filter-bar"
          onSubmit={(event) => {
            event.preventDefault()
            act(() =>
              refreshAdmission({
                configUpdate: { configNo, limitPerSecond, bucketCapacity },
              }),
            )
          }}
        >
          <label className="filter-item">
            <span>配置编号</span>
            <input value={configNo} onChange={(event) => setConfigNo(event.target.value)} />
          </label>
          <label className="filter-item">
            <span>每秒请求上限</span>
            <input
              type="number"
              value={limitPerSecond}
              onChange={(event) => setLimitPerSecond(Number(event.target.value))}
            />
          </label>
          <label className="filter-item">
            <span>令牌桶容量</span>
            <input
              type="number"
              value={bucketCapacity}
              onChange={(event) => setBucketCapacity(Number(event.target.value))}
            />
          </label>
          <button className="btn" type="submit">提交限速调节</button>
          {configPresets.map((preset, index) => (
            <button
              key={preset.label}
              className="btn ghost"
              type="button"
              onClick={() => applyConfigPreset(index)}
            >
              {preset.label}
            </button>
          ))}
        </form>

        <table className="data-table">
          <thead>
            <tr>
              <th>冲突编号</th>
              <th>站点</th>
              <th>版本变化</th>
              <th>采用边界</th>
              <th>另一套边界</th>
              <th>涉及批次</th>
              <th>复核状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.conflicts.map((conflict) => (
              <tr key={conflict.id}>
                <td>{conflict.id}</td>
                <td>{conflict.site}</td>
                <td>{`${conflict.oldVersion} → ${conflict.newVersion}`}</td>
                <td>{conflict.adoptedBoundary}</td>
                <td>{conflict.alternateBoundary}</td>
                <td>{conflict.affectedBatches.join('、')}</td>
                <td>{conflict.reviewStatus}</td>
                <td>
                  <button
                    className="link"
                    type="button"
                    onClick={() => act(() => reviewConflict(conflict.id))}
                  >
                    复核
                  </button>
                </td>
              </tr>
            ))}
            {snapshot.conflicts.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={8}>暂无配置更新冲突</td>
              </tr>
            )}
          </tbody>
        </table>

        <table className="data-table">
          <thead>
            <tr>
              <th>任务编排记录</th>
              <th>冲突编号</th>
              <th>站点</th>
              <th>判定内容</th>
              <th>涉及批次</th>
              <th>复核状态</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.decisions.map((decision) => (
              <tr key={decision.id}>
                <td>{decision.id}</td>
                <td>{decision.conflictId}</td>
                <td>{decision.site}</td>
                <td>{decision.decision}</td>
                <td>{decision.batches.join('、')}</td>
                <td>{decision.reviewStatus}</td>
              </tr>
            ))}
            {snapshot.decisions.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={6}>暂无任务编排判定记录</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        <label className="filter-item">
          <span>站点 / 批次</span>
          <input
            value={siteFilter}
            placeholder="按目标站点或批次编号检索"
            onChange={(event) => setSiteFilter(event.target.value)}
          />
        </label>
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setSiteFilter('')}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row: EntryRow) => (
            <tr key={String(row.id)}>
              {columns.map((column) => (
                <td key={column}>
                  {row[column] === undefined || row[column] === '' ? '—' : row[column]}
                </td>
              ))}
              <td>{row.status}</td>
              <td className="row-actions">
                <button
                  className="link"
                  type="button"
                  onClick={() => act(() => admitBatch(String(row['批次编号'] ?? '')))}
                >
                  执行准入
                </button>
                <button
                  className="link"
                  type="button"
                  onClick={() => act(() => startBatch(String(row['批次编号'] ?? '')))}
                >
                  启动批次
                </button>
              </td>
            </tr>
          ))}
          {visibleRows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>
                暂无限速准入批次，先执行限速准入
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <section className="panel">
        <header className="panel-head">
          <h3>等待批次</h3>
          <span className="panel-hint">未分配到额度的批次保留在等待区，并显示下一可用时间</span>
        </header>
        <table className="data-table">
          <thead>
            <tr>
              <th>批次编号</th>
              <th>目标站点</th>
              <th>配置版本</th>
              <th>申请令牌数</th>
              <th>等待原因</th>
              <th>下一可用时间</th>
              <th>复核状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.waiting.map((row) => (
              <tr key={String(row.id)}>
                <td>{String(row['批次编号'] ?? '')}</td>
                <td>{String(row['目标站点'] ?? '')}</td>
                <td>{String(row['配置版本'] ?? '')}</td>
                <td>{String(row['申请令牌数'] ?? '')}</td>
                <td>{String(row['等待原因'] ?? '')}</td>
                <td>{String(row['下一可用时间'] ?? '—')}</td>
                <td>{String(row['复核状态'] ?? '')}</td>
                <td>
                  <button
                    className="link"
                    type="button"
                    onClick={() => act(() => admitBatch(String(row['批次编号'] ?? '')))}
                  >
                    再准入
                  </button>
                  <button
                    className="link"
                    type="button"
                    onClick={() => act(() => startBatch(String(row['批次编号'] ?? '')))}
                  >
                    启动批次
                  </button>
                </td>
              </tr>
            ))}
            {snapshot.waiting.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={8}>当前没有等待批次</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <header className="panel-head">
          <h3>核对</h3>
          <div className="page-actions">
            <button className="btn" type="button" onClick={runVerify}>执行核对</button>
            <button className="btn" type="button" onClick={() => downloadEntries('admission')}>
              按模块导出
            </button>
          </div>
        </header>
        <p className="panel-hint">
          核对条件：同一站点并发请求不突破每秒上限且等待原因可核对，对应数据可按配置编号与配置版本回查。
        </p>
        {(verification ?? snapshot.verification)
          ? (
            <table className="data-table">
              <thead>
                <tr>
                  <th>核对项</th>
                  <th>明细</th>
                  <th>相关批次</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {(verification ?? snapshot.verification)!.items.map((item) => (
                  <tr key={item.check}>
                    <td>{item.check}</td>
                    <td>{item.detail}</td>
                    <td>{item.refs.join('、') || '—'}</td>
                    <td>{item.passed ? '通过' : '未通过'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
          : <p className="panel-hint">还没有核对记录</p>}
      </section>

      <section className="panel">
        <header className="panel-head">
          <h3>当天处理轨迹（{todayText}）</h3>
          <span className="panel-hint">清单版本 {snapshot.revision}</span>
        </header>
        <table className="data-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>站点</th>
              <th>动作</th>
              <th>结果</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.traces.map((trace) => (
              <tr key={trace.id}>
                <td>{formatTime(trace.at)}</td>
                <td>{trace.site}</td>
                <td>{trace.action}</td>
                <td>{trace.outcome}</td>
                <td>{trace.detail}</td>
              </tr>
            ))}
            {snapshot.traces.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={5}>当天还没有处理轨迹</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <footer className="page-foot">
        <span>共 {visibleRows.length} 条准入批次，清单版本 {snapshot.revision}</span>
        {message && <span className="ok-text">{message}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
