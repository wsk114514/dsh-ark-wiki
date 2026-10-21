/**
 * Banner (gacha) schedule data and a probabilistic next-banner predictor.
 *
 * Data comes from the PRTS "卡池一览" pages:
 *   - 卡池一览/常驻标准寻访/{year}   rotating standard banners (2 six-stars each)
 *   - 卡池一览/限时寻访              limited / collab / rerun banners
 *   - 卡池一览/常驻中坚寻访&中坚甄选/{year}  kernel (中坚) banners
 *
 * The prediction is deliberately a ranking, never a promise: every row carries
 * a confidence label and the signals that produced it, and the caller-facing
 * text says so explicitly.
 */

import { pageContent } from './prts.js'
import { loadOperatorEntries } from './sources.js'
import { REGION_ALIASES, operatorMatchesRegion, regionForCanonical } from './regions.js'
import { loadStorySignals } from './story-signals.js'
import { predictDebut } from './debut.js'
import { verifyCandidatesAgainstWiki } from './wiki-roster.js'
import { collectRegionDossiers, formatDossierNotes } from './operator-dossiers.js'

const BANNER_TTL_MS = 30 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const STANDARD_PAGE_PREFIX = '卡池一览/常驻标准寻访/'

/** Append only the sentences that base does not already contain. */
function mergeNotes (base, extra, separator) {
  if (!extra) return base
  const parts = String(base).split(separator)
  const additions = String(extra)
    .split(separator)
    .map(part => part.trim())
    .filter(part => part && !parts.some(existing => existing.trim() === part))
  return [base, ...additions].join(separator)
}
const LIMITED_PAGE = '卡池一览/限时寻访'
const KERNEL_PAGE_PREFIX = '卡池一览/常驻中坚寻访&中坚甄选/'
const KERNEL_PAGE_PREFIX_ALT = '卡池一览/常驻中坚寻访&中坚甄选/'
const SIX_STAR = 6

// 往期限定干员不再进入后续卡池：它们只能在对应限定寻访里通过兑换（井）获得。
// 因此限定 / 复刻类预测不再把「已有限定」列为 UP 候选，只推断同池陪跑的非限定 6★。
const LIMITED_RULE = '往期限定干员不会进入后续卡池，只能在对应限定寻访中通过兑换（井）获得；本次不把已有限定干员列为 UP 候选。'

const REGION_LABEL = { cn: '国服', global: '国际服', jp: '日服', kr: '韩服', tw: '繁中服' }

let bannerCache = null

/** Drop cached banner pages (tests and long-lived sessions). */
export function resetBannerCache () {
  bannerCache = null
}

const DATE_RE = /(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}:\d{2}))?/
const FILE_LINK_RE = /^(?:文件|File|Image|图片):/i
const AVATAR_RE = /\{\{\s*干员头像\s*\|([^|}]+)([^}]*)\}\}/g

/** Parse the "2026-10-08 04:00" form PRTS uses (CN time, UTC+8). */
export function parseBannerDate (text) {
  const match = DATE_RE.exec(String(text ?? ''))
  if (!match) return null
  const [, year, month, day, time = '00:00'] = match
  const date = new Date(`${year}-${month}-${day}T${time}:00+08:00`)
  return Number.isNaN(date.valueOf()) ? null : date
}

function daysBetween (from, to) {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS)
}

function formatDate (date) {
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) return ''
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function extractAvatars (cell) {
  const list = []
  const text = String(cell ?? '')
  const regex = new RegExp(AVATAR_RE.source, 'g')
  let match
  while ((match = regex.exec(text)) !== null) {
    const name = match[1].trim()
    if (!name) continue
    const params = match[2] ?? ''
    list.push({
      name,
      limited: /limited\s*=\s*1/.test(params),
      shop: /shop\s*=\s*1/.test(params)
    })
  }
  return list
}

function extractTitle (cell) {
  let title = ''
  let label = ''
  let fallback = ''
  const text = String(cell ?? '')
  const regex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g
  let match
  while ((match = regex.exec(text)) !== null) {
    const target = match[1].trim()
    if (FILE_LINK_RE.test(target)) {
      // Standard banners only embed a file link; keep its link= target as a
      // readable fallback title ("寻访模拟/干员轮换卡池195" → "干员轮换卡池195").
      const link = /link=([^|\]}]+)/.exec(match[2] ?? '')?.[1]
      if (link) fallback = link.trim().replace(/^寻访模拟\//, '')
      continue
    }
    const display = match[2]?.trim()
    if (display && !/^\d+px$/i.test(display)) label = display
    title = display && !/^\d+px$/i.test(display) ? display : target
  }
  return { title: title || fallback, label }
}

