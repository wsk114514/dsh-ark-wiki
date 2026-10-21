import { readFileSync, statSync } from 'node:fs'

// ---------------------------------------------------------------------------
// 联动剧情识别
//
// 联动 SideStory 的人物与泰拉世界观的主线/地区排期关系很弱（联动角色通常一次
// 活动内讲完、且多为联动方 IP 的角色），因此用户要求：在联动剧情里出场过的
// 角色只给约 +2% 的轻微加成，未出场的角色不加也不减。
//
// 数据来自 tools/build-collab-events.mjs（PRTS「联动」页面里的联动SideStory）。
// ---------------------------------------------------------------------------

const DATA_URL = new URL('../data/collab-events.json', import.meta.url)

/** 联动剧情只提高约 2%：弱信号，不能压过往期地区/主线信号。 */
export const COLLAB_BONUS_MULTIPLIER = 1.02

let cache = null

const fileMtime = url => {
  try {
    return statSync(url).mtimeMs
  } catch {
    return null
  }
}

/**
 * @returns {{ names: string[], set: Set<string>, generatedAt: string|null, mtime: number|null, missing: boolean }}
 */
export function loadCollabEvents () {
  const mtime = fileMtime(DATA_URL)
  if (cache && cache.mtime === mtime) return cache
  try {
    const data = JSON.parse(readFileSync(DATA_URL, 'utf8'))
    const names = (Array.isArray(data.events) ? data.events : [])
      .map(name => String(name ?? '').trim())
      .filter(Boolean)
    cache = {
      names,
      set: new Set(names),
      generatedAt: data.generatedAt ?? null,
      mtime,
      missing: false
    }
  } catch {
    cache = { names: [], set: new Set(), generatedAt: null, mtime, missing: true }
  }
  return cache
}

export function resetCollabEvents () {
  cache = null
}

/** `源石尘行动(12)` → `{ title: '源石尘行动', count: 12 }` */
function splitGroup (group) {
  const text = String(group ?? '').trim()
  const match = /^(.+?)\((\d+)\)$/.exec(text)
  if (match) return { title: match[1].trim(), count: Number(match[2]) }
  return { title: text, count: 0 }
}

/**
 * 复刻页可能长成「源石尘行动2024」「源石尘行动·复刻」这类变体，所以除了
 * 精确匹配，也接受「联动名 + 数字/复刻字样」的前缀形式。
 */
export function isCollabEvent (title) {
  const index = loadCollabEvents()
  const value = String(title ?? '').trim()
  if (!value || index.set.size === 0) return false
  if (index.set.has(value)) return true
  for (const name of index.names) {
    if (!value.startsWith(name)) continue
    const rest = value.slice(name.length)
    if (/^[\d\s·・\-—（(复刻]*$/.test(rest)) return true
  }
  return false
}

/**
 * 统计一段剧情出场记录里有多少段属于联动剧情。
 *
 * @param {string[]} groups 形如 `["源石尘行动(12)", "孤星(3)"]`
 * @returns {{ count: number, names: string[] }}
 */
export function collabHits (groups) {
  const count = { count: 0, names: [] }
  for (const group of groups ?? []) {
    const { title, count: segments } = splitGroup(group)
    if (!isCollabEvent(title)) continue
    count.count += segments
    if (!count.names.includes(title)) count.names.push(title)
  }
  return count
}
