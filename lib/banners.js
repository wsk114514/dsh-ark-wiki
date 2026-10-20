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

const BANNER_TTL_MS = 30 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const STANDARD_PAGE_PREFIX = '卡池一览/常驻标准寻访/'
const LIMITED_PAGE = '卡池一览/限时寻访'
const KERNEL_PAGE_PREFIX = '卡池一览/常驻中坚寻访&中坚甄选/'
const KERNEL_PAGE_PREFIX_ALT = '卡池一览/常驻中坚寻访&中坚甄选/'
const SIX_STAR = 6

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

const REGION_ALIASES = [
  ['莱塔尼亚', ['莱塔尼亚']],
  ['维多利亚', ['维多利亚']],
  ['龙门', ['龙门']],
  ['炎国', ['炎国', '大炎', '炎']],
  ['叙拉古', ['叙拉古']],
  ['拉特兰', ['拉特兰']],
  ['乌萨斯', ['乌萨斯']],
  ['哥伦比亚', ['哥伦比亚']],
  ['卡西米尔', ['卡西米尔']],
  ['谢拉格', ['谢拉格']],
  ['伊比利亚', ['伊比利亚']],
  ['阿戈尔', ['阿戈尔']],
  ['萨尔贡', ['萨尔贡']],
  ['米诺斯', ['米诺斯']],
  ['萨米', ['萨米']],
  ['雷姆必拓', ['雷姆必拓']],
  ['玻利瓦尔', ['玻利瓦尔']],
  ['东国', ['东国']],
  ['汐斯塔', ['汐斯塔']],
  ['罗德岛', ['罗德岛']],
  ['企鹅物流', ['企鹅物流']],
  ['莱茵生命', ['莱茵生命']],
  ['喀兰贸易', ['喀兰贸易']],
  ['深海猎人', ['深海猎人']],
  ['整合运动', ['整合运动']]
]

const SEASON_RULES = [
  { season: '春节', keys: ['春节', '新年', '过年'], months: [1, 2] },
  { season: '庆典', keys: ['庆典', '周年', '半周年'], months: [4, 5, 10, 11] },
  { season: '夏季', keys: ['夏季', '夏日', '泳装'], months: [6, 7, 8] },
  { season: '联动', keys: ['联动', 'collab'], months: [] }
]

const LIMITED_KEYS = ['限定', '春节', '新年', '周年', '庆典', '半周年', '夏季', '夏日', '泳装', '联动']
const RERUN_KEYS = ['复刻', '轮换复刻']
const KERNEL_KEYS = ['中坚', '甄选']

/** Extract the usable signals from the free-text hint. */
export function parseBannerHint (hint = '', explicitType) {
  const text = String(hint ?? '').trim()
  const regions = REGION_ALIASES
    .filter(([, keys]) => keys.some(key => text.includes(key)))
    .map(([canonical, keys]) => ({ canonical, keys }))
  const seasonRule = SEASON_RULES.find(rule => rule.keys.some(key => text.includes(key)))

  let bannerType = explicitType ?? null
  if (!bannerType) {
    if (KERNEL_KEYS.some(key => text.includes(key))) bannerType = 'kernel'
    else if (RERUN_KEYS.some(key => text.includes(key))) bannerType = 'rerun'
    else if (LIMITED_KEYS.some(key => text.includes(key))) bannerType = 'limited'
    else bannerType = 'standard'
  }

  const hasTypeSignal = [...LIMITED_KEYS, ...RERUN_KEYS, ...KERNEL_KEYS].some(key => text.includes(key))
  const hasSeason = Boolean(seasonRule)
  const hintUsed = Boolean(text) && (regions.length > 0 || hasSeason || hasTypeSignal)
  const onlyRegionHint = regions.length > 0 && !hasSeason && !LIMITED_KEYS.some(key => text.includes(key))

  return {
    text,
    regions,
    season: seasonRule?.season ?? null,
    seasonMonths: seasonRule?.months ?? [],
    bannerType,
    hintUsed,
    onlyRegionHint,
    mentionsSkin: /皮肤|时装|skin/i.test(text),
    mentionsEP: /\bEP\b|单曲|音乐|主题曲/i.test(text)
  }
}

