import {
  ADMISSION_LEDGER_KEY,
  ADMISSION_MODULE_KEY,
  ALLOCATED_STATUSES,
  WAITING_STATUSES,
  alignWindow,
  batchCodeOf,
  batchKeyOf,
  cloneLedger,
  dayOf,
  emptyLedger,
  formatDateTime,
  normalizeRateConfig,
  numberOf,
  quotaOf,
  requestTokensOf,
  sameConfig,
  textOf,
  windowEnd,
  type AdmissionLedger,
  type AdmissionTrace,
  type ConflictRecord,
  type NormalizedRateConfig,
  type RateConfigVersion,
  type SiteLedger,
  type VerificationItem,
  type VerificationResult,
} from '@/data/admission'
import { commit, commitIf, listRows, readShared, writeShared } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'
import { ADMISSION_FIELDS } from '@/data/admission'

/** 任务编排记录：配置更新冲突判定后写下的结论，供任务编排侧与复核共用。 */
export type OrchestrationDecision = {
  id: string
  at: number
  site: string
  conflictId: string
  batches: string[]
  decision: string
  reviewStatus: '待复核' | '已复核'
}

export type SiteQuotaView = {
  site: string
  configNo: string
  configVersion: string
  confirmedVersion: string
  limitPerSecond: number
  windowSeconds: number
  bucketCapacity: number
  quota: number
  usedTokens: number
  availableTokens: number
  nextWindowAt: string
  allocatedCount: number
  waitingCount: number
  previousVersion: string
  previousQuota: number
}

export type { VerificationItem, VerificationResult } from '@/data/admission'
export type AdmissionSnapshot = {
  revision: number
  ledger: AdmissionLedger
  rows: EntryRow[]
  sites: SiteQuotaView[]
  waiting: EntryRow[]
  conflicts: ConflictRecord[]
  decisions: OrchestrationDecision[]
  traces: AdmissionTrace[]
  verification: VerificationResult | null
  stats: { label: string; value: number }[]
}

type VersionChanges = Record<string, { old: string; next: string }>

// 同一站点同时提交准入时，只有先进入临界区的一次能拿到令牌；
// 后到的一次直接被告知稍后重试，不会基于同一份旧账本重复扣减。
let admissionInFlight = false

function withLock<T>(work: () => T, busy: T): T {
  if (admissionInFlight) {
    return busy
  }
  admissionInFlight = true
  try {
    return work()
  } finally {
    admissionInFlight = false
  }
}

function loadLedger(): AdmissionLedger {
  const raw = readShared<Partial<AdmissionLedger>>(ADMISSION_LEDGER_KEY)
  const base = emptyLedger()
  if (!raw || typeof raw !== 'object') {
    return base
  }
  return {
    revision: Number(raw.revision ?? 0),
    seq: Number(raw.seq ?? 0),
    sites: raw.sites && typeof raw.sites === 'object' ? (raw.sites as Record<string, SiteLedger>) : {},
    traces: Array.isArray(raw.traces) ? (raw.traces as AdmissionTrace[]) : [],
    conflicts: Array.isArray(raw.conflicts) ? (raw.conflicts as ConflictRecord[]) : [],
    receipts:
      raw.receipts && typeof raw.receipts === 'object'
        ? (raw.receipts as AdmissionLedger['receipts'])
        : {},
    lastVerification: raw.lastVerification ?? null,
  }
}

function loadDecisions(): OrchestrationDecision[] {
  const raw = readShared<OrchestrationDecision[]>('orchestrationDecisions')
  return Array.isArray(raw) ? raw : []
}

function nextSeq(ledger: AdmissionLedger): number {
  ledger.seq += 1
  return ledger.seq
}

function pushTrace(
  ledger: AdmissionLedger,
  at: number,
  site: string,
  action: string,
  outcome: string,
  detail: string,
): void {
  ledger.traces.unshift({
    id: `TRACE-${String(nextSeq(ledger)).padStart(4, '0')}`,
    at,
    day: dayOf(at),
    site: site || '全部站点',
    action,
    outcome,
    detail,
  })
  if (ledger.traces.length > 500) {
    ledger.traces = ledger.traces.slice(0, 500)
  }
}

function ensureSite(ledger: AdmissionLedger, site: string): SiteLedger {
  const existing = ledger.sites[site]
  if (existing) {
    if (!Array.isArray(existing.versions)) existing.versions = []
    return existing
  }
  const created: SiteLedger = {
    site,
    active: null,
    confirmed: null,
    versions: [],
    seq: 0,
    windowStart: 0,
    usedTokens: 0,
  }
  ledger.sites[site] = created
  return created
}

function effectiveVersion(ledger: AdmissionLedger, site: string): RateConfigVersion | null {
  const siteLedger = ledger.sites[site]
  return siteLedger ? siteLedger.active ?? siteLedger.confirmed : null
}

function ensureWindow(siteLedger: SiteLedger, version: RateConfigVersion, now: number): void {
  const aligned = alignWindow(now, version.windowSeconds)
  if (siteLedger.windowStart !== aligned) {
    siteLedger.windowStart = aligned
    siteLedger.usedTokens = 0
  }
}

/** 读取启用的限速配置；同一站点多条启用配置时以最后一条为准，并在轨迹里说明。 */
function enabledRateConfigs(
  ledger: AdmissionLedger,
  now: number,
  rateRows: EntryRow[] = listRows('ratelimit'),
): NormalizedRateConfig[] {
  const rows = rateRows.filter((row) => String(row.status) === '已启用')
  const bySite = new Map<string, NormalizedRateConfig>()
  for (const row of rows) {
    const parsed = normalizeRateConfig(row)
    if (!parsed.ok) {
      pushTrace(ledger, now, textOf(row, '目标站点'), '读取限速配置', '配置无效', parsed.reason)
      continue
    }
    const config = parsed.value
    if (bySite.has(config.site)) {
      pushTrace(
        ledger,
        now,
        config.site,
        '读取限速配置',
        '站点存在多条启用配置',
        `采用 ${config.configNo}，其余启用配置不参与令牌计算`,
      )
    }
    bySite.set(config.site, config)
  }
  return [...bySite.values()]
}

