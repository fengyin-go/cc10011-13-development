import type { EntryRow } from './types'

/** 限速准入：站点限速配置 -> 令牌额度 -> 批次准入记录 -> 采集准入批次清单。 */

export const ADMISSION_MODULE_KEY = 'admission'
export const ADMISSION_LEDGER_KEY = 'rateAdmission'

export const ADMISSION_FIELDS = [
  '批次编号',
  '目标站点',
  '配置编号',
  '每秒请求上限',
  '令牌桶容量',
  '申请令牌数',
  '已分配令牌数',
  '配置版本',
  '配置依据',
  '准入结果',
  '等待原因',
  '下一可用时间',
  '复核状态',
  '优先级权重',
  '幂等键',
  '准入时间',
]

export const ADMISSION_STATUSES = ['待准入', '已准入', '等待中', '已启动', '已过期']

/** 参与窗口令牌占用的状态：已放行的批次不再重复扣减。 */
export const ALLOCATED_STATUSES = ['已准入', '已启动']

/** 尚未拿到额度的状态，可以在后续准入轮次里重新判定。 */
export const WAITING_STATUSES = ['待准入', '等待中']

export type NormalizedRateConfig = {
  configNo: string
  rateId: number
  site: string
  limitPerSecond: number
  windowSeconds: number
  bucketCapacity: number
  penalty: number
  cooldownSeconds: number
  priorityWeight: number
}

export type RateConfigVersion = NormalizedRateConfig & {
  version: string
  seq: number
  appliedAt: number
}

export type SiteLedger = {
  site: string
  active: RateConfigVersion | null
  confirmed: RateConfigVersion | null
  versions: RateConfigVersion[]
  seq: number
  windowStart: number
  usedTokens: number
}

export type AdmissionTrace = {
  id: string
  at: number
  day: string
  site: string
  action: string
  outcome: string
  detail: string
}

export type ConflictRecord = {
  id: string
  at: number
  site: string
  oldVersion: string
  newVersion: string
  adoptedBoundary: string
  alternateBoundary: string
  decision: string
  affectedBatches: string[]
  reviewStatus: '待复核' | '已复核'
}

export type VerificationItem = {
  check: string
  detail: string
  passed: boolean
  refs: string[]
}

export type VerificationResult = {
  at: number
  passed: boolean
  items: VerificationItem[]
}

/** 幂等回执：同一批次在同一配置版本下只允许发放一次令牌。 */
export type AdmissionReceipt = {
  at: number
  ok: boolean
  message: string
}

export type AdmissionLedger = {
  revision: number
  seq: number
  sites: Record<string, SiteLedger>
  traces: AdmissionTrace[]
  conflicts: ConflictRecord[]
  receipts: Record<string, AdmissionReceipt>
  lastVerification: VerificationResult | null
}

export function emptyLedger(): AdmissionLedger {
  return {
    revision: 0,
    seq: 0,
    sites: {},
    traces: [],
    conflicts: [],
    receipts: {},
    lastVerification: null,
  }
}

export function textOf(row: EntryRow, field: string): string {
  const value = row[field]
  return value === undefined || value === null ? '' : String(value).trim()
}

export function numberOf(row: EntryRow, field: string, fallback = 0): number {
  const value = row[field]
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  const parsed = Number(String(value ?? '').trim())
  return Number.isFinite(parsed) ? parsed : fallback
}

function isIntegerInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max
}

export function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

/** 统一格式：YYYY-MM-DD HH:mm:ss，便于清单导出与回查。 */
export function formatDateTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) {
    return ''
  }
  const date = new Date(ms)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

