#!/usr/bin/env node
// Builds data/operator-aliases.json — the “did we just predict an operator who
// is already released?” safety net for debut prediction.
//
// For every operator page we read the 客观履历 (record) paragraph and check
// whether it mentions a speaker that data/story-cast.json classified as an
// unreleased NPC. A hit means that speaker is the operator’s real name or a
// nickname (e.g. 客观履历 of 缇缇 says “现任馆长梅捷缇克缇，只有朋友才可以称她‘缇缇’”),
// so the speaker must never be predicted as a new character.
//
// The 客观履历 paragraph is used on purpose: 档案资料四 etc. mention unrelated
// characters (缇缇’s file mentions her companion 米奥) and would create false
// positives.
//
// Usage:
//   node tools/build-operator-aliases.mjs [--limit 20] [--out data/operator-aliases.json]
//
// Output:
//   { generatedAt, scannedOperators, matchedOperators, aliases: { "<speaker>": "<operator>" },
//     ambiguous: { "<speaker>": ["<operator>", …] } }

import { readFile, writeFile } from 'node:fs/promises'
import { loadOperatorEntries } from '../lib/sources.js'
import { pageContent, cleanShort } from '../lib/prts.js'

const args = process.argv.slice(2)
const readArg = (name, fallback) => {
  const index = args.indexOf(name)
  if (index >= 0 && args[index + 1]) return args[index + 1]
  const prefixed = args.find(arg => arg.startsWith(`${name}=`))
  return prefixed ? prefixed.split('=')[1] : fallback
}

const limit = Number(readArg('--limit', '0')) || 0
const out = readArg('--out', 'data/operator-aliases.json')
const CONCURRENCY = 4

// 客观履历 is stored as a template parameter pair inside the operator page:
//   |档案3=客观履历
//   |档案3条件=初始开放
//   |档案3文本=…
// The parameter number varies between operators, and an extra 条件 parameter
// sits in between, so locate the label and then the next 文本= parameter.
function extractRecord (text) {
  const label = text.indexOf('=客观履历')
  if (label < 0) return ''
  const start = text.indexOf('文本=', label)
  if (start < 0) return ''
  const bodyStart = start + '文本='.length
  const tail = text.slice(bodyStart)
  const end = /\n\|\s*档案\d/.exec(tail)
  return end ? tail.slice(0, end.index) : tail.slice(0, 2000)
}

const data = JSON.parse(await readFile('data/story-cast.json', 'utf8'))
const entries = await loadOperatorEntries()

const operators = entries
  .map(entry => cleanShort(entry?.name))
  .filter(Boolean)
  .sort()

const operatorsSet = new Set(operators)

// Generic crowd / role words that can appear inside a record without naming a
// person (and are also the noisiest `[name="…"]` speakers).
const GENERIC = /^(?:所有人|大家|众人|某人|有人|其他人|母亲|父亲|母亲大人|父母|家族成员|成员|保镖|助理|司机|卡车司机|驾驶员|治安官|警官|士兵|平民|村民|城民|岛民|镇民|居民|干员|菲林|驮兽|兽亲|铳骑|赦罪师|博士|武士|骑士|管家|店主|顾客|所长|队长|导师|教官|士兵长|首领|皇帝|贵族|大臣|法官|记者|主持人|主播|观众|客人|服务员|保安|警察|医生|护士|学生|老师|孩子|男人|女人|老人|青年|少女|少年|工匠|厨子|厨师|店员|领班|职员|军官|军人|将领|后勤|通讯员|播音|节目|声音|旁白|未知|某人|众人|小贩|游夫|水手|船员|乘者|侍者|卫队|巡逻|刽子手)$/

// Speakers worth checking: unreleased NPCs only (operator pages themselves are
// already excluded upstream). Single-character names are too noisy.
const npcNames = Object.entries(data.catalog ?? {})
  .filter(([name, info]) => {
    if (typeof name !== 'string' || name.length < 2) return false
    if (operatorsSet.has(name)) return false
    if (GENERIC.test(name)) return false
    return info?.kind === 'unknown' || info?.kind === 'story'
  })
  .map(([name]) => name)

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A speaker counts as the operator’s real name / nickname only when the record
// introduces it as a name:
//   - “阿娜特，曾任萨尔贡法尔贾万达巴德博物馆的代理馆长…”  → sentence-leading name
//   - “现任馆长梅捷缇克缇，只有朋友才可以称她‘缇缇’”       → name + punctuation
//   - “干员的本名是某某”                                     → nickname pattern
// Mere mentions of other people mid-sentence are ignored.
function recordNamesSpeaker (record, speaker) {
  const firstSentence = record.split('。')[0] ?? ''
  const re = new RegExp(escapeRe(speaker) + '[，,。]')
  if (re.test(firstSentence)) return true
  const nickname = new RegExp(`称[她他其]?[^”"’』」]{0,10}[“"‘『「]${escapeRe(speaker)}[”"’』」]`)
  if (nickname.test(record)) return true
  const realName = new RegExp(`(?:本名|原名|真名|姓名)[是为：:][^，。]{0,6}${escapeRe(speaker)}`)
  return realName.test(record)
}

console.error(`checking ${npcNames.length} unreleased speakers against ${operators.length} operator pages`)

const picked = limit > 0 ? operators.slice(0, limit) : operators
const hits = new Map()

let scanned = 0
let withRecord = 0

async function scanOperator (name) {
  let text = ''
  try {
    const page = await pageContent(name, { timeoutMs: 20000, retries: 1 })
    if (page.missing) return
    text = page.content
  } catch {
    return
  }
  scanned += 1
  const record = extractRecord(text)
  if (!record) return
  withRecord += 1
  for (const speaker of npcNames) {
    if (!record.includes(speaker)) continue
    if (!recordNamesSpeaker(record, speaker)) continue
    const list = hits.get(speaker) ?? []
    if (!list.includes(name)) list.push(name)
    hits.set(speaker, list)
  }
}

const queue = [...picked]
async function worker () {
  while (queue.length > 0) {
    const name = queue.shift()
    await scanOperator(name)
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker))

// Only unique mappings are trustworthy: a real name that appears in several
// operators’ records is usually a shared reference (a superior, a relative),
// not an identity.
const aliases = {}
const ambiguous = {}
for (const [speaker, list] of [...hits.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh'))) {
  const unique = [...new Set(list)]
  if (unique.length === 1) aliases[speaker] = unique[0]
  else ambiguous[speaker] = unique
}

const payload = {
  generatedAt: new Date().toISOString(),
  source: 'PRTS 干员一览 + 干员页“客观履历”段落',
  scannedOperators: scanned,
  matchedOperators: withRecord,
  aliasCount: Object.keys(aliases).length,
  aliases,
  ambiguous
}

await writeFile(out, JSON.stringify(payload, null, 1) + '\n', 'utf8')
console.error(
  `scanned ${scanned} operator pages (${withRecord} with 客观履历), ` +
  `matched ${Object.keys(aliases).length} unique speaker→operator aliases, ` +
  `${Object.keys(ambiguous).length} ambiguous`
)
console.log(`wrote ${out}`)
