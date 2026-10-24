import { readFileSync, statSync } from 'node:fs'
import { REGION_ALIASES, regionForCanonical } from './regions.js'
import { COLLAB_BONUS_MULTIPLIER, collabHits, loadCollabEvents } from './collab-events.js'
import { loadAnnouncedOperators } from './announced.js'
import { extractOperatorAnnouncements, loadBiliNews, matchRegionMentions, recentItems, summarizeBiliNews } from './bili-news.js'

// ---------------------------------------------------------------------------
// 剧情新角色 / 异格预测
//
// 数据来自 tools/build-story-cast.mjs + tools/build-story-aliases.mjs：
// 扫描全部主线与活动剧情台词（[name="…"]，2019 年至今），统计每个说话者的出场
// 段数与所在剧情地区；再用 PRTS 页面把“真实姓名/化名”归并到已实装干员，
// 剩下的就是尚未实装、但在剧情里反复出现的人物。
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000
const CAST_URL = new URL('../data/story-cast.json', import.meta.url)
const ALIAS_URL = new URL('../data/operator-aliases.json', import.meta.url)

const RECENT_DAYS = 240
const ALTER_STALE_DAYS = 730
const ALTER_RELIC_DAYS = 1095

// BOSS 模板 / 主线核心这类「叙事分量极重」的人物，官方更倾向留作大型活动的主角，
// 短期进卡池的概率反而偏低，因此整体票数 ×0.95（即下调 5%）。
const FLAGSHIP_PENALTY = 0.95
// 纯活动高频（主线 0 段、活动 ≥10 段）过去被主线加分系统性压过，补一点分。
const ACTIVITY_HEAVY_BONUS = 0.6

// 首次进池超过 4 年的老干员，官方更可能用异格来「重新介绍」他们，因此按规则
// 较大幅度提高异格概率——但上限 20%，不能盖过地区吻合、hint 点名这些强信号。
const ALTER_OLD_YEARS = 4
const ALTER_OLD_BONUS_MULTIPLIER = 1.18

// 数据文件是构建产物：记下 mtime，运行中被 `npm run data:cast` 重建后能自动
// 重新读盘，而不是一直用进程启动时的那份快照。
const fileMtime = url => {
  try {
    return statSync(url).mtimeMs
  } catch {
    return null
  }
}

let castCache = null
let aliasCache = null

/**
 * Load the real-name / nickname → operator index (built offline from the
 * 客观履历 paragraph of every operator page). This is the “已推出的干员”
 * safety net: a speaker such as 梅捷缇克缇 is the real name of operator 缇缇 and
 * must never be predicted as a new character.
 */
export function loadOperatorAliases () {
  const mtime = fileMtime(ALIAS_URL)
  if (aliasCache && aliasCache.mtime === mtime) return aliasCache
  try {
    const data = JSON.parse(readFileSync(ALIAS_URL, 'utf8'))
    aliasCache = {
      aliases: data.aliases ?? {},
      ambiguous: data.ambiguous ?? {},
      generatedAt: data.generatedAt ?? null,
      scanned: data.scannedOperators ?? 0,
      mtime,
      missing: false
    }
  } catch {
    aliasCache = { aliases: {}, ambiguous: {}, generatedAt: null, scanned: 0, mtime, missing: true }
  }
  return aliasCache
}

export function resetOperatorAliases () {
  aliasCache = null
}

