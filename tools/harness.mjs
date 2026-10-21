/**
 * Local contract harness: runs the plugin's tool definitions outside DSH, using
 * the host's own dsh-tools build (so the schema compiler and validators are the
 * exact ones DSH uses at runtime).
 *
 * Note: defineTool() already compiles both schemas at definition time, so
 * `tool.parameters` and `tool.output.schema` are raw JSON Schema here.
 *
 * Usage: node tools/harness.mjs [offline|live]
 */

import * as T from '@deepseek-ai/dsh-tools'
import { writeFileSync } from 'node:fs'
import { arkWikiLookup, arkBannerPredict, name, inject, apply } from '../lib/index.js'
import { loadStoryCast, predictDebut, loadOperatorAliases } from '../lib/debut.js'
import { collabHits, isCollabEvent, loadCollabEvents } from '../lib/collab-events.js'
import {
  collectRegionDossiers,
  extractArchiveClues,
  extractRecordClues,
  formatDossierNotes,
  parseRecordLines,
  resetDossierCache,
  selectRegionOperators
} from '../lib/operator-dossiers.js'
import {
  buildBannerIndex,
  kernelMoved,
  parseBannerDate,
  parseBannerHint,
  parseBannerTables,
  predictBanners
} from '../lib/banners.js'

const mode = process.argv[2] ?? 'live'

const report = { mode, exports: { name, inject }, checks: [], contract: [], results: [] }
const check = (label, ok, detail) => report.checks.push({ label, ok, ...(detail === undefined ? {} : { detail }) })

check('tool name is ark_wiki_lookup', arkWikiLookup.name === 'ark_wiki_lookup', arkWikiLookup.name)
check('tool name is ark_banner_predict', arkBannerPredict.name === 'ark_banner_predict', arkBannerPredict.name)
check('inject contains tools', Array.isArray(inject) && inject.includes('tools'), inject)
check('lookup parameters is compiled JSON Schema', arkWikiLookup.parameters?.type === 'object')
check('lookup output.schema is compiled JSON Schema', arkWikiLookup.output.schema?.type === 'object')
check('banner parameters is compiled JSON Schema', arkBannerPredict.parameters?.type === 'object')
check('banner output.schema is compiled JSON Schema', arkBannerPredict.output.schema?.type === 'object')

// --- Lifecycle: the Cordis loader calls apply(ctx); it must register through
// ctx.tools inside ctx.effect so the registration is disposable.
const registrations = []
const disposeLog = []
const effects = []
const fakeCtx = {
  tools: {
    register (definition) {
      registrations.push(definition)
      return () => { disposeLog.push('tools.unregister') }
    }
  },
  effect (callback, label) {
    const dispose = callback()
    effects.push({ label, dispose })
    return () => {
      disposeLog.push(label ?? 'effect')
      if (typeof dispose === 'function') dispose()
      else if (dispose && typeof dispose[Symbol.dispose] === 'function') dispose[Symbol.dispose]()
    }
  }
}

check('apply is a function', typeof apply === 'function')
if (typeof apply === 'function') apply(fakeCtx)
check('apply registers exactly two tools', registrations.length === 2, registrations.map(definition => definition.name))
const registeredNames = registrations.map(definition => definition.name).sort()
check('registered tools are ark_wiki_lookup + ark_banner_predict',
  registeredNames.join(',') === 'ark_banner_predict,ark_wiki_lookup', registeredNames)
check('apply registered inside one effect', effects.length === 1, effects.map(effect => effect.label))
for (const effect of effects) effect.dispose()
check('disposing the effect unregisters both tools', disposeLog.filter(item => item === 'tools.unregister').length === 2, disposeLog)

report.lookupParameterJsonSchema = arkWikiLookup.parameters
report.lookupOutputJsonSchema = arkWikiLookup.output.schema
report.bannerParameterJsonSchema = arkBannerPredict.parameters
report.bannerOutputJsonSchema = arkBannerPredict.output.schema

// defineTool() validates inside execute(), so argument rejection is observed there.
const tryExecute = async (tool, args) => {
  try {
    return { ok: true, value: await tool.execute(args, {}) }
  } catch (error) {
    return { ok: false, error: error?.constructor?.name, message: String(error?.message ?? error), violations: error?.violations }
  }
}

const invalid = [
  [arkWikiLookup, {}, 'lookup: missing required query'],
  [arkWikiLookup, { query: '阿米娅', category: 'hero' }, 'lookup: category outside enum'],
  [arkWikiLookup, { query: 42 }, 'lookup: query wrong type'],
  [arkBannerPredict, {}, 'banner: missing required hint'],
  [arkBannerPredict, { hint: '春节', banner_type: 'seasonal' }, 'banner: banner_type outside enum'],
  [arkBannerPredict, { hint: '春节', region: 'eu' }, 'banner: region outside enum']
]
const argRows = []
for (const [tool, args, label] of invalid) {
  const r = await tryExecute(tool, args)
  argRows.push({ tool: tool.name, label, args, rejected: !r.ok, error: r.error, violations: r.violations })
  check(`rejects args: ${label}`, !r.ok, { error: r.error, violations: r.violations })
}
report.argValidation = argRows

// ---------------------------------------------------------------------------
// Offline contract checks: pure parsing + scoring, no network.
// ---------------------------------------------------------------------------