/**
 * Parse every banner table in one PRTS page into banner rows.
 *
 * Handles the nested `{| ... |}` table that sometimes lives inside a cell, so
 * it does not split those rows on the inner `|-` markers.
 */
export function parseBannerTables (content, options = {}) {
  const banners = []
  if (typeof content !== 'string' || content.length === 0) return banners
  const sectionOverride = options.section ?? null
  let section = sectionOverride
  let depth = 0
  let row = null

  const flush = () => {
    if (row && row.cells.length >= 3) {
      const banner = buildBanner(row.cells, section)
      if (banner) banners.push(banner)
    }
    row = null
  }

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    const heading = /^==+\s*([^=][^=]*?)\s*==+$/.exec(trimmed)
    if (heading) {
      flush()
      section = heading[1]
      continue
    }
    if (depth === 0) {
      if (trimmed.startsWith('{|')) {
        depth = 1
        row = null
      }
      continue
    }
    if (trimmed.startsWith('{|')) {
      depth += 1
      if (row && row.cells.length > 0) row.cells[row.cells.length - 1] += `\n${line}`
      continue
    }
    if (trimmed.startsWith('|}')) {
      depth -= 1
      if (row && row.cells.length > 0) row.cells[row.cells.length - 1] += `\n${line}`
      continue
    }
    if (depth === 1) {
      if (/^\|-/.test(trimmed)) {
        flush()
        row = { cells: [] }
        continue
      }
      if (/^!/.test(trimmed)) continue
      if (row && trimmed.startsWith('|') && !trimmed.startsWith('|+')) {
        const parts = trimmed.slice(1).split('||')
        if (row.cells.length === 0) row.cells.push(...parts)
        else if (parts.length === 1) row.cells.push(parts[0])
        else row.cells.push(...parts)
        continue
      }
    }
    if (row && row.cells.length > 0) row.cells[row.cells.length - 1] += `\n${line}`
  }
  flush()
  return banners
}

function buildBanner (rawCells, section) {
  const cells = rawCells.map(cell => String(cell).trim())
  let offset = 0
  if (/^\d+$/.test(cells[0] ?? '')) offset = 1
  const pageCell = cells[offset] ?? ''
  const dateCell = cells[offset + 1] ?? ''
  const sixCell = cells[offset + 2] ?? ''
  const fiveCell = cells[offset + 3] ?? ''
  if (!pageCell || !dateCell) return null

  const start = parseBannerDate(dateCell)
  if (!start) return null
  const allDates = [...dateCell.matchAll(new RegExp(DATE_RE.source, 'g'))]
  const end = allDates.length > 1 ? parseBannerDate(allDates[1][0]) : null

  const { title, label } = extractTitle(pageCell)
  if (!title) return null
  const six = extractAvatars(sixCell)
  if (six.length === 0) return null
  const five = extractAvatars(fiveCell)

  const text = `${label} ${title}`
  const season = /【限定寻访[·・]\s*([^】]+)】/.exec(text)?.[1]?.trim() ?? null
  const limited = season !== null || six.some(avatar => avatar.limited)
  const rerun = /复刻/.test(text)
  const kernel = /中坚/.test(text)
  const rotating = /轮换卡池/.test(text) || /轮换卡池/.test(pageCell)

  let kind = 'event'
  if (kernel) kind = 'kernel'
  else if (rerun) kind = 'rerun'
  else if (limited) kind = 'limited'
  else if (rotating || section?.includes('标准')) kind = 'standard'

  return {
    title: title.replace(/^【[^】]+】/, '').trim() || title,
    label: label || null,
    kind,
    limited,
    rerun,
    season,
    section,
    start,
    end,
    six: six.map(avatar => avatar.name),
    sixLimited: six.filter(avatar => avatar.limited).map(avatar => avatar.name),
    five: five.map(avatar => avatar.name),
    shop: six.filter(avatar => avatar.shop).map(avatar => avatar.name)
  }
}