/** 配置编号+数值变化都会生成新版本；已分配额度按版本号回查。 */
function upsertVersions(
  ledger: AdmissionLedger,
  configs: NormalizedRateConfig[],
  now: number,
): VersionChanges {
  const changes: VersionChanges = {}
  for (const config of configs) {
    const siteLedger = ensureSite(ledger, config.site)
    if (siteLedger.active && sameConfig(siteLedger.active, config)) {
      continue
    }
    if (!siteLedger.active && siteLedger.confirmed && sameConfig(siteLedger.confirmed, config)) {
      siteLedger.active = siteLedger.confirmed
      continue
    }
    const previous = siteLedger.active ?? siteLedger.confirmed
    siteLedger.seq += 1
    const version: RateConfigVersion = {
      ...config,
      seq: siteLedger.seq,
      version: `${config.configNo}#${siteLedger.seq}`,
      appliedAt: now,
    }
    siteLedger.versions.push(version)
    if (siteLedger.versions.length > 20) {
      siteLedger.versions = siteLedger.versions.slice(-20)
    }
    siteLedger.active = version
    siteLedger.confirmed = version
    ensureWindow(siteLedger, version, now)
    changes[config.site] = {
      old: previous ? previous.version : '无',
      next: version.version,
    }
    pushTrace(
      ledger,
      now,
      config.site,
      '应用限速配置',
      previous ? '配置更新' : '首次确认',
      `${previous ? previous.version : '无'} -> ${version.version}（每秒 ${version.limitPerSecond}，令牌桶 ${version.bucketCapacity}）`,
    )
  }
  return changes
}

function jobByBatch(spiderRows: EntryRow[]): Map<string, EntryRow> {
  const map = new Map<string, EntryRow>()
  for (const job of spiderRows) {
    map.set(batchCodeOf(job), job)
  }
  return map
}

function newBatchRow(id: number, job: EntryRow, version: RateConfigVersion | null): EntryRow {
  return {
    id,
    status: '待准入',
    pending: true,
    abnormal: false,
    [ADMISSION_FIELDS[0]]: batchCodeOf(job),
    [ADMISSION_FIELDS[1]]: textOf(job, '目标站点'),
    [ADMISSION_FIELDS[2]]: version ? version.configNo : '',
    [ADMISSION_FIELDS[3]]: version ? version.limitPerSecond : 0,
    [ADMISSION_FIELDS[4]]: version ? version.bucketCapacity : 0,
    [ADMISSION_FIELDS[5]]: requestTokensOf(job),
    [ADMISSION_FIELDS[6]]: 0,
    [ADMISSION_FIELDS[7]]: version ? version.version : '',
    [ADMISSION_FIELDS[8]]: version ? `限速配置 ${version.configNo}` : '',
    [ADMISSION_FIELDS[9]]: '未执行',
    [ADMISSION_FIELDS[10]]: '尚未执行准入',
    [ADMISSION_FIELDS[11]]: '',
    [ADMISSION_FIELDS[12]]: '无需复核',
    [ADMISSION_FIELDS[13]]: version ? version.priorityWeight : 0,
    [ADMISSION_FIELDS[14]]: `${batchKeyOf(job)}:admit`,
    [ADMISSION_FIELDS[15]]: '',
  }
}

function sortCandidates(rows: EntryRow[]): EntryRow[] {
  return [...rows].sort((a, b) => {
    const priority = numberOf(b, '优先级权重', 0) - numberOf(a, '优先级权重', 0)
    if (priority !== 0) return priority
    return Number(a.id) - Number(b.id)
  })
}

function boundaryText(
  rows: EntryRow[],
  version: RateConfigVersion,
  usedBase: number,
  now: number,
): string {
  const quota = quotaOf(version)
  let used = Math.max(0, usedBase)
  const lines = sortCandidates(rows).map((row) => {
    const need = Math.max(1, numberOf(row, '申请令牌数', 1))
    const batch = textOf(row, '批次编号')
    if (need > quota) {
      return `${batch} 等待（申请 ${need} 超过窗口额度 ${quota}，下一可用 ${formatDateTime(windowEnd(alignWindow(now, version.windowSeconds), version.windowSeconds))}）`
    }
    if (used + need <= quota) {
      used += need
      return `${batch} 已分配 ${need}`
    }
    return `${batch} 等待（剩余 ${Math.max(0, quota - used)}，下一可用 ${formatDateTime(windowEnd(alignWindow(now, version.windowSeconds), version.windowSeconds))}）`
  })
  return lines.length === 0 ? '无待判定批次' : lines.join('；')
}

/**
 * 把任务编排的待执行作业同步进限速准入批次清单，并按最新配置刷新：
 * - 已分配额度的批次保留原配置快照，不重新扣令牌；
 * - 等待中的批次改用新配置，重新参与下一轮准入；
 * - 检测“已分配批次沿用旧配置”与“全部待执行批次改用新配置”的边界冲突。
 */