const FIXTURE_PAGE = `{| class="wikitable"
|-
! 序号 !! 寻访页面 !! 开启时间 !! 6★ !! 5★
|-
| 1 || [[文件:干员轮换卡池1.png|400px|link=寻访模拟/干员轮换卡池1]] || 2025-01-01 04:00~<br/>2025-01-15 03:59 || {{干员头像|斥罪|shop=1}} || {{干员头像|左乐}}
|}
== 非标准寻访 ==
{| class="wikitable"
|-
! 寻访页面 !! 开启时间 !! 6★ !! 5★
|-
| [[文件:x.png]]<br/>[[岁岁平安]] || 2025-01-16 16:00~<br/>2025-01-30 03:59 || {{干员头像|年|limited=1}} {{干员头像|令}} || {{干员头像|夕}}
|}`

const FIXTURE_ENTRIES = [
  { name: '斥罪', stars: 6, nation: '莱塔尼亚', organization: '莱塔尼亚', releasedAt: '2023-03-07' },
  { name: '年', stars: 6, nation: '炎-龙门', organization: '龙门', releasedAt: '2020-01-16' },
  { name: '刻俄柏', stars: 6, nation: '哥伦比亚', organization: '罗德岛', releasedAt: '2020-05-01' },
  { name: '玛恩纳', stars: 6, nation: '卡西米尔', organization: '卡西米尔', releasedAt: '2022-09-08' },
  { name: '左乐', stars: 5, nation: '炎-龙门', organization: '龙门', releasedAt: '2024-01-01' },
  { name: '令', stars: 6, nation: '炎-龙门', organization: '岁', releasedAt: '2022-01-25' }
]

const syntheticStandard = (title, operator, date) => ({
  title,
  label: null,
  kind: 'standard',
  limited: false,
  rerun: false,
  season: null,
  section: null,
  start: new Date(date),
  end: null,
  six: [operator],
  five: [],
  shop: []
})

const contract = []
const contractCheck = (label, ok, detail) => {
  contract.push({ label, ok, ...(detail === undefined ? {} : { detail }) })
  check(`contract: ${label}`, ok, detail)
}

const fixtureBanners = parseBannerTables(FIXTURE_PAGE)
contractCheck('parses two banner rows', fixtureBanners.length === 2, fixtureBanners.map(banner => banner.title))
contractCheck('classifies rotating row as standard', fixtureBanners[0]?.kind === 'standard', fixtureBanners[0]?.kind)
contractCheck('classifies limited row as limited', fixtureBanners[1]?.kind === 'limited', fixtureBanners[1]?.kind)
contractCheck('keeps limited avatar flag', fixtureBanners[1]?.limited === true && fixtureBanners[1]?.six.includes('年'), fixtureBanners[1]?.six)
contractCheck('parses CN schedule start', fixtureBanners[1]?.start?.toISOString() === '2025-01-16T08:00:00.000Z', fixtureBanners[1]?.start?.toISOString())
contractCheck('parses bare date', parseBannerDate('2025-01-01')?.toISOString() === '2024-12-31T16:00:00.000Z', parseBannerDate('2025-01-01')?.toISOString())

const syntheticKernel = (title, operator, date) => ({
  ...syntheticStandard(title, operator, date),
  kind: 'kernel'
})

const fixtureIndex = buildBannerIndex([
  ...fixtureBanners,
  syntheticStandard('干员轮换卡池2', '刻俄柏', '2025-06-01T04:00:00+08:00'),
  syntheticStandard('干员轮换卡池3', '玛恩纳', '2025-08-01T04:00:00+08:00')
])
contractCheck('index marks limited operator', fixtureIndex.limitedOperators.has('年') && !fixtureIndex.limitedOperators.has('斥罪'))
contractCheck('index marks standard operator', fixtureIndex.standardPool.has('斥罪'))
contractCheck('limited flag stays per avatar',
  fixtureBanners[1]?.sixLimited?.length === 1 && fixtureBanners[1]?.sixLimited?.[0] === '年' &&
  fixtureBanners[1]?.six?.includes('令'), { six: fixtureBanners[1]?.six, sixLimited: fixtureBanners[1]?.sixLimited })
contractCheck('co-listed six star is not marked limited',
  fixtureBanners[1]?.limited === true && !fixtureIndex.limitedOperators.has('令'), [...fixtureIndex.limitedOperators])

const kernelMovedIndex = buildBannerIndex([
  ...fixtureBanners,
  syntheticStandard('干员轮换卡池2', '斥罪', '2025-06-01T04:00:00+08:00'),
  syntheticKernel('中坚寻访1', '斥罪', '2025-09-01T04:00:00+08:00')
])

const regionHint = parseBannerHint('莱塔尼亚活动')
contractCheck('region-only hint defaults to debut prediction',
  regionHint.bannerType === 'debut' && regionHint.regions.some(item => item.canonical === '莱塔尼亚'))
const explicitStandardHint = parseBannerHint('莱塔尼亚活动', 'standard')
contractCheck('explicit standard keeps rotation mode', explicitStandardHint.bannerType === 'standard', explicitStandardHint.bannerType)
const rotationHint = parseBannerHint('常驻轮换')
contractCheck('rotation hint infers standard', rotationHint.bannerType === 'standard', rotationHint.bannerType)
const alterHint = parseBannerHint('安洁莉娜会不会异格')
contractCheck('alter hint infers debut with alter flag',
  alterHint.bannerType === 'debut' && alterHint.mentionsAlter === true, alterHint)
