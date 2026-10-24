import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// B 站官方账号动态（「明日方舟」，mid 161775300）快照
//
// PRTS 建页之前，官方往往先在 B 站发「干员技能展示PV」「活动先导PV」：
//   《明日方舟》干员「克莱门莎」技能展示PV
//   《明日方舟》SideStory「时间啊，向前！」活动先导PV
//   《明日方舟》2026「感谢庆典」活动宣传PV
// 这些标题/文案是 PRTS 之外唯一能拿到的「官方口径」线索，但它们只覆盖视频类
// 动态；图文长图公告（活动详情、干员立绘）在 API 里没有文本，只能看到图片。
//
// 运行期不联网：tools/build-bili-news.mjs 抓取并写入 data/bili-news.json，
// 本模块只读快照并做纯函数解析（方便离线测试）。
// ---------------------------------------------------------------------------

const NEWS_URL = new URL('../data/bili-news.json', import.meta.url)

// 《明日方舟》干员「克莱门莎」技能展示PV
const OPERATOR_PATTERN = /干员[「『]([^」』]{2,12})[」』]/
// 《明日方舟》SideStory「时间啊，向前！」活动先导PV
const EVENT_PATTERN = /(SideStory|故事集|主线)[「『]([^」』]{2,30})[」』]/
// 2026「感谢庆典」活动宣传PV / 周年庆 / 感谢庆典
const SEASON_PATTERN = /(感谢庆典|周年庆|周年|春节|夏活|联动|感谢祭)/

/** @typedef {{id: string, date: string, type: string, title: string, text: string, url: string}} NewsItem */

function normalizeDate (value) {
  if (typeof value !== 'string') return ''
  const match = value.match(/(\d{4})-(\d{2})-(\d{2})/)
  return match ? match[0] : ''
}

/** 从一条动态标题/文案里提取「干员『X』」式公布。 */
export function extractOperatorAnnouncements (items) {
  const out = []
  const seen = new Set()
  for (const item of items ?? []) {
    const haystack = `${item?.title ?? ''} ${item?.text ?? ''}`
    const match = haystack.match(OPERATOR_PATTERN)
    if (!match) continue
    const name = match[1].trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({ name, date: normalizeDate(item.date), title: item.title ?? '', url: item.url ?? null })
  }
  return out
}

/** 从动态里提取活动名（SideStory / 故事集 / 主线）。 */
export function extractEventAnnouncements (items) {
  const out = []
  const seen = new Set()
  for (const item of items ?? []) {
    const haystack = `${item?.title ?? ''} ${item?.text ?? ''}`
    const match = haystack.match(EVENT_PATTERN)
    if (match) {
      const key = `${match[1]}:${match[2]}`
      if (!seen.has(key)) {
        seen.add(key)
        out.push({ type: match[1], name: match[2], date: normalizeDate(item.date), title: item.title ?? '', url: item.url ?? null })
      }
      continue
    }
    if (SEASON_PATTERN.test(haystack)) {
      const season = haystack.match(SEASON_PATTERN)[1]
      const title = (item?.title ?? '').trim()
      // 印象曲 / 原声 / 主题曲 只是配乐 PV，不代表活动排期，别当事件信号。
      if (/(印象曲|原声|OST|主题曲|音乐)/.test(haystack)) continue
      if (!/(PV|活动|前瞻|先导|实录|庆典)/.test(haystack)) continue
      const key = `season:${season}`
      if (!title || seen.has(key)) continue
      seen.add(key)
      out.push({ type: 'season', name: season, date: normalizeDate(item.date), title, url: item.url ?? null })
    }
  }
  return out
}

/**
 * 统计若干地区名在动态文本里出现的次数（用于「官方近况提到某个地区」的弱信号）。
 * @param {NewsItem[]} items
 * @param {string[]} regions
 * @returns {Map<string, {count: number, latest: string, sample: string}>}
 */
export function matchRegionMentions (items, regions) {
  const wanted = [...new Set((regions ?? []).map(name => String(name ?? '').trim()).filter(Boolean))]
  const stats = new Map()
  if (wanted.length === 0) return stats
  for (const item of items ?? []) {
    const haystack = `${item?.title ?? ''} ${item?.text ?? ''}`
    if (!haystack.trim()) continue
    const date = normalizeDate(item.date)
    for (const region of wanted) {
      if (!haystack.includes(region)) continue
      const record = stats.get(region) ?? { count: 0, latest: '', sample: '' }
      record.count += 1
      if (date > record.latest) {
        record.latest = date
        record.sample = (item.title || item.text || '').trim().slice(0, 60)
      }
      stats.set(region, record)
    }
  }
  return stats
}

/** 近 `days` 天内的动态（按日期字符串比较，缺日期的按「最新」处理）。 */
export function recentItems (items, days = 30, now = new Date()) {
  const cutoffMs = now.getTime() - days * 24 * 3600 * 1000
  return (items ?? []).filter(item => {
    const date = normalizeDate(item?.date)
    if (!date) return true
    const ms = Date.parse(`${date}T00:00:00Z`)
    return Number.isFinite(ms) ? ms >= cutoffMs : true
  })
}

/** 拼一句给人看的「官方近况」。 */
export function summarizeBiliNews (items, { days = 30, now = new Date(), maxEvents = 2, maxOperators = 2 } = {}) {
  const recent = recentItems(items, days, now)
  if (recent.length === 0) return null
  const events = extractEventAnnouncements(recent).slice(0, maxEvents)
  const operators = extractOperatorAnnouncements(recent).slice(0, maxOperators)
  const parts = []
  for (const event of events) {
    const label = event.type === 'season' ? `「${event.name}」相关PV` : `${event.type}「${event.name}」`
    parts.push(`${label}${event.date ? `（${event.date}）` : ''}`)
  }
  for (const operator of operators) {
    parts.push(`干员「${operator.name}」技能展示PV${operator.date ? `（${operator.date}）` : ''}`)
  }
  return parts.length > 0 ? parts.join('、') : null
}

let cache = null

/**
 * 读取 data/bili-news.json 快照。
 * @returns {{items: NewsItem[], operators: Array, events: Array, generatedAt: string|null, source: object|null, missing: boolean}}
 */
export function loadBiliNews () {
  if (cache) return cache
  try {
    const data = JSON.parse(readFileSync(NEWS_URL, 'utf8'))
    const items = (data.items ?? []).map(item => ({
      id: String(item?.id ?? ''),
      date: normalizeDate(item?.date),
      type: String(item?.type ?? ''),
      title: String(item?.title ?? ''),
      text: String(item?.text ?? ''),
      url: item?.url ?? null
    }))
    cache = {
      items,
      operators: extractOperatorAnnouncements(items),
      events: extractEventAnnouncements(items),
      generatedAt: data.generatedAt ?? null,
      source: data.source ?? null,
      missing: false
    }
  } catch {
    cache = { items: [], operators: [], events: [], generatedAt: null, source: null, missing: true }
  }
  return cache
}

export function resetBiliNews () {
  cache = null
}