/** Build the lookup structures the scorer needs from a banner list. */
export function buildBannerIndex (banners, options = {}) {
  const rows = (banners ?? [])
    .filter(banner => banner.start instanceof Date && !Number.isNaN(banner.start.valueOf()))
    .sort((a, b) => a.start - b.start)

  const byOperator = new Map()
  const limitedOperators = new Set()
  const standardPool = new Set()
  const kernelPool = new Set()
  const ensure = name => {
    if (!byOperator.has(name)) {
      byOperator.set(name, {
        appearances: [],
        lastStandard: null,
        lastRerun: null,
        lastKernel: null,
        lastLimited: null,
        lastEvent: null,
        limitedAppearances: [],
        seasons: new Set()
      })
    }
    return byOperator.get(name)
  }

  for (const banner of rows) {
    for (const name of banner.six) {
      const record = ensure(name)
      record.appearances.push({ date: banner.start, title: banner.title, kind: banner.kind, season: banner.season })
      if (banner.kind === 'standard') {
        record.lastStandard = banner.start
        standardPool.add(name)
      } else if (banner.kind === 'kernel') {
        record.lastKernel = banner.start
        kernelPool.add(name)
      } else if (banner.kind === 'rerun' && !banner.limited) {
        // A rerun of a normal rotation banner still puts the operator back on
        // stage, so it counts for "last time this operator was featured".
        record.lastRerun = banner.start
        standardPool.add(name)
      } else if (banner.kind === 'event') {
        // Event/welfare 6★ (e.g. 流明、歌蕾蒂娅) never rotate through the
        // standard banner; they must not pollute rotation predictions.
        record.lastEvent = banner.start
      }
    }
    // Only the avatars explicitly flagged `limited=1` are limited operators.
    // A limited banner also lists non-limited 6★ alongside its headliner.
    for (const name of banner.sixLimited ?? []) {
      const record = ensure(name)
      record.lastLimited = banner.start
      record.seasons.add(banner.season ?? '限定')
      record.limitedAppearances.push({ date: banner.start, title: banner.title, season: banner.season })
      limitedOperators.add(name)
    }
  }

  // Median gap between standard-banner appearances, used as a per-operator
  // cadence baseline instead of one global constant.
  const cadence = new Map()
  const kernelCadence = new Map()
  for (const [name, record] of byOperator) {
    for (const [target, kinds] of [[cadence, ['standard', 'rerun']], [kernelCadence, ['kernel']]]) {
      const dates = record.appearances
        .filter(item => kinds.includes(item.kind))
        .map(item => item.date.getTime())
        .sort((a, b) => a - b)
      if (dates.length < 3) continue
      const gaps = []
      for (let index = 1; index < dates.length; index += 1) {
        gaps.push((dates[index] - dates[index - 1]) / DAY_MS)
      }
      gaps.sort((a, b) => a - b)
      target.set(name, gaps[Math.floor(gaps.length / 2)])
    }
  }

  return {
    banners: rows,
    byOperator,
    limitedOperators,
    standardPool,
    kernelPool,
    cadence,
    kernelCadence,
    oldest: rows[0]?.start ?? null,
    newest: rows[rows.length - 1]?.start ?? null,
    counts: {
      standard: rows.filter(banner => banner.kind === 'standard').length,
      limited: rows.filter(banner => banner.limited).length,
      kernel: rows.filter(banner => banner.kind === 'kernel').length
    }
  }
}