export function dayOf(ms: number): string {
  const date = new Date(ms)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 站点在单个并发窗口内可发放的令牌额度：每秒上限 × 窗口秒数，再受令牌桶容量约束。 */
export function quotaOf(config: {
  limitPerSecond: number
  windowSeconds: number
  bucketCapacity: number
}): number {
  const perWindow = config.limitPerSecond * config.windowSeconds
  return Math.max(0, Math.min(perWindow, config.bucketCapacity))
}

/** 对齐到窗口起点（本地时钟毫秒）。 */
export function alignWindow(now: number, windowSeconds: number): number {
  const windowMs = Math.max(1, Math.floor(windowSeconds)) * 1000
  return Math.floor(now / windowMs) * windowMs
}

export function windowEnd(windowStart: number, windowSeconds: number): number {
  return windowStart + Math.max(1, Math.floor(windowSeconds)) * 1000
}

/**
 * 解析并校验一条限速配置。
 * 阈值超出范围、令牌桶容量小于每秒上限等矛盾配置不进入令牌计算，直接判失败。
 */
export function normalizeRateConfig(
  row: EntryRow,
): { ok: true; value: NormalizedRateConfig } | { ok: false; reason: string } {
  const configNo = textOf(row, '配置编号')
  const site = textOf(row, '目标站点')
  if (!configNo) {
    return { ok: false, reason: '缺少配置编号，无法作为限速准入的业务依据' }
  }
  if (!site) {
    return { ok: false, reason: `${configNo} 缺少目标站点` }
  }
  const limitPerSecond = numberOf(row, '每秒请求上限', Number.NaN)
  if (!isIntegerInRange(limitPerSecond, 1, 10000)) {
    return { ok: false, reason: `${configNo} 的每秒请求上限必须在 1-10000 之间` }
  }
  const windowSeconds = numberOf(row, '并发窗口', Number.NaN)
  if (!isIntegerInRange(windowSeconds, 1, 3600)) {
    return { ok: false, reason: `${configNo} 的并发窗口必须在 1-3600 秒之间` }
  }
  const bucketCapacity = numberOf(row, '令牌桶容量', Number.NaN)
  if (!isIntegerInRange(bucketCapacity, 1, 1000000)) {
    return { ok: false, reason: `${configNo} 的令牌桶容量必须在 1-1000000 之间` }
  }
  if (bucketCapacity < limitPerSecond) {
    return { ok: false, reason: `${configNo} 的令牌桶容量小于每秒请求上限，阈值范围矛盾` }
  }
  const penalty = numberOf(row, '惩罚系数', 1)
  if (!Number.isFinite(penalty) || penalty < 0 || penalty > 10) {
    return { ok: false, reason: `${configNo} 的惩罚系数超出 0-10 的范围` }
  }
  const priorityWeight = numberOf(row, '优先级权重', 0)
  if (!Number.isFinite(priorityWeight) || priorityWeight < 0 || priorityWeight > 100) {
    return { ok: false, reason: `${configNo} 的优先级权重超出 0-100 的范围` }
  }
  return {
    ok: true,
    value: {
      configNo,
      rateId: Number(row.id),
      site,
      limitPerSecond,
      windowSeconds,
      bucketCapacity,
      penalty,
      cooldownSeconds: Math.max(0, numberOf(row, '冷却秒数', 0)),
      priorityWeight,
    },
  }
}

// 配置版本只认影响令牌额度与排队顺序的字段；惩罚系数、冷却秒数不改变窗口额度，
// 单独调整时不生成新版本，避免已分配批次被无谓判成需要复核。
export function sameConfig(a: NormalizedRateConfig, b: NormalizedRateConfig): boolean {
  return (
    a.configNo === b.configNo &&
    a.site === b.site &&
    a.limitPerSecond === b.limitPerSecond &&
    a.windowSeconds === b.windowSeconds &&
    a.bucketCapacity === b.bucketCapacity &&
    a.priorityWeight === b.priorityWeight
  )
}

export function makeVersion(
  config: NormalizedRateConfig,
  seq: number,
  appliedAt: number,
): RateConfigVersion {
  return {
    ...config,
    seq,
    version: `${config.configNo}#${seq}`,
    appliedAt,
  }
}

export function cloneLedger(ledger: AdmissionLedger): AdmissionLedger {
  return JSON.parse(JSON.stringify(ledger)) as AdmissionLedger
}

export function requestTokensOf(spiderRow: EntryRow): number {
  const concurrency = Math.floor(numberOf(spiderRow, '并发线程数', 1))
  return Math.min(100000, Math.max(1, concurrency))
}

export function batchKeyOf(spiderRow: EntryRow): string {
  const code = textOf(spiderRow, '作业编号')
  return code || `SPID-${spiderRow.id}`
}

export function batchCodeOf(spiderRow: EntryRow): string {
  return `BATCH-${batchKeyOf(spiderRow)}`
}
