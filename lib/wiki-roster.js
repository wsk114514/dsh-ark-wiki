import { searchTitles, pageContent, cleanShort } from './prts.js'

// ---------------------------------------------------------------------------
// 实装校验：拿候选名去 PRTS 检索一遍
//
// 用户要求：预测出候选项后，在 wiki「干员一览」里查是否有本名或外号相同的
// 干员；如果有，说明这次预测到的是已经实装的干员，必须剔除。
//
// 干员一览本身只有代号，没有本名列，所以这里用「标题检索 + 页面确认」两步：
//   1. list=search&srwhat=title 搜候选名，取前几条标题；
//   2. 标题等于候选名、或以候选名开头时，打开页面找 {{干员页面名|代号}}。
// 这样能识别「玛嘉烈」→ 页面「玛嘉烈・临光」→ 干员「临光」这类本名/别名页，
// 而剧情 NPC 页（如「罗伊」）没有干员模板，不会被误判。
// ---------------------------------------------------------------------------

const cache = new Map()

export function resetWikiRosterCache () {
  cache.clear()
}

async function operatorOfPage (title, signal) {
  try {
    const page = await pageContent(title, { signal })
    if (page.missing) return null
    const match = /\{\{干员页面名\|([^|}]+)/.exec(page.content)
    return match ? cleanShort(match[1]) : null
  } catch {
    return null
  }
}

/**
 * 检索一个名字，若对应某个干员页则返回 { operator, title }。
 *
 * @param {string} name
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function lookupOperatorByName (name, { signal } = {}) {
  if (typeof name !== 'string' || name.length < 2) return null
  if (cache.has(name)) return cache.get(name)
  let result = null
  try {
    const titles = await searchTitles(name, { signal, limit: 5, what: 'title' })
    for (const title of titles) {
      if (title !== name && !title.startsWith(name)) continue
      const operator = await operatorOfPage(title, signal)
      if (operator) {
        result = { operator, title }
        break
      }
    }
  } catch {
    result = null
  }
  cache.set(name, result)
  return result
}

/**
 * 对预测结果里的「新角色」候选逐个做实装校验，命中的剔除并写进 caveats。
 *
 * @param {object} result predictDebut / predictBanners 的返回值
 * @param {{ entries?: Array<{name?: string}>, signal?: AbortSignal }} [options]
 */
export async function verifyCandidatesAgainstWiki (result, { entries = [], signal } = {}) {
  const operatorNames = new Set(entries.map(entry => entry?.name).filter(Boolean))
  const candidates = Array.isArray(result?.candidates) ? result.candidates : []
  const checked = []
  const removed = []
  for (const candidate of candidates) {
    const name = candidate?.operator
    const kind = candidate?.kind ?? candidate?._kind
    if (kind !== 'new' || !name) continue
    const hit = await lookupOperatorByName(name, { signal })
    checked.push(name)
    if (hit && (operatorNames.size === 0 || operatorNames.has(hit.operator))) {
      removed.push({ name, operator: hit.operator, title: hit.title, candidate })
    }
  }
  if (checked.length === 0) return result

  const verifiedAt = `实装校验：已对 ${checked.length} 个候选在 PRTS「干员一览」范围内按标题检索确认是否已有同名干员`
  if (removed.length > 0) {
    const kept = candidates.filter(candidate => !removed.some(item => item.candidate === candidate))
    const details = removed.map(item => `${item.name}＝干员「${item.operator}」（页面「${item.title}」）`).join('、')
    return {
      ...result,
      candidates: kept,
      prediction_basis: `${result.prediction_basis}；${verifiedAt}`,
      caveats: `${result.caveats} 实装校验：${details}，这些候选对应已推出的干员，已从候选中排除。`
    }
  }
  return { ...result, prediction_basis: `${result.prediction_basis}；${verifiedAt}` }
}
