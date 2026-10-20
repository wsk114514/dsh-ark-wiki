#!/usr/bin/env node
// Offline builder: scans recent story scripts and records who actually speaks
// in them. The result (data/story-cast.json) powers debut/alter prediction, so
// it is built once and committed instead of fetched on every tool call.
//
// Usage:
//   node tools/build-story-cast.mjs [--since 2024-01-01] [--limit 20] [--out data/story-cast.json]
//
// Notes:
// - Only 主线剧情 / 活动剧情 pages are scanned; 干员密录 rarely introduces new
//   playable characters and would triple the request count.
// - Speaker names come from `[name="..."]` dialogue tags, so NPCs are included.
// - Generic crowd labels (士兵/队员/村民 …) are dropped; they never become 6★.

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { loadStoryTiming, loadOperatorEntries } from '../lib/sources.js'
import { pageContent, cleanShort } from '../lib/prts.js'

const args = process.argv.slice(2)
const readArg = (name, fallback) => {
  const index = args.indexOf(name)
  if (index >= 0 && args[index + 1]) return args[index + 1]
  const prefixed = args.find(arg => arg.startsWith(`${name}=`))
  return prefixed ? prefixed.split('=')[1] : fallback
}

const since = Date.parse(readArg('--since', '2024-01-01') + 'T00:00:00Z')
const limit = Number(readArg('--limit', '0')) || 0
const out = readArg('--out', 'data/story-cast.json')
const CONCURRENCY = 4
const GENERIC = /(士兵|干员|队员|卫兵|守卫|群众|路人|研究员|术师|战士|猎人|村民|市民|岛民|镇民|居民|平民|国人|感染者|商人|工人|祭司|教徒|信使|佣兵|队长|首领|主持人|记者|主播|观众|客人|服务员|保安|警察|医生|护士|学生|老师|孩子|男人|女人|老者|青年|少女|少年|帝王|贵族|仆从|侍从|工匠|匠|厨师|店员|领班|职员|军官|军人|将领|士兵长|后勤|通讯员|广播|节目|声音|旁白|未知|某人|众人|小贩|渔夫|水手|船员|乘客|侍者|卫队|巡逻|哨兵)/

const [timing, entries] = await Promise.all([
  loadStoryTiming(),
  loadOperatorEntries().catch(() => [])
])

const operatorNames = new Map()
for (const entry of entries) {
  if (!entry?.name) continue
  operatorNames.set(entry.name, entry.nation ?? null)
}

const targets = []
for (const [page, meta] of timing) {
  if (!['主线剧情', '活动剧情'].includes(meta.kind)) continue
  if (!meta.ts || meta.ts < since) continue
  targets.push({ page, meta })
}
targets.sort((a, b) => b.meta.ts - a.meta.ts)
const picked = limit > 0 ? targets.slice(0, limit) : targets
console.error(`scanning ${picked.length} stories since ${new Date(since).toISOString().slice(0, 10)}`)

const NAME_RE = /\[name="([^"]+)"\]/g

async function scanStory (item) {
  const titles = [`${item.page}/BEG`, `${item.page}/END`]
  const texts = []
  for (const title of titles) {
    try {
      const result = await pageContent(title, { timeoutMs: 20000, retries: 1 })
      if (result.missing) continue
      texts.push(result.content)
    } catch {
      // A missing subpage is normal for single-node stories.
    }
  }
  if (texts.length === 0) {
    try {
      const result = await pageContent(item.page, { timeoutMs: 20000, retries: 1 })
      if (!result.missing) texts.push(result.content)
    } catch {
      return null
    }
  }
  const counts = new Map()
  for (const text of texts) {
    NAME_RE.lastIndex = 0
    let match
    while ((match = NAME_RE.exec(text)) !== null) {
      const name = cleanShort(match[1])
      if (!name || name.length > 12) continue
      if (GENERIC.test(name)) continue
      // Crowd placeholders: 城镇居民A, 不安的平民, “同胞” …
      if (/[“”「」『』]/.test(name)) continue
      if (/[A-Za-z0-9]$/.test(name) && /[A-Za-z]$/.test(name.slice(-1))) continue
      if (/(的|地|们)$/.test(name)) continue
      if (/[？?]$/.test(name)) continue
      if (/(声|无线电|信号|助手|帮手|广播)$/.test(name)) continue
      if (/(士官|新兵|老兵|军士|军曹|卫队|巡逻|惩戒军)/.test(name)) continue
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
  }
  if (counts.size === 0) return null
  return { ...item, counts }
}

const characters = new Map()
let scanned = 0
let skipped = 0

async function worker (queue) {
  for (;;) {
    const item = queue.pop()
    if (!item) return
    let result = null
    try {
      result = await scanStory(item)
    } catch {
      result = null
    }
    if (!result) {
      skipped += 1
    } else {
      scanned += 1
      const cast = [...result.counts.entries()].sort((a, b) => b[1] - a[1])
      const regionVotes = new Map()
      for (const [name] of cast) {
        const nation = operatorNames.get(name)
        if (!nation) continue
        regionVotes.set(nation, (regionVotes.get(nation) ?? 0) + 1)
      }
      const date = result.meta.date ?? new Date(result.meta.ts).toISOString().slice(0, 10)
      for (const [name, lines] of cast) {
        if (!characters.has(name)) {
          characters.set(name, {
            total: 0, main: 0, event: 0, lines: 0,
            lastTs: 0, lastDate: null, groups: new Map(), regions: new Map(), stories: []
          })
        }
        const record = characters.get(name)
        record.total += 1
        record.lines += lines
        if (result.meta.kind === '主线剧情') record.main += 1
        else record.event += 1
        if (result.meta.ts > record.lastTs) {
          record.lastTs = result.meta.ts
          record.lastDate = date
        }
        if (result.meta.group) record.groups.set(result.meta.group, (record.groups.get(result.meta.group) ?? 0) + 1)
        for (const [region, votes] of regionVotes) {
          record.regions.set(region, (record.regions.get(region) ?? 0) + votes)
        }
        if (record.stories.length < 4) record.stories.push(result.meta.group ? `${result.meta.group} · ${result.page}` : result.page)
      }
    }
  }
}

const queue = [...picked]
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)))

const top = (map, count) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, count)

const payload = {
  generatedAt: new Date().toISOString(),
  since: new Date(since).toISOString().slice(0, 10),
  scanned,
  characters: {}
}
const names = [...characters.keys()].sort()
for (const name of names) {
  const record = characters.get(name)
  if (record.total < 2) continue
  payload.characters[name] = {
    total: record.total,
    main: record.main,
    event: record.event,
    lines: record.lines,
    lastDate: record.lastDate,
    groups: top(record.groups, 4).map(([group, count]) => `${group}(${count})`),
    regions: top(record.regions, 3).map(([region, votes]) => `${region}(${votes})`),
    stories: record.stories
  }
}
const size = JSON.stringify(payload).length
await mkdir(dirname(out), { recursive: true })
await writeFile(out, JSON.stringify(payload, null, 0) + '\n')
console.error(`scanned ${scanned} stories, skipped ${skipped}, characters ${Object.keys(payload.characters).length}, bytes ${size} -> ${out}`)