const limitedHint = parseBannerHint('夏季限定')
contractCheck('season hint infers limited', limitedHint.bannerType === 'limited' && limitedHint.season === '夏季')
const newYearHint = parseBannerHint('春节限定')
contractCheck('new-year hint is flagged', newYearHint.newYear === true && newYearHint.bannerType === 'limited', newYearHint)
const vagueHint = parseBannerHint('随便猜猜')
contractCheck('vague hint is flagged as insufficient', vagueHint.hintUsed === false && vagueHint.bannerType === 'debut')

const now = new Date('2026-10-19T00:00:00+08:00')

const standardPredictionWithKernel = predictBanners({
  entries: FIXTURE_ENTRIES,
  index: kernelMovedIndex,
  hint: '莱塔尼亚活动',
  now
})
contractCheck('kernelMoved marks operator that moved to the kernel pool', kernelMoved(kernelMovedIndex, '斥罪') === true)
contractCheck('kernel banner moves operator out of standard rotation',
  kernelMovedIndex.kernelPool.has('斥罪') &&
  !standardPredictionWithKernel.candidates.some(item => item.operator === '斥罪'),
  standardPredictionWithKernel.candidates.map(item => item.operator))
const regionPrediction = predictBanners({
  entries: FIXTURE_ENTRIES,
  index: fixtureIndex,
  hint: '莱塔尼亚活动',
  now
})
contractCheck('region prediction returns 3 candidates', regionPrediction.candidates.length === 3, regionPrediction.candidates.map(item => item.operator))
contractCheck('region prediction ranks 斥罪 first', regionPrediction.candidates[0]?.operator === '斥罪', regionPrediction.candidates[0])
contractCheck('region-only hint caps confidence at medium', regionPrediction.candidates[0]?.confidence === 'medium', regionPrediction.candidates[0]?.confidence)
contractCheck('region prediction basis mentions 卡池一览', regionPrediction.prediction_basis.includes('卡池一览'), regionPrediction.prediction_basis)
contractCheck('region prediction schema valid', T.validateJsonSchemaValue(arkBannerPredict.output.schema, regionPrediction).length === 0,
  T.validateJsonSchemaValue(arkBannerPredict.output.schema, regionPrediction))

const seasonPrediction = predictBanners({
  entries: FIXTURE_ENTRIES,
  index: fixtureIndex,
  hint: '夏季限定',
  now
})
contractCheck('limited prediction excludes already-released limited operators',
  seasonPrediction.candidates.every(item => item.operator !== '年'), seasonPrediction.candidates.map(item => item.operator))
contractCheck('limited prediction offers companion candidates', seasonPrediction.candidates.length > 0, seasonPrediction.candidates.map(item => item.operator))
contractCheck('limited prediction states the exchange-only rule', /兑换/.test(seasonPrediction.prediction_basis) && /兑换/.test(seasonPrediction.caveats),
  { basis: seasonPrediction.prediction_basis, caveats: seasonPrediction.caveats })
contractCheck('season prediction includes interval evidence', /天/.test(seasonPrediction.candidates[0]?.reason ?? ''), seasonPrediction.candidates[0]?.reason)

const newYearPrediction = predictBanners({
  entries: FIXTURE_ENTRIES,
  index: fixtureIndex,
  hint: '春节限定',
  now
})
contractCheck('new-year hint yields no candidates', newYearPrediction.candidates.length === 0, newYearPrediction.candidates)
contractCheck('new-year hint explains the skip', /不预测/.test(newYearPrediction.prediction_basis), newYearPrediction.prediction_basis)
contractCheck('new-year prediction schema valid', T.validateJsonSchemaValue(arkBannerPredict.output.schema, newYearPrediction).length === 0,
  T.validateJsonSchemaValue(arkBannerPredict.output.schema, newYearPrediction))

const storyFixture = {
  byOperator: new Map([
    ['斥罪', { total: 6, main: 1, event: 4, memory: 1, latestTs: Date.parse('2025-09-01T00:00:00+08:00') }],
    ['玛恩纳', { total: 1, main: 0, event: 1, memory: 0, latestTs: Date.parse('2026-08-01T00:00:00+08:00') }]
  ]),
  staleRegions: [{ canonical: '莱塔尼亚', ts: Date.parse('2025-06-01T00:00:00+08:00'), months: 16 }]
}
const storyPrediction = predictBanners({
  entries: FIXTURE_ENTRIES,
  index: fixtureIndex,
  hint: '莱塔尼亚活动',
  story: storyFixture,
  now
})
const storyCandidate = storyPrediction.candidates.find(item => item.operator === '斥罪')
contractCheck('story appearance adds a boost signal', storyCandidate?.signals.includes('story_appearance'), storyCandidate)
contractCheck('story appearance reason cites the count', /剧情中共出场 6 次/.test(storyCandidate?.reason ?? ''), storyCandidate?.reason)
contractCheck('stale region reason cites months', /莱塔尼亚.*16 个月/.test(storyCandidate?.reason ?? ''), storyCandidate?.reason)
contractCheck('story prediction basis lists story signals', /剧情信号/.test(storyPrediction.prediction_basis), storyPrediction.prediction_basis)
contractCheck('story prediction schema valid', T.validateJsonSchemaValue(arkBannerPredict.output.schema, storyPrediction).length === 0,
  T.validateJsonSchemaValue(arkBannerPredict.output.schema, storyPrediction))

