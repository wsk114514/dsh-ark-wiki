import { readFileSync } from 'node:fs'
import { REGION_ALIASES, regionForCanonical } from './regions.js'

// ---------------------------------------------------------------------------
// 剧情新角色 / 异格预测
//
// 数据来自 tools/build-story-cast.mjs + tools/build-story-aliases.mjs：
// 扫描 2024 年以来的主线与活动剧情台词（[name="…"]），统计每个说话者的出场
// 段数与所在剧情地区；再用 PRTS 页面把“真实姓名/化名”归并到已实装干员，
// 剩下的就是尚未实装、但在剧情里反复出现的人物。
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000
const CAST_URL = new URL('../data/story-cast.json', import.meta.url)

const RECENT_DAYS = 240
const ALTER_STALE_DAYS = 730
const ALTER_RELIC_DAYS = 1095

let castCache = null

/** Load the committed cast database (built offline; never fetched at call time). */
export function loadStoryCast () {
  if (castCache) return castCache
  try {
    const data = JSON.parse(readFileSync(CAST_URL, 'utf8'))
    castCache = {
      generatedAt: data.generatedAt ?? null,
      since: data.since ?? null,
      scanned: data.scanned ?? 0,
      characters: data.characters ?? {},
      catalog: data.catalog ?? {},
      missing: false
    }
  } catch {
    castCache = { generatedAt: null, since: null, scanned: 0, characters: {}, catalog: {}, missing: true }
  }
  return castCache
}

export function resetStoryCast () {
  castCache = null
}

function parseRegionVotes (list) {
  const votes = new Map()
  for (const item of list ?? []) {
    const match = /^(.+?)\((\d+)\)$/.exec(String(item))
    if (!match) continue
    votes.set(match[1], Number(match[2]))
  }
  return votes
}

function regionMatches (nation, canonical) {
  const region = regionForCanonical(canonical)
  if (!region) return false
  const text = String(nation ?? '')
  if (!text) return false
  if (region.keys.some(key => text.includes(key))) return true
  return region.keys.some(key => key.includes(text))
}

function daysSince (ts, now) {
  if (!ts) return null
  return Math.round((now.getTime() - ts) / DAY_MS)
}

function formatDays (days) {
  if (days === null) return '时间未知'
  if (days < 60) return `${days} 天前`
  const months = Math.round(days / 30)
  if (months < 24) return `约 ${months} 个月前`
  return `约 ${(days / 365).toFixed(1)} 年前`
}

function confidenceFor (score, { regionHit = false, total = 0, recent = false, elite = false }) {
  if (regionHit && total >= 10 && elite) return 'high'
  if (regionHit && total >= 6) return 'medium'
  if (recent && total >= 8) return 'medium'
  if (score >= 4.4) return 'medium'
  return 'low'
}

/**
 * Predict debut characters (unreleased NPCs) and alter candidates.
 *
 * @param {object} input
 * @param {string[]} input.regions  canonical regions parsed from the hint
 * @param {object[]} input.entries  operator entries (for nation + alter detection)
 * @param {object} input.signals    story signals of released operators
 * @param {Date} [input.now]
 */
