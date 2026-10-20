/**
 * Lookup layer: turns a user-supplied name into one canonical record from
 * PRTS, using the cheapest source that can answer it.
 *
 *   operator -> ark-info (three Cargo tables, cached)
 *   item     -> PRTS Cargo `item` table + `{{道具信息}}` page template
 *   stage    -> PRTS page wikitext (`{{普通关卡信息}}` / `{{突袭关卡信息}}`)
 */

import { getOperators } from 'ark-info'
import {
  API_ENDPOINT,
  WIKI_BASE,
  PrtsError,
  apiGet,
  cargoQuery,
  pageContent,
  prtsFetch,
  searchTitles,
  extractTemplateParams,
  extractTemplates,
  cleanText,
  cleanShort,
  splitList,
  toNumber
} from './prts.js'

const OPERATOR_TTL_MS = 10 * 60 * 1000
const OPERATOR_FIELDS = [
  'id', 'index', 'position', 'subProfession', 'tags', 'designer', 'painter',
  'nation', 'organization', 'team', 'feature', 'birthday', 'sex', 'race', 'obtainMethod'
]
const STAGE_CODE_PATTERN = /^[A-Za-z]{0,3}\d+(?:-\d+)+$/
const MAX_CANDIDATES = 8

let operatorCache = null

/** Drop cached operator data (tests and long-lived sessions). */
export function resetCaches () {
  operatorCache = null
  operatorPageCache.clear()
  storyIndexCache = null
  memoryIndexCache = null
  appearanceIndexCache = null
  activityDateCache = null
  worldTitleCache = null
  worldPageCache = new Map()
  worldGlossaryCache = null
}

