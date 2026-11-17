import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import { loadAdmissionSnapshot } from '@/api/admission-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('ratelimit')
const columns = [
  "配置编号",
  "目标站点",
  "每秒请求上限",
  "并发窗口",
  "令牌桶容量",
  "惩罚系数",
  "冷却秒数",
  "优先级权重"
]
const actions = [
  "提交校验",
  "启用限速",
  "停用限速"
]
const statuses = [
  "草稿",
  "待校验",
  "已启用",
  "已停用"
]
const stats = [
  {
    "label": "限速配置总数",
    "value": 0
  },
  {
    "label": "已启用配置",
    "value": 0
  },
  {
    "label": "待校验配置",
    "value": 0
  }
]

export default function RatelimitView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [quotaHint, setQuotaHint] = useState('')
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      // 令牌额度和配置版本由准入服务计算，这里只做展示，避免两处各算一套。
      setQuotaHint(
        loadAdmissionSnapshot()
          .sites.map(
            (site) =>
              `${site.site}：${site.configNo} ${site.configVersion} 窗口额度 ${site.quota}，已用 ${site.usedTokens}`,
          )
          .join('；'),
      )
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '限速调节列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
  }

  return (
    <section className="page" data-module="ratelimit">
      <header className="page-head">
        <div>
          <h2>限速调节管理</h2>
          <p className="page-desc">维护限速配置的输入、执行约束与结果记录，为限速调节提供可验证的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('限速配置登记入口尚未接入审批流')}>
            登记限速配置
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出限速调节清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      {quotaHint && (
        <p className="panel-hint">
          准入侧令牌额度：{quotaHint}
          <Link className="link" to="/admission" style={{ marginLeft: 8 }}>前往限速准入</Link>
        </p>
      )}

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
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
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{row.status}</td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无限速调节数据，可先登记限速配置</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条限速调节记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
