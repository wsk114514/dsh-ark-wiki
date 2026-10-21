/**
 * 干员档案与密录线索。
 *
 * 地区类预测（「下个版本回 XX，会出谁」）过去只看剧情台词里谁出场多。剧情台词
 * 能说明「谁在台面上」，但干员自己的档案与密录更常埋着「这条线还没讲完」的
 * 伏笔：未完成的计划、没说出口的来历、下一站要去哪。这里把这些片段捞出来，作为
 * 弱信号附在预测依据后面。
 *
 * 取数路径（全部走 PRTS 页面，不做离线快照，因为干员太多、更新太频繁）：
 *   干员页  → `{{人员档案|档案N=…}}`          （parseArchivesFromPage）
 *   密录索引 → Cargo `char_memory`.`storyTxt`  （一页一条密录）
 *   密录页  → `[name="…"]台词`                 （剧情模拟器脚本）
 *
 * 只在「hint 里给了地区」时才跑，且限流：最多 3 名干员、每人 1 篇密录。
 */

import { pageContent, cargoQuery, cleanShort, cleanText } from './prts.js'
import { parseArchivesFromPage } from './sources.js'
import { operatorMatchesRegion, regionForCanonical } from './regions.js'

const CACHE_TTL_MS = 30 * 60 * 1000
const MAX_OPERATORS = 3
const MAX_RECORDS_PER_OPERATOR = 1
const MAX_CLUES = 5
const MAX_CLUES_PER_OPERATOR = 2
const CLUE_MAX_LENGTH = 120

/** 档案里出现这些词，通常意味着还有没展开的伏笔。 */
const HOOK_RE = /(计划|打算|即将|将来|未来|下一步|尚未|仍未|还没|离开|回到|返回|故乡|复仇|寻找|失踪|秘密|隐瞒|真相|传闻|也许|或许|恐怕|将要|准备|结局|下落)/

/** 只取有正文的档案段：基础档案/体检报告是表格数据，不含剧情线索。 */
const ARCHIVE_TITLE_RE = /(客观履历|档案资料|晋升记录)/

const cache = new Map()

/** Drop cached dossiers (tests and long-lived sessions). */
export function resetDossierCache () {
  cache.clear()
}

/** Split a paragraph into sentences, keeping the terminator off. */
export function splitSentences (text) {
  return String(text ?? '')
    .split(/(?<=[。！？；])/)
    .map(part => part.replace(/^[\s　]+|[\s　]+$/g, ''))
    .filter(part => part.length >= 6)
}

function keyHits (text, keys) {
  const value = String(text ?? '')
  return keys.filter(key => key && value.includes(key)).length
}

/**
 * Pick the operators whose dossier is most likely to talk about this region:
 * those who appeared in its story most recently, then higher rarities.
 */
export function selectRegionOperators (entries, canonical, { signals = null, limit = MAX_OPERATORS, now = new Date() } = {}) {
  const region = regionForCanonical(canonical)
  if (!region) return []
  const known = signals?.byOperator ?? new Map()
  const scored = []
  for (const entry of entries ?? []) {
    const name = entry?.name
    if (!name) continue
    if (!operatorMatchesRegion(entry, region)) continue
    const record = known.get(name) ?? null
    const latestTs = record?.latestTs ?? null
    const days = latestTs ? Math.round((now.getTime() - latestTs) / (24 * 60 * 60 * 1000)) : null
    let score = Number(entry.stars ?? 0) * 0.1
    if (days !== null) score += days <= 365 ? 3 : (days <= 730 ? 1.5 : 0)
    if (record && Number(record.total ?? 0) >= 5) score += 0.6
    scored.push({ entry, score, days })
  }
  scored.sort((left, right) => right.score - left.score || String(left.entry.name).localeCompare(String(right.entry.name)))
  return scored.slice(0, Math.max(0, limit)).map(item => item.entry)
}

/**
 * Sentences from an operator's written archives that mention the region (or a
 * hook keyword together with the region). Region mention is mandatory: a lone
 * 「离开」 sentence is not evidence about this region's next banner.
 */
export function extractArchiveClues (archives, keys, { limit = 3 } = {}) {
  const clues = []
  for (const archive of archives ?? []) {
    if (!archive?.text) continue
    if (archive.title && !ARCHIVE_TITLE_RE.test(archive.title)) continue
    for (const sentence of splitSentences(archive.text)) {
      const hits = keyHits(sentence, keys)
      if (hits === 0) continue
      const score = hits * 2 + (HOOK_RE.test(sentence) ? 2 : 0)
      clues.push({ title: archive.title ?? null, text: cleanText(sentence, CLUE_MAX_LENGTH), score })
    }
  }
  clues.sort((left, right) => right.score - left.score)
  const seen = new Set()
  const picked = []
  for (const clue of clues) {
    if (seen.has(clue.text)) continue
    seen.add(clue.text)
    picked.push({ title: clue.title, text: clue.text, score: clue.score })
    if (picked.length >= limit) break
  }
  return picked
}

/** `[name="…"]台词` lines of a 剧情模拟器 page; inline tags are stripped. */
export function parseRecordLines (content) {
  const lines = []
  for (const raw of String(content ?? '').split('\n')) {
    const match = /^\[name="([^"]+)"\]\s*(.+)$/.exec(raw.trim())
    if (!match) continue
    const speaker = cleanShort(match[1])
    const text = cleanText(match[2].replace(/\[[^\]]*\]/g, ' '), CLUE_MAX_LENGTH)
    if (!speaker || !text || text.length < 6) continue
    lines.push({ speaker, text })
  }
  return lines
}