export function predictDebut ({ regions = [], entries = [], signals = null, now = new Date(), body = '' } = {}) {
  const cast = loadStoryCast()
  const operatorNames = new Set(entries.map(entry => entry.name).filter(Boolean))
  const nationOf = new Map()
  for (const entry of entries) nationOf.set(entry.name, entry.nation ?? null)
  const regionsHinted = regions
    .map(canonical => ({ canonical, region: regionForCanonical(canonical) }))
    .filter(item => item.region)

  const candidates = []
  let npcCount = 0
  let alterCount = 0

  const hintText = String(body ?? '')
  const alterHint = /异格/.test(hintText)
  const namedHint = new Set(
    entries
      .map(entry => entry?.name)
      .filter(name => typeof name === 'string' && name.length >= 2 && hintText.includes(name))
  )
  const alteredNamed = [...namedHint].filter(name =>
    [...operatorNames].some(other => other !== name && other.endsWith(name))
  )
  const namedNpc = new Set(
    Object.keys(cast.characters).filter(name =>
      name.length >= 2 && hintText.includes(name) && !operatorNames.has(name)
    )
  )

  // --- unreleased story characters -----------------------------------------
  for (const [name, record] of Object.entries(cast.characters)) {
    const catalog = cast.catalog[name] ?? null
    if (operatorNames.has(name)) continue
    if (catalog?.kind === 'operator') continue
    const total = Number(record.total ?? 0)
    if (total < 2) continue
    const lastTs = record.lastDate ? Date.parse(`${record.lastDate}T00:00:00Z`) : null
    const days = daysSince(lastTs, now)
    const votes = parseRegionVotes(record.regions)
    const regionHits = regionsHinted.filter(item =>
      [...votes.keys()].some(nation => regionMatches(nation, item.canonical))
    )
    const recent = days !== null && days <= RECENT_DAYS

    let score = Math.min(2.5, total * 0.16)
    if (Number(record.main ?? 0) >= 1) score += 0.7
    if (Number(record.main ?? 0) >= 5) score += 0.5
    if (recent) score += 1.2
    else if (days !== null && days <= 365) score += 0.5
    if (catalog?.kind === 'enemy') score += 0.3
    if (regionHits.length > 0) score += 2.1
    if (namedNpc.has(name)) score += 2.6
    npcCount += 1

    const reasons = [`剧情中共出场 ${total} 段（主线 ${record.main ?? 0} 段 / 活动 ${record.event ?? 0} 段）`]
    if (namedNpc.has(name)) reasons.unshift('hint 直接点名该角色')
    if (record.lastDate) reasons.push(`最近一次出现在 ${record.lastDate}（${formatDays(days)}）`)
    if (regionHits.length > 0) {
      const names = regionHits.map(item => `「${item.canonical}」`).join('、')
      reasons.push(`与${names}剧情高度相关，符合“新地区版本带来本地角色”的历史规律`)
    }
    if (catalog?.kind === 'enemy') reasons.push('在剧情中拥有独立敌人模板（重要反派/首领级人物）')
    if (catalog?.kind === 'unknown') reasons.push('尚无独立词条页，身份靠台词统计推定')
    reasons.push('尚未作为可操作干员实装')

    const signalsOut = ['story_appearance']
    if (regionHits.length > 0) signalsOut.push('story_tie_in')
    if (recent) signalsOut.push('story_recent')

    const elite = Number(record.main ?? 0) >= 5 || catalog?.kind === 'enemy'
    let confidence = confidenceFor(score, { regionHit: regionHits.length > 0, total, recent, elite })
    if (namedNpc.has(name)) confidence = total >= 8 ? 'high' : (confidence === 'low' ? 'medium' : confidence)
    candidates.push({
      operator: name,
      confidence,
      reason: `${reasons.join('；')}。`,
      signals: signalsOut,
      _kind: 'new',
      _score: score
    })
  }

  // --- alter candidates: famous operators without story for years -----------
  const known = signals?.byOperator ?? new Map()
  for (const entry of entries) {
    const name = entry?.name
    if (!name) continue
    const record = known.get(name)
    if (!record || record.total < 5) continue
    const lastTs = record.latestTs ?? null
    if (!lastTs) continue
    const days = daysSince(lastTs, now)
    if (days === null || days < ALTER_STALE_DAYS) continue
    // Already altered? (予愿安洁莉娜 / 涤火杰西卡 …)
    const altered = [...operatorNames].some(other => other !== name && other.endsWith(name))
    if (altered) continue
    const regionHit = regionsHinted.length > 0 && regionsHinted.some(item => regionMatches(entry.nation, item.canonical))
    let score = 1.9 + Math.min(1.4, record.total * 0.08)
    score += days >= ALTER_RELIC_DAYS ? 1.5 : 0.8
    if (regionHit) score += 1.4
    if (namedHint.has(name)) score += 2.4
    if (alterHint) score += 1.2
    alterCount += 1
    const reasons = [
      `异格候选：剧情出场 ${record.total} 次（主线 ${record.main ?? 0} / 活动 ${record.event ?? 0}）`,
      `已 ${formatDays(days)} 没有新剧情，符合“老角色长期无新剧情 → 异格实装”的历史规律`
    ]
    if (namedHint.has(name)) reasons.unshift('hint 直接点名该角色')
    if (regionHit) reasons.push(`所属地区与本次线索「${regionsHinted.map(item => item.canonical).join('、')}」吻合`)
    const signalsOut = ['alter_candidate']
    if (regionHit) signalsOut.push('story_tie_in')
    candidates.push({
      operator: name,
      confidence: days >= ALTER_RELIC_DAYS || regionHit ? 'medium' : 'low',
      reason: `${reasons.join('；')}。`,
      signals: signalsOut,
      _kind: 'alter',
      _score: score
    })
  }

  candidates.sort((a, b) => b._score - a._score)
  const picked = candidates.slice(0, 4).map(({ _kind, _score, ...rest }) => ({ ...rest, kind: _kind }))

  const basisParts = []
  if (cast.missing) {
    basisParts.push('未找到离线剧情卡司数据（data/story-cast.json），仅能基于已实装干员排期推断')
  } else {
    basisParts.push(`剧情卡司数据：扫描 ${cast.scanned} 段 ${cast.since ?? ''} 起的剧情，识别 ${npcCount} 名未实装/待确认人物、${alterCount} 名异格候选`)
    basisParts.push(`数据生成于 ${(cast.generatedAt ?? '').slice(0, 10)}，之后上线的新剧情未统计`)
  }
  if (regionsHinted.length > 0) basisParts.push(`地区线索：${regionsHinted.map(item => item.canonical).join('、')}`)
  if (namedHint.size > 0) basisParts.push(`hint 点名：${[...namedHint].join('、')}`)
  if (namedNpc.size > 0) basisParts.push(`hint 提到的未实装人物：${[...namedNpc].join('、')}`)
  if (alterHint) basisParts.push('hint 提到「异格」，异格候选加权')
  if (picked.length === 0) basisParts.push('没有找到符合条件的剧情新角色，建议补充地区/剧情线索')

  const caveats = [
    '新角色是否上线由官方宣传与开发排期决定，剧情出场只能作为弱信号，不构成上线承诺。',
    '台词出场次数只是“剧情分量”的近似值，无法量化社区人气；呼声高但剧情少的角色可能被低估。',
    '真实姓名/化名依赖 PRTS 页面识别，仍有漏判：无独立页面的重要人物以“待确认”形式保留。',
    '已实装干员与已异格角色均已排除，往期限定干员只能在对应限定寻访中兑换，不会作为新角色候选。'
  ]
  if (alteredNamed.length > 0) {
    caveats.push(`${alteredNamed.join('、')} 已经异格实装，因此不再作为异格候选（可查对应异格干员）。`)
  }
  if (cast.missing) caveats.unshift('剧情卡司数据缺失，本次结果退化为干员排期参考。')

  return { prediction_basis: basisParts.join('；'), candidates: picked, caveats: caveats.join(' ') }
}