const vaguePrediction = predictBanners({
  entries: FIXTURE_ENTRIES,
  index: fixtureIndex,
  hint: '随便猜猜',
  now
})
contractCheck('vague hint degrades confidence', vaguePrediction.candidates.every(item => item.confidence === 'low'), vaguePrediction.candidates)
contractCheck('vague hint says insufficient clues', vaguePrediction.prediction_basis.includes('线索不足'), vaguePrediction.prediction_basis)

const emptyPrediction = predictBanners({
  entries: FIXTURE_ENTRIES,
  index: buildBannerIndex([]),
  hint: '莱塔尼亚活动',
  now
})
contractCheck('no banner data yields no candidates', emptyPrediction.candidates.length === 0, emptyPrediction.candidates)
contractCheck('no banner data explains itself', emptyPrediction.caveats.includes('没有可用的历史卡池数据'), emptyPrediction.caveats)

// --- debut / alter prediction (offline, from the committed cast database) ---
const cast = loadStoryCast()
contractCheck('story cast database is available and classified',
  cast.missing === false && Object.keys(cast.characters).length > 100 && Object.keys(cast.catalog).length > 100,
  { missing: cast.missing, chars: Object.keys(cast.characters).length, catalog: Object.keys(cast.catalog).length })

const regionDebut = predictDebut({ regions: ['阿戈尔', '伊比利亚'], entries: FIXTURE_ENTRIES, signals: storyFixture, now })
contractCheck('debut returns candidates for a region hint', regionDebut.candidates.length > 0, regionDebut.candidates)
contractCheck('debut candidates expose new/alter kind',
  regionDebut.candidates.every(item => item.kind === 'new' || item.kind === 'alter'), regionDebut.candidates)
contractCheck('debut basis cites the cast scan', /扫描 \d+ 段/.test(regionDebut.prediction_basis), regionDebut.prediction_basis)
contractCheck('debut basis cites the hinted region', /阿戈尔/.test(regionDebut.prediction_basis), regionDebut.prediction_basis)
contractCheck('debut caveats keep the exchange rule', /兑换/.test(regionDebut.caveats), regionDebut.caveats)
contractCheck('debut prediction schema valid',
  T.validateJsonSchemaValue(arkBannerPredict.output.schema, regionDebut).length === 0,
  T.validateJsonSchemaValue(arkBannerPredict.output.schema, regionDebut))

const namedDebut = predictDebut({ regions: [], entries: FIXTURE_ENTRIES, signals: storyFixture, now, body: '塔露拉会实装吗' })
contractCheck('named unreleased character ranks first', namedDebut.candidates[0]?.operator === '塔露拉', namedDebut.candidates.map(item => item.operator))
contractCheck('named hint is stated in the basis', /hint 提到的未实装人物/.test(namedDebut.prediction_basis), namedDebut.prediction_basis)

const alterStory = {
  byOperator: new Map([
    ['玛恩纳', { total: 8, main: 2, event: 6, memory: 0, latestTs: Date.parse('2019-01-01T00:00:00+08:00') }]
  ]),
  staleRegions: []
}
const alterDebut = predictDebut({
  regions: [],
  entries: [...FIXTURE_ENTRIES, { name: '安洁莉娜', stars: 6, nation: '叙拉古' }, { name: '予愿安洁莉娜', stars: 6, nation: '叙拉古' }],
  signals: alterStory,
  now,
  body: '安洁莉娜很久没剧情了，会不会异格'
})
contractCheck('alter hint weights alter candidates', alterDebut.candidates.some(item => item.kind === 'alter'), alterDebut.candidates)
contractCheck('stale operator becomes a medium alter candidate',
  alterDebut.candidates.find(item => item.operator === '玛恩纳')?.confidence === 'medium',
  alterDebut.candidates.find(item => item.operator === '玛恩纳'))
contractCheck('already-altered operator is rejected with an explanation', /已经异格实装/.test(alterDebut.caveats), alterDebut.caveats)
contractCheck('alter candidate cites the 4-year release rule',
  /首次进池于 2022-09-08/.test(alterDebut.candidates.find(item => item.operator === '玛恩纳')?.reason ?? '') &&
  /超过 4 年/.test(alterDebut.candidates.find(item => item.operator === '玛恩纳')?.reason ?? ''),
  alterDebut.candidates.find(item => item.operator === '玛恩纳'))

// --- 0.9.0 rules: collab cameo (+2%) and 4-year-old first release (alter) ---
const collabDebut = predictDebut({ regions: ['玻利瓦尔'], entries: FIXTURE_ENTRIES, signals: storyFixture, now })
const collabIndex = loadCollabEvents()
contractCheck('collab event list is available',
  collabIndex.missing === false && collabIndex.names.includes('源石尘行动') && collabIndex.names.includes('无忧梦呓'),
  { missing: collabIndex.missing, names: collabIndex.names })