function refreshRows(
  ledger: AdmissionLedger,
  currentRows: EntryRow[],
  spiderRows: EntryRow[],
  now: number,
  changes: VersionChanges,
  decisions: OrchestrationDecision[],
): EntryRow[] {
  const jobs = jobByBatch(spiderRows)
  const rows = currentRows.map((row) => ({ ...row }))
  let maxId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)

  for (const row of rows) {
    const batch = textOf(row, '批次编号')
    const job = jobs.get(batch)
    const status = String(row.status)
    const site = textOf(row, '目标站点')

    if (!job) {
      if (WAITING_STATUSES.includes(status) || status === '已准入') {
        row.status = '已过期'
        row.pending = false
        row['准入结果'] = '已过期'
        row['等待原因'] = '对应采集作业不在待执行状态'
        row['下一可用时间'] = ''
        row['已分配令牌数'] = 0
      }
      continue
    }

    if (String(job.status) !== '待执行') {
      if (status === '已准入') {
        if (String(job.status) === '运行中') {
          row.status = '已启动'
          row.pending = false
          continue
        }
        row.status = '已过期'
        row.pending = false
        row['准入结果'] = '已过期'
        row['等待原因'] = `采集作业状态为 ${String(job.status)}，预留令牌释放`
        row['下一可用时间'] = ''
        row['已分配令牌数'] = 0
        continue
      }
      if (WAITING_STATUSES.includes(status)) {
        row.status = '已过期'
        row.pending = false
        row['准入结果'] = '已过期'
        row['等待原因'] = `采集作业状态为 ${String(job.status)}`
        row['下一可用时间'] = ''
      }
      continue
    }

    // 作业重新回到待执行：过期批次重新进入待准入。
    if (status === '已过期') {
      row.status = '待准入'
      row.pending = true
      row['准入结果'] = '未执行'
      row['已分配令牌数'] = 0
      row['等待原因'] = ''
      row['下一可用时间'] = ''
      row['复核状态'] = '无需复核'
    }

    const version = effectiveVersion(ledger, site)
    const liveStatus = String(row.status)

    if (liveStatus === '已准入') {
      // 已分配批次继续使用原配置；若站点已更新版本，转入复核。
      if (version && textOf(row, '配置版本') !== version.version) {
        row['复核状态'] = '待复核'
        row['等待原因'] = '配置更新期间已分配额度继续使用原配置'
      }
      continue
    }

    if (liveStatus === '已启动') {
      continue
    }

    if (WAITING_STATUSES.includes(liveStatus)) {
      if (!version) {
        row['配置编号'] = ''
        row['配置版本'] = ''
        row['准入结果'] = '未命中配置'
        row['等待原因'] = '目标站点没有已确认的限速配置'
        row['下一可用时间'] = ''
        row['已分配令牌数'] = 0
        row['复核状态'] = '无需复核'
        continue
      }
      const rowVersion = textOf(row, '配置版本')
      const versionChanged = rowVersion !== version.version
      row['目标站点'] = site || version.site
      row['配置编号'] = version.configNo
      row['每秒请求上限'] = version.limitPerSecond
      row['令牌桶容量'] = version.bucketCapacity
      row['申请令牌数'] = Math.max(1, numberOf(row, '申请令牌数', requestTokensOf(job)))
      row['配置版本'] = version.version
      row['配置依据'] = `限速配置 ${version.configNo}`
      row['优先级权重'] = version.priorityWeight
      if (!versionChanged) {
        // 配置没变：保留上一轮判定的等待原因与下一可用时间。
        continue
      }
      // 未分配额度的批次改用新配置，重新排队等待准入。
      row['已分配令牌数'] = 0
      row['准入结果'] = '待准入'
      row['等待原因'] = '尚未执行准入，等待按新配置重新排队'
      row['下一可用时间'] = ''
      row['复核状态'] = '无需复核'
      row.status = '待准入'
      row.pending = true
    }
  }

  for (const [batch, job] of jobs) {
    if (String(job.status) !== '待执行') {
      continue
    }
    if (rows.some((row) => textOf(row, '批次编号') === batch && String(row.status) !== '已过期')) {
      continue
    }
    const existingExpired = rows.find((row) => textOf(row, '批次编号') === batch)
    if (existingExpired) {
      continue
    }
    maxId += 1
    const version = effectiveVersion(ledger, textOf(job, '目标站点'))
    rows.push(newBatchRow(maxId, job, version))
  }

  detectConflicts(ledger, rows, now, changes, decisions)
  return rows
}

function detectConflicts(
  ledger: AdmissionLedger,
  rows: EntryRow[],
  now: number,
  changes: VersionChanges,
  decisions: OrchestrationDecision[],
): void {
  for (const site of Object.keys(changes)) {
    const version = effectiveVersion(ledger, site)
    if (!version) continue
    const siteLedger = ensureSite(ledger, site)
    ensureWindow(siteLedger, version, now)
    const siteRows = rows.filter((row) => textOf(row, '目标站点') === site)
    const allocated = siteRows.filter(
      (row) => String(row.status) === '已准入' && numberOf(row, '已分配令牌数', 0) > 0,
    )
    const waiting = siteRows.filter((row) => WAITING_STATUSES.includes(String(row.status)))

    if (allocated.length === 0) {
      continue
    }

    if (waiting.length === 0) {
      pushTrace(
        ledger,
        now,
        site,
        '限速配置更新',
        '沿用原配置',
        `${allocated.map((row) => textOf(row, '批次编号')).join('、')} 已分配额度，继续使用 ${
          changes[site].old
        }`,
      )
      continue
    }

    const existing = ledger.conflicts.find(
      (item) =>
        item.site === site &&
        item.oldVersion === changes[site].old &&
        item.newVersion === changes[site].next &&
        item.reviewStatus === '待复核',
    )
    const allocatedTokens = allocated.reduce(
      (sum, row) => sum + numberOf(row, '已分配令牌数', 0),
      0,
    )
    const adoptedBoundary = boundaryText(waiting, version, siteLedger.usedTokens, now)
    const alternateRows = [...allocated, ...waiting]
    const alternateBoundary = boundaryText(
      alternateRows,
      version,
      Math.max(0, siteLedger.usedTokens - allocatedTokens),
      now,
    )
    const batches = [
      ...allocated.map((row) => textOf(row, '批次编号')),
      ...waiting.map((row) => textOf(row, '批次编号')),
    ]

    if (existing) {
      existing.adoptedBoundary = adoptedBoundary
      existing.alternateBoundary = alternateBoundary
      existing.affectedBatches = batches
      continue
    }

    const conflict: ConflictRecord = {
      id: `CONF-${String(nextSeq(ledger)).padStart(4, '0')}`,
      at: now,
      site,
      oldVersion: changes[site].old,
      newVersion: changes[site].next,
      adoptedBoundary,
      alternateBoundary,
      decision:
        '按业务规定采用「已分配额度的批次继续使用原配置」：已分配批次保留旧额度，其余待执行批次改用新配置；任务编排记录已判定，限速准入批次清单供复核。',
      affectedBatches: batches,
      reviewStatus: '待复核',
    }
    ledger.conflicts.unshift(conflict)
    for (const row of [...allocated, ...waiting]) {
      row['复核状态'] = '待复核'
    }
    const decision: OrchestrationDecision = {
      id: `DECI-${String(nextSeq(ledger)).padStart(4, '0')}`,
      at: now,
      site,
      conflictId: conflict.id,
      batches,
      decision: conflict.decision,
      reviewStatus: '待复核',
    }
    decisions.unshift(decision)
    pushTrace(
      ledger,
      now,
      site,
      '并发命中限速配置更新',
      '冲突已判定',
      `${conflict.id}：${changes[site].old} -> ${changes[site].next}；已分配批次沿用原配置，等待队列按新配置重排，任务编排记录 ${decision.id}`,
    )
  }
}

