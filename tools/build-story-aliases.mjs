#!/usr/bin/env node
// Enriches data/story-cast.json with a rough identity catalog for every speaker
// name that is not an existing operator:
//
//   operator  – PRTS page is an operator page ({{干员页面名|代号|…}}) → alias of
//               an existing operator (真实姓名 / 化名), never a debut candidate
//   enemy     – boss page ({{敌人信息/common2}}) → story-important NPC
//   story     – any other existing page → NPC
//   unknown   – no page found; kept as a weak NPC candidate
//
// Usage: node tools/build-story-aliases.mjs [--limit 20]

import { readFile, writeFile } from 'node:fs/promises'
import { loadOperatorEntries } from '../lib/sources.js'
import { pageContent, cleanShort } from '../lib/prts.js'

const args = process.argv.slice(2)
const limit = Number(args.find(arg => arg.startsWith('--limit='))?.split('=')[1] ?? 0) || 0
const CONCURRENCY = 4

const data = JSON.parse(await readFile('data/story-cast.json', 'utf8'))
const entries = await loadOperatorEntries()
const operatorNames = new Set(entries.map(entry => entry.name).filter(Boolean))

const names = Object.keys(data.characters).filter(name => !operatorNames.has(name))
const picked = limit > 0 ? names.slice(0, limit) : names
console.error(`classifying ${picked.length} of ${names.length} non-operator speakers`)

const catalog = {}
function aliasOf (name) {
  // 予愿安洁莉娜 / 涤火杰西卡 … an operator whose codename ends with this name
  for (const operator of operatorNames) {
    if (operator !== name && operator.endsWith(name)) return operator
  }
  return null
}

async function classify (name) {
  const direct = aliasOf(name)
  if (direct) return { kind: 'operator', alias: direct, source: 'name-suffix' }
  let content = ''
  try {
    const page = await pageContent(name, { timeoutMs: 15000, retries: 1 })
    if (!page.missing) content = page.content
  } catch {
    return { kind: 'unknown' }
  }
  if (!content) return { kind: 'unknown' }
  const operator = /\{\{干员页面名\|([^|}]+)/.exec(content)
  if (operator) {
    const alias = cleanShort(operator[1])
    return { kind: 'operator', alias, source: 'page' }
  }
  if (/\{\{敌人信息/.test(content)) return { kind: 'enemy', source: 'page' }
  return { kind: 'story', source: 'page' }
}

const queue = [...picked]
let done = 0
async function worker () {
  for (;;) {
    const name = queue.pop()
    if (!name) return
    try {
      catalog[name] = await classify(name)
    } catch {
      catalog[name] = { kind: 'unknown' }
    }
    done += 1
    if (done % 20 === 0) console.error(`  ${done}/${picked.length}`)
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))

data.catalog = { generatedAt: new Date().toISOString(), ...catalog }
await writeFile('data/story-cast.json', JSON.stringify(data) + '\n')
const counts = {}
for (const value of Object.values(catalog)) counts[value.kind] = (counts[value.kind] ?? 0) + 1
console.error(`classified ${Object.keys(catalog).length}`, JSON.stringify(counts), '-> data/story-cast.json')