contractCheck('collab segments are counted from story groups',
  collabHits(['源石尘行动(12)', '孤星(3)']).count === 12, collabHits(['源石尘行动(12)', '孤星(3)']))
contractCheck('non-collab stories contribute no collab segments',
  collabHits(['孤星(3)', '吾导先路(5)']).count === 0, collabHits(['孤星(3)', '吾导先路(5)']))
contractCheck('collab rerun titles still match',
  isCollabEvent('源石尘行动2024') === true && isCollabEvent('孤星') === false)
contractCheck('collab cameo is explained in the candidate reason',
  /联动剧情「[^」]*源石尘行动/.test(collabDebut.candidates.map(item => item.reason).join(' ')),
  collabDebut.candidates.map(item => item.reason))
contractCheck('collab cameo adds a signal instead of a veto',
  collabDebut.candidates.every(item => Array.isArray(item.signals)) &&
  collabDebut.candidates.some(item => item.signals.includes('collab_cameo')),
  collabDebut.candidates.map(item => item.signals))
contractCheck('debut basis states the collab and 4-year rules',
  /联动加成/.test(regionDebut.prediction_basis) && /异格加权/.test(regionDebut.prediction_basis),
  regionDebut.prediction_basis)

contractCheck('debut caveats warn about weak signals', /弱信号/.test(regionDebut.caveats), regionDebut.caveats)

// --- region operator dossiers: archives + 干员密录 as weak signals ------------
const dossierEntries = [
  { name: '缪尔赛思', stars: 6, nation: '哥伦比亚', page: '缪尔赛思' },
  { name: '塞雷娅', stars: 6, nation: '哥伦比亚' },
  { name: '斥罪', stars: 6, nation: '莱塔尼亚' }
]
const pickedDossiers = selectRegionOperators(dossierEntries, '哥伦比亚', { signals: storyFixture, limit: 3, now })
contractCheck('dossier selection keeps only operators of the region',
  pickedDossiers.length === 2 && pickedDossiers.every(entry => entry.nation === '哥伦比亚'),
  pickedDossiers.map(entry => entry.name))

const archiveClues = extractArchiveClues([
  { title: '基础档案', text: '哥伦比亚，莱茵生命。' },
  { title: '档案资料四', text: '缪尔赛思仍打算回哥伦比亚处理莱茵生命的旧账。她的导师留在特里蒙，至今没有下落。' },
  { title: '临床诊断分析', text: '体检标准沿用哥伦比亚。' }
], ['哥伦比亚', '莱茵生命'])
contractCheck('archive clues keep only region sentences from written archives',
  archiveClues.length === 1 && archiveClues[0].text.includes('哥伦比亚') && archiveClues[0].title === '档案资料四',
  archiveClues)

const recordLines = parseRecordLines([
  '[name="缪尔赛思"]我打算回哥伦比亚一趟。',
  '[charslot(slot="l")]',
  '[name="生态科研究员A"]莱茵生命最近不太安稳。',
  '[name="塞雷娅"]总辖的位置一直空着。'
].join('\n'))
contractCheck('record parser keeps speaker and line, drops engine tags', recordLines.length === 3, recordLines)
const recordClues = extractRecordClues(recordLines, ['哥伦比亚', '莱茵生命'])
contractCheck('record clues filter by region mention',
  recordClues.length === 2 && recordClues[0].text.includes('哥伦比亚'), recordClues)

resetDossierCache()
const fakeDossierPage = async (title) => {
  if (title === '缪尔赛思') {
    return { missing: false, content: '{{人员档案|档案1=档案资料一|档案1文本=缪尔赛思在哥伦比亚长大，后来加入了莱茵生命。}}' }
  }
  if (title === '缪尔赛思/干员密录/1') {
    return { missing: false, content: '[name="缪尔赛思"]我们该回哥伦比亚看看了。' }
  }
  return { missing: true, content: '' }
}
const fakeDossierRecords = async () => [{ set: '无根之雨', index: '1', page: '缪尔赛思/干员密录/1' }]
const regionDossier = await collectRegionDossiers({
  canonical: '哥伦比亚',
  entries: dossierEntries,
  signals: storyFixture,
  now,
  fetchPage: fakeDossierPage,
  fetchRecords: fakeDossierRecords,
  useCache: false
})
contractCheck('dossier collector merges archive and 密录 clues',
  regionDossier.clues.length >= 2 &&
  regionDossier.clues.some(clue => clue.source === '档案') &&
  regionDossier.clues.some(clue => clue.source === '密录'),
  regionDossier.clues)
contractCheck('dossier clue carries source operator and link',
  regionDossier.clues.every(clue => clue.operator && clue.url && clue.text), regionDossier.clues)
const dossierNotes = formatDossierNotes(regionDossier)
contractCheck('dossier notes name the operators and the region',
  /档案\/密录线索/.test(dossierNotes) && dossierNotes.includes('缪尔赛思') && dossierNotes.includes('哥伦比亚'),
  dossierNotes)
contractCheck('empty dossier still explains itself',
  /没有找到提及/.test(formatDossierNotes({ region: '谢拉格', operators: ['角峰'], scanned: 1, clues: [] })),
  formatDossierNotes({ region: '谢拉格', operators: ['角峰'], scanned: 1, clues: [] }))


