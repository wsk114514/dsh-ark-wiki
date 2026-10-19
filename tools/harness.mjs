/**
 * Local contract harness: runs the plugin's tool definition outside DSH, using
 * the host's own dsh-tools build (so the schema compiler and validators are the
 * exact ones DSH uses at runtime).
 *
 * Note: defineTool() already compiles both schemas at definition time, so
 * `tool.parameters` and `tool.output.schema` are raw JSON Schema here.
 *
 * Usage: node tools/harness.mjs [stub|live]
 */

import * as T from '@deepseek-ai/dsh-tools'
import { writeFileSync } from 'node:fs'
import { arkWikiLookup, name, inject, apply } from '../lib/index.js'

const mode = process.argv[2] ?? 'live'

const report = { mode, exports: { name, inject }, checks: [] }
const check = (label, ok, detail) => report.checks.push({ label, ok, ...(detail === undefined ? {} : { detail }) })

check('tool name is ark_wiki_lookup', arkWikiLookup.name === 'ark_wiki_lookup', arkWikiLookup.name)
check('inject contains tools', Array.isArray(inject) && inject.includes('tools'), inject)
check('parameters is compiled JSON Schema', arkWikiLookup.parameters?.type === 'object')
check('output.schema is compiled JSON Schema', arkWikiLookup.output.schema?.type === 'object')

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
check('apply registers exactly one tool', registrations.length === 1, registrations.map(definition => definition.name))
check('registered tool is ark_wiki_lookup', registrations[0]?.name === 'ark_wiki_lookup')
check('apply registered inside one effect', effects.length === 1, effects.map(effect => effect.label))
for (const effect of effects) effect.dispose()
check('disposing the effect unregisters the tool', disposeLog.includes('tools.unregister'), disposeLog)

report.parameterJsonSchema = arkWikiLookup.parameters
report.outputJsonSchema = arkWikiLookup.output.schema

// defineTool() validates inside execute(), so argument rejection is observed there.
const tryExecute = async (args) => {
  try {
    return { ok: true, value: await arkWikiLookup.execute(args, {}) }
  } catch (error) {
    return { ok: false, error: error?.constructor?.name, message: String(error?.message ?? error), violations: error?.violations }
  }
}

const invalid = [
  [{}, 'missing required query'],
  [{ query: '阿米娅', category: 'hero' }, 'category outside enum'],
  [{ query: 42 }, 'query wrong type']
]
const argRows = []
for (const [args, label] of invalid) {
  const r = await tryExecute(args)
  argRows.push({ label, args, rejected: !r.ok, error: r.error, violations: r.violations })
  check(`rejects args: ${label}`, !r.ok, { error: r.error, violations: r.violations })
}
report.argValidation = argRows

const cases = mode === 'offline'
  ? []
  : [
      {
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
        args: { query: '12F' },
        expect: ['operator', 'ok'],
        assert: value => value.entry?.records?.length === 1
          && value.entry.records[0].page === '12F/干员密录/1'
          && value.entry.archives?.some(archive => archive.title === '档案资料一')
      },
      {
        args: { query: '银灰' },
        expect: ['operator', 'ok'],
        assert: value => value.entry?.skills?.length === 3
          && value.entry.talents?.length === 2
          && value.entry.talents[0].name === '领袖'
          && value.entry.talents[0].levels.some(level => level.potentialEffect)
      },
      {
        args: { query: '玫兰莎' },
        expect: ['operator', 'ok'],
        assert: value => value.entry?.skills?.length === 1 && value.entry.skills[0].levels.length === 7
          && value.entry.talents?.[0]?.levels.length === 2
      },
      {
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
        args: { query: '12F 干员密录' },
        expect: ['story', 'ok'],
        assert: value => value.entry?.kind === '干员密录' && value.entry.lineCount > 60
      },
      {
        args: { query: '1-7' },
        expect: ['stage', 'ok'],
        assert: value => value.entry?.story?.before?.page === '1-7 暴君/BEG'
          && value.entry.story?.after?.page === '1-7 暴君/END'
      },
      {
        args: { query: '黑暗时代' },
        expect: ['unknown', 'not_found'],
        assert: value => value.candidates?.some(candidate => candidate.category === 'story')
      },
      { args: { query: 'Amiya' }, expect: ['operator', 'ok'] },
      { args: { query: 'アーミヤ' }, expect: ['operator', 'ok'] },
      {
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
        args: { query: '阿米娅 出场' },
        expect: ['story', 'ok'],
        assert: value => value.entry?.kind === '干员出场'
          && value.entry.counts.main > 50
          && value.entry.counts.memory > 0
      },
      {
        args: { query: '维多利亚', category: 'world' },
        expect: ['world', 'ok'],
        assert: value => value.entry?.section === '地理'
          && value.entry.infobox?.['首都'] === '伦蒂尼姆'
          && (value.entry.related ?? []).some(link => link.name === '伦蒂尼姆')
      },
      {
        args: { query: '罗德岛', category: 'world' },
        expect: ['world', 'ok'],
        assert: value => value.entry?.section === '组织'
          && String(value.entry.details?.['日文名'] ?? '').includes('ロドス')
      },
      {
        args: { query: '源石', category: 'world' },
        expect: ['world', 'ok'],
        assert: value => (value.entry?.terms ?? []).some(term => term.zh === '源石' && term.en === 'Originiums')
      },
      { args: { query: '泰拉年表' }, expect: ['world', 'ok'] },
      { args: { query: '不存在的世界观词条xyz' }, expect: ['unknown', 'not_found'] },
      { args: { query: '阿米娅的信物' }, expect: ['item', 'ok'] },
      { args: { query: '至纯源石' }, expect: ['item', 'ok'] },
      { args: { query: '固源岩', category: 'item' }, expect: ['item', 'ok'] },
      { args: { query: 'S4-7' }, expect: ['stage', 'ok'] },
      { args: { query: '龙门市区' }, expect: ['stage', 'ok'] },
      { args: { query: 'CE-5' }, expect: ['stage', 'ok'] },
      { args: { query: '不存在的词条xyz' }, expect: ['unknown', 'not_found'] }
    ]

const results = []
for (const testCase of cases) {
  const args = testCase.args ?? testCase
  const started = Date.now()
  const r = await tryExecute(args)
  const elapsedMs = Date.now() - started
  if (!r.ok) {
    results.push({ args, threw: r.message, elapsedMs, expectationMet: false })
    continue
  }
  const value = r.value
  const violations = T.validateJsonSchemaValue(arkWikiLookup.output.schema, value)
  const blocks = arkWikiLookup.output.render(args, value)
  const expectationMet = !testCase.expect
    || (value?.category === testCase.expect[0] && value?.status === testCase.expect[1])
  let assertMet
  let assertError
  if (testCase.assert) {
    try {
      assertMet = testCase.assert(value) === true
    } catch (error) {
      assertMet = false
      assertError = String(error?.message ?? error)
    }
  }
  const entry = value?.entry && typeof value.entry === 'object' ? value.entry : undefined
  results.push({
    args,
    elapsedMs,
    expected: testCase.expect,
    expectationMet,
    ...(assertMet === undefined ? {} : { assertMet, assertError }),
    violatesOutputSchema: violations,
    status: value?.status,
    category: value?.category,
    matchedBy: value?.matchedBy,
    message: value?.message,
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
    console.log(`${row.args.query} [${row.args.category ?? 'auto'}] ${row.elapsedMs}ms ${row.status ?? '-'} ${flags.join(' ') || 'ok'}`)
  }
}