/** Record lines that mention the region; hook keywords only raise the score. */
export function extractRecordClues (lines, keys, { limit = 2 } = {}) {
  const clues = []
  for (const line of lines ?? []) {
    const hits = keyHits(line.text, keys)
    if (hits === 0) continue
    clues.push({ speaker: line.speaker, text: line.text, score: hits * 2 + (HOOK_RE.test(line.text) ? 2 : 0) })
  }
  clues.sort((left, right) => right.score - left.score)
  const seen = new Set()
  const picked = []
  for (const clue of clues) {
    if (seen.has(clue.text)) continue
    seen.add(clue.text)
    picked.push({ speaker: clue.speaker, text: clue.text })
    if (picked.length >= limit) break
  }
  return picked
}

/** One archive and one 密录 per operator, then fill up to the per-operator cap. */
function pickPerOperator (archiveClues, recordClues) {
  const picked = []
  if (archiveClues.length) picked.push(archiveClues[0])
  if (recordClues.length && picked.length < MAX_CLUES_PER_OPERATOR) picked.push(recordClues[0])
  for (const clue of [...archiveClues.slice(1), ...recordClues.slice(1)]) {
    if (picked.length >= MAX_CLUES_PER_OPERATOR) break
    picked.push(clue)
  }
  return picked.slice(0, MAX_CLUES_PER_OPERATOR)
}

async function recordPages (name, options) {
  const quoted = `'${String(name).replace(/'/g, "''")}'`
  const rows = await cargoQuery({
    tables: 'char_memory',
    fields: '_pageName=pageName,storySetName,storyIndex,storyTxt',
    where: `_pageName=${quoted}`,
    orderBy: 'storySetName,storyIndex',
    limit: MAX_RECORDS_PER_OPERATOR
  }, options).catch(() => [])
  return rows
    .map(row => ({
      set: cleanShort(row.storySetName) || null,
      index: cleanShort(row.storyIndex) || null,
      page: cleanShort(row.storyTxt) || null
    }))
    .filter(row => row.page)
}

/**
 * Collect archive / 密录 clues for a region.
 *
 * Never throws for a single failed page: a missing operator page or a broken
 * 密录 simply contributes nothing. Returns the operator names actually scanned
 * so the caller can say so honestly.
 */
export async function collectRegionDossiers ({
  canonical,
  entries = [],
  signals = null,
  now = new Date(),
  limit = MAX_OPERATORS,
  signal = null,
  fetchPage = pageContent,
  fetchRecords = recordPages,
  useCache = true
} = {}) {
  const region = regionForCanonical(canonical)
  if (!region) return { region: canonical, operators: [], clues: [], missing: 'unknown-region' }

  const cached = cache.get(canonical)
  if (useCache && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value

  const selected = selectRegionOperators(entries, canonical, { signals, limit, now })
  const clues = []
  for (const entry of selected) {
    if (signal?.aborted) break
    if (clues.length >= MAX_CLUES) break
    const name = entry.name
    const url = `https://prts.wiki/w/${encodeURIComponent(name)}`
    const page = entry.page ?? name
    const archiveClues = []
    const recordClues = []
    try {
      const data = await fetchPage(page, { signal, timeoutMs: 12000, retries: 0 })
      if (data && !data.missing) {
        const archives = parseArchivesFromPage(data.content)
        for (const clue of extractArchiveClues(archives, region.keys)) {
          archiveClues.push({ operator: name, source: '档案', title: clue.title, text: clue.text, url })
        }
      }
    } catch (error) {
      if (error?.code === 'ABORTED' || error?.name === 'AbortError') break
    }
    if (signal?.aborted) {
      clues.push(...pickPerOperator(archiveClues, recordClues))
      break
    }
    try {
      const records = await fetchRecords(name, { signal, timeoutMs: 10000, retries: 0 })
      for (const record of records.slice(0, MAX_RECORDS_PER_OPERATOR)) {
        if (signal?.aborted) break
        const story = await fetchPage(record.page, { signal, timeoutMs: 12000, retries: 0 })
        if (!story || story.missing) continue
        const title = [record.set, record.index ? `第${record.index}话` : null].filter(Boolean).join(' · ') || record.page
        for (const clue of extractRecordClues(parseRecordLines(story.content), region.keys)) {
          recordClues.push({
            operator: name,
            source: '密录',
            title,
            text: clue.text,
            url: `https://prts.wiki/w/${encodeURIComponent(record.page)}`
          })
        }
      }
    } catch (error) {
      if (error?.code === 'ABORTED' || error?.name === 'AbortError') break
    }
    clues.push(...pickPerOperator(archiveClues, recordClues))
  }

  const value = {
    region: canonical,
    operators: selected.map(entry => entry.name),
    scanned: selected.length,
    clues: clues.slice(0, MAX_CLUES),
    missing: null
  }
  if (useCache) cache.set(canonical, { at: Date.now(), value })
  return value
}

/** One sentence for `prediction_basis`. */
export function formatDossierNotes (dossier) {
  if (!dossier) return ''
  const operators = dossier.operators?.length ? `（${dossier.operators.join('、')}）` : ''
  if (!dossier.clues?.length) {
    return dossier.scanned
      ? `档案/密录线索：本次检查了${operators}的干员档案与密录，没有找到提及「${dossier.region}」的可用片段`
      : `档案/密录线索：没有找到属于「${dossier.region}」的已实装干员，跳过档案与密录检索`
  }
  const items = dossier.clues.map(clue => {
    const title = [clue.source, clue.title].filter(Boolean).join('·')
    return `「${clue.operator}」${title}：「${clue.text}」`
  })
  return `档案/密录线索${operators}：${items.join('；')}（只摘录与本地区相关的片段，属弱信号，不代表官方走向）`
}