// --- released-operator verification (real names / nicknames) ----------------
const aliasIndex = loadOperatorAliases()
contractCheck('operator alias index is available',
  aliasIndex.missing === false && aliasIndex.aliases['梅捷缇克缇'] === '缇缇',
  { missing: aliasIndex.missing, sample: aliasIndex.aliases['梅捷缇克缇'], scanned: aliasIndex.scanned })

const releasedDebut = predictDebut({ regions: ['萨尔贡'], entries: FIXTURE_ENTRIES, signals: storyFixture, now })
contractCheck('released operators are never predicted as new characters by real name',
  !releasedDebut.candidates.some(item => ['梅捷缇克缇', '阿娜特'].includes(item.operator)),
  releasedDebut.candidates.map(item => item.operator))
contractCheck('alias exclusions are explained in the caveats',
  /实装校验/.test(releasedDebut.caveats), releasedDebut.caveats)
contractCheck('debut basis cites the operator roster verification',
  /实装校验/.test(releasedDebut.prediction_basis), releasedDebut.prediction_basis)

const hintAliasDebut = predictDebut({
  regions: [],
  entries: [...FIXTURE_ENTRIES, { name: '缇缇', stars: 6, nation: '萨尔贡' }],
  signals: storyFixture,
  now,
  body: '缇缇（梅捷缇克缇）会不会实装'
})
contractCheck('hint naming a released operator is explained instead of predicted',
  /hint 点名的「缇缇」已经是实装干员/.test(hintAliasDebut.caveats), hintAliasDebut.caveats)
contractCheck('hint real name is listed first among alias exclusions',
  /实装校验：梅捷缇克缇＝干员「缇缇」/.test(hintAliasDebut.caveats), hintAliasDebut.caveats)

report.contract = contract

// ---------------------------------------------------------------------------
// Live cases (network). Each case names the tool it exercises.
// ---------------------------------------------------------------------------