function operatorMatchesRegion (entry, region) {
  const fields = [entry.nation, entry.organization, entry.team]
    .filter(Boolean)
    .map(value => String(value))
  return fields.some(field => region.keys.some(key => field.includes(key)))
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
    if (!isLimited) return null
    const sinceLimited = record?.lastLimited ? daysBetween(record.lastLimited, context.now) : sinceReleased
    if (sinceLimited === null) return null
    if (context.bannerType === 'rerun' && sinceLimited < 300) return null

    if (sinceLimited >= 440 && sinceLimited <= 540) {
      score += 5
      signals.push('interval_overdue')
      reasons.push(`距上次限定登场约 ${sinceLimited} 天，正落在 450–520 天的复刻窗口附近`)
    } else if (sinceLimited > 540) {
      score += 3
      signals.push('interval_overdue')
      reasons.push(`距上次限定登场约 ${sinceLimited} 天，已越过常见复刻窗口，属于超期候选`)
    } else if (sinceLimited < 150) {
      score -= 3
      reasons.push(`上次限定登场约 ${sinceLimited} 天前，短期再复刻概率偏低`)
    }

    // Community observation: 限时复刻 mostly cycles the last two years of
    // limited operators; very old ones stay rare (年/夕 rerun years ago).
    if (sinceLimited > 1100) {
      score -= 3
      reasons.push('限定登场已超过三年，官方复刻通常优先覆盖较新的限定')
    } else if (sinceLimited >= 180 && sinceLimited <= 760) {
      score += 1
      reasons.push('落在近两年限定复刻较常覆盖的区间内')
    }

    if (context.season && record?.seasons?.has(context.season)) {
      score += 3.5
      reasons.push(`其限定系列与 hint 提到的「${context.season}」一致`)
    } else if (context.season) {
      score -= 3
      reasons.push(`限定系列与 hint 的「${context.season}」不一致`)
    }

    const monthWindow = context.seasonMonths.length > 0 ? context.seasonMonths : [4, 5, 10, 11]
    if (monthWindow.includes(context.now.getMonth() + 1)) {
      score += 2
      signals.push('anniversary_window')
      reasons.push(`当前 ${context.now.getMonth() + 1} 月处于${context.season ? `「${context.season}」` : '周年/半周年'}窗口内`)
    }
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

  if (score <= 0 && reasons.length === 0) return null
  return { entry, score, signals: [...new Set(signals)], reasons }
}

function pickPool (entries, index, bannerType) {
  const sixStars = (entries ?? []).filter(entry => Number(entry.stars) === SIX_STAR && entry.name)
  if (bannerType === 'limited' || bannerType === 'rerun') {
    return sixStars.filter(entry => index.limitedOperators.has(entry.name))
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
    degraded = null
  } = input

  const parsed = parseBannerHint(hint, bannerType)
  const context = {
    ...parsed,
    now,
    bannerType: parsed.bannerType,
    degraded,
    region
  }

  const hasHistory = (index?.banners?.length ?? 0) > 0
  const pool = hasHistory ? pickPool(entries, index, context.bannerType) : []
  const scored = pool
    .map(entry => scoreCandidate(entry, index, context))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name, 'zh'))

  const picked = hasHistory ? scored.slice(0, 5) : []
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
  if (degraded) basis.push(`降级说明：${degraded}`)

  const caveats = [
    '这是概率性候选排序，不是官方排期；历史规律存在被官方打破的记录。',
    'PRTS 卡池一览按年度维护，最近几期可能有编辑滞后，请以游戏内公告为准。',
    '450–520 天复刻窗口、2–3 期进店间隔都是社区统计规律，官方可以提前或延后。'
  ]
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
  const degradations = []

  let entries = []
  try {
    entries = await loadOperatorEntries({ signal })
  } catch (error) {
    degradations.push(`干员档案获取失败（${error?.message ?? String(error)}）`)
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

  return predictBanners({
    entries,
    index,
    hint: args.hint,
    bannerType: args.banner_type,
    region: args.region ?? 'cn',
    now,
    degraded: degradations.length > 0 ? degradations.join('；') : null
  })
}