function configOf(siteLedger: SiteLedger): RateConfigVersion | null {
  return siteLedger.active ?? siteLedger.confirmed
}

function evaluateSite(
  ledger: AdmissionLedger,
  rows: EntryRow[],
  site: string,
  now: number,
  onlyBatch?: string,
): void {
  const siteLedger = ensureSite(ledger, site)
  const version = configOf(siteLedger)
  const siteRows = rows.filter((row) => textOf(row, '目标站点') === site)
  if (!version) {
    for (const row of siteRows) {
      if (WAITING_STATUSES.includes(String(row.status))) {
        row['准入结果'] = '未命中配置'
        row['等待原因'] = '目标站点没有已确认的限速配置'
        row['下一可用时间'] = ''
        row.status = '等待中'
        row.pending = true
      }
    }
    return
  }
  ensureWindow(siteLedger, version, now)
  const quota = quotaOf(version)
  const nextAt = formatDateTime(windowEnd(siteLedger.windowStart, version.windowSeconds))
  let used = Math.max(0, siteLedger.usedTokens)

  const candidates = sortCandidates(
    siteRows.filter(
      (row) =>
        WAITING_STATUSES.includes(String(row.status)) &&
        (!onlyBatch || textOf(row, '批次编号') === onlyBatch),
    ),
  )
  for (const row of candidates) {
    const batch = textOf(row, '批次编号')
    const need = Math.max(1, numberOf(row, '申请令牌数', 1))
    row['配置编号'] = version.configNo
    row['每秒请求上限'] = version.limitPerSecond
    row['令牌桶容量'] = version.bucketCapacity
    row['配置版本'] = version.version
    row['配置依据'] = `限速配置 ${version.configNo}`
    if (need > quota) {
      row.status = '等待中'
      row.pending = true
      row['准入结果'] = '额度不足'
      row['已分配令牌数'] = 0
      row['等待原因'] = `申请 ${need} 个令牌超过窗口额度 ${quota}，需拆分批次`
      row['下一可用时间'] = nextAt
      continue
    }
    if (used + need <= quota) {
      used += need
      row.status = '已准入'
      row.pending = false
      row['准入结果'] = '已分配'
      row['已分配令牌数'] = need
      row['等待原因'] = ''
      row['下一可用时间'] = ''
      row['准入时间'] = formatDateTime(now)
      siteLedger.usedTokens = used
      ledger.receipts[`admit:${batch}:${version.version}`] = {
        at: now,
        ok: true,
        message: `${batch} 在 ${version.version} 下分配 ${need} 个令牌`,
      }
      pushTrace(
        ledger,
        now,
        site,
        '令牌准入',
        '已分配',
        `${batch} 分配 ${need}/${quota}，版本 ${version.version}`,
      )
      continue
    }
    row.status = '等待中'
    row.pending = true
    row['准入结果'] = '额度不足'
    row['已分配令牌数'] = 0
    row['等待原因'] = `窗口剩余令牌 ${Math.max(0, quota - used)} 少于申请 ${need}`
    row['下一可用时间'] = nextAt
    if (onlyBatch && onlyBatch === batch) {
      // 单批次准入时保留其余批次的等待原因，不额外展开。
      continue
    }
  }
  siteLedger.usedTokens = used
}

function findJobByBatch(spiderRows: EntryRow[], batchCode: string): EntryRow | undefined {
  return spiderRows.find((job) => batchCodeOf(job) === batchCode)
}

function collectSites(ledger: AdmissionLedger, rows: EntryRow[], now: number): SiteQuotaView[] {
  const views: SiteQuotaView[] = []
  for (const siteLedger of Object.values(ledger.sites)) {
    const version = configOf(siteLedger)
    if (!version) continue
    ensureWindow(siteLedger, version, now)
    const quota = quotaOf(version)
    const siteRows = rows.filter((row) => textOf(row, '目标站点') === siteLedger.site)
    views.push({
      site: siteLedger.site,
      configNo: version.configNo,
      configVersion: version.version,
      confirmedVersion: siteLedger.confirmed ? siteLedger.confirmed.version : '无',
      limitPerSecond: version.limitPerSecond,
      windowSeconds: version.windowSeconds,
      bucketCapacity: version.bucketCapacity,
      quota,
      usedTokens: siteLedger.usedTokens,
      availableTokens: Math.max(0, quota - siteLedger.usedTokens),
      nextWindowAt: formatDateTime(windowEnd(siteLedger.windowStart, version.windowSeconds)),
      allocatedCount: siteRows.filter((row) => ALLOCATED_STATUSES.includes(String(row.status))).length,
      waitingCount: siteRows.filter((row) => WAITING_STATUSES.includes(String(row.status))).length,
      previousVersion:
        siteLedger.versions.length > 1
          ? siteLedger.versions[siteLedger.versions.length - 2].version
          : '无',
      previousQuota:
        siteLedger.versions.length > 1
          ? quotaOf(siteLedger.versions[siteLedger.versions.length - 2])
          : 0,
    })
  }
  return views.sort((a, b) => a.site.localeCompare(b.site))
}