const cases = mode === 'offline'
  ? []
  : [
      {
        tool: arkWikiLookup,
        args: { query: '阿米娅' },
        expect: ['operator', 'ok'],
        assert: value => value.entry?.skills?.length === 3 && value.entry.skills[2].name === '奇美拉'
          && value.entry.talents?.some(t => t.name === '情绪吸收')
          && !value.entry.talents.some(t => t.name.includes('？'))
          && value.entry.buildingSkills?.length > 0
          && value.entry.profile?.birthplace === '雷姆必拓'
          && value.entry.archives?.some(archive => archive.title === '客观履历')
          && !value.entry.archives.some(archive => archive.title.includes('？'))
      },
      {
        tool: arkWikiLookup,
        args: { query: '12F' },
        expect: ['operator', 'ok'],
        assert: value => value.entry?.records?.length === 1
          && value.entry.records[0].page === '12F/干员密录/1'
          && value.entry.archives?.some(archive => archive.title === '档案资料一')
      },
      {
        tool: arkWikiLookup,
        args: { query: '银灰' },
        expect: ['operator', 'ok'],
        assert: value => value.entry?.skills?.length === 3
          && value.entry.talents?.length === 2
          && value.entry.talents[0].name === '领袖'
          && value.entry.talents[0].levels.some(level => level.potentialEffect)
      },
      {
        tool: arkWikiLookup,
        args: { query: '玫兰莎' },
        expect: ['operator', 'ok'],
        assert: value => value.entry?.skills?.length === 1 && value.entry.skills[0].levels.length === 7
          && value.entry.talents?.[0]?.levels.length === 2
      },
      {
        tool: arkWikiLookup,
        args: { query: '0-1 坍塌 行动前' },
        expect: ['story', 'ok'],
        assert: value => value.entry?.kind === '主线剧情'
          && value.entry.chapter === '黑暗时代·上'
          && value.entry.characters.includes('杜宾')
          && value.entry.lines.length > 10
          && value.entry.truncated === true
          && value.entry.lines.every(line => !line.text.includes('{@'))
      },
      {
        tool: arkWikiLookup,
        args: { query: '12F 干员密录' },
        expect: ['story', 'ok'],
        assert: value => value.entry?.kind === '干员密录' && value.entry.lineCount > 60
      },
      {
        tool: arkWikiLookup,
        args: { query: '1-7' },
        expect: ['stage', 'ok'],
        assert: value => value.entry?.story?.before?.page === '1-7 暴君/BEG'
          && value.entry.story?.after?.page === '1-7 暴君/END'
      },
      {
        tool: arkWikiLookup,
        args: { query: '黑暗时代' },
        expect: ['unknown', 'not_found'],
        assert: value => value.candidates?.some(candidate => candidate.category === 'story')
      },
      { tool: arkWikiLookup, args: { query: 'Amiya' }, expect: ['operator', 'ok'] },
      { tool: arkWikiLookup, args: { query: 'アーミヤ' }, expect: ['operator', 'ok'] },
      {
        tool: arkWikiLookup,
        args: { query: '克莱门莎 出场' },
        expect: ['story', 'ok'],
        assert: value => value.entry?.kind === '干员出场'
          && value.entry.total > 20
          && value.entry.earliest?.title === 'BP-ST-1 浪潮守望者'
          && value.entry.earliest?.date === '2024-06-05'
          && value.entry.appearances.length > 5
          && value.entry.appearances.every(item => !('navIndex' in item))
      },
      {
        tool: arkWikiLookup,
        args: { query: '阿米娅 出场' },
        expect: ['story', 'ok'],
        assert: value => value.entry?.kind === '干员出场'
          && value.entry.counts.main > 50
          && value.entry.counts.memory > 0
      },
      {
        tool: arkWikiLookup,
        args: { query: '维多利亚', category: 'world' },
        expect: ['world', 'ok'],
        assert: value => value.entry?.section === '地理'
          && value.entry.infobox?.['首都'] === '伦蒂尼姆'
          && (value.entry.related ?? []).some(link => link.name === '伦蒂尼姆')
      },
      {
        tool: arkWikiLookup,
        args: { query: '罗德岛', category: 'world' },
        expect: ['world', 'ok'],
        assert: value => value.entry?.section === '组织'
          && String(value.entry.details?.['日文名'] ?? '').includes('ロドス')
      },
      {
        tool: arkWikiLookup,
        args: { query: '源石', category: 'world' },
        expect: ['world', 'ok'],
        assert: value => (value.entry?.terms ?? []).some(term => term.zh === '源石' && term.en === 'Originiums')
      },
      { tool: arkWikiLookup, args: { query: '泰拉年表' }, expect: ['world', 'ok'] },
      { tool: arkWikiLookup, args: { query: '不存在的世界观词条xyz' }, expect: ['unknown', 'not_found'] },
      { tool: arkWikiLookup, args: { query: '阿米娅的信物' }, expect: ['item', 'ok'] },
      { tool: arkWikiLookup, args: { query: '至纯源石' }, expect: ['item', 'ok'] },
      { tool: arkWikiLookup, args: { query: '固源岩', category: 'item' }, expect: ['item', 'ok'] },
      { tool: arkWikiLookup, args: { query: 'S4-7' }, expect: ['stage', 'ok'] },
      { tool: arkWikiLookup, args: { query: '龙门市区' }, expect: ['stage', 'ok'] },
      { tool: arkWikiLookup, args: { query: 'CE-5' }, expect: ['stage', 'ok'] },
      { tool: arkWikiLookup, args: { query: '不存在的词条xyz' }, expect: ['unknown', 'not_found'] },
      {
        tool: arkBannerPredict,
        args: { hint: '莱塔尼亚活动，下期标准轮换' },
        assert: value => value.candidates.length >= 3
          && value.candidates.length <= 4
          && value.candidates.every(item => ['high', 'medium', 'low'].includes(item.confidence))
          && value.prediction_basis.length > 0
          && value.prediction_basis.includes('剧情信号')
          && (value.caveats.includes('概率') || value.caveats.includes('排期'))
      },
      {
        // 春节/新年限定 is skipped by design: no network, no candidates.
        tool: arkBannerPredict,
        args: { hint: '春节限定池' },
        assert: value => value.candidates.length === 0
          && /不预测/.test(value.prediction_basis)
      },
      {
        tool: arkBannerPredict,
        args: { hint: '夏季限定池' },
        assert: value => value.candidates.length >= 1
          && value.prediction_basis.includes('限定')
          && /兑换/.test(value.prediction_basis)
          && value.candidates.every(item => typeof item.operator === 'string' && item.reason.length > 0)
      },
      {
        tool: arkBannerPredict,
        args: { hint: '维多利亚复刻' },
        assert: value => value.candidates.length >= 1
          && /兑换/.test(value.caveats)
          && value.candidates.every(item => ['high', 'medium', 'low'].includes(item.confidence))
      },
      {
        tool: arkBannerPredict,
        args: { hint: '随便猜猜', banner_type: 'standard' },
        assert: value => value.candidates.every(item => item.confidence === 'low')
          && value.prediction_basis.includes('线索不足')
      },
      {
        // 默认模式：新角色/异格，不查卡池排期页。
        tool: arkBannerPredict,
        args: { hint: '下个版本可能回阿戈尔或伊比利亚' },
        assert: value => value.candidates.length >= 1
          && value.candidates.every(item => item.kind === 'new' || item.kind === 'alter')
          && /扫描 \d+ 段/.test(value.prediction_basis)
          && /阿戈尔/.test(value.prediction_basis)
          && /兑换/.test(value.caveats)
      },
      {
        tool: arkBannerPredict,
        args: { hint: '萨尔贡下一个版本会出哪些新角色' },
        assert: value => value.candidates.length >= 1
          && !value.candidates.some(item => ['梅捷缇克缇', '阿娜特', '缇缇'].includes(item.operator))
          && /实装校验/.test(value.caveats)
      },
      {
        // wiki 标题检索实装校验：玛嘉烈 是干员「临光」的本名（页面「玛嘉烈・临光」），
        // 必须被剔除；这里同时确认候选都不是已实装干员。
        tool: arkBannerPredict,
        args: { hint: '卡西米尔下个版本会出哪些新角色' },
        assert: value => value.candidates.length >= 1
          && !value.candidates.some(item => ['玛嘉烈', '临光'].includes(item.operator))
          // 多轮补位会重复调用校验，说明文字只能出现一次
          && (value.prediction_basis.match(/按标题检索/g) ?? []).length === 1
      },
      {
        tool: arkBannerPredict,
        args: { hint: '塔露拉会实装吗' },
        assert: value => value.candidates.some(item => item.operator === '塔露拉')
          && value.candidates.every(item => item.kind === 'new' || item.kind === 'alter')
          // BOSS 模板 / 主线核心整体票数 ×0.95，理由里要写明
          && value.candidates.some(item => item.operator === '塔露拉' && /下调 5%/.test(item.reason))
      },
      {
        // 地区票过滤：普瑞赛斯（拉特兰 5/69）与奥卢斯（拉特兰 4/22）曾因同场
        // 萨科塔/伊比利亚干员「带票」被当成拉特兰角色，占半数以上才应算命中。
        tool: arkBannerPredict,
        args: { hint: '拉特兰的下一个新角色' },
        assert: value => value.candidates.length >= 1
          && !value.candidates.some(item => ['普瑞赛斯', '奥卢斯'].includes(item.operator))
          && /占该人物出场票/.test(value.prediction_basis)
          && value.candidates.some(item => /拉特兰/.test(item.reason))
      },
      {
        // 泛称清理 + 末尾结果表格：哥伦比亚池里「保镖」曾作为泛称职业角色混进候选。
        tool: arkBannerPredict,
        args: { hint: '哥伦比亚的下一个新角色' },
        assert: (value, text) => value.candidates.length >= 1
          && !value.candidates.some(item => ['保镖', '保安', '随从'].includes(item.operator))
          && /\| 顺序 \| 角色 \| 类型 \| 置信度 \| 关键依据 \|/.test(text)
      },
      {
        tool: arkBannerPredict,
        args: { hint: '安洁莉娜很久没新剧情了，会不会异格' },
        assert: value => value.candidates.some(item => item.kind === 'alter')
          && /已经异格实装/.test(value.caveats)
      }
    ]