/** Load the committed cast database (built offline; never fetched at call time). */
export function loadStoryCast () {
  const mtime = fileMtime(CAST_URL)
  if (castCache && castCache.mtime === mtime) return castCache
  try {
    const data = JSON.parse(readFileSync(CAST_URL, 'utf8'))
    castCache = {
      generatedAt: data.generatedAt ?? null,
      since: data.since ?? null,
      scanned: data.scanned ?? 0,
      characters: data.characters ?? {},
      catalog: data.catalog ?? {},
      mtime,
      missing: false
    }
  } catch {
    castCache = { generatedAt: null, since: null, scanned: 0, characters: {}, catalog: {}, mtime, missing: true }
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

// Region votes are counted from the operators who share a scene with a character,
// so a single cameo in a mixed cast can hand out a few foreign votes. Require both
// a floor (≥ MIN_REGION_VOTES) and a majority share (≥ MIN_REGION_SHARE) of that
// character's votes before calling it "the story is about this region": 普瑞赛斯
// had 5 Laterano votes out of 69 and used to count as a Laterano character.
const MIN_REGION_VOTES = 5
const MIN_REGION_SHARE = 0.5

// 罗德岛是剧情里的常驻机构：几乎每一段剧情都有大量罗德岛干员同场，投票时它会给
// 每个说话者都塞一大票，把本地角色稀释成「罗德岛人物」。塔露拉（80 票罗德岛）、
// 费奥多尔（25 票罗德岛）都因此拿不到乌萨斯地区的 50% 占比。计算占比时把罗德岛
// 的同场票排除，只留真正能说明「故事发生在哪」的阵营票。
const RESIDENT_NATIONS = new Set(['罗德岛'])

// 已知跨地区人物：他们在多条剧情线里客串，同场投票会把少量外来票算成「本地票」
// （普瑞赛斯拉特兰 5 票、奥卢斯拉特兰 4 票）。排除罗德岛票后这两种票的占比会
// 被放大，所以直接规定这些人物不做地区归属。
const CROSS_REGION_FIGURES = new Map([
  ['普瑞赛斯', '横跨拉特兰、阿戈尔等多条剧情线的谜之人物'],
  ['奥卢斯', '深海教会相关，在拉特兰与阿戈尔剧情中都有出场']
])

// 种族 / 群体 / 路人代称不是「人物」：建卡司时的 GENERIC 正则已经滤掉大部分泛称，
// 但老数据里仍残留「海嗣」「恐鱼」「整合运动成员」这类说话者，它们不可能实装。
const NON_PERSON = /(?:成员|海嗣|恐鱼|卫兵|士兵|卫队|小队|兵团|骑士团|弩手|盾卫|无人机|术师|术士|狙击手|炮手|突击兵|步兵|骑兵|卫士|守备队|金律法卫|联络员|商队|佣兵|信使|守卫|警备员|研究员|工人|农民|市民|难民|村民|孩子|老人|少年|少女|男人|女人|声音|旁白|广播|通讯|系统|播音员)$/

function regionSupport (votes, canonical, name = '') {
  if (CROSS_REGION_FIGURES.has(name)) return null
  let matched = 0
  let all = 0
  for (const [nation, count] of votes) {
    if (RESIDENT_NATIONS.has(nation)) continue
    all += count
    if (regionMatches(nation, canonical)) matched += count
  }
  if (all <= 0 || matched < MIN_REGION_VOTES) return null
  const share = matched / all
  if (share < MIN_REGION_SHARE) return null
  return { votes: matched, share }
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

/**
 * 干员首次进入卡池的时间：ark-info 的 `releasedAt`（形如 2019-11-19）。
 * 缺记录时返回 null，调用方据此跳过「老干员异格加权」。
 */
function releaseAge (entry, now) {
  const value = entry?.releasedAt
  if (!value) return null
  const date = String(value).slice(0, 10)
  const ts = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(ts)) return null
  const days = Math.round((now.getTime() - ts) / DAY_MS)
  if (days < 0) return null
  return { date, days }
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
export function predictDebut ({ regions = [], entries = [], signals = null, now = new Date(), body = '', exclude = null } = {}) {
  const cast = loadStoryCast()
  const aliasIndex = loadOperatorAliases()
  // 官方前瞻已公布、但 PRTS 干员页还没建立的六星：这段窗口里实装校验识别不到，
  // 用 data/announced-operators.json 兜底（塔露拉 / 乌萨斯小皇帝 / 内卫）。
  const announced = loadAnnouncedOperators()
  const announcedAs = name => announced.byName.get(name) ?? null
  const announcedExcluded = []
  // 官方 B 站动态：PRTS 建页之前，官方会先发「干员技能展示PV」，标题里直接写着名字。
  // 只当弱信号用——不参与排序，只用来兜住「已公布但 PRTS 还没建页」的窗口。
  const biliNews = loadBiliNews()
  const BILI_WINDOW_DAYS = 30
  const biliRecent = recentItems(biliNews.items, BILI_WINDOW_DAYS, now)
  const biliAnnounced = new Map(extractOperatorAnnouncements(biliRecent).map(item => [item.name, item]))
  const biliAs = name => biliAnnounced.get(name) ?? null
  const operatorNames = new Set(entries.map(entry => entry.name).filter(Boolean))
  const nationOf = new Map()
  for (const entry of entries) nationOf.set(entry.name, entry.nation ?? null)

  // 已推出干员索引：代号 + 外文名/日文名 + 页面「客观履历」里声明的本名/外号。
  // 预测前后都要用它复核，避免把「本名/化名」当成未实装的新角色。
  const releasedBy = new Map()
  for (const entry of entries) {
    const operator = entry?.name
    if (!operator) continue
    if (!releasedBy.has(operator)) releasedBy.set(operator, operator)
    for (const alias of entry?.aliases ?? []) {
      if (typeof alias === 'string' && alias.length >= 2 && !releasedBy.has(alias)) {
        releasedBy.set(alias, operator)
      }
    }
  }
  const releasedAs = (name) => releasedBy.get(name) ?? aliasIndex.aliases[name] ?? null
  const aliasExcluded = []
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
      name.length >= 2 && hintText.includes(name) && !releasedAs(name) && !announcedAs(name) && !biliAs(name)
    )
  )
  // hint 里直接点名的「已推出干员」（代号，或本名/外号），用于在 caveats 里明确解释为什么不给候选。
  const releasedNamed = [...namedHint].filter(name => releasedAs(name))
  const aliasNamedInHint = Object.keys(cast.characters).filter(name =>
    name.length >= 2 && hintText.includes(name) && !operatorNames.has(name) && releasedAs(name)
  )

  // hint 直接点名的「已公布」角色，以及 hint 地区对得上的已公布角色：即使他们在
  // 剧情卡司里没有（或几乎没有）地区票，也要在 caveats 里点出来——比如乌萨斯线索
  // 下的塔露拉与内卫，靠投票永远筛不到，但官方已经公布了。
  const announcedForHint = [...new Set(announced.byName.values())].filter(item => {
    if (hintText.includes(item.name)) return true
    if (regionsHinted.length === 0 || !item.region) return false
    return regionsHinted.some(hint => regionMatches(item.region, hint.canonical))
  })
  // B 站动态里公布的干员没有地区信息，只有在 hint 点名时才需要单独说明。
  const biliForHint = [...biliAnnounced.values()].filter(item => hintText.includes(item.name))

  // --- unreleased story characters -----------------------------------------
  for (const [name, record] of Object.entries(cast.characters)) {
    const catalog = cast.catalog[name] ?? null
    if (catalog?.kind === 'operator') continue
    // 直接就是干员代号：静默跳过（数据里残留的已实装干员）
    if (operatorNames.has(name)) continue
    const total = Number(record.total ?? 0)
    if (total < 2) continue
    if (NON_PERSON.test(name)) continue
    const alreadyReleased = releasedAs(name)
    const lastTs = record.lastDate ? Date.parse(`${record.lastDate}T00:00:00Z`) : null
    const days = daysSince(lastTs, now)
    const votes = parseRegionVotes(record.regions)
    const regionHits = regionsHinted
      .map(item => ({ canonical: item.canonical, support: regionSupport(votes, item.canonical, name) }))
      .filter(hit => hit.support)
      .map(hit => ({ canonical: hit.canonical, share: hit.support.share, votes: hit.support.votes }))
    const recent = days !== null && days <= RECENT_DAYS
    const collab = collabHits(record.groups)

    // 本名/外号对应某位干员：从候选剔除，并在 caveats 里说明（只记有分量的，
    // 否则每条回答都会带上一串全局别名噪音）。已实装的不算「未实装/待确认」。
    if (alreadyReleased) {
      const relevant = regionsHinted.length > 0 ? regionHits.length > 0 : total >= 5
      if (relevant) {
        aliasExcluded.push({ name, operator: alreadyReleased, total, regionHit: regionHits.length > 0 })
      }
      continue
    }

    // 官方已公布实装、但 PRTS 干员页还没建立：不进入候选（否则会把刚公布的六星
    // 继续当成「待实装新角色」），改用 caveats 里的「已公布」说明。
    const revealed = announcedAs(name)
    if (revealed) {
      const relevant = regionsHinted.length > 0
        ? regionHits.length > 0
        : total >= 20 || hintText.includes(name)
      if (relevant) {
        announcedExcluded.push({
          name,
          operator: revealed.name,
          rarity: revealed.rarity,
          total,
          regionHit: regionHits.length > 0,
          hintNamed: hintText.includes(name)
        })
      }
      continue
    }

    // 官方 B 站「干员『X』技能展示PV」已经公布：同样不进候选，caveat 里注明来源。
    const biliRevealed = biliAs(name)
    if (biliRevealed) {
      const relevant = regionsHinted.length > 0
        ? regionHits.length > 0
        : total >= 20 || hintText.includes(name)
      if (relevant) {
        announcedExcluded.push({
          name,
          operator: name,
          rarity: null,
          total,
          regionHit: regionHits.length > 0,
          hintNamed: hintText.includes(name),
          source: 'bilibili',
          date: biliRevealed.date,
          title: biliRevealed.title
        })
      }
      continue
    }

    // 计数放在 exclude 之前：补位重跑时这个数字仍代表数据里的识别结果，不随轮次变化
    npcCount += 1
    // 上一轮已被 wiki 实装校验剔除的名字，重跑时不再进入候选池
    if (exclude?.has(name)) continue

    let score = Math.min(3.0, total * 0.18)
    if (Number(record.main ?? 0) >= 1) score += 0.7
    if (Number(record.main ?? 0) >= 5) score += 0.5
    const activityHeavy = Number(record.main ?? 0) === 0 && Number(record.event ?? 0) >= 10
    if (activityHeavy) score += ACTIVITY_HEAVY_BONUS
    if (recent) score += 1.2
    else if (days !== null && days <= 365) score += 0.5
    if (regionHits.length > 0) score += 2.1
    if (namedNpc.has(name)) score += 2.6
    // 叙事分量极重的角色（BOSS 模板，或主线 ≥5 段且总段数 ≥40）整体下调 5%。
    const flagship = catalog?.kind === 'enemy' || (Number(record.main ?? 0) >= 5 && total >= 40)
    if (flagship) score *= FLAGSHIP_PENALTY
    // 联动剧情参考价值较小：在联动剧情里出场过只加约 2%，没出场也不扣分。
    if (collab.count > 0) score *= COLLAB_BONUS_MULTIPLIER

    const reasons = [`剧情中共出场 ${total} 段（主线 ${record.main ?? 0} 段 / 活动 ${record.event ?? 0} 段）`]
    if (namedNpc.has(name)) reasons.unshift('hint 直接点名该角色')
    if (record.lastDate) reasons.push(`最近一次出现在 ${record.lastDate}（${formatDays(days)}）`)
    if (regionHits.length > 0) {
      const names = regionHits.map(item => `「${item.canonical}」`).join('、')
      const share = Math.round(Math.max(...regionHits.map(item => item.share)) * 100)
      reasons.push(`与${names}剧情高度相关（该地区占其出场票的 ${share}%），符合“新地区版本带来本地角色”的历史规律`)
    }
    if (catalog?.kind === 'enemy') reasons.push('在剧情中拥有独立敌人模板（重要反派/首领级人物）')
    if (flagship) reasons.push('叙事分量极重（BOSS 模板 / 主线核心），这类角色常被官方留作大型活动主角，按规则整体票数下调 5%')
    if (collab.count > 0) {
      reasons.push(`在联动剧情「${collab.names.join('、')}」中出场过（共 ${collab.count} 段），联动剧情参考价值较小，按规则仅小幅提高约 2%`)
    }
    if (catalog?.kind === 'unknown') reasons.push('尚无独立词条页，身份靠台词统计推定')
    reasons.push('尚未作为可操作干员实装')

    const signalsOut = ['story_appearance']
    if (regionHits.length > 0) signalsOut.push('story_tie_in')
    if (recent) signalsOut.push('story_recent')
    if (collab.count > 0) signalsOut.push('collab_cameo')

    const elite = Number(record.main ?? 0) >= 5 || catalog?.kind === 'enemy'
    let confidence = confidenceFor(score, { regionHit: regionHits.length > 0, total, recent, elite })
    if (namedNpc.has(name)) confidence = total >= 8 ? 'high' : (confidence === 'low' ? 'medium' : confidence)
    candidates.push({
      operator: name,
      confidence,
      reason: `${reasons.join('；')}。`,
      signals: signalsOut,
      _kind: 'new',
      _score: score,
      _regionHit: regionHits.length > 0
    })
  }

  // --- alter candidates: famous operators without story for years -----------
  const known = signals?.byOperator ?? new Map()
  for (const entry of entries) {
    const name = entry?.name
    if (!name) continue
    if (announcedAs(name)) continue
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
    // 首次进池超过 4 年：官方更可能用异格来重新介绍老干员，按规则提高约 18%（上限 20%）。
    const release = releaseAge(entry, now)
    const oldTenure = release !== null && release.days >= ALTER_OLD_YEARS * 365
    if (oldTenure) score *= ALTER_OLD_BONUS_MULTIPLIER
    // 联动剧情只作弱参考（与新角色同一条规则）：出场过 +2%，没出场不扣分。
    const collab = collabHits(cast.characters[name]?.groups ?? record.groups)
    if (collab.count > 0) score *= COLLAB_BONUS_MULTIPLIER
    // 计数先于 exclude 的剔除：补位重跑时这个数字仍代表数据里的异格候选数
    alterCount += 1
    if (exclude?.has(name)) continue
    const reasons = [
      `异格候选：剧情出场 ${record.total} 次（主线 ${record.main ?? 0} / 活动 ${record.event ?? 0}${Number(record.memory ?? 0) > 0 ? ` / 密录 ${record.memory}` : ''}）`,
      `已 ${formatDays(days)} 没有新剧情，符合“老角色长期无新剧情 → 异格实装”的历史规律`
    ]
    if (namedHint.has(name)) reasons.unshift('hint 直接点名该角色')
    if (regionHit) reasons.push(`所属地区与本次线索「${regionsHinted.map(item => item.canonical).join('、')}」吻合`)
    if (oldTenure) {
      reasons.push(`首次进池于 ${release.date}（${(release.days / 365).toFixed(1)} 年），超过 ${ALTER_OLD_YEARS} 年，按规则提高异格概率约 18%（上限 20%）`)
    }
    if (collab.count > 0) {
      reasons.push(`在联动剧情「${collab.names.join('、')}」中出场过（共 ${collab.count} 段），联动剧情参考价值较小，按规则仅小幅提高约 2%`)
    }
    const signalsOut = ['alter_candidate']
    if (regionHit) signalsOut.push('story_tie_in')
    if (oldTenure) signalsOut.push('long_tenure')
    if (collab.count > 0) signalsOut.push('collab_cameo')
    candidates.push({
      operator: name,
      confidence: days >= ALTER_RELIC_DAYS || regionHit ? 'medium' : 'low',
      reason: `${reasons.join('；')}。`,
      signals: signalsOut,
      _kind: 'alter',
      _score: score,
      _regionHit: regionHit
    })
  }

  const byScoreOf = (a, b) => b._score - a._score
  const rank = (list) => {
    const hit = list.filter(item => item._regionHit).sort(byScoreOf)
    const rest = list.filter(item => !item._regionHit).sort(byScoreOf)
    return [...hit, ...rest]
  }
  const regionOnly = regionsHinted.length > 0
  const news = regionOnly
    ? rank(candidates.filter(item => item._kind === 'new' && item._regionHit))
    : candidates.filter(item => item._kind === 'new').sort(byScoreOf)
  const alters = regionOnly
    ? rank(candidates.filter(item => item._kind === 'alter' && item._regionHit))
    : candidates.filter(item => item._kind === 'alter').sort(byScoreOf)
  const byScore = [...news, ...alters]

  // 地区线索优先地区吻合的人物（新角色留 3 席），异格线索给异格留 2 席，其余按顺序补足到 4 名
  let pickedRaw = []
  if (alterHint) pickedRaw = [...news.slice(0, 2), ...alters.slice(0, 2)]
  else if (regionsHinted.length > 0) pickedRaw = [...news.slice(0, 3), ...alters.slice(0, 1)]
  if (pickedRaw.length === 0) pickedRaw = byScore.slice(0, 4)
  else {
    for (const item of byScore) {
      if (pickedRaw.length >= 4) break
      if (!pickedRaw.includes(item)) pickedRaw.push(item)
    }
  }

  const picked = pickedRaw.map(({ _kind, _score, _regionHit, ...rest }) => ({ ...rest, kind: _kind }))

  const basisParts = []
  if (cast.missing) {
    basisParts.push('未找到离线剧情卡司数据（data/story-cast.json），仅能基于已实装干员排期推断')
  } else {
    basisParts.push(`剧情卡司数据：扫描 ${cast.scanned} 段 ${cast.since ?? ''} 起的剧情，识别 ${npcCount} 名未实装/待确认人物、${alterCount} 名异格候选`)
    basisParts.push(`数据生成于 ${(cast.generatedAt ?? '').slice(0, 10)}，之后上线的新剧情未统计`)
  }
  if (regionsHinted.length > 0) {
    basisParts.push(`地区线索：${regionsHinted.map(item => item.canonical).join('、')}`)
    basisParts.push(`地区信号：要求该地区剧情票 ≥${MIN_REGION_VOTES} 且占该人物出场票的 ${MIN_REGION_SHARE * 100}% 以上（计算占比时排除常驻机构「罗德岛」的同场票，避免它给每个角色都投一票、把本地人物稀释掉），避免同场其他阵营的干员「带票」`)
  }
  if (namedHint.size > 0) basisParts.push(`hint 点名：${[...namedHint].join('、')}`)
  if (namedNpc.size > 0) basisParts.push(`hint 提到的未实装人物：${[...namedNpc].join('、')}`)
  if (alterHint) basisParts.push('hint 提到「异格」，异格候选加权')
  if (!aliasIndex.missing) {
    basisParts.push(`实装校验：候选已对照 PRTS 干员一览（${aliasIndex.scanned} 名干员）复核代号与本名/外号`)
  }
  if (!announced.missing && announced.count > 0) {
    const names = [...new Set([...announced.byName.values()].map(item => item.name))]
    basisParts.push(`已公布名单：${names.join('、')}（官方前瞻/公告确认实装、PRTS 干员页尚未建立，不参与候选，见 data/announced-operators.json）`)
  }
  const biliSummary = summarizeBiliNews(biliNews.items, { days: BILI_WINDOW_DAYS, now })
  if (biliSummary) {
    basisParts.push(`官方动态（B 站「明日方舟」近 ${BILI_WINDOW_DAYS} 天）：${biliSummary}（快照 ${biliNews.generatedAt ?? '未知'}；只能读到视频标题与文案，图文长图公告在 API 里没有文本）`)
  }
  if (regionsHinted.length > 0 && biliRecent.length > 0) {
    const mentions = matchRegionMentions(biliRecent, regionsHinted.map(item => item.canonical))
    const hits = [...mentions.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 3)
      .map(([region, stat]) => `「${region}」${stat.count} 次（最近 ${stat.latest || '未知'}）`)
    if (hits.length > 0) basisParts.push(`官方近况提到：${hits.join('、')}（仅弱提示，不参与排序）`)
  }
  basisParts.push('评分口径：出场段数按 0.18/段计（封顶 3.0），主线戏份额外加权，纯活动高频角色补偿加分；BOSS 模板或主线核心等「叙事分量极重」的角色整体票数 ×0.95（下调 5%，官方更可能将其留作大型活动主角）')
  const collabIndex = loadCollabEvents()
  if (!collabIndex.missing && collabIndex.names.length > 0) {
    basisParts.push(`联动加成：联动剧情（${collabIndex.names.join('、')}）与泰拉主线的排期关系弱、参考价值较小，在其中出场过的角色按规则 +2%，未出场角色不扣分`)
  }
  if (entries.length > 0) {
    const withRelease = entries.filter(entry => entry?.releasedAt).length
    basisParts.push(`异格加权：首次进池时间超过 ${ALTER_OLD_YEARS} 年（约 ${ALTER_OLD_YEARS * 365} 天）的干员，异格概率按规则提高约 ${Math.round((ALTER_OLD_BONUS_MULTIPLIER - 1) * 100)}%（上限 20%）；${withRelease}/${entries.length} 名干员有「上线时间」记录，缺记录者不加权`)
  }
  if (picked.length === 0) basisParts.push('没有找到符合条件的剧情新角色，建议补充地区/剧情线索')

  const caveats = [
    '新角色是否上线由官方宣传与开发排期决定，剧情出场只能作为弱信号，不构成上线承诺。',
    '台词出场次数只是“剧情分量”的近似值，无法量化社区人气；呼声高但剧情少的角色可能被低估。',
    '真实姓名/化名依赖 PRTS 页面识别（干员页“客观履历”），仍有漏判：无独立页面的重要人物以“待确认”形式保留。',
    '地区票来自同场出场干员的阵营；计算地区占比时已排除常驻机构「罗德岛」的同场票，否则主线角色几乎都会被稀释成“罗德岛人物”。',
    '已知跨地区人物不做地区归属（普瑞赛斯、奥卢斯在多条剧情线里客串，同场投票会带出外来票）；「海嗣」「恐鱼」「整合运动成员」这类种族/群体说话者不算人物，不会进入候选。',
    '已实装干员与已异格角色均已排除，往期限定干员只能在对应限定寻访中兑换，不会作为新角色候选。'
  ]
  if (regionsHinted.length > 0 && picked.length === 0) {
    caveats.push('本次地区线索下没有达到阈值的未实装人物：同场投票里没有任何角色的该地区票数 ≥5 且占比 ≥50%。这不等于该地区不会出新角色，只是当前卡司快照对该地区的支持不足，可以去「不限定地区」看整体候选。')
  }
  if (aliasExcluded.length > 0 || aliasNamedInHint.length > 0) {
    const seen = new Set()
    const ordered = [
      ...aliasNamedInHint.map(name => ({
        name,
        operator: releasedAs(name),
        total: Number(cast.characters[name]?.total ?? 0),
        regionHit: false,
        hintNamed: true
      })),
      ...aliasExcluded
    ].filter(item => {
      if (!item.name || seen.has(item.name)) return false
      seen.add(item.name)
      return true
    })
    const list = ordered
      .sort((a, b) => (Number(b.hintNamed ?? 0) - Number(a.hintNamed ?? 0))
        || (Number(b.regionHit) - Number(a.regionHit))
        || (b.total - a.total))
      .slice(0, 4)
      .map(({ name, operator }) => `${name}＝干员「${operator}」`)
      .join('、')
    caveats.push(`实装校验：${list}，这些是本名/外号对应已推出的干员，已从候选中排除。`)
  }
  if (announcedExcluded.length > 0 || announcedForHint.length > 0 || biliForHint.length > 0) {
    const merged = new Map()
    for (const item of announcedExcluded) merged.set(item.name, item)
    for (const item of announcedForHint) {
      if (merged.has(item.name)) continue
      merged.set(item.name, {
        name: item.name,
        rarity: item.rarity,
        total: Number(cast.characters[item.name]?.total ?? 0),
        regionHit: false,
        hintNamed: hintText.includes(item.name),
        source: 'announced-list'
      })
    }
    for (const item of biliForHint) {
      if (merged.has(item.name)) continue
      merged.set(item.name, {
        name: item.name,
        rarity: null,
        total: Number(cast.characters[item.name]?.total ?? 0),
        regionHit: false,
        hintNamed: true,
        source: 'bilibili',
        date: item.date
      })
    }
    const ordered = [...merged.values()].sort((a, b) =>
      (Number(b.hintNamed ?? 0) - Number(a.hintNamed ?? 0))
      || (Number(b.regionHit) - Number(a.regionHit))
      || (b.total - a.total))
    const list = ordered.slice(0, 5)
      .map(item => `${item.name}${item.rarity ? `（${item.rarity}★）` : ''}`)
      .join('、')
    const hinted = ordered.filter(item => item.hintNamed).map(item => `「${item.name}」`)
    const biliNames = ordered.filter(item => item.source === 'bilibili')
    const manualNames = ordered.filter(item => item.source !== 'bilibili')
    const notes = []
    if (manualNames.length > 0) notes.push('这些角色已在官方前瞻/公告中确认实装')
    if (biliNames.length > 0) {
      notes.push(`其中 ${biliNames.map(item => `「${item.name}」${item.date ? `（${item.date}）` : ''}`).join('、')} 来自官方 B 站动态里的「干员技能展示PV」${manualNames.length > 0 ? '，不在人工名单 data/announced-operators.json 里，也一并剔除' : '，按 data/announced-operators.json 同一套规则从候选中剔除'}`)
    }
    caveats.push(`已公布实装：${list}。${notes.join('；')}；PRTS 干员页尚未建立、运行期实装校验暂时识别不到${hinted.length > 0 ? `。其中 ${hinted.join('、')} 就是本次 hint 点名的角色，答案是「官方已公布」，不是待实装候选` : ''}。`)
  }
  if (releasedNamed.length > 0) {
    caveats.push(`hint 点名的${releasedNamed.map(name => `「${name}」`).join('、')}已经是实装干员，不会作为新角色候选；可改用排期模式查它的复刻/轮换。`)
  }
  if (alteredNamed.length > 0) {
    caveats.push(`${alteredNamed.join('、')} 已经异格实装，因此不再作为异格候选（可查对应异格干员）。`)
  }
  if (cast.missing) caveats.unshift('剧情卡司数据缺失，本次结果退化为干员排期参考。')
  if (collabIndex.missing) {
    caveats.push('联动剧情清单缺失（data/collab-events.json），本次未应用「联动出场 +2%」的加成；运行 npm run data:collab 可更新。')
  }
  if (biliNews.missing) {
    caveats.push('官方 B 站动态快照缺失（data/bili-news.json），本次没有「官方最近在宣什么」的旁证；运行 npm run data:bili 可更新。')
  } else if (biliNews.generatedAt) {
    const biliAge = daysSince(Date.parse(biliNews.generatedAt), now)
    if (biliAge !== null && biliAge > 30) {
      caveats.push(`官方 B 站动态快照生成于 ${biliNews.generatedAt}（${biliAge} 天前），之后的新 PV/公告未收录；运行 npm run data:bili 可更新。`)
    } else {
      caveats.push('官方动态只覆盖视频标题与文案：活动详情、干员立绘这类图文长图公告在 B 站 API 里没有文本，「官方最近在宣什么」只能当弱提示，不是排期证据。')
    }
  }

  // 本名/外号是构建期从 PRTS 干员页抓的快照：太久没更新时提示，避免把新实装的干员漏过校验。
  const aliasAgeDays = aliasIndex.generatedAt ? daysSince(Date.parse(aliasIndex.generatedAt), now) : null
  if (aliasAgeDays !== null && aliasAgeDays > 45) {
    const date = new Date(aliasIndex.generatedAt).toISOString().slice(0, 10)
    caveats.push(`本名/外号校验快照生成于 ${date}（${aliasAgeDays} 天前），此后新实装的干员可能漏判；运行 npm run data:cast 可更新。`)
  }

  return { prediction_basis: basisParts.join('；'), candidates: picked, caveats: caveats.join(' ') }
}