function statsOf(rows: EntryRow[], conflicts: ConflictRecord[], ledger: AdmissionLedger): {
  label: string
  value: number
}[] {
  const rateRows = listRows('ratelimit')
  return [
    { label: '限速配置总数', value: rateRows.length },
    { label: '已启用配置', value: rateRows.filter((row) => String(row.status) === '已启用').length },
    { label: '准入批次总数', value: rows.length },
    { label: '已分配批次', value: rows.filter((row) => ALLOCATED_STATUSES.includes(String(row.status))).length },
    { label: '等待批次', value: rows.filter((row) => WAITING_STATUSES.includes(String(row.status))).length },
    {
      label: '待复核冲突',
      value: conflicts.filter((item) => item.reviewStatus === '待复核').length,
    },
    { label: '清单版本', value: ledger.revision },
  ]
}

export function loadAdmissionSnapshot(now = Date.now()): AdmissionSnapshot {
  const ledger = loadLedger()
  const rows = listRows(ADMISSION_MODULE_KEY)
  const conflicts = [...ledger.conflicts]
  const today = dayOf(now)
  return {
    revision: ledger.revision,
    ledger,
    rows,
    sites: collectSites(ledger, rows, now),
    waiting: rows.filter((row) => WAITING_STATUSES.includes(String(row.status))),
    conflicts,
    decisions: loadDecisions(),
    traces: ledger.traces.filter((trace) => trace.day === today),
    verification: ledger.lastVerification ? (ledger.lastVerification as VerificationResult) : null,
    stats: statsOf(rows, conflicts, ledger),
  }
}

type MutationOptions = { now?: number }

/**
 * 同步限速配置并刷新限速准入批次清单。
 * 可选的 configUpdate 模拟限速调节提交新阈值；校验失败时不保存矛盾配置，
 * 清单沿用上一份确认版本，处理轨迹当天留档。
 */
export function refreshAdmission(
  options: MutationOptions & {
    configUpdate?: {
      configNo: string
      limitPerSecond: number
      bucketCapacity: number
    }
  } = {},
): ActionResult {
  return withLock(
    () => {
      const now = options.now ?? Date.now()
      const ledger = loadLedger()
      const baseRevision = ledger.revision
      const decisions = loadDecisions()
      const spiderRows = listRows('spider')
      const admissionRows = listRows(ADMISSION_MODULE_KEY)
      const rateRows = listRows('ratelimit')
      let nextRateRows = rateRows
      let failure = ''

      if (options.configUpdate) {
        const { configNo, limitPerSecond, bucketCapacity } = options.configUpdate
        const index = rateRows.findIndex((row) => textOf(row, '配置编号') === configNo)
        if (index < 0) {
          failure = `没有找到配置编号为 ${configNo} 的限速配置`
        } else {
          const candidate: EntryRow = {
            ...rateRows[index],
            '每秒请求上限': limitPerSecond,
            '令牌桶容量': bucketCapacity,
          }
          const parsed = normalizeRateConfig(candidate)
          if (!parsed.ok) {
            failure = `限速调节处理失败：${parsed.reason}；限速准入批次清单沿用上一份确认版本`
            const site = textOf(rateRows[index], '目标站点')
            const siteLedger = ledger.sites[site]
            if (siteLedger && siteLedger.confirmed) {
              siteLedger.active = siteLedger.confirmed
              failure += ` ${siteLedger.confirmed.version}`
            }
            pushTrace(ledger, now, site, '限速调节', '处理失败，沿用上一份确认版本', failure)
          } else {
            nextRateRows = rateRows.map((row, rowIndex) =>
              rowIndex === index
                ? { ...row, '每秒请求上限': limitPerSecond, '令牌桶容量': bucketCapacity }
                : row,
            )
          }
        }
      }

      let changes: VersionChanges = {}
      if (!failure) {
        // 按提交后的配置计算版本，避免读到尚未落库的旧阈值。
        const configs = enabledRateConfigs(ledger, now, nextRateRows)
        changes = upsertVersions(ledger, configs, now)
      }

      const rows = refreshRows(ledger, admissionRows, spiderRows, now, changes, decisions)
      ledger.revision += 1
      if (!failure) {
        pushTrace(
          ledger,
          now,
          '全部站点',
          '刷新限速准入批次清单',
          '完成',
          changes && Object.keys(changes).length
            ? `配置版本变化：${Object.entries(changes)
                .map(([site, item]) => `${site} ${item.old}->${item.next}`)
                .join('；')}`
            : '配置无变化；已分配额度批次继续使用原配置',
        )
      }
      const written = commitIf(
        (shared) => Number((shared[ADMISSION_LEDGER_KEY] as AdmissionLedger | undefined)?.revision ?? 0) === baseRevision,
        {
          rows: { ratelimit: nextRateRows, admission: rows },
          shared: { [ADMISSION_LEDGER_KEY]: ledger, orchestrationDecisions: decisions },
        },
      )
      if (!written) {
        return { ok: false, message: '限速准入已被其他操作更新，本次未写入，请重试' }
      }
      return {
        ok: !failure,
        message: failure || '限速准入批次清单已刷新，已分配额度批次继续使用原配置',
      }
    },
    { ok: false, message: '限速准入正在处理中，请稍后重试' },
  )
}

