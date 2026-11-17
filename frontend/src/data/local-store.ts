import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// 模块清单与跨模块业务状态放在同一个 JSON 里，一次 setItem 提交，避免出现
// “令牌已扣、准入记录没落盘”这种只完成一半的结果。
const STORAGE_KEY = 'scraper-strategy-studio:entries'
const SHARED_NAMESPACE = '__shared'

type StoredBlob = Record<string, unknown>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedBlob(): StoredBlob {
  return clone(SEED_ROWS) as StoredBlob
}

function normalizeBlob(raw: StoredBlob): StoredBlob {
  const next: StoredBlob = { ...raw }
  for (const [key, rows] of Object.entries(SEED_ROWS)) {
    if (!Array.isArray(next[key])) {
      next[key] = clone(rows)
    }
  }
  const shared = next[SHARED_NAMESPACE]
  if (!shared || typeof shared !== 'object' || Array.isArray(shared)) {
    next[SHARED_NAMESPACE] = {}
  }
  return next
}

function persist(blob: StoredBlob): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const raw = JSON.stringify(blob)
      window.localStorage.setItem(STORAGE_KEY, raw)
      cacheRaw = raw
    } catch {
      // 本地存储不可写时不阻断内存里的业务操作，刷新后回到上一次成功持久化的数据。
    }
  }
}

function readStorage(): StoredBlob {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seedBlob()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const fallback = seedBlob()
    persist(fallback)
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as StoredBlob
    return normalizeBlob(parsed)
  } catch {
    const fallback = seedBlob()
    persist(fallback)
    return fallback
  }
}

let cache: StoredBlob | null = null
let cacheRaw: string | null = null

function storedBlob(): StoredBlob {
  if (cache !== null && (typeof window === 'undefined' || !window.localStorage)) {
    return cache
  }
  // 另一个标签页写入过时，以存储里的版本为准：先重读，读写都基于最新数据。
  const raw = typeof window !== 'undefined' && window.localStorage
    ? window.localStorage.getItem(STORAGE_KEY)
    : null
  if (cache !== null && raw !== null && raw === cacheRaw) {
    return cache
  }
  cache = readStorage()
  cacheRaw =
    typeof window !== 'undefined' && window.localStorage
      ? window.localStorage.getItem(STORAGE_KEY)
      : null
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  const blob = storedBlob()
  const rows: Record<string, EntryRow[]> = {}
  for (const [key, value] of Object.entries(blob)) {
    if (key !== SHARED_NAMESPACE && Array.isArray(value)) {
      rows[key] = value as EntryRow[]
    }
  }
  return rows
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export type CommitPatch = {
  rows?: Record<string, EntryRow[]>
  shared?: Record<string, unknown>
}

/** 原子提交：模块行与共享业务状态写入同一次 localStorage.setItem。 */
export function commit(patch: CommitPatch): void {
  const current = storedBlob()
  const next: StoredBlob = { ...current }
  if (patch.rows) {
    for (const [key, rows] of Object.entries(patch.rows)) {
      if (key !== SHARED_NAMESPACE) {
        next[key] = clone(rows)
      }
    }
  }
  if (patch.shared) {
    const shared = next[SHARED_NAMESPACE]
    next[SHARED_NAMESPACE] = {
      ...(shared && typeof shared === 'object' && !Array.isArray(shared) ? shared : {}),
      ...clone(patch.shared),
    }
  }
  cache = next
  persist(next)
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commit({ rows: { [key]: rows } })
}

export function saveModules(rows: Record<string, EntryRow[]>): void {
  commit({ rows })
}

export function readShared<T>(key: string): T | null {
  const blob = storedBlob()
  const shared = blob[SHARED_NAMESPACE]
  if (!shared || typeof shared !== 'object' || Array.isArray(shared)) {
    return null
  }
  const value = (shared as Record<string, unknown>)[key]
  return value === undefined ? null : (clone(value) as T)
}

/**
 * 先重读本地存储再决定是否落盘：预期状态被其他会话改过就放弃本次写入。
 * 并发争用最后一个令牌时，后到的调用拿不到写入权，不会重复扣减。
 */
export function commitIf(
  expected: (shared: Record<string, unknown>) => boolean,
  patch: CommitPatch,
): boolean {
  const current = storedBlob()
  const shared = current[SHARED_NAMESPACE]
  const snapshot = shared && typeof shared === 'object' && !Array.isArray(shared)
    ? (shared as Record<string, unknown>)
    : {}
  if (!expected(snapshot)) {
    // 放弃写入后丢掉内存缓存，后续读取回到存储里的最新版本。
    cache = current
    return false
  }
  const next: StoredBlob = { ...current }
  if (patch.rows) {
    for (const [key, rows] of Object.entries(patch.rows)) {
      if (key !== SHARED_NAMESPACE) {
        next[key] = clone(rows)
      }
    }
  }
  if (patch.shared) {
    next[SHARED_NAMESPACE] = { ...snapshot, ...clone(patch.shared) }
  }
  cache = next
  persist(next)
  return true
}

export function writeShared(key: string, value: unknown): void {
  commit({ shared: { [key]: value } })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