/** Fetch + cache the banner pages for the given year (CN schedule). */
export async function loadBannerData (options = {}) {
  const { signal, now = new Date() } = options
  if (bannerCache && Date.now() - bannerCache.at < BANNER_TTL_MS) return bannerCache

  const year = now.getFullYear()
  const titles = [
    `${STANDARD_PAGE_PREFIX}${year}`,
    `${STANDARD_PAGE_PREFIX}${year - 1}`,
    `${KERNEL_PAGE_PREFIX}${year}`,
    `${KERNEL_PAGE_PREFIX}${year - 1}`,
    `${KERNEL_PAGE_PREFIX}${year - 2}`,
    LIMITED_PAGE
  ]

  const results = await Promise.allSettled(titles.map(title => pageContent(title, { signal })))
  const collected = []
  let pagesLoaded = 0
  for (const result of results) {
    if (result.status !== 'fulfilled' || result.value.missing) continue
    const parsed = parseBannerTables(result.value.content)
    if (parsed.length === 0) continue
    pagesLoaded += 1
    collected.push(...parsed)
  }

  const seen = new Set()
  const unique = []
  for (const banner of collected) {
    const key = `${banner.kind}|${banner.title}|${banner.start.toISOString()}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(banner)
  }

  bannerCache = {
    at: Date.now(),
    banners: unique,
    index: buildBannerIndex(unique),
    pagesRequested: titles.length,
    pagesLoaded
  }
  return bannerCache
}

// ---------------------------------------------------------------------------
// Hint parsing
// ---------------------------------------------------------------------------

const SEASON_RULES = [
  { season: '庆典', keys: ['庆典', '周年', '半周年'], months: [4, 5, 10, 11] },
  { season: '夏季', keys: ['夏季', '夏日', '泳装'], months: [6, 7, 8] },
  { season: '联动', keys: ['联动', 'collab'], months: [] }
]

/** 春节/新年限定 deliberately not predicted (see `NEW_YEAR_KEYS`). */
const NEW_YEAR_KEYS = ['春节', '新年', '过年']

const LIMITED_KEYS = ['限定', '春节', '新年', '周年', '庆典', '半周年', '夏季', '夏日', '泳装', '联动']
const RERUN_KEYS = ['复刻', '轮换复刻']
const KERNEL_KEYS = ['中坚', '甄选']
/** 新角色/异格预测：默认目标（用户要的是“下一次卡池会实装谁”）。 */
const DEBUT_KEYS = ['新角色', '新干员', '新人物', '新六星', '实装', '上线', '异格', '新卡池', '新寻访']
const STANDARD_KEYS = ['轮换', '标准', '常规', '进店', '常驻']

/** Extract the usable signals from the free-text hint. */
export function parseBannerHint (hint = '', explicitType, defaultType = 'debut') {
  const text = String(hint ?? '').trim()
  const regions = REGION_ALIASES
    .filter(([, keys]) => keys.some(key => text.includes(key)))
    .map(([canonical, keys]) => ({ canonical, keys }))
  const seasonRule = SEASON_RULES.find(rule => rule.keys.some(key => text.includes(key)))
  const newYear = NEW_YEAR_KEYS.some(key => text.includes(key))
  const mentionsAlter = /异格/.test(text)
  const mentionsDebut = DEBUT_KEYS.some(key => text.includes(key))

  let bannerType = explicitType ?? null
  if (!bannerType) {
    if (KERNEL_KEYS.some(key => text.includes(key))) bannerType = 'kernel'
    else if (RERUN_KEYS.some(key => text.includes(key))) bannerType = 'rerun'
    else if (LIMITED_KEYS.some(key => text.includes(key))) bannerType = 'limited'
    else if (STANDARD_KEYS.some(key => text.includes(key))) bannerType = 'standard'
    else bannerType = defaultType
  }

  const hasTypeSignal = [...LIMITED_KEYS, ...RERUN_KEYS, ...KERNEL_KEYS, ...DEBUT_KEYS, ...STANDARD_KEYS]
    .some(key => text.includes(key))
  const hasSeason = Boolean(seasonRule)
  const hintUsed = Boolean(text) && (regions.length > 0 || hasSeason || hasTypeSignal)
  const onlyRegionHint = regions.length > 0 && !hasSeason && !LIMITED_KEYS.some(key => text.includes(key))

  return {
    text,
    regions,
    season: seasonRule?.season ?? null,
    seasonMonths: seasonRule?.months ?? [],
    newYear,
    bannerType,
    hintUsed,
    onlyRegionHint,
    mentionsAlter,
    mentionsDebut,
    mentionsSkin: /皮肤|时装|skin/i.test(text),
    mentionsEP: /\bEP\b|单曲|音乐|主题曲/i.test(text)
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function latestOf (record) {
  if (!record) return null
  const dates = [record.lastStandard, record.lastRerun, record.lastKernel, record.lastLimited].filter(Boolean)
  if (dates.length === 0) return null
  return new Date(Math.max(...dates.map(date => date.getTime())))
}

/** Last time the operator was featured in the normal rotation (incl. reruns). */
function lastRotationOf (record) {
  if (!record) return null
  const dates = [record.lastStandard, record.lastRerun].filter(Boolean)
  if (dates.length === 0) return null
  return new Date(Math.max(...dates.map(date => date.getTime())))
}

/**
 * Operators that have been folded into the 中坚 (kernel) pool: their latest
 * appearance is a kernel banner, so they no longer rotate through the normal
 * standard banners.
 */
export function kernelMoved (index, name) {
  const record = index.byOperator.get(name)
  if (!record || !index.kernelPool.has(name) || !record.lastKernel) return false
  const rotation = lastRotationOf(record)
  return rotation === null || record.lastKernel.getTime() > rotation.getTime()
}

function scoreCandidate (entry, index, context) {
  const record = index.byOperator.get(entry.name)
  const isLimited = index.limitedOperators.has(entry.name)
  const released = entry.releasedAt ? new Date(entry.releasedAt) : null
  const sinceReleased = released && !Number.isNaN(released.valueOf()) ? daysBetween(released, context.now) : null
  const sinceAny = latestOf(record) ? daysBetween(latestOf(record), context.now) : sinceReleased

  let score = 0
  const signals = []
  const reasons = []

  if (context.bannerType === 'limited' || context.bannerType === 'rerun') {
    // 往期限定不进入后续卡池：只能在对应限定寻访里兑换（井）获得；新限定尚未
    // 公布也无法提前预测。因此这里只推断同池「陪跑」的非限定 6★。
    if (isLimited) return null
    if (kernelMoved(index, entry.name)) return null
    const lastRotation = lastRotationOf(record)
    if (!lastRotation) return null
    const sinceStandard = daysBetween(lastRotation, context.now)
    if (sinceStandard === null) return null
    const cadence = index.cadence.get(entry.name) ?? 240
    const threshold = Math.max(150, Math.round(cadence * 1.35))
    if (sinceStandard >= threshold) {
      score += 2 + Math.min(2.5, ((sinceStandard - threshold) / threshold) * 1.5)
      signals.push('interval_overdue')
      reasons.push(`距上次进入轮换池约 ${sinceStandard} 天，常态间隔约 ${Math.round(cadence)} 天`)
    } else if (sinceStandard < 45) {
      score -= 2.5
      reasons.push(`最近 ${sinceStandard} 天才进过轮换池，短期重复概率低`)
    }
    reasons.push(context.bannerType === 'limited'
      ? '限定池的限定 6★ 无法提前预测（新限定未公布、往期限定只能兑换）；这里给的是同池陪跑 6★'
      : '复刻池不把已有限定列为候选（往期限定只能兑换）；这里给的是同期 6★')
  } else if (context.bannerType === 'kernel') {
    if (isLimited || !index.kernelPool.has(entry.name)) return null
    const sinceKernel = record?.lastKernel ? daysBetween(record.lastKernel, context.now) : null
    if (sinceKernel === null) return null
    if (sinceKernel >= 240) {
      score += 3.5 + Math.min(1.5, ((sinceKernel - 240) / 240) * 1.5)
      signals.push('interval_overdue')
      reasons.push(`距上次进入中坚池约 ${sinceKernel} 天，中坚池每 1–2 期轮换 2 位 6★，属于久未回归候选`)
    } else if (sinceKernel >= 120) {
      score += 2 + Math.min(1, ((sinceKernel - 120) / 120))
      signals.push('interval_overdue')
      reasons.push(`距上次进入中坚池约 ${sinceKernel} 天，接近常见轮换间隔`)
    } else if (sinceKernel < 42) {
      score -= 2
      reasons.push(`最近 ${sinceKernel} 天刚进过中坚池，短期重复概率低`)
    }
    // Among a tie (ops co-listed in the same 中坚 banner), the one with the
    // longer personal kernel cycle is the weaker candidate for the next slot.
    const kernelCycle = index.kernelCadence?.get(entry.name) ?? 240
    score += Math.min(0.9, kernelCycle / 600)
  } else {
    if (isLimited) return null
    // 中坚池把老干员从标准轮换里抽走了，只有最近仍在标准池出现的人才算候选。
    if (kernelMoved(index, entry.name)) return null
    const lastRotation = lastRotationOf(record)
    // Event/welfare 6★ only ever appear on event banners: they are not part of
    // the standard rotation and should not be predicted for it.
    if (!lastRotation) return null
    const sinceStandard = daysBetween(lastRotation, context.now)
    if (sinceStandard === null) return null
    const cadence = index.cadence.get(entry.name) ?? 240
    const threshold = Math.max(150, Math.round(cadence * 1.35))
    if (sinceStandard >= threshold) {
      score += 2 + Math.min(2.5, ((sinceStandard - threshold) / threshold) * 1.5)
      signals.push('interval_overdue')
      reasons.push(`距上次进入轮换池约 ${sinceStandard} 天，常态间隔约 ${Math.round(cadence)} 天`)
    } else if (sinceStandard < 45) {
      score -= 2.5
      reasons.push(`最近 ${sinceStandard} 天才进过轮换池，短期重复概率低`)
    }
    if (sinceReleased !== null && sinceReleased < 90) {
      score -= 1
      reasons.push('上线不足 90 天，通常不会立刻进入轮换池')
    }
  }

  if (context.regions.length > 0) {
    const matched = context.regions.find(region => operatorMatchesRegion(entry, region))
    if (matched) {
      score += 4.5
      signals.push('story_tie_in')
      reasons.push(`阵营或出身与 hint 的「${matched.canonical}」相关`)
    } else if (context.hintUsed) {
      score -= 1.5
    }
  }

  // Story-driven bonus: recurring named characters, and regions that have been
  // quiet for more than nine months (a likely target for the next story event).
  const story = context.story
  if (story) {
    const info = story.byOperator?.get(entry.name)
    if (info && info.total >= 2) {
      score += Math.min(2, 0.3 + info.total * 0.22)
      signals.push('story_appearance')
      reasons.push(`剧情中共出场 ${info.total} 次（主线 ${info.main} / 活动 ${info.event} / 密录 ${info.memory}），属于反复出现的重要角色`)
    }
    const stale = (story.staleRegions ?? [])
      .map(item => ({ item, region: regionForCanonical(item.canonical) }))
      .find(match => match.region && operatorMatchesRegion(entry, match.region))
    if (stale) {
      score += 1.5
      signals.push('story_tie_in')
      reasons.push(`所属「${stale.item.canonical}」已约 ${stale.item.months} 个月无新剧情，官方有回访该地区的可能`)
    }
  }

  if (score <= 0 && reasons.length === 0) return null
  return { entry, score, signals: [...new Set(signals)], reasons }
}

function pickPool (entries, index, bannerType) {
  const sixStars = (entries ?? []).filter(entry => Number(entry.stars) === SIX_STAR && entry.name)
  if (bannerType === 'limited' || bannerType === 'rerun') {
    // 已有限定不会再次作为 UP 出现（只能在限定池里兑换），因此限定/复刻池只
    // 推断同池陪跑的非限定 6★。
    return sixStars.filter(entry => {
      if (index.limitedOperators.has(entry.name)) return false
      if (kernelMoved(index, entry.name)) return false
      return lastRotationOf(index.byOperator.get(entry.name)) !== null
    })
  }
  if (bannerType === 'kernel') {
    return sixStars.filter(entry => index.kernelPool.has(entry.name) && !index.limitedOperators.has(entry.name))
  }
  return sixStars.filter(entry => {
    if (index.limitedOperators.has(entry.name)) return false
    if (kernelMoved(index, entry.name)) return false
    return lastRotationOf(index.byOperator.get(entry.name)) !== null
  })
}

function confidenceFor (score, signals, context) {
  let confidence = 'low'
  if (score >= 6 && signals.length >= 2) confidence = 'high'
  else if (score >= 3.5) confidence = 'medium'
  if (!context.hintUsed) confidence = 'low'
  if (context.onlyRegionHint && confidence === 'high') confidence = 'medium'
  if (context.degraded) confidence = 'low'
  // A prediction without a matching seasonal series, and a plain standard-pool
  // guess, should never claim "high" — there is no official timetable to match.
  if ((context.bannerType === 'limited' || context.bannerType === 'rerun') && !context.season && confidence === 'high') {
    confidence = 'medium'
  }
  if (context.bannerType === 'standard' && confidence === 'high') confidence = 'medium'
  return confidence
}

/**
 * Canonical prediction result. Pure function: no network access, so the
 * offline harness can feed it fixtures.
 */
export function predictBanners (input) {
  const {
    entries = [],
    index,
    hint = '',
    bannerType,
    region = 'cn',
    now = new Date(),
    story = null,
    degraded = null
  } = input

  const parsed = parseBannerHint(hint, bannerType, 'standard')

  // 春节/新年限定 is intentionally out of scope: predicting it burns budget on a
  // single annual slot while the answer is always the same handful of 岁相干员.
  if (parsed.newYear) {
    return {
      prediction_basis: `hint 指向春节/新年限定（${parsed.text}）；按当前配置不预测新年角色，未拉取卡池或剧情数据。`,
      candidates: [],
      caveats: '本工具不预测春节/新年限定卡池。如需卡池参考，请改用具体地区、剧情线索、复刻或中坚等线索。'
    }
  }

  const context = {
    ...parsed,
    now,
    bannerType: parsed.bannerType,
    story,
    degraded,
    region
  }

  const hasHistory = (index?.banners?.length ?? 0) > 0
  const pool = hasHistory ? pickPool(entries, index, context.bannerType) : []
  const scored = pool
    .map(entry => scoreCandidate(entry, index, context))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name, 'zh'))

  const picked = hasHistory ? scored.slice(0, 4) : []
  if (picked.length < 3 && hasHistory) {
    const used = new Set(picked.map(item => item.entry.name))
    const filler = pool
      .filter(entry => !used.has(entry.name))
      .map(entry => {
        const record = index.byOperator.get(entry.name)
        const since = latestOf(record) ? daysBetween(latestOf(record), now) : null
        return { entry, since }
      })
      .sort((a, b) => (b.since ?? 0) - (a.since ?? 0))
      .slice(0, 3 - picked.length)
    for (const item of filler) {
      picked.push({
        entry: item.entry,
        score: 0,
        signals: [],
        reasons: ['没有明显信号，仅按长期未 UP 的常规观察列入']
      })
    }
  }

  const candidates = picked.map(item => ({
    operator: item.entry.name,
    confidence: confidenceFor(item.score, item.signals, context),
    reason: item.reasons.length > 0 ? item.reasons.join('；') : '常规轮换观察，无强信号',
    signals: item.signals
  }))

  const counts = index.counts ?? { standard: 0, limited: 0, kernel: 0 }
  const basis = []
  if (index.banners?.length) {
    basis.push(`基于 PRTS 卡池一览：标准轮换 ${counts.standard} 期、限时/限定 ${counts.limited} 期` +
      `${counts.kernel ? `、中坚 ${counts.kernel} 期` : ''}；最近一期 ${formatDate(index.newest)}`)
  } else {
    basis.push('卡池页面未能加载，本次没有排期数据')
  }
  basis.push(`当前时间 ${formatDate(now)}（按 ${REGION_LABEL[region] ?? region} 排期推断）`)

  if (context.hintUsed) {
    const used = [
      ...context.regions.map(item => item.canonical),
      context.season,
      context.bannerType !== 'standard' ? `卡池类型 ${context.bannerType}` : null
    ].filter(Boolean)
    basis.push(`hint 信号：${used.join('、')}`)
  } else {
    basis.push('线索不足：hint 未包含可识别的地域/卡池类型/季节信号，以下为基于历史规律的宽泛参考')
  }
  if (story) {
    const recurring = [...(story.byOperator?.values?.() ?? [])].filter(info => info.total >= 2).length
    const stale = (story.staleRegions ?? []).slice(0, 4)
    basis.push(
      `剧情信号：${recurring} 位干员在剧情中出场 ≥2 次；` +
      (stale.length > 0
        ? `超过 9 个月无新剧情的地区：${stale.map(item => `${item.canonical}（约 ${item.months} 个月）`).join('、')}`
        : '暂无超过 9 个月无新剧情的地区')
    )
  } else {
    basis.push('剧情信号不可用：本次仅按卡池历史排期推断')
  }
  if (context.bannerType === 'limited' || context.bannerType === 'rerun') {
    basis.push('基础规则：往期限定干员不进入后续卡池，只能通过兑换获得；已有限定未列入候选，限定 6★ 本身无法提前预测')
  }
  if (degraded) basis.push(`降级说明：${degraded}`)

  const caveats = [
    '这是概率性候选排序，不是官方排期；历史规律存在被官方打破的记录。',
    'PRTS 卡池一览按年度维护，最近几期可能有编辑滞后，请以游戏内公告为准。',
    '标准/中坚池的进店间隔与季节档期都是社区统计规律，官方可以提前或延后；往期限定干员不会进入后续卡池，只能在对应限定寻访中兑换（井）。',
    '剧情信号来自「干员剧情一览」，只统计被收录的剧情页；早期主线章节日期为估算，仅用于判断地区是否长期没有新剧情。',
    '「某地区超过 9 个月无新剧情」以该地区角色的最近一次剧情登场为代理指标，角色跨地区出场会高估地区的新鲜度。'
  ]
  if (context.bannerType === 'limited' || context.bannerType === 'rerun') {
    caveats.splice(1, 0, LIMITED_RULE)
  }
  if (region !== 'cn') {
    caveats.push(`本预测基于 CN 排期；${REGION_LABEL[region] ?? region}通常存在版本偏移，未做精确换算。`)
  }
  if (parsed.mentionsSkin || parsed.mentionsEP) {
    caveats.push('未接入皮肤/EP 数据，皮肤与 EP 信号没有参与打分。')
  }
  if (!index.banners?.length) {
    caveats.push('没有可用的历史卡池数据，候选仅来自 hint 与干员档案，可信度很低。')
  }
  if (degraded) caveats.push('本次已降级：部分数据源不可用，结论仅供方向性参考。')

  return {
    prediction_basis: basis.join('；'),
    candidates,
    caveats: caveats.join(' ')
  }
}

/** One-call helper used by the tool: fetch data, then predict. */
export async function runBannerPrediction (args = {}, options = {}) {
  const { signal } = options
  const now = options.now ?? new Date()
  const hint = typeof args.hint === 'string' ? args.hint : ''
  const degradations = []

  // New-year hints are rejected before any network access: no banner pages, no
  // appearance index, no story dates.
  const parsedHint = parseBannerHint(hint, args.banner_type)
  if (parsedHint.newYear) {
    return predictBanners({ hint, bannerType: args.banner_type, region: args.region ?? 'cn', now })
  }

  let entries = []
  try {
    entries = await loadOperatorEntries({ signal })
  } catch (error) {
    degradations.push(`干员档案获取失败（${error?.message ?? String(error)}）`)
  }

  // Debut / alter prediction answers a different question ("who will be shipped
  // next?"), so it never touches the banner schedule pages at all.
  if (parsedHint.bannerType === 'debut') {
    let story = options.story ?? null
    if (!story && entries.length > 0) {
      try {
        story = await loadStorySignals({ signal, entries, now })
      } catch (error) {
        degradations.push(`剧情信号获取失败（${error?.message ?? String(error)}）`)
      }
    }
    const regions = parsedHint.regions.map(region => region.canonical)
    let result = predictDebut({ regions, entries, signals: story, now, body: hint })

    // 实装校验（wiki 检索）会剔除「其实是某位已实装干员的本名/别名」的候选；
    // 每剔掉一个就用 exclude 重跑一次，把空出来的名额补回下一个最合适的人物。
    const excluded = new Set()
    for (let round = 0; round < 3; round += 1) {
      let verified
      try {
        verified = await verifyCandidatesAgainstWiki(result, { entries, signal })
      } catch (error) {
        result.caveats = `${result.caveats} 实装校验未完成（${error?.message ?? String(error)}）。`
        break
      }
      const removedNames = (result.candidates ?? [])
        .filter(candidate => !(verified.candidates ?? []).includes(candidate))
        .map(candidate => candidate.operator)
        .filter(Boolean)
      // verified 在 result 之后追加了说明文字，逐步累计到最终结果上
      const carried = verified.caveats.slice(result.caveats.length)
      const carriedBasis = verified.prediction_basis.slice(result.prediction_basis.length)
      result = verified
      if (removedNames.length === 0) break
      for (const name of removedNames) excluded.add(name)
      if (round === 2) break
      const rerun = predictDebut({ regions, entries, signals: story, now, body: hint, exclude: excluded })
      rerun.caveats = mergeNotes(rerun.caveats, carried, ' ')
      rerun.prediction_basis = mergeNotes(rerun.prediction_basis, carriedBasis, '；')
      result = rerun
    }
    // 地区线索：把本地区相关干员的档案与密录里提到该地区的片段附在依据后面。
    // 这只是一条弱信号（说明「这条线还没讲完」），不参与候选排序。
    if (parsedHint.regions.length > 0 && entries.length > 0) {
      const region = parsedHint.regions[0]
      try {
        const dossier = await collectRegionDossiers({
          canonical: region.canonical,
          entries,
          signals: story,
          now,
          signal
        })
        if (!dossier.missing) {
          if (dossier.clues.length > 0) result.dossier_clues = dossier.clues
          result.prediction_basis = mergeNotes(result.prediction_basis, formatDossierNotes(dossier), '；')
        }
      } catch (error) {
        result.caveats = `${result.caveats} 干员档案/密录检索未完成（${error?.message ?? String(error)}）。`
      }
    }
    if (degradations.length > 0) {
      result.caveats = `${result.caveats} 降级说明：${degradations.join('；')}`
    }
    if (parsedHint.mentionsSkin || parsedHint.mentionsEP) {
      result.caveats = `${result.caveats} 未接入皮肤/EP 数据，皮肤与 EP 信号没有参与打分。`
    }
    return result
  }

  let index = buildBannerIndex([])
  try {
    const data = await loadBannerData({ signal, now })
    index = data.index
    if (data.pagesLoaded < data.pagesRequested) {
      degradations.push(`卡池页仅 ${data.pagesLoaded}/${data.pagesRequested} 成功加载`)
    }
  } catch (error) {
    degradations.push(`卡池页获取失败（${error?.message ?? String(error)}）`)
  }

  let story = options.story ?? null
  if (!story && entries.length > 0) {
    try {
      story = await loadStorySignals({ signal, entries, now })
    } catch (error) {
      degradations.push(`剧情信号获取失败（${error?.message ?? String(error)}）`)
    }
  }

  return predictBanners({
    entries,
    index,
    hint,
    bannerType: args.banner_type,
    region: args.region ?? 'cn',
    story,
    now,
    degraded: degradations.length > 0 ? degradations.join('；') : null
  })
}
