/**
 * Story signals for `ark_banner_predict`.
 *
 * Two story-derived facts drive the bonus:
 *   1. how often an operator actually appears in story pages (main / event /
 *      memory) — recurring named characters are the ones Hoyoverse-style event
 *      banners are built around;
 *   2. how long a region has gone without a new story appearance — a region
 *      quiet for more than nine months is a plausible target for the next
 *      story event, which in turn lifts its operators.
 *
 * Both come from `干员剧情一览`, joined with the plot-navigation dates used by
 * the story lookup. Everything is cached for a quarter of an hour; callers may
 * pass a pre-built `byOperator`/`staleRegions` fixture in tests.
 */

import { loadAppearanceRecords, loadStoryTiming } from './sources.js'
import { canonicalRegions } from './regions.js'

const STORY_TTL_MS = 15 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
/** "超过 9 个月没有新剧情" — the user-facing threshold. */
export const STALE_DAYS = 270

let storyCache = null

export function resetStorySignals () {
  storyCache = null
}

/**
 * @param {{ signal?: AbortSignal, entries?: Array<object>, now?: Date, force?: boolean }} options
 * @returns {Promise<{
 *   byOperator: Map<string, {total:number, main:number, event:number, memory:number, latestTs:number|null}>,
 *   byRegion: Map<string, {canonical:string, ts:number, months:number}>,
 *   staleRegions: Array<{canonical:string, ts:number, months:number}>,
 *   operatorCount: number, regionCount: number, staleDays: number
 * }>}
 */
export async function loadStorySignals (options = {}) {
  if (!options.force && storyCache && Date.now() - storyCache.at < STORY_TTL_MS) return storyCache

  const records = await loadAppearanceRecords(options)
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('干员剧情一览为空，无法计算剧情信号')
  }
  // Missing dates only weaken recency, never the appearance counts, so a
  // failed timing lookup still leaves a usable index.
  const timing = await loadStoryTiming(options).catch(() => new Map())

  const byOperator = new Map()
  for (const record of records) {
    if (!record?.name) continue
    const seen = new Set()
    const counts = { main: 0, event: 0, memory: 0 }
    let latestTs = null
    for (const column of ['main', 'event', 'memory']) {
      for (const link of record.columns?.[column] ?? []) {
        if (!link?.page || seen.has(link.page)) continue
        seen.add(link.page)
        counts[column] += 1
        const ts = timing.get(link.page)?.ts
        if (Number.isFinite(ts) && (latestTs === null || ts > latestTs)) latestTs = ts
      }
    }
    if (seen.size === 0) continue
    byOperator.set(record.name, { total: seen.size, ...counts, latestTs })
  }

  const now = options.now ?? new Date()
  const byRegion = new Map()
  for (const entry of options.entries ?? []) {
    const info = byOperator.get(entry?.name)
    if (!Number.isFinite(info?.latestTs)) continue
    for (const canonical of canonicalRegions(entry)) {
      const previous = byRegion.get(canonical)
      if (!previous || info.latestTs > previous.ts) {
        byRegion.set(canonical, {
          canonical,
          ts: info.latestTs,
          months: Math.max(0, Math.floor((now.getTime() - info.latestTs) / (30 * DAY_MS)))
        })
      }
    }
  }

  const staleRegions = [...byRegion.values()]
    .filter(region => now.getTime() - region.ts > STALE_DAYS * DAY_MS)
    .sort((left, right) => left.ts - right.ts)

  storyCache = {
    at: Date.now(),
    byOperator,
    byRegion,
    staleRegions,
    operatorCount: byOperator.size,
    regionCount: byRegion.size,
    staleDays: STALE_DAYS
  }
  return storyCache
}