const matchesExpectation = (tool, value, expect) => {
  if (!expect) return true
  if (tool === arkWikiLookup) return value?.category === expect[0] && value?.status === expect[1]
  return true
}

const results = []
for (const testCase of cases) {
  const tool = testCase.tool ?? arkWikiLookup
  const args = testCase.args ?? {}
  const started = Date.now()
  const r = await tryExecute(tool, args)
  const elapsedMs = Date.now() - started
  const label = args.query ?? args.hint ?? JSON.stringify(args)
  if (!r.ok) {
    results.push({ tool: tool.name, args, label, threw: r.message, elapsedMs, expectationMet: false })
    continue
  }
  const value = r.value
  const violations = T.validateJsonSchemaValue(tool.output.schema, value)
  const blocks = tool.output.render(args, value)
  const rendered = blocks.map(b => b.text).join('\n')
  const expectationMet = matchesExpectation(tool, value, testCase.expect)
  let assertMet
  let assertError
  if (testCase.assert) {
    try {
      assertMet = testCase.assert(value, rendered) === true
    } catch (error) {
      assertMet = false
      assertError = String(error?.message ?? error)
    }
  }
  const entry = value?.entry && typeof value.entry === 'object' ? value.entry : undefined
  results.push({
    tool: tool.name,
    args,
    label,
    elapsedMs,
    expected: testCase.expect,
    expectationMet,
    ...(assertMet === undefined ? {} : { assertMet, assertError }),
    violatesOutputSchema: violations,
    status: value?.status,
    category: value?.category,
    matchedBy: value?.matchedBy,
    message: value?.message,
    candidateCount: value?.candidates?.length,
    counts: entry && {
      skills: entry.skills?.length ?? 0,
      skillLevels: entry.skills?.reduce((sum, skill) => sum + skill.levels.length, 0) ?? 0,
      talents: entry.talents?.length ?? 0,
      buildingSkills: entry.buildingSkills?.length ?? 0
    },
    entryKeys: entry ? Object.keys(entry) : undefined,
    blockTypes: blocks.map(b => b.type),
    render: blocks.map(b => b.text).join('\n')
  })
}
report.results = results
report.allValid = report.checks.every(entry => entry.ok)
  && results.every(r => !r.threw && r.violatesOutputSchema?.length === 0 && r.blockTypes?.length > 0
    && r.expectationMet && r.assertMet !== false)

if (!process.env.HARNESS_SUMMARY) console.log(JSON.stringify(report, null, 2))
if (!report.allValid) process.exitCode = 1

if (process.env.HARNESS_REPORT) {
  writeFileSync(process.env.HARNESS_REPORT, JSON.stringify(report, null, 2))
}
if (process.env.HARNESS_SUMMARY) {
  const failed = report.checks.filter(check => !check.ok).map(check => check.label)
  console.log('--- summary ---')
  console.log('allValid:', report.allValid, '| failed checks:', failed.length ? failed.join('; ') : 'none')
  for (const row of report.results) {
    const flags = [
      row.expectationMet ? null : 'EXPECT-MISMATCH',
      row.assertMet === false ? 'ASSERT-FAILED' : null,
      (row.violatesOutputSchema ?? []).length > 0 ? 'SCHEMA-VIOLATION' : null,
      row.threw ? `THREW: ${row.threw}` : null
    ].filter(Boolean)
    console.log(`${row.label} [${row.tool}] ${row.elapsedMs}ms ${row.status ?? '-'} ${flags.join(' ') || 'ok'}`)
  }
}