/** 读取站点配置和待执行批次，计算令牌额度并写入准入记录，生成限速准入批次清单。 */
export function admitBatches(
  options: MutationOptions & { site?: string; batchCode?: string } = {},
): ActionResult {
  return withLock<ActionResult>(
    () => {
      const now = options.now ?? Date.now()
      const ledger = loadLedger()
      const baseRevision = ledger.revision
      const decisions = loadDecisions()
      const spiderRows = listRows('spider')
      const admissionRows = listRows(ADMISSION_MODULE_KEY)
      const configs = enabledRateConfigs(ledger, now)
      const changes = upsertVersions(ledger, configs, now)
      const rows = refreshRows(ledger, admissionRows, spiderRows, now, changes, decisions)

      const targets = new Set<string>()
      if (options.site) {
        targets.add(options.site)
      } else {
        for (const row of rows) {
          if (WAITING_STATUSES.includes(String(row.status))) {
            targets.add(textOf(row, '目标站点'))
          }
        }
      }

      for (const site of targets) {
        evaluateSite(ledger, rows, site, now, options.batchCode)
      }
      // 配置版本发生变化时同样要判定边界：已分配批次沿用原配置还是全部改用新配置。
      detectConflicts(ledger, rows, now, changes, decisions)

      ledger.revision += 1
      const allocated = rows.filter((row) => String(row.status) === '已准入').length
      const waiting = rows.filter((row) => WAITING_STATUSES.includes(String(row.status))).length
      pushTrace(
        ledger,
        now,
        options.site ?? '全部站点',
        '执行限速准入',
        '完成',
        `已分配 ${allocated} 个批次，等待 ${waiting} 个批次，清单版本 ${ledger.revision}`,
      )
      const written = commitIf(
        (shared) => Number((shared[ADMISSION_LEDGER_KEY] as AdmissionLedger | undefined)?.revision ?? 0) === baseRevision,
        {
          rows: { admission: rows },
          shared: { [ADMISSION_LEDGER_KEY]: ledger, orchestrationDecisions: decisions },
        },
      )
      if (!written) {
        return { ok: false, message: '限速准入已被其他操作更新，本次未写入，请重试' }
      }
      return {
        ok: true,
        message: `限速准入完成：已分配 ${allocated} 个批次，等待 ${waiting} 个批次`,
      }
    },
    { ok: false, message: '限速准入正在处理中，请稍后重试' },
  )
}

/** 单批次准入：重复提交命中幂等键时不再扣减令牌。 */
export function admitBatch(batchCode: string, options: MutationOptions = {}): ActionResult {
  return withLock(
    () => {
      const now = options.now ?? Date.now()
      const ledger = loadLedger()
      const baseRevision = ledger.revision
      const decisions = loadDecisions()
      const spiderRows = listRows('spider')
      const admissionRows = listRows(ADMISSION_MODULE_KEY)
      const configs = enabledRateConfigs(ledger, now)
      const changes = upsertVersions(ledger, configs, now)
      let rows = refreshRows(ledger, admissionRows, spiderRows, now, changes, decisions)
      let row = rows.find((item) => textOf(item, '批次编号') === batchCode)

      if (!row) {
        return { ok: false, message: `限速准入批次清单里没有 ${batchCode}` }
      }
      if (row.status === '已准入' || row.status === '已启动') {
        return { ok: false, message: `${batchCode} 已分配额度，重复提交不再消耗令牌` }
      }

      const site = textOf(row, '目标站点')
      const version = effectiveVersion(ledger, site)
      if (version) {
        const receipt = ledger.receipts[`admit:${batchCode}:${version.version}`]
        if (receipt) {
          return { ok: false, message: `${batchCode} 已有准入回执，重复提交不再消耗令牌` }
        }
      }

      evaluateSite(ledger, rows, site, now, batchCode)
      ledger.revision += 1
      rows = refreshRows(ledger, rows, spiderRows, now, {}, decisions)
      row = rows.find((item) => textOf(item, '批次编号') === batchCode)
      const written = commitIf(
        (shared) => Number((shared[ADMISSION_LEDGER_KEY] as AdmissionLedger | undefined)?.revision ?? 0) === baseRevision,
        {
          rows: { admission: rows },
          shared: { [ADMISSION_LEDGER_KEY]: ledger, orchestrationDecisions: decisions },
        },
      )
      if (!written) {
        return { ok: false, message: '其他并发准入已先行处理，本次未扣减令牌，请重试' }
      }
      if (!row) {
        return { ok: false, message: `${batchCode} 刷新后不在清单中` }
      }
      if (row.status === '已准入') {
        return {
          ok: true,
          message: `${batchCode} 已分配 ${numberOf(row, '已分配令牌数', 0)} 个令牌（${textOf(row, '配置版本')}）`,
        }
      }
      return {
        ok: false,
        message: `${batchCode} 未分配到额度，保留在等待区；${
          textOf(row, '等待原因') || '等待下一轮准入'
        }${textOf(row, '下一可用时间') ? `，下一可用时间 ${textOf(row, '下一可用时间')}` : ''}`,
      }
    },
    { ok: false, message: '限速准入正在处理中，请稍后重试' },
  )
}

