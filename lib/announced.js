import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// 已公布实装名单
//
// PRTS 的干员页要等角色正式上线前后才建立，而官方前瞻直播/公告往往提前一两周
// 就公布了六星。这段窗口里，剧情里出现的同名人物会被误当成「未实装新角色」——
// 塔露拉、乌萨斯小皇帝（费奥多尔）、内卫就是典型。
//
// data/announced-operators.json 是人工维护的小名单：
//   { name, aliases[], rarity, announcedAt, region, note }
// 命中名单的人物不进候选，并在 caveats 里说明「官方已公布」。PRTS 建页之后，
// 运行期实装校验（lib/wiki-roster.js）会接管，名单里的条目可以删掉。
// ---------------------------------------------------------------------------

const ANNOUNCED_URL = new URL('../data/announced-operators.json', import.meta.url)

let cache = null

/** @returns {{byName: Map<string, object>, generatedAt: string|null, source: string|null, missing: boolean, count: number}} */
export function loadAnnouncedOperators () {
  if (cache) return cache
  try {
    const data = JSON.parse(readFileSync(ANNOUNCED_URL, 'utf8'))
    const byName = new Map()
    for (const item of data.operators ?? []) {
      const name = typeof item?.name === 'string' ? item.name.trim() : ''
      if (!name) continue
      const record = {
        name,
        rarity: Number.isFinite(item.rarity) ? item.rarity : null,
        announcedAt: item.announcedAt ?? null,
        region: item.region ?? null,
        note: item.note ?? null
      }
      if (!byName.has(name)) byName.set(name, record)
      for (const alias of item.aliases ?? []) {
        if (typeof alias === 'string' && alias.length >= 2 && !byName.has(alias)) byName.set(alias, record)
      }
    }
    cache = {
      byName,
      generatedAt: data.generatedAt ?? null,
      source: data.source ?? null,
      count: (data.operators ?? []).length,
      missing: false
    }
  } catch {
    cache = { byName: new Map(), generatedAt: null, source: null, count: 0, missing: true }
  }
  return cache
}

export function resetAnnouncedOperators () {
  cache = null
}

/** `名字（含别名）→ 已公布记录`；未命中返回 null。 */
export function announcedOperator (name) {
  const index = loadAnnouncedOperators()
  return index.byName.get(String(name ?? '')) ?? null
}