function normalize (value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function unique (values) {
  return [...new Set(values.filter(Boolean))]
}

function wikiUrl (title) {
  return WIKI_BASE + encodeURIComponent(String(title ?? '').replace(/ /g, '_'))
}

function envelope (category, query) {
  return {
    status: 'not_found',
    category: category ?? 'unknown',
    query,
    matchedBy: 'none',
    entry: null,
    candidates: [],
    message: '',
    source: { endpoint: API_ENDPOINT }
  }
}

function ok (category, query, entry, matchedBy) {
  const result = envelope(category, query)
  result.status = 'ok'
  result.matchedBy = matchedBy
  result.entry = entry
  if (entry.url) result.source.page = entry.url
  return result
}

// ---------------------------------------------------------------------------
// Operators (ark-info)
// ---------------------------------------------------------------------------

function adaptOperator (row) {
  const names = {
    zh: cleanShort(row.names?.zh ?? row.name),
    en: cleanShort(row.names?.en),
    ja: cleanShort(row.names?.ja)
  }
  const name = names.zh || names.en || String(row.name ?? '')
  const birthday = row.birthday && typeof row.birthday === 'object' && row.birthday.month
    ? `${row.birthday.month}月${row.birthday.day}日`
    : cleanShort(typeof row.birthday === 'string' ? row.birthday : '')
  const tags = Array.isArray(row.tags) ? row.tags.map(cleanShort).filter(Boolean) : splitList(row.tags)
  const obtain = Array.isArray(row.obtainMethod)
    ? row.obtainMethod.map(cleanShort).filter(Boolean)
    : splitList(row.obtainMethod)

  return {
    category: 'operator',
    name,
    aliases: unique([names.zh, names.en, names.ja]).filter(alias => alias !== name),
    id: row.id ?? null,
    index: toNumber(row.index),
    profession: cleanShort(row.profession) || null,
    subProfession: cleanShort(row.subProfession) || null,
    position: cleanShort(row.position) || null,
    stars: toNumber(row.stars),
    tags,
    nation: cleanShort(row.nation) || null,
    organization: cleanShort(row.organization) || null,
    team: cleanShort(row.team) || null,
    race: cleanShort(row.race) || null,
    sex: cleanShort(row.sex) || null,
    birthday: birthday || null,
    feature: cleanText(row.feature, 300) || null,
    designer: cleanShort(row.designer) || null,
    painter: cleanShort(row.painter) || null,
    obtainMethod: obtain,
    releasedAt: row.releasedAt ?? null,
    page: name,
    url: wikiUrl(name)
  }
}

async function loadOperators (signal) {
  if (operatorCache && Date.now() - operatorCache.at < OPERATOR_TTL_MS) return operatorCache
  const rows = await getOperators({ extraFields: OPERATOR_FIELDS, fetch: prtsFetch(signal) })
  const records = []
  const index = new Map()
  for (const row of rows) {
    const entry = adaptOperator(row)
    if (!entry.name) continue
    const keys = unique([
      row.name, row.names?.zh, row.names?.en, row.names?.ja
    ].map(normalize))
    records.push({ entry, keys })
    for (const key of keys) if (!index.has(key)) index.set(key, entry)
  }
  operatorCache = { at: Date.now(), records, index }
  return operatorCache
}

/** Flat operator entries for consumers (banner prediction) that only need fields. */
export async function loadOperatorEntries (options = {}) {
  const cache = await loadOperators(options.signal)
  return cache.records.map(record => record.entry)
}

function rankMatches (records, query, keysOf) {
  const target = normalize(query)
  if (!target) return []
  const scored = []
  for (const record of records) {
    const keys = keysOf(record)
    let best = null
    for (const key of keys) {
      let score = null
      if (key === target) score = 0
      else if (key.startsWith(target)) score = 1
      else if (key.includes(target)) score = 2
      else if (key.length >= 2 && target.includes(key)) score = 3
      if (score === null) continue
      if (best === null || score < best.score || (score === best.score && key.length < best.length)) {
        best = { score, length: key.length }
      }
    }
    if (best) scored.push({ record, ...best })
  }
  scored.sort((left, right) => left.score - right.score || left.length - right.length)
  return scored
}

const MATCH_LABEL = ['exact', 'prefix', 'fuzzy', 'fuzzy']

async function lookupOperator (query, options = {}) {
  const { records, index } = await loadOperators(options.signal)
  const target = normalize(query)
  const exact = index.get(target)
  if (exact) return ok('operator', query, await enrichOperator(exact, options), 'exact')

  const ranked = rankMatches(records, query, record => record.keys)
  if (ranked.length === 0) {
    const result = envelope('operator', query)
    result.message = `PRTS 干员库（共 ${records.length} 名）中没有名称匹配「${query}」的干员。`
    return result
  }
  const best = ranked[0]
  if (best.score <= 2) {
    const result = ok('operator', query, await enrichOperator(best.record.entry, options), MATCH_LABEL[best.score])
    result.message = `未找到完全同名的干员，已按相近名称匹配「${best.record.entry.name}」。`
    return result
  }
  const result = envelope('operator', query)
  result.candidates = ranked.slice(0, MAX_CANDIDATES).map(({ record }) => ({
    category: 'operator',
    name: record.entry.name,
    detail: [record.entry.profession, record.entry.subProfession, record.entry.stars ? `${record.entry.stars}★` : null]
      .filter(Boolean).join(' · ')
  }))
  result.message = `没有与「${query}」同名的干员，但存在相近条目，见 candidates。`
  return result
}

// ---------------------------------------------------------------------------
// Operator skills & talents
//
// PRTS exposes no Cargo table for combat skills or talents (`cargotables` lists
// only chara/chara_data/chara_extra_info/char_obtain/char_mod/char_memory/
// char_building_skill/...), so these are parsed from the operator page itself:
// `{{技能|…}}` / `{{技能2|…}}` per skill slot and `{{天赋列表3|…}}` per talent.
// Building skills ("基建技能") *are* a Cargo table, so they cost one cheap query.
// ---------------------------------------------------------------------------

const SKILL_TEMPLATE_NAME = /^技能\d*$/
const TALENT_TEMPLATE_NAME = /^天赋列表\d*$/
const SKILL_LEVEL_KEYS = ['1', '2', '3', '4', '5', '6', '7', '专精1', '专精2', '专精3']
/** PRTS fills not-yet-revealed talents with 「？？？」 placeholders. */
const PLACEHOLDER_TEXT = /^[？?\s]+$/
const EMPTY_CONDITION = /^[—\-－]+$/
const OPERATOR_PAGE_TTL_MS = 10 * 60 * 1000
const operatorPageCache = new Map()

function sqlQuote (value) {
  return "'" + String(value ?? '').replace(/'/g, "''") + "'"
}

function skillLevelLabel (key) {
  return key.startsWith('专精') ? `专${key.slice(2)}` : `${key}级`
}

/** One `{{技能…}}` block per skill slot, with every rank/mastery row. */
export function parseSkillsFromPage (content) {
  const blocks = extractTemplates(content, SKILL_TEMPLATE_NAME, { limit: 4, before: 200 })
  const skills = []
  for (const block of blocks) {
    const params = block.params
    const name = cleanShort(params['技能名'])
    if (!name) continue
    const levels = []
    for (const key of SKILL_LEVEL_KEYS) {
      const description = cleanText(params[`技能${key}描述`], 400)
      if (!description) continue
      levels.push({
        level: skillLevelLabel(key),
        description,
        initialSp: toNumber(params[`技能${key}初始`]),
        spCost: toNumber(params[`技能${key}消耗`]),
        duration: toNumber(params[`技能${key}持续`])
      })
    }
    if (levels.length === 0) continue
    const unlock = /技能\d+（([^）]+)）/.exec(block.before)
    skills.push({
      index: skills.length + 1,
      name,
      nameEn: cleanShort(params['技能名en']) || null,
      nameJa: cleanShort(params['技能名jp']) || null,
      chargeType: cleanShort(params['技能类型1']) || null,
      triggerType: cleanShort(params['技能类型2']) || null,
      unlock: unlock ? cleanShort(unlock[1]) || null : null,
      levels
    })
  }
  return skills
}

/** One entry per talent, with every elite/module level and its potential boost. */
export function parseTalentsFromPage (content) {
  const blocks = extractTemplates(content, TALENT_TEMPLATE_NAME, { limit: 6, before: 0 })
  const talents = []
  const seen = new Set()
  for (const block of blocks) {
    const slot = cleanShort(block.params['天赋']) || null
    for (let index = 1; index <= 6; index += 1) {
      const name = cleanShort(block.params[`天赋${index}`])
      const effect = cleanText(block.params[`天赋${index}效果`], 400)
      if (!name || !effect) continue
      if (PLACEHOLDER_TEXT.test(name) || PLACEHOLDER_TEXT.test(effect)) continue
      const rawCondition = cleanShort(block.params[`天赋${index}条件`])
      const condition = rawCondition && !EMPTY_CONDITION.test(rawCondition) ? rawCondition : null
      const key = `${slot ?? ''}|${name}|${condition ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      // PRTS is inconsistent about the field order of potential upgrades.
      const potentialEffect = cleanText(
        block.params[`潜能增强_天赋${index}效果`] ?? block.params[`潜能增强_${index}天赋效果`], 400) || null
      let talent = talents.find(item => item.slot === slot && item.name === name)
      if (!talent) {
        talent = { slot, name, levels: [] }
        talents.push(talent)
      }
      talent.levels.push({ condition, effect, potentialEffect })
    }
  }
  return talents
}

async function loadBuildingSkills (page, options) {
  const rows = await cargoQuery({
    tables: 'char_building_skill',
    fields: '_pageName=pageName,skillIndex,inSkillIndex,name,phase,level',
    where: `_pageName=${sqlQuote(page)}`,
    orderBy: 'skillIndex,inSkillIndex',
    limit: 30
  }, options).catch(() => [])
  return rows
    .map(row => ({
      name: cleanShort(row.name),
      phase: cleanShort(row.phase) || null,
      level: cleanShort(row.level) || null
    }))
    .filter(skill => skill.name)
}

/** Character-sheet keys on `{{人员档案set}}`; PRTS uses the same names everywhere. */
const PROFILE_FIELDS = [
  ['gender', '性别'], ['combatExperience', '战斗经验'], ['birthplace', '出身地'],
  ['birthday', '生日'], ['race', '种族'], ['height', '身高'],
  ['infectionStatus', '矿石病感染情况'], ['infected', '是否感染者'],
  ['physicalStrength', '物理强度'], ['mobility', '战场机动'], ['endurance', '生理耐受'],
  ['tactics', '战术规划'], ['combatSkill', '战斗技巧'], ['artsAdaptability', '源石技艺适应性'],
  ['cellFusionRate', '体细胞与源石融合率'], ['crystalDensity', '血液源石结晶密度']
]

/** `{{人员档案set|…}}` — the demographic/medical block of the operator sheet. */
export function parseOperatorProfile (content) {
  const [block] = extractTemplates(content, /^人员档案set$/, { limit: 1, before: 0 })
  if (!block) return null
  const profile = {}
  for (const [key, label] of PROFILE_FIELDS) {
    const value = cleanShort(block.params[label])
    if (value) profile[key] = value
  }
  return Object.keys(profile).length > 0 ? profile : null
}

/** `{{人员档案|档案1=…|档案1条件=…|档案1文本=…}}` — the written archives. */
export function parseArchivesFromPage (content) {
  const [block] = extractTemplates(content, /^人员档案$/, { limit: 1, before: 0 })
  if (!block) return []
  const archives = []
  for (let index = 1; index <= 12; index += 1) {
    const title = cleanShort(block.params[`档案${index}`])
    const text = cleanText(block.params[`档案${index}文本`], 400)
    if (!title || !text) continue
    // Unrevealed archives are titled/texted 「？？？」 on PRTS.
    if (PLACEHOLDER_TEXT.test(title) || PLACEHOLDER_TEXT.test(text)) continue
    archives.push({
      title,
      condition: cleanShort(block.params[`档案${index}条件`]) || null,
      text
    })
  }
  return archives
}

/** 干员密录 links live in Cargo `char_memory`; `storyTxt` is the story page. */
async function loadRecords (page, options) {
  const rows = await cargoQuery({
    tables: 'char_memory',
    fields: '_pageName=pageName,storySetName,storyIndex,storyTxt',
    where: `_pageName=${sqlQuote(page)}`,
    orderBy: 'storySetName,storyIndex',
    limit: 30
  }, options).catch(() => [])
  return rows
    .map(row => {
      const storyPage = cleanShort(row.storyTxt)
      if (!storyPage) return null
      return {
        set: cleanShort(row.storySetName) || null,
        index: cleanShort(row.storyIndex) || null,
        page: storyPage,
        url: wikiUrl(storyPage)
      }
    })
    .filter(Boolean)
}

/** Page-derived extras, cached per operator page; a failure degrades to nothing. */
async function enrichOperator (entry, options = {}) {
  const page = entry.page || entry.name
  const cached = operatorPageCache.get(page)
  if (cached && Date.now() - cached.at < OPERATOR_PAGE_TTL_MS) return { ...entry, ...cached.data }

  // PRTS occasionally answers a page fetch in ~6 s, so this budget is generous:
  // when it still fails the entry degrades to the profile fields we already have.
  // The page fetch is isolated from the Cargo calls so a slow page still leaves
  // skills-adjacent metadata (干员密录) intact.
  const requestOptions = { signal: options.signal, timeoutMs: 12000, retries: 0 }
  try {
    const [pageData, buildingSkills, records] = await Promise.all([
      pageContent(page, requestOptions).catch(error => {
        if (error?.code === 'ABORTED' || error?.name === 'AbortError') throw error
        return null
      }),
      loadBuildingSkills(page, requestOptions),
      loadRecords(page, requestOptions)
    ])
    const data = {}
    if (pageData && !pageData.missing) {
      const skills = parseSkillsFromPage(pageData.content)
      const talents = parseTalentsFromPage(pageData.content)
      const archives = parseArchivesFromPage(pageData.content)
      const profile = parseOperatorProfile(pageData.content)
      if (skills.length) data.skills = skills
      if (talents.length) data.talents = talents
      if (archives.length) data.archives = archives
      if (profile) data.profile = profile
    }
    if (buildingSkills.length) data.buildingSkills = buildingSkills
    if (records.length) data.records = records
    operatorPageCache.set(page, { at: Date.now(), data })
    return { ...entry, ...data }
  } catch (error) {
    if (error?.code === 'ABORTED' || error?.name === 'AbortError') throw error
    return entry
  }
}

// ---------------------------------------------------------------------------
// Items (Cargo `item` table + `{{道具信息}}`)
// ---------------------------------------------------------------------------

function escapeSqlLike (value) {
  return String(value).replace(/'/g, "''").replace(/[%_]/g, match => '\\' + match)
}

/** Rarity/quantity labels PRTS attaches to a drop instead of a second item. */
const DROP_QUALITY = new Set([
  '罕见', '稀有', '普通', '常见', '固定掉落', '三星获得', '大概率', '小概率', '特殊', '额外'
])

/**
 * PRTS uses two drop notations:
 *   `梓兰:固定掉落,至纯源石:三星获得`      (name:condition pairs)
 *   `:家具=yes:1=白色物资箱:2=罕见`        (numbered key=value pairs)
 */
function parseDrops (value) {
  const text = String(value ?? '').trim()
  if (!text) return []
  const parts = text.includes('=')
    ? text.split(':').map(part => part.trim()).filter(Boolean)
    : text.split(/[,，]/).map(part => part.trim()).filter(Boolean)

  const drops = []
  for (const part of parts) {
    const separator = part.includes('=') ? '=' : (part.match(/[:：]/) ? ':' : null)
    if (!separator) {
      drops.push({ name: cleanShort(part), condition: null })
      continue
    }
    const separatorIndex = part.indexOf(separator)
    const key = part.slice(0, separatorIndex).trim()
    const val = part.slice(separatorIndex + 1).trim()
    if (!val) continue
    if (key === '家具' || val === 'yes' || val === 'no') continue
    if (/^\d+$/.test(key)) {
      const previous = drops[drops.length - 1]
      if (DROP_QUALITY.has(val) && previous && previous.condition === null) {
        previous.condition = val
        continue
      }
      drops.push({ name: cleanShort(val), condition: null })
      continue
    }
    if (key) drops.push({ name: cleanShort(key), condition: cleanShort(val) || null })
  }
  return drops.filter(drop => drop.name).slice(0, 20)
}

async function buildItemEntry (row, signal) {
  const pageTitle = row.pageName || row.name
  const entry = {
    category: 'item',
    name: cleanShort(row.name) || pageTitle,
    itemId: row.itemId ?? null,
    rarity: toNumber(row.rarity),
    rarityStars: toNumber(row.rarity) === null ? null : toNumber(row.rarity) + 1,
    kind: null,
    description: cleanText(row.description, 500) || null,
    usage: null,
    obtain: null,
    page: pageTitle,
    url: wikiUrl(pageTitle)
  }

  // The page template carries prose the Cargo table does not (用途/获得方式/分类).
  try {
    const page = await pageContent(pageTitle, { signal })
    if (!page.missing) {
      const params = extractTemplateParams(page.content, ['道具信息'])
      if (params) {
        entry.kind = cleanShort(params['分类']) || entry.kind
        entry.description = cleanText(params['描述'], 500) || entry.description
        entry.usage = cleanText(params['用途'], 300) || null
        entry.obtain = cleanText(params['获得方式'], 200) || null
        if (params['名称']) entry.name = cleanShort(params['名称'])
      }
    }
  } catch (error) {
    if (error?.code === 'ABORTED') throw error
    // Enrichment is optional: keep the Cargo row when the page is unavailable.
  }
  return entry
}

async function lookupItem (query, options = {}) {
  const rows = await cargoQuery({
    tables: 'item',
    fields: '_pageName=pageName,name,itemId,rarity,description',
    where: `name LIKE '%${escapeSqlLike(query)}%'`,
    limit: 25
  }, options)

  if (rows.length === 0) {
    const result = envelope('item', query)
    result.message = `PRTS 物品库中没有名称包含「${query}」的物品。`
    return result
  }

  const ranked = rankMatches(rows, query, row => [normalize(row.name)])
  const best = ranked[0]
  if (best && best.score <= 2) {
    if (options.exactOnly && best.score > 0) {
      // A prefix/fuzzy item hit is weaker than an exact operator or stage hit,
      // so defer it to the caller instead of answering now.
      const deferred = envelope('item', query)
      deferred.message = `没有完全同名的物品，存在相近条目「${best.record.name}」。`
      deferred.candidates = rows.slice(0, MAX_CANDIDATES).map(row => ({
        category: 'item',
        name: cleanShort(row.name),
        detail: toNumber(row.rarity) === null ? '物品' : `物品 · ${toNumber(row.rarity) + 1}★`
      }))
      deferred._near = { row: best.record, score: best.score }
      return deferred
    }
    const entry = await buildItemEntry(best.record, options.signal)
    const result = ok('item', query, entry, MATCH_LABEL[best.score])
    if (best.score > 0) result.message = `未找到完全同名的物品，已按相近名称匹配「${entry.name}」。`
    return result
  }

  const result = envelope('item', query)
  result.candidates = rows.slice(0, MAX_CANDIDATES).map(row => ({
    category: 'item',
    name: cleanShort(row.name),
    detail: toNumber(row.rarity) === null ? '物品' : `物品 · ${toNumber(row.rarity) + 1}★`
  }))
  result.message = `没有与「${query}」同名的物品，但物品库中存在包含该词条的条目，见 candidates。`
  return result
}

// ---------------------------------------------------------------------------
// Stages (page wikitext)
// ---------------------------------------------------------------------------

function parseEnemies (params) {
  if (!params) return []
  const enemies = []
  for (let index = 1; index <= 40; index += 1) {
    const name = cleanShort(params[`敌人${index}`])
    if (!name) continue
    enemies.push({
      name,
      count: toNumber(params[`敌人${index}数量`]),
      level: toNumber(params[`敌人${index}级别`])
    })
  }
  return enemies
}

/**
 * PRTS spreads stages across several infobox templates (主线/支线 use
 * `普通关卡信息`, annihilation uses `剿灭关卡信息`, events add their own).
 * All of them share the same key vocabulary, so pick the first one that carries
 * a stage code.
 */
function extractStageParams (content) {
  const direct = extractTemplateParams(content, ['普通关卡信息', '关卡信息'])
  if (direct && direct['关卡代号']) return direct
  const names = unique(
    [...content.matchAll(/\{\{([^|{}\n]{1,20})/g)].map(match => match[1].trim())
  ).filter(name => /关卡信息$/.test(name) && name !== '突袭关卡信息')
  for (const name of names) {
    const params = extractTemplateParams(content, [name])
    if (params && params['关卡代号']) return params
  }
  return null
}

function parseStagePage (title, content) {
  const normal = extractStageParams(content)
  if (!normal) return null
  const challenge = extractTemplateParams(content, ['突袭关卡信息'])

  const description = cleanText(normal['关卡描述'], 500) || null
  const entry = {
    category: 'stage',
    code: cleanShort(normal['关卡代号']) || null,
    name: cleanShort(normal['关卡名']) || null,
    id: cleanShort(normal['关卡id']) || null,
    type: cleanShort(normal['关卡类型']) || null,
    subtype: cleanShort(normal['子类型']) || null,
    difficulty: cleanShort(normal['关卡难度']) || null,
    region: cleanShort(normal['所属区域']) || null,
    unlock: cleanText(normal['解锁条件'], 200) || null,
    recommendedLevel: cleanShort(normal['推荐等级']) || null,
    squadLimit: toNumber(normal['部署上限']),
    initialCost: toNumber(normal['初始COST']),
    costLimit: toNumber(normal['COST上限']),
    lifePoints: toNumber(normal['目标点耐久']),
    enemyCount: toNumber(normal['敌人数量']),
    mapSize: cleanShort(normal['地图大小']) || null,
    fastestClear: cleanShort(normal['最短用时']) || null,
    description,
    sanityCost: toNumber(normal['作战消耗']),
    drillCost: toNumber(normal['演习消耗']),
    firstClearDrops: parseDrops(normal['首次掉落']),
    normalDrops: parseDrops(normal['常规掉落']),
    extraMateriel: splitList(normal['额外物资']),
    reward: cleanShort(normal['报酬']) || null,
    terrain: cleanText(normal['特殊地形效果'], 300) || null,
    note: cleanText(normal['情报'], 300) || null,
    challenge: null,
    enemies: parseEnemies(extractTemplateParams(content, ['敌方情报'])),
    page: title,
    url: wikiUrl(title)
  }

  if (challenge) {
    const condition = cleanText(challenge['情报'], 400)
      || cleanText(String(challenge['关卡描述'] ?? '').replace(/^[^{]*\{\{color[^|]*\|[^|]*\|[^}]*\}\}/, ''), 400)
      || null
    entry.challenge = {
      difficulty: cleanShort(challenge['关卡难度']) || null,
      unlock: cleanText(challenge['解锁条件'], 200) || null,
      condition: condition || null,
      sanityCost: toNumber(challenge['作战消耗']),
      drillCost: toNumber(challenge['演习消耗']),
      firstClearDrops: parseDrops(challenge['首次掉落'])
    }
  }

  return entry
}

function stageTitleMatches (title, query) {
  const normalizedTitle = normalize(title)
  const normalizedQuery = normalize(query)
  return normalizedTitle === normalizedQuery || normalizedTitle.startsWith(normalizedQuery + ' ')
}

async function lookupStage (query, options = {}) {
  const direct = await pageContent(query, { signal: options.signal })
  if (!direct.missing) {
    const entry = parseStagePage(direct.title, direct.content)
    if (entry) {
      await attachStageStories(entry, options)
      const matchedBy = normalize(direct.title) === normalize(query) ? 'exact' : 'redirect'
      const result = ok('stage', query, entry, matchedBy)
      if (matchedBy === 'redirect') result.message = `「${query}」是一个重定向页面，实际关卡为「${direct.title}」。`
      return result
    }
  }

  const titles = await searchTitles(query, { signal: options.signal, limit: 6 })
  const ordered = unique([
    ...titles.filter(title => stageTitleMatches(title, query)),
    ...titles
  ]).slice(0, 3)

  for (const title of ordered) {
    const page = await pageContent(title, { signal: options.signal })
    if (page.missing) continue
    const entry = parseStagePage(page.title, page.content)
    if (!entry) continue
    await attachStageStories(entry, options)
    const result = ok('stage', query, entry, 'search')
    result.message = `PRTS 中「${query}」没有直接对应的关卡页，已按搜索命中「${page.title}」。`
    return result
  }

  const result = envelope('stage', query)
  result.candidates = titles.slice(0, MAX_CANDIDATES).map(title => ({
    category: 'stage',
    name: title,
    detail: 'PRTS 搜索命中'
  }))
  result.message = `没有找到代号或名称匹配「${query}」的关卡页。`
  return result
}

// ---------------------------------------------------------------------------
// Stories (剧情)
//
// PRTS has no Cargo table for stories. `Template:剧情导航` (~145 KB) is the whole
// index: one wiki-table row per chapter, holding `主线`/`活动` and links shaped
// like `[[0-1 坍塌/BEG|0-1 坍塌 行动前]]`. Each story page then carries the
// performance script in `{{剧情模拟器|…|文本数据=[name="杜宾"]  可恶……}}`,
// so dialogue can be read straight from the wikitext.
// ---------------------------------------------------------------------------

const STORY_NAV_TITLE = 'Template:剧情导航'
const STORY_INDEX_TTL_MS = 10 * 60 * 1000
const MEMORY_TTL_MS = 10 * 60 * 1000
const STORY_LINE_LIMIT = 60
const MEMORY_ROW_LIMIT = 500
const STORY_KIND_LABEL = { 主线: '主线剧情', 支线: '活动剧情', 活动: '活动剧情', 剧情: '特殊剧情' }
/** A query that names a story is tried against the story index before stages. */
const STORY_HINT = /(行动前|行动后|密录|剧情|序曲|出场|戏份|登场|\/(?:BEG|END)\b)/i

let storyIndexCache = null
let memoryIndexCache = null

function storyRecord (label, page, chapter, kind) {
  return {
    label: cleanShort(label) || page,
    page,
    chapter: chapter ? cleanShort(chapter) : null,
    kind: kind ? (STORY_KIND_LABEL[kind] ?? cleanShort(kind)) : null
  }
}

/** One wiki-table cell: drop the `!`/`|` marker and any `width="…"|` attributes. */
function tableCellValue (line) {
  const body = line.slice(1).trim()
  if (!body) return ''
  const separator = body.indexOf('|')
  if (separator > 0) {
    const head = body.slice(0, separator)
    if (head.includes('=') || head.includes('"')) return body.slice(separator + 1).trim()
  }
  return body
}

/** Turn `Template:剧情导航` wikitext into `{label, page, chapter, kind}` records. */
export function parseStoryNav (content) {
  const records = []
  const seen = new Set()
  for (const block of String(content ?? '').split('\n|-')) {
    let chapter = null
    let kind = null
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      if (line.startsWith('!')) {
        const value = tableCellValue(line)
        if (!value) continue
        if (chapter === null) chapter = value
        else if (kind === null) kind = value
        continue
      }
      if (!line.startsWith('|')) continue
      if (chapter === null || kind === null) continue
      const cell = tableCellValue(line)
      for (const match of cell.matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
        const page = match[1].trim()
        if (!page || seen.has(page)) continue
        if (/^(?:文件|分类|Template):/.test(page) || page === '剧情一览') continue
        seen.add(page)
        records.push(storyRecord(match[2] ?? page, page, chapter, kind))
      }
    }
  }
  return records
}

/** Split `文本数据` into dialogue/narration rows, dropping stage directions. */
// Story scripts embed `{@nickname}` (the player/doctor) and occasional other
// `{@…}` placeholders; show the doctor's default name instead of raw markup.
const STORY_PLAYER_NAME = /\{@nickname\}/g
const STORY_PLACEHOLDER = /\{@[A-Za-z_]+\}/g
function normalizeStoryText (raw) {
  return String(raw ?? '')
    .replace(/Dr\.\s*\{@nickname\}/g, '博士')
    .replace(STORY_PLAYER_NAME, '博士')
    .replace(STORY_PLACEHOLDER, '')
}

export function parseStoryScript (script) {
  const lines = []
  const characters = []
  for (const raw of String(script ?? '').split(/\r?\n/)) {
    const line = normalizeStoryText(raw).trim()
    if (!line || line.startsWith('<!--')) continue
    const speaker = /^\[name="([^"]*)"\]\s*(.*)$/.exec(line)
    if (speaker) {
      const text = cleanText(speaker[2], 300)
      if (!text) continue
      const name = cleanShort(speaker[1]) || null
      if (name && !characters.includes(name)) characters.push(name)
      lines.push({ speaker: name, text })
      continue
    }
    // `[Dialog]`, `[Background(…)]`, `[PlayMusic(…)]` and friends are directions.
    const direction = /^\[[a-zA-Z]+[^\]]*\]\s*(.*)$/.exec(line)
    if (direction) {
      const text = cleanText(direction[1], 300)
      if (text) lines.push({ speaker: null, text })
      continue
    }
    const text = cleanText(line, 300)
    if (text && !PLACEHOLDER_TEXT.test(text)) lines.push({ speaker: null, text })
  }
  return { lines, characters }
}

export function parseStoryPage (title, content) {
  const [block] = extractTemplates(content, /^剧情模拟器$/, { limit: 1, before: 0 })
  if (!block) return null
  const { lines, characters } = parseStoryScript(block.params['文本数据'])
  if (lines.length === 0) return null
  return {
    category: 'story',
    title: cleanShort(title) || null,
    storyType: cleanShort(block.params['剧情类型']) || null,
    storyGroup: cleanShort(block.params['剧情分组']) || null,
    textPath: cleanShort(block.params['文本路径']) || null,
    characters,
    lineCount: lines.length,
    truncated: lines.length > STORY_LINE_LIMIT,
    lines: lines.slice(0, STORY_LINE_LIMIT),
    page: title,
    url: wikiUrl(title)
  }
}

async function loadStoryIndex (options = {}) {
  if (storyIndexCache && Date.now() - storyIndexCache.at < STORY_INDEX_TTL_MS) return storyIndexCache
  const page = await pageContent(STORY_NAV_TITLE, {
    signal: options.signal, timeoutMs: 12000, retries: 0
  })
  storyIndexCache = { at: Date.now(), entries: page.missing ? [] : parseStoryNav(page.content) }
  return storyIndexCache
}

/** 干员密录 index, straight from `char_memory` (its `storyTxt` is the page title). */
async function loadMemoryIndex (options = {}) {
  if (memoryIndexCache && Date.now() - memoryIndexCache.at < MEMORY_TTL_MS) return memoryIndexCache
  const rows = await cargoQuery({
    tables: 'char_memory',
    fields: '_pageName=pageName,storySetName,storyIndex,storyTxt',
    orderBy: 'storySetName,storyIndex',
    limit: MEMORY_ROW_LIMIT
  }, options).catch(() => [])
  const entries = []
  for (const row of rows) {
    const page = cleanShort(row.storyTxt)
    if (!page) continue
    const operator = cleanShort(row.pageName)
    const set = cleanShort(row.storySetName)
    const index = cleanShort(row.storyIndex)
    entries.push(storyRecord(
      `${operator} 干员密录·${set}${index ? `（第${index}话）` : ''}`,
      page,
      '干员密录',
      '干员密录'
    ))
  }
  memoryIndexCache = { at: Date.now(), entries }
  return memoryIndexCache
}

async function loadStoryRecords (options = {}) {
  const [nav, memory] = await Promise.all([
    loadStoryIndex(options).catch(() => ({ entries: [] })),
    loadMemoryIndex(options)
  ])
  const seen = new Set()
  const records = []
  for (const record of [...nav.entries, ...memory.entries]) {
    if (seen.has(record.page)) continue
    seen.add(record.page)
    records.push(record)
  }
  return records
}

function storyCandidate (record) {
  return {
    category: 'story',
    name: record.label,
    detail: [record.kind, record.chapter].filter(Boolean).join(' · ')
  }
}

async function lookupStory (query, options = {}) {
  // 「X 出场」asks for an operator's appearance list, not for one story script.
  if (APPEARANCE_HINT.test(query)) {
    const appearance = await lookupAppearance(query, options).catch(() => null)
    if (appearance) return appearance
  }

  const records = await loadStoryRecords(options)
  if (records.length === 0) {
    const result = envelope('story', query)
    result.message = '未能读取 PRTS 剧情索引（Template:剧情导航 与 char_memory），暂时无法查询剧情。'
    return result
  }

  const ranked = rankMatches(records, query, record => unique([record.label, record.page]).map(normalize))
  const best = ranked[0]
  if (best && best.score <= 2) {
    const page = await pageContent(best.record.page, {
      signal: options.signal, timeoutMs: 12000, retries: 0
    })
    if (!page.missing) {
      const entry = parseStoryPage(page.title, page.content)
      if (entry) {
        entry.title = best.record.label || page.title
        entry.chapter = best.record.chapter
        entry.kind = best.record.kind
        if (best.record.kind === '干员密录') entry.operator = best.record.label.split(' ')[0]
        const result = ok('story', query, entry, MATCH_LABEL[best.score])
        if (best.score > 0) result.message = `没有完全同名的剧情，已按相近标题匹配「${entry.title}」。`
        return result
      }
    }
  }

  // Operator name without the 「出场」suffix: answer with the appearance list.
  const appearance = await lookupAppearance(query, options).catch(() => null)
  if (appearance) return appearance

  const result = envelope('story', query)
  const chapterKey = normalize(query)
  const chapterHits = records
    .filter(record => record.chapter && normalize(record.chapter).includes(chapterKey))
    .slice(0, MAX_CANDIDATES)
  if (chapterHits.length > 0) {
    result.candidates = chapterHits.map(storyCandidate)
    result.message = `没有标题为「${query}」的剧情，但它匹配章节「${chapterHits[0].chapter}」（共 ${chapterHits.length} 条候选）；可换用 candidates 中的标题重查。`
    return result
  }

  const loose = ranked.filter(item => item.score > 2).slice(0, MAX_CANDIDATES)
  if (loose.length > 0) {
    result.candidates = loose.map(item => storyCandidate(item.record))
    result.message = `没有与「${query}」同名的剧情，但存在相近条目，见 candidates。`
    return result
  }

  result.message = `PRTS 剧情索引中没有匹配「${query}」的剧情。剧情标题形如「0-1 坍塌 行动前」「序章·上」，干员密录形如「12F 干员密录」。`
  return result
}

/**
 * Cross-link a stage to its 行动前/行动后 story pages, so a stage answer can
 * point the model at the story text without a second guess.
 */
async function attachStageStories (entry, options = {}) {
  if (!entry.code || !entry.name) return
  const index = await loadStoryIndex(options).catch(() => null)
  if (!index) return
  const prefix = normalize(`${entry.code} ${entry.name} `)
  const before = []
  const after = []
  for (const record of index.entries) {
    const key = normalize(record.label)
    if (!key.startsWith(prefix)) continue
    const link = { title: record.label, page: record.page, url: wikiUrl(record.page) }
    if (key.includes('行动前')) before.push(link)
    else if (key.includes('行动后')) after.push(link)
  }
  if (before.length === 0 && after.length === 0) return
  entry.story = {
    before: before[0] ?? null,
    after: after[0] ?? null,
    ...(before.length + after.length > 2 ? { extra: [...before.slice(1), ...after.slice(1)] } : {})
  }
}

// ---------------------------------------------------------------------------
// Operator appearances (干员剧情一览)
// ---------------------------------------------------------------------------

const APPEARANCE_TTL_MS = 10 * 60 * 1000
const APPEARANCE_LIMIT = 48
const APPEARANCE_PAGES = [
  { page: '干员剧情一览/一二星干员', rarity: 2 },
  { page: '干员剧情一览/三星干员', rarity: 3 },
  { page: '干员剧情一览/四星干员', rarity: 4 },
  { page: '干员剧情一览/五星干员', rarity: 5 },
  { page: '干员剧情一览/六星干员', rarity: 6 }
]
const APPEARANCE_COLUMNS = ['main', 'event', 'memory']
const APPEARANCE_COLUMN_LABEL = { main: '主线剧情', event: '活动剧情', memory: '干员密录' }
const APPEARANCE_HINT = /(出场|戏份|登场)/u
const ACTIVITY_DATE_QUERY = '[[活动开始时间::+]]|?名称缩短|?活动开始时间#ISO|limit=600'
const ACTIVITY_DATE_TTL_MS = 30 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
/** Early main-story chapters carry no SMW date; 30 days per chapter keeps their order stable. */
const MAIN_STORY_FALLBACK_MS = 1556575200000 // 2019-04-30 (游戏公测)
const DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
})
/** Cell attribute prefix such as `style="…"` or `colspan="3"`, as opposed to content. */
const CELL_ATTRIBUTE = /^(?:class|style|width|colspan|rowspan|align|valign|id|scope|data-[a-z-]+)\s*=/

let appearanceIndexCache = null
let activityDateCache = null

function formatTimestamp (milliseconds) {
  const date = new Date(milliseconds)
  if (Number.isNaN(date.getTime())) return null
  try {
    return DATE_FORMATTER.format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

/** Drop the leading `|`/`!` and any attribute prefix of one wiki-table cell. */
function stripCellAttributes (line) {
  const body = line.slice(1).trim()
  const separator = body.indexOf('|')
  if (separator < 0) return body
  return CELL_ATTRIBUTE.test(body.slice(0, separator).trim())
    ? body.slice(separator + 1).trim()
    : body
}

function operatorFromCell (cell) {
  const avatar = /\{\{干员头像\/情报\|([^|}]+)/.exec(cell)
  if (avatar) return cleanShort(avatar[1])
  const link = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(cell)
  if (link) return cleanShort(link[2] ?? link[1])
  return cleanShort(cell.replace(/\{\{[^{}]*\}\}/g, ''))
}

function parseAppearanceCell (cell) {
  const items = []
  for (const match of String(cell ?? '').matchAll(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g)) {
    const page = cleanShort(match[1])
    if (!page || /^(?:文件|分类|Template):/i.test(page)) continue
    const title = cleanShort((match[2] ?? match[1]).replace(/\{\{[^{}]*\}\}/g, ''))
    if (!title || title === '无' || PLACEHOLDER_TEXT.test(title)) continue
    items.push({ title, page })
  }
  return items
}

/** One `干员剧情一览` page: profession sections, one row per operator. */
export function parseAppearanceTable (content, meta = {}) {
  const rows = []
  let profession = null
  let inTable = false
  let cells = null
  const flush = () => {
    if (!cells || cells.length < 4) {
      cells = null
      return
    }
    const name = operatorFromCell(cells[0])
    if (!name) {
      cells = null
      return
    }
    const columns = {}
    APPEARANCE_COLUMNS.forEach((key, index) => {
      const raw = index === APPEARANCE_COLUMNS.length - 1
        ? cells.slice(index + 1).join(' ')
        : (cells[index + 1] ?? '')
      columns[key] = parseAppearanceCell(raw)
    })
    rows.push({
      name,
      rarity: meta.rarity ?? null,
      profession,
      page: meta.page ?? null,
      columns
    })
    cells = null
  }
  for (const rawLine of String(content ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (!inTable) {
      const heading = /^={2,4}\s*(.+?)\s*={2,4}$/.exec(line)
      if (heading) profession = cleanShort(heading[1])
      if (line.startsWith('{|')) {
        inTable = true
        cells = null
      }
      continue
    }
    if (line.startsWith('|}')) {
      flush()
      inTable = false
      continue
    }
    if (line.startsWith('|-')) {
      flush()
      continue
    }
    if (line.startsWith('!')) continue
    if (!line.startsWith('|')) continue
    if (!cells) cells = []
    cells.push(stripCellAttributes(line))
  }
  flush()
  return rows
}

async function loadAppearanceIndex (options = {}) {
  if (appearanceIndexCache && Date.now() - appearanceIndexCache.at < APPEARANCE_TTL_MS) return appearanceIndexCache
  const pages = await Promise.all(APPEARANCE_PAGES.map(meta =>
    pageContent(meta.page, { signal: options.signal, timeoutMs: 15000, retries: 0 })
      .catch(() => ({ missing: true, content: '' }))
  ))
  const records = []
  pages.forEach((page, index) => {
    if (page.missing) return
    records.push(...parseAppearanceTable(page.content, APPEARANCE_PAGES[index]))
  })
  if (records.length > 0) appearanceIndexCache = { at: Date.now(), records }
  return appearanceIndexCache ?? { at: Date.now(), records }
}

/** Raw appearance rows (one per operator) for the story-signal index. */
export async function loadAppearanceRecords (options = {}) {
  const index = await loadAppearanceIndex(options)
  return index.records ?? []
}

/**
 * Story page → date/group map, built from the plot navigation plus SMW
 * activity dates. Pages without a reliable date keep `ts: null` so callers can
 * fall back to "unknown recency" instead of inventing one.
 */
export async function loadStoryTiming (options = {}) {
  const [records, dates] = await Promise.all([
    loadStoryRecords(options).catch(() => []),
    loadActivityDates(options).catch(() => new Map())
  ])
  const byPage = new Map()
  for (const item of records) {
    if (item?.page && !byPage.has(item.page)) byPage.set(item.page, item)
  }
  const chapterDates = mainChapterDates(records, dates)
  const timing = new Map()
  for (const [page, meta] of byPage) {
    const memory = meta.kind === '干员密录'
    const hit = memory
      ? null
      : (chapterDates.get(normalize(meta.chapter)) ?? dates.get(normalize(meta.chapter)) ?? null)
    timing.set(page, {
      ts: hit?.ts ?? null,
      date: hit && !hit.estimated ? hit.date : null,
      group: meta.chapter ?? null,
      kind: meta.kind ?? null
    })
  }
  return timing
}

/** SMW release dates: activities and recent main-story chapters carry `活动开始时间`. */
async function loadActivityDates (options = {}) {
  if (activityDateCache && Date.now() - activityDateCache.at < ACTIVITY_DATE_TTL_MS) return activityDateCache.map
  const payload = await apiGet({ action: 'ask', query: ACTIVITY_DATE_QUERY }, {
    signal: options.signal, timeoutMs: 15000, retries: 0
  })
  const map = new Map()
  for (const [title, value] of Object.entries(payload?.query?.results ?? {})) {
    const printouts = value?.printouts ?? {}
    const seconds = Number(printouts['活动开始时间']?.[0]?.timestamp)
    if (!Number.isFinite(seconds) || seconds <= 0) continue
    const milliseconds = seconds * 1000
    const short = cleanShort(printouts['名称缩短']?.[0] ?? '')
    const entry = {
      name: cleanShort(title) || String(title),
      short: short || null,
      date: formatTimestamp(milliseconds),
      ts: milliseconds
    }
    for (const key of unique([title, short])) {
      const normalized = normalize(key)
      if (normalized && !map.has(normalized)) map.set(normalized, entry)
    }
  }
  if (map.size > 0) activityDateCache = { at: Date.now(), map }
  return map
}

function findDateAnchor (order, known, from, step) {
  for (let index = from + step; index >= 0 && index < order.length; index += step) {
    const hit = known.get(order[index])
    if (hit) return { index, ts: hit.ts }
  }
  return null
}

/**
 * Release date per main-story chapter. Undated chapters are interpolated between
 * dated neighbours (and extrapolated by 30 days) so ordering stays correct; only
 * dates flagged `estimated: false` are shown to the user.
 */
function mainChapterDates (records, dates) {
  const order = []
  for (const record of records) {
    if (record.kind !== '主线剧情' || !record.chapter) continue
    const key = normalize(record.chapter)
    if (!order.includes(key)) order.push(key)
  }
  const known = new Map()
  for (const key of order) {
    const hit = dates.get(key)
    if (hit) known.set(key, hit)
  }
  const result = new Map()
  order.forEach((key, index) => {
    if (known.has(key)) {
      result.set(key, { ...known.get(key), estimated: false })
      return
    }
    const before = findDateAnchor(order, known, index, -1)
    const after = findDateAnchor(order, known, index, 1)
    let ts
    if (before && after) ts = before.ts + (after.ts - before.ts) * ((index - before.index) / (after.index - before.index))
    else if (before) ts = before.ts + (index - before.index) * 30 * DAY_MS
    else if (after) ts = after.ts - (after.index - index) * 30 * DAY_MS
    else ts = MAIN_STORY_FALLBACK_MS + index * 30 * DAY_MS
    result.set(key, { name: key, date: formatTimestamp(ts), ts, estimated: true })
  })
  return result
}

function appearanceOperatorName (query) {
  return String(query ?? '')
    .replace(/[?？。!！]+$/g, '')
    .replace(/\s*(?:的|在)?\s*(?:出场|戏份|登场)(?:剧情|记录|列表)?\s*$/u, '')
    .replace(/^干员\s*/u, '')
    .trim()
}

/**
 * All story appearances of one operator, oldest first. Returns null when the
 * operator is not in the appearance index, so callers can fall back.
 */
async function lookupAppearance (query, options = {}) {
  const index = await loadAppearanceIndex(options)
  if (index.records.length === 0) return null
  const name = appearanceOperatorName(query)
  const ranked = rankMatches(index.records, name, record => [normalize(record.name)])
  const best = ranked[0]
  if (!best || best.score > 2) return null
  const record = best.record

  const [records, dates] = await Promise.all([
    loadStoryRecords(options).catch(() => []),
    loadActivityDates(options).catch(() => new Map())
  ])
  const byPage = new Map()
  const navOrder = new Map()
  records.forEach((item, index) => {
    if (!byPage.has(item.page)) byPage.set(item.page, item)
    if (item.kind !== '干员密录' && !navOrder.has(item.page)) navOrder.set(item.page, index)
  })
  const chapterDates = mainChapterDates(records, dates)

  const items = []
  const seen = new Set()
  for (const column of APPEARANCE_COLUMNS) {
    for (const link of record.columns[column]) {
      if (seen.has(link.page)) continue
      seen.add(link.page)
      const meta = byPage.get(link.page)
      const chapter = meta?.chapter ?? null
      const memory = column === 'memory' || meta?.kind === '干员密录'
      const timing = chapter && !memory
        ? (chapterDates.get(normalize(chapter)) ?? dates.get(normalize(chapter)) ?? null)
        : null
      items.push({
        title: link.title,
        page: link.page,
        url: wikiUrl(link.page),
        column,
        group: chapter ?? (memory ? '干员密录' : APPEARANCE_COLUMN_LABEL[column]),
        kind: meta?.kind ?? (memory ? '干员密录' : null),
        date: timing && !timing.estimated ? timing.date : null,
        sortAt: timing?.ts ?? null,
        navIndex: navOrder.get(link.page) ?? null
      })
    }
  }
  if (items.length === 0) return null

  const byNav = (left, right) => {
    const a = left.navIndex ?? Infinity
    const b = right.navIndex ?? Infinity
    return a === b ? 0 : (a < b ? -1 : 1)
  }
  items.sort((left, right) => {
    if (left.sortAt === null && right.sortAt === null) {
      return byNav(left, right) || left.title.localeCompare(right.title, 'zh')
    }
    if (left.sortAt === null) return 1
    if (right.sortAt === null) return -1
    return left.sortAt - right.sortAt || byNav(left, right) || left.title.localeCompare(right.title, 'zh')
  })

  const dated = items.find(item => item.sortAt !== null) ?? null
  const counts = {}
  for (const column of APPEARANCE_COLUMNS) counts[column] = record.columns[column].length
  const entry = {
    category: 'story',
    kind: '干员出场',
    operator: record.name,
    profession: record.profession,
    rarity: record.rarity,
    total: items.length,
    counts,
    earliest: dated
      ? { title: dated.title, page: dated.page, group: dated.group, kind: dated.kind, date: dated.date }
      : null,
    appearances: items.slice(0, APPEARANCE_LIMIT).map(({ navIndex, ...rest }) => rest),
    truncated: items.length > APPEARANCE_LIMIT,
    source: record.page,
    page: record.page,
    url: wikiUrl(record.page)
  }
  const result = ok('story', query, entry, MATCH_LABEL[best.score])
  if (best.score > 0) result.message = `没有完全同名的干员，已按相近名称匹配「${record.name}」。`
  return result
}

// ---------------------------------------------------------------------------
// 泰拉大典 (Terrapedia): worldview, lore and terminology
// ---------------------------------------------------------------------------

const WORLD_TTL_MS = 10 * 60 * 1000
const WORLD_NAMESPACE = 3000
const WORLD_SECTION_LABEL = {
  角色: '人物考据',
  地理: '地理',
  组织: '组织',
  百科: '百科事典',
  剧情: '剧情分析',
  关卡: '关卡考据',
  生物: '生态调查',
  道具: '商品目录',
  家具: '家居手册',
  成就: '荣誉记录',
  集成战略: '集成战略',
  用户界面: '界面设计',
  编辑指南: '编辑指南',
  条目格式: '条目格式',
  泰拉人名录: '泰拉人名录',
  附表: '附表'
}
/** Main-namespace Terrapedia companions (timeline, glossary, script). */
const WORLD_EXTRA_PAGES = [
  { title: '泰拉年表', section: '附表', blurb: 'PRTS 泰拉大典的编年史附表，按时代与年份罗列泰拉大陆的大事记（结晶纪元至 12 世纪）。' },
  { title: '泰拉词库', section: '附表', blurb: 'PRTS 泰拉大典的译名对照附表，给出泰拉专有名词的中文、英文、日文等写法。' },
  { title: '泰拉文字', section: '附表', blurb: '泰拉文字的字形与拉丁字母对照表。' }
]
const WORLD_TEXT_LIMIT = 900
const WORLD_SECTION_LIMIT = 14
const WORLD_LINK_LIMIT = 8
const WORLD_HINT = /(泰拉大典|世界观|考据|泰拉年表|泰拉词库|年表|词库)/u
/** List pages: their body is a set of `{{…考据}}` / `{{百科词条}}` blocks, not prose. */
const WORLD_BLOCK_SPECS = [
  { pattern: /^角色考据$/, field: '姓名', section: '角色', text: '角色经历' },
  { pattern: /^地理考据$/, field: null, section: '地理', text: '简介' },
  { pattern: /^组织考据$/, field: null, section: '组织', text: '简介' },
  { pattern: /^种族考据$/, field: '种族', section: '生物', text: '情报' },
  { pattern: /^百科词条$/, field: null, section: '百科', text: '情报' }
]

let worldTitleCache = null
let worldPageCache = new Map()
let worldGlossaryCache = null

function worldSectionLabel (section) {
  return WORLD_SECTION_LABEL[section] ?? section
}

function parseWorldTitle (title) {
  const match = /^泰拉大典:([^/]+)(?:\/(.+))?$/.exec(String(title ?? '').trim())
  if (!match) return null
  return { section: match[1], name: (match[2] ?? match[1]).trim(), title: String(title).trim() }
}

/** Page titles available for direct matching (namespace 3000 + the main-namespace extras). */
async function loadWorldTitles (options = {}) {
  if (worldTitleCache && Date.now() - worldTitleCache.at < WORLD_TTL_MS) return worldTitleCache
  const payload = await apiGet({
    action: 'query',
    list: 'allpages',
    apnamespace: String(WORLD_NAMESPACE),
    aplimit: '500'
  }, { signal: options.signal, timeoutMs: 12000, retries: 0 })
  const records = []
  for (const page of payload?.query?.allpages ?? []) {
    const parsed = parseWorldTitle(page.title)
    if (!parsed) continue
    records.push({
      ...parsed,
      keys: unique([parsed.name, `${parsed.section}/${parsed.name}`, parsed.title]).map(normalize)
    })
  }
  for (const extra of WORLD_EXTRA_PAGES) {
    records.push({
      section: extra.section,
      name: extra.title,
      title: extra.title,
      blurb: extra.blurb,
      keys: [normalize(extra.title)]
    })
  }
  if (records.length > 0) worldTitleCache = { at: Date.now(), records }
  return worldTitleCache ?? { at: Date.now(), records }
}

function stripWorldBoilerplate (content) {
  return String(content ?? '')
    .replace(/\{\{考据头[^{}]*\}\}/g, '')
    .replace(/\{\{考据底[^{}]*\}\}/g, '')
    .replace(/\{\{编辑中[^{}]*\}\}/g, '')
    .replace(/\{\{NoReferer[^{}]*\}\}/g, '')
    .replace(/^\{\{(?:参阅|cbox2)\b[^{}]*\}\}[ \t]*$/gm, '')
    .replace(/\{\{DISPLAYTITLE:[^{}]*\}\}/g, '')
    .replace(/__NOTOC__|__TOC__/g, '')
}

const INFOBOX_SKIP_LABEL = /(?:图标|Logo|图片|标志|立绘|尺寸|colspan|rowspan)/i

function parseWorldInfobox (content) {
  const fields = {}
  let inTable = false
  let pending = null
  for (const rawLine of String(content ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('{|')) {
      inTable = true
      pending = null
      continue
    }
    if (!inTable) continue
    if (line.startsWith('|}')) break
    if (line.startsWith('|-') || line.startsWith('|+')) continue
    if (line.startsWith('!')) {
      const label = cleanText(stripCellAttributes(line), 40)
      pending = label && !label.includes('||') && !/\s/.test(label) && !INFOBOX_SKIP_LABEL.test(label) ? label : null
      continue
    }
    if (line.startsWith('|') && pending) {
      const value = cleanText(stripCellAttributes(line), 120)
      if (value && !/^\d+px$/.test(value) && Object.keys(fields).length < 8) fields[pending] = value
      pending = null
    }
  }
  return fields
}

function worldProse (content) {
  let stripped = String(content ?? '')
  for (let pass = 0; pass < 3; pass += 1) {
    const next = stripped.replace(/\{\|[\s\S]*?\|\}/g, '\n').replace(/^\{\|[^\n]*$/gm, '\n')
    if (next === stripped) break
    stripped = next
  }
  stripped = stripped
    .replace(/^={2,4}.*$/gm, '\n')
    .replace(/<[^>]+>/g, ' ')
  return cleanText(stripped, WORLD_TEXT_LIMIT)
}

function parseWorldLinks (content) {
  const links = []
  for (const match of String(content ?? '').matchAll(/\{\{泰拉大典\|([^|}]+)\|([^|}]+)\}\}/g)) {
    const section = cleanShort(match[1])
    const name = cleanShort(match[2])
    if (!section || !name) continue
    const page = `泰拉大典:${section}/${name}`
    if (links.some(link => link.page === page)) continue
    links.push({ section: worldSectionLabel(section), name, page, url: wikiUrl(page) })
    if (links.length >= WORLD_LINK_LIMIT) break
  }
  return links
}

const WORLD_DETAIL_KEYS = ['英文名', '日文名', '成员', '主要种族', '登场', '角色']

function parseWorldPage (record, content) {
  const clean = stripWorldBoilerplate(content)
  const details = {}
  const head = extractTemplates(clean, /^(?:组织考据|地理考据|角色考据|种族考据)$/, { limit: 1, before: 0 })[0]
  if (head) {
    for (const key of WORLD_DETAIL_KEYS) {
      const value = cleanShort(head.params[key] ?? '')
      if (value) details[key] = key === '登场' ? cleanText(value, 300) : value
    }
  }
  const isIndex = record.section === '附表' || record.section === '百科'
  const infobox = isIndex || record.section === '组织' ? {} : parseWorldInfobox(clean)
  const sections = [...clean.matchAll(/^(={2,4})\s*([^=\n]+?)\s*\1\s*$/gm)]
    .map(match => cleanShort(match[2]))
    .filter(Boolean)
    .slice(0, WORLD_SECTION_LIMIT)
  const name = cleanShort(record.name) || record.name
  let summary = record.blurb ?? worldProse(clean)
  const duplicated = `${name} ${name}`
  if (summary.startsWith(duplicated)) summary = summary.slice(duplicated.length - name.length).trim()
  return {
    category: 'world',
    section: worldSectionLabel(record.section),
    title: name,
    summary,
    infobox,
    ...(Object.keys(details).length > 0 ? { details } : {}),
    sections,
    related: parseWorldLinks(clean)
  }
}

/** Extract `{{…考据}}` / `{{百科词条}}` blocks from a Terrapedia list page. */
export function parseWorldBlocks (content) {
  const blocks = []
  for (const spec of WORLD_BLOCK_SPECS) {
    for (const hit of extractTemplates(content, spec.pattern, { limit: 400, before: 0 })) {
      const name = cleanShort(spec.field ? (hit.params[spec.field] ?? '') : (hit.positional[0] ?? ''))
      if (!name) continue
      const text = cleanText(hit.params[spec.text] ?? hit.params['情报'] ?? '', 500)
      if (!text) continue
      const extra = {}
      for (const key of ['英文名', '日文名', '登场', '成员', '角色', '基本信息']) {
        const value = cleanShort(hit.params[key] ?? '')
        if (value) extra[key] = key === '登场' ? cleanText(value, 300) : value
      }
      blocks.push({
        category: 'world',
        section: worldSectionLabel(spec.section),
        title: name,
        summary: text,
        ...(Object.keys(extra).length > 0 ? { details: extra } : {}),
        keys: [normalize(name)]
      })
    }
  }
  return blocks
}

async function buildWorldPageEntry (record, options = {}) {
  const cached = worldPageCache.get(record.title)
  if (cached && Date.now() - cached.at < WORLD_TTL_MS) return cached.entry
  const page = await pageContent(record.title, { signal: options.signal, timeoutMs: 12000, retries: 0 })
  if (page.missing) return null
  const entry = parseWorldPage(record, page.content)
  entry.page = page.title
  entry.url = wikiUrl(page.title)
  worldPageCache.set(record.title, { at: Date.now(), entry })
  return entry
}

/** `泰拉词库` glossary rows: 中文 / 英文 / 其他 / 日文 / 悠星英文. */
export function parseGlossaryRows (content) {
  const rows = []
  let section = null
  let inTable = false
  for (const rawLine of String(content ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!inTable) {
      const heading = /^==+\s*(.+?)\s*==+$/.exec(line)
      if (heading) section = cleanShort(heading[1])
      if (line.startsWith('{|')) inTable = true
      continue
    }
    if (line.startsWith('|}')) {
      inTable = false
      continue
    }
    if (!line.startsWith('|') || line.startsWith('|-') || line.startsWith('|+')) continue
    const cells = line.slice(1).split('||').map(cell => cleanShort(cell))
    if (cells.length < 2) continue
    const [zh, en, other, ja, yostar] = cells
    if (!zh || CELL_ATTRIBUTE.test(zh)) continue
    rows.push({
      zh,
      en: en || null,
      other: other && other !== '-' ? other : null,
      ja: ja && ja !== '-' ? cleanText(ja, 60) : null,
      yostar: yostar && yostar !== '-' ? yostar : null,
      section
    })
  }
  return rows
}

async function loadWorldGlossary (options = {}) {
  if (worldGlossaryCache && Date.now() - worldGlossaryCache.at < WORLD_TTL_MS) return worldGlossaryCache
  const page = await pageContent('泰拉词库', { signal: options.signal, timeoutMs: 12000, retries: 0 })
  const rows = page.missing ? [] : parseGlossaryRows(page.content)
  if (rows.length > 0) worldGlossaryCache = { at: Date.now(), rows }
  return worldGlossaryCache ?? { at: Date.now(), rows }
}

function worldCandidate (entry) {
  return {
    category: 'world',
    name: entry.title,
    detail: [entry.section, entry.kind ?? null].filter(Boolean).join(' · ')
  }
}

function glossaryMatches (rows, query) {
  const key = normalize(query)
  const hits = rows.filter(row => normalize(row.zh) === key)
  if (hits.length > 0) return hits
  return rows.filter(row => {
    const zh = normalize(row.zh)
    return zh.startsWith(key) || normalize(row.ja ?? '') === key
  })
}

async function lookupWorld (query, options = {}) {
  const text = String(query ?? '').trim()
  const titles = await loadWorldTitles(options).catch(() => ({ records: [] }))
  const rankedTitles = rankMatches(titles.records, text, record => record.keys)
  const bestTitle = rankedTitles[0]

  // A list page (百科/*, 角色/其他 …) is a directory: search its blocks instead.
  const isDirectory = bestTitle && bestTitle.score <= 2 && bestTitle.record.section === '百科'
  if (bestTitle && bestTitle.score <= 2 && !isDirectory) {
    const entry = await buildWorldPageEntry(bestTitle.record, options)
    if (entry) {
      const result = ok('world', text, entry, MATCH_LABEL[bestTitle.score])
      if (bestTitle.score > 0) result.message = `没有完全同名的泰拉大典条目，已按相近标题匹配「${entry.title}」。`
      return result
    }
  }

  // Full-text search inside the Terrapedia namespace catches directory entries.
  const hits = await searchTitles(text, {
    signal: options.signal, timeoutMs: 15000, retries: 0, what: 'text', namespace: WORLD_NAMESPACE, limit: 5
  }).catch(() => [])
  const pages = await Promise.all(hits.map(title =>
    pageContent(title, { signal: options.signal, timeoutMs: 12000, retries: 0 }).catch(() => null)
  ))
  const candidates = []
  let bestBlock = null
  for (const page of pages) {
    if (!page || page.missing) continue
    const blocks = parseWorldBlocks(page.content)
    const ranked = rankMatches(blocks, text, block => block.keys)
    const best = ranked[0]
    if (best && best.score <= 2 && (!bestBlock || best.score < bestBlock.score)) {
      bestBlock = { ...best, page }
    }
    const parsed = parseWorldTitle(page.title)
    candidates.push({ category: 'world', name: cleanShort(page.title), detail: parsed ? worldSectionLabel(parsed.section) : '泰拉大典' })
  }

  // Terminology: the glossary is a translation table rather than an article.
  const glossary = await loadWorldGlossary(options).catch(() => ({ rows: [] }))
  const terms = glossaryMatches(glossary.rows, text)

  // An exact encyclopedia entry beats a translation-only glossary hit, but an
  // exact glossary term beats a merely similar block name.
  const wantBlock = bestBlock && (bestBlock.score === 0 || terms.length === 0)
  if (wantBlock) {
    const entry = { ...bestBlock.record }
    delete entry.keys
    entry.page = bestBlock.page.title
    entry.url = wikiUrl(bestBlock.page.title)
    const result = ok('world', text, entry, MATCH_LABEL[bestBlock.score])
    if (bestBlock.score > 0) result.message = `没有完全同名的词条，已按相近名称匹配「${entry.title}」。`
    return result
  }
  if (terms.length > 0) {
    const entry = {
      category: 'world',
      kind: '术语对照',
      title: terms[0].zh,
      section: '泰拉词库',
      terms: terms.slice(0, 4).map(({ section, ...rest }) => ({ ...rest, group: section })),
      page: '泰拉词库',
      url: wikiUrl('泰拉词库'),
      summary: `泰拉词库中的「${terms[0].zh}」有 ${terms.length} 条译名记录。`
    }
    return ok('world', text, entry, MATCH_LABEL[0])
  }
  if (bestBlock) {
    const entry = { ...bestBlock.record }
    delete entry.keys
    entry.page = bestBlock.page.title
    entry.url = wikiUrl(bestBlock.page.title)
    const result = ok('world', text, entry, MATCH_LABEL[bestBlock.score])
    result.message = `没有完全同名的词条，已按相近名称匹配「${entry.title}」。`
    return result
  }

  const result = envelope('world', text)
  if (candidates.length > 0) {
    result.candidates = candidates.slice(0, MAX_CANDIDATES)
    result.message = `泰拉大典中没有标题为「${text}」的条目，但有以下相关页面，见 candidates。`
  } else {
    result.message = `泰拉大典（及泰拉年表、泰拉词库）中没有匹配「${text}」的内容。可换用更短的世界观词条（如「源石」「维多利亚」「整合运动」）。`
  }
  return result
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

const LOOKUPS = {
  operator: lookupOperator,
  item: lookupItem,
  stage: lookupStage,
  story: lookupStory,
  world: lookupWorld
}

/** Materialize a deferred near-match item hit after exact lookups failed. */
export async function resolveItemNear (query, near, options = {}) {
  const entry = await buildItemEntry(near.row, options.signal)
  const result = ok('item', query, entry, MATCH_LABEL[near.score] ?? 'fuzzy')
  result.message = `没有完全同名的条目，已按相近物品名称匹配「${entry.name}」；若并非目标条目，请改用 candidates 中的名称重查。`
  return result
}

/**
 * Resolve one query to a single canonical record.
 *
 * @param {string} query
 * @param {'operator'|'item'|'stage'|'story'|'world'|undefined} category
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function resolveLookup (query, category, options = {}) {
  const text = String(query ?? '').trim()
  if (!text) {
    const result = envelope(category, text)
    result.message = '查询词为空：请提供干员名、物品名、关卡代号或剧情标题。'
    return result
  }

  const order = category
    ? [category]
    : WORLD_HINT.test(text)
      ? ['world', 'story', 'stage', 'item', 'operator']
      : STORY_HINT.test(text)
        ? ['story', 'stage', 'item', 'operator', 'world']
        : STAGE_CODE_PATTERN.test(text)
          ? ['stage', 'item', 'operator', 'story', 'world']
          : ['item', 'operator', 'stage', 'story', 'world']

  const misses = []
  let pendingItem = null
  for (const kind of order) {
    const result = await LOOKUPS[kind](text, kind === 'item' ? { ...options, exactOnly: true } : options)
    if (result.status === 'ok') return result
    if (result._near) {
      pendingItem = result._near
      delete result._near
    }
    misses.push(result)
  }

  if (pendingItem) return resolveItemNear(text, pendingItem, options)

  const withCandidates = misses.find(result => result.candidates.length > 0)
  const combined = envelope(category, text)
  combined.candidates = withCandidates?.candidates ?? []
  if (combined.candidates.length > 0) {
    combined.message = `没有与「${text}」同名或近名的${category ? category : '干员/物品/关卡/剧情'}，但存在相近条目，见 candidates；可换用 candidates 中的名称重查。`
  } else {
    combined.message = `PRTS 的干员库、物品库、关卡页、剧情索引与泰拉大典中都没有匹配「${text}」的条目。请确认名称是否为简体中文正式译名，或换用更短的词条（如只写代号「1-7」）。`
  }
  return combined
}

export { PrtsError }