/** 启动批次：必须先拿到令牌，否则留在等待区并回报下一可用时间。 */
export function startBatch(batchCode: string, options: MutationOptions = {}): ActionResult {
  return withLock(
    () => {
      const now = options.now ?? Date.now()
      const ledger = loadLedger()
      const baseRevision = ledger.revision
      const decisions = loadDecisions()
      const spiderRows = listRows('spider')
      const admissionRows = listRows(ADMISSION_MODULE_KEY)
      const job = findJobByBatch(spiderRows, batchCode)
      if (!job) {
        return { ok: false, message: `任务编排里没有对应 ${batchCode} 的采集作业` }
      }
      if (String(job.status) === '运行中') {
        return { ok: false, message: `${batchCode} 已在运行中，不要重复启动` }
      }
      if (String(job.status) !== '待执行') {
        return { ok: false, message: `采集作业当前状态为「${String(job.status)}」，只有待执行作业可以启动` }
      }

      const configs = enabledRateConfigs(ledger, now)
      const changes = upsertVersions(ledger, configs, now)
      const rows = refreshRows(ledger, admissionRows, spiderRows, now, changes, decisions)
      let row = rows.find((item) => textOf(item, '批次编号') === batchCode)
      if (!row) {
        return { ok: false, message: `${batchCode} 尚未同步到限速准入批次清单` }
      }

      if (row.status !== '已准入' && row.status !== '已启动') {
        evaluateSite(ledger, rows, textOf(row, '目标站点'), now, batchCode)
        row = rows.find((item) => textOf(item, '批次编号') === batchCode)
      }

      if (!row || row.status !== '已准入') {
        ledger.revision += 1
        pushTrace(
          ledger,
          now,
          textOf(row ?? job, '目标站点'),
          '启动采集批次',
          '保留等待区',
          `${batchCode} 未分配到额度${
            row && textOf(row, '下一可用时间') ? `，下一可用时间 ${textOf(row, '下一可用时间')}` : ''
          }`,
        )
        commitIf(
          (shared) => Number((shared[ADMISSION_LEDGER_KEY] as AdmissionLedger | undefined)?.revision ?? 0) === baseRevision,
          {
            rows: { admission: rows },
            shared: { [ADMISSION_LEDGER_KEY]: ledger, orchestrationDecisions: decisions },
          },
        )
        return {
          ok: false,
          message: `${batchCode} 未分配到额度，保留在等待区；${
            row ? textOf(row, '等待原因') : '等待准入'
          }${row && textOf(row, '下一可用时间') ? `，下一可用时间 ${textOf(row, '下一可用时间')}` : ''}`,
        }
      }

      row.status = '已启动'
      row.pending = false
      row['准入结果'] = '已启动'
      row['等待原因'] = ''
      row['下一可用时间'] = ''
      job.status = '运行中'
      job.pending = false
      ledger.revision += 1
      pushTrace(
        ledger,
        now,
        textOf(row, '目标站点'),
        '启动采集批次',
        '已启动',
        `${batchCode} 使用 ${textOf(row, '配置版本')} 的 ${numberOf(row, '已分配令牌数', 0)} 个令牌启动`,
      )
      const written = commitIf(
        (shared) => Number((shared[ADMISSION_LEDGER_KEY] as AdmissionLedger | undefined)?.revision ?? 0) === baseRevision,
        {
          rows: { admission: rows, spider: spiderRows },
          shared: { [ADMISSION_LEDGER_KEY]: ledger, orchestrationDecisions: decisions },
        },
      )
      if (!written) {
        return { ok: false, message: '其他操作已更新限速准入，本次启动未生效，请重试' }
      }
      return {
        ok: true,
        message: `${batchCode} 已启动，使用配置 ${textOf(row, '配置版本')} 分配的 ${numberOf(
          row,
          '已分配令牌数',
          0,
        )} 个令牌`,
      }
    },
    { ok: false, message: '限速准入正在处理中，请稍后重试' },
  )
}

/** 任务编排侧接收限速准入批次清单后再同步；该动作只同步清单，不消耗令牌。 */
export function syncBundle(options: MutationOptions = {}): ActionResult {
  return withLock<ActionResult>(
    () => {
      const now = options.now ?? Date.now()
      const ledger = loadLedger()
      const baseRevision = ledger.revision
      const decisions = loadDecisions()
      const configs = enabledRateConfigs(ledger, now)
      const changes = upsertVersions(ledger, configs, now)
      const rows = refreshRows(
        ledger,
        listRows(ADMISSION_MODULE_KEY),
        listRows('spider'),
        now,
        changes,
        decisions,
      )
      ledger.revision += 1
      pushTrace(ledger, now, '全部站点', '同步限速准入批次清单', '完成', `清单版本 ${ledger.revision}`)
      const written = commitIf(
        (shared) => Number((shared[ADMISSION_LEDGER_KEY] as AdmissionLedger | undefined)?.revision ?? 0) === baseRevision,
        {
          rows: { admission: rows },
          shared: { [ADMISSION_LEDGER_KEY]: ledger, orchestrationDecisions: decisions },
        },
      )
      if (!written) {
        return { ok: false, message: '限速准入已被其他操作更新，本次未写入，请重试' }
      }
      return { ok: true, message: `已同步待执行批次，当前清单版本 ${ledger.revision}` }
    },
    { ok: false, message: '限速准入正在处理中，请稍后重试' },
  )
}

export function reviewConflict(conflictId: string, options: MutationOptions = {}): ActionResult {
  return withLock(
    () => {
      const now = options.now ?? Date.now()
      const ledger = loadLedger()
      const baseRevision = ledger.revision
      const conflict = ledger.conflicts.find((item) => item.id === conflictId)
      if (!conflict) {
        return { ok: false, message: `没有找到冲突记录 ${conflictId}` }
      }
      if (conflict.reviewStatus === '已复核') {
        return { ok: false, message: `${conflictId} 已复核，不用重复操作` }
      }
      conflict.reviewStatus = '已复核'
      const rows = listRows(ADMISSION_MODULE_KEY).map((row) => {
        if (conflict.affectedBatches.includes(textOf(row, '批次编号'))) {
          return { ...row, 复核状态: '已复核' }
        }
        return row
      })
      const decisions = loadDecisions().map((item) =>
        item.conflictId === conflictId ? { ...item, reviewStatus: '已复核' as const } : item,
      )
      pushTrace(
        ledger,
        now,
        conflict.site,
        '复核冲突',
        '已复核',
        `${conflict.id}：${conflict.affectedBatches.join('、')} 按已分配批次沿用原配置核对`,
      )
      const written = commitIf(
        (shared) => Number((shared[ADMISSION_LEDGER_KEY] as AdmissionLedger | undefined)?.revision ?? 0) === baseRevision,
        {
          rows: { admission: rows },
          shared: { [ADMISSION_LEDGER_KEY]: ledger, orchestrationDecisions: decisions },
        },
      )
      if (!written) {
        return { ok: false, message: '限速准入已被其他操作更新，本次复核未写入，请重试' }
      }
      return { ok: true, message: `${conflictId} 已复核，复核依据为已分配额度的批次继续使用原配置` }
    },
    { ok: false, message: '限速准入正在处理中，请稍后重试' },
  )
}

/**
 * 核对：同一站点当前窗口内已分配令牌是否突破每秒上限，等待原因是否可核对。
 */
export function verifyAdmission(options: MutationOptions = {}): {
  ok: boolean
  message: string
  result: VerificationResult
} {
  return withLock(
    () => {
      const now = options.now ?? Date.now()
      const ledger = loadLedger()
      const baseRevision = ledger.revision
      const rows = listRows(ADMISSION_MODULE_KEY)
      const items: VerificationItem[] = []
      const sites = collectSites(ledger, rows, now)

      for (const site of sites) {
        const siteLedger = ensureSite(ledger, site.site)
        const version = configOf(siteLedger)
        if (!version) continue
        const siteRows = rows.filter((row) => textOf(row, '目标站点') === site.site)
        const allocatedRows = siteRows.filter((row) => ALLOCATED_STATUSES.includes(String(row.status)))

        // 已分配额度按配置版本分别核对：旧版本按旧额度，新版本按新额度。
        const versionTotals = new Map<string, number>()
        for (const row of allocatedRows) {
          const key = textOf(row, '配置版本')
          versionTotals.set(key, (versionTotals.get(key) ?? 0) + numberOf(row, '已分配令牌数', 0))
        }
        for (const [versionKey, tokens] of versionTotals) {
          const knownVersion = [...(siteLedger.versions ?? [])]
            .reverse()
            .find((item) => item.version === versionKey)
          const versionQuota = knownVersion ? quotaOf(knownVersion) : 0
          const isCurrent = versionKey === version.version
          items.push({
            check: isCurrent
              ? `${site.site} 窗口令牌不突破每秒上限`
              : `${site.site} 已分配批次沿用原配置额度`,
            detail: isCurrent
              ? `已分配 ${tokens} 个令牌，窗口额度 ${versionQuota}（每秒 ${version.limitPerSecond} × ${version.windowSeconds} 秒，令牌桶 ${version.bucketCapacity}）`
              : `${versionKey} 已分配 ${tokens} 个令牌，该版本额度 ${versionQuota}，继续使用原配置`,
            passed: knownVersion ? tokens <= versionQuota : false,
            refs: allocatedRows
              .filter((row) => textOf(row, '配置版本') === versionKey)
              .map((row) => textOf(row, '批次编号')),
          })
        }

        // 每条准入记录都要能按配置编号+配置版本回查，查不回来的记录判不通过。
        const untraceable = allocatedRows.filter(
          (row) => !textOf(row, '配置编号') || !textOf(row, '配置版本'),
        )
        items.push({
          check: `${site.site} 准入记录可回查`,
          detail: `已分配 ${allocatedRows.length} 个批次，${untraceable.length} 个缺少配置编号或配置版本`,
          passed: untraceable.length === 0,
          refs: allocatedRows.map((row) => textOf(row, '批次编号')),
        })

        const waitingRows = siteRows.filter((row) => WAITING_STATUSES.includes(String(row.status)))
        const missingReason = waitingRows.filter((row) => !textOf(row, '等待原因'))
        const capacityReason = waitingRows.filter((row) =>
          textOf(row, '等待原因').includes('令牌'),
        )
        const missingNext = capacityReason.filter((row) => !textOf(row, '下一可用时间'))
        items.push({
          check: `${site.site} 等待原因可核对`,
          detail:
            waitingRows.length === 0
              ? '没有等待批次'
              : `${waitingRows.length} 个等待批次，${missingReason.length} 个缺少原因，${missingNext.length} 个缺少下一可用时间`,
          passed: missingReason.length === 0 && missingNext.length === 0,
          refs: waitingRows.map((row) => textOf(row, '批次编号')),
        })
      }

      const pendingConflicts = ledger.conflicts.filter((item) => item.reviewStatus === '待复核')
      items.push({
        check: '冲突复核完成',
        detail:
          ledger.conflicts.length === 0
            ? '没有配置更新冲突'
            : `${ledger.conflicts.length} 条冲突记录，${pendingConflicts.length} 条待复核`,
        passed: pendingConflicts.length === 0,
        refs: pendingConflicts.map((item) => item.id),
      })

      const passed = items.every((item) => item.passed)
      const result: VerificationResult = { at: now, passed, items }
      ledger.lastVerification = result
      pushTrace(
        ledger,
        now,
        '全部站点',
        '核对限速准入结果',
        passed ? '通过' : '未通过',
        items
          .filter((item) => !item.passed)
          .map((item) => item.check)
          .join('；') || '全部核对项通过',
      )
      const written = commitIf(
        (shared) => Number((shared[ADMISSION_LEDGER_KEY] as AdmissionLedger | undefined)?.revision ?? 0) === baseRevision,
        { shared: { [ADMISSION_LEDGER_KEY]: ledger } },
      )
      if (!written) {
        return {
          ok: false,
          message: '限速准入已被其他操作更新，核对结果未写入，请重试',
          result,
        }
      }
      return {
        ok: passed,
        message: passed ? '核对通过：并发请求未突破每秒上限，等待原因可核对' : '核对未通过，请查看核对明细',
        result,
      }
    },
    {
      ok: false,
      message: '限速准入正在处理中，请稍后重试',
      result: { at: 0, passed: false, items: [] },
    },
  )
}

export function exportAdmissionBundle(): { filename: string; content: string } {
  const rows = listRows(ADMISSION_MODULE_KEY)
  const header = ['编号', ...ADMISSION_FIELDS, '当前状态']
  const lines = [header.join(',')]
  for (const row of rows) {
    lines.push(
      [row.id, ...ADMISSION_FIELDS.map((field) => row[field] ?? ''), row.status].join(','),
    )
  }
  return { filename: '限速准入批次清单.csv', content: `﻿${lines.join('\n')}` }
}

export function resetAdmission(): void {
  const ledger = cloneLedger(emptyLedger())
  commit({
    rows: { admission: [] },
    shared: {
      [ADMISSION_LEDGER_KEY]: ledger,
      orchestrationDecisions: [],
    },
  })
}

/** 兼容旧数据：早期版本没有准入共享状态时，补一份空账本，避免页面读到 null。 */
export function ensureAdmissionState(): void {
  if (readShared<AdmissionLedger>(ADMISSION_LEDGER_KEY) === null) {
    writeShared(ADMISSION_LEDGER_KEY, emptyLedger())
  }
}
