/**
 * Thin PRTS Wiki client: MediaWiki API transport, Cargo queries, wikitext
 * template extraction, and the small amount of text cleanup the model needs.
 *
 * Everything here is data-layer only — no tool schema, no rendering.
 */

export const API_ENDPOINT = 'https://prts.wiki/api.php'
export const WIKI_BASE = 'https://prts.wiki/w/'

/** PRTS rejects requests without a browser-like identity. */
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': 'zh-CN,zh;q=0.9'
}

const DEFAULT_TIMEOUT_MS = 8000

export class PrtsError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number, retryable?: boolean }} [details]
   */
  constructor (message, details = {}) {
    super(message)
    this.name = 'PrtsError'
    this.code = details.code
    this.status = details.status
    this.retryable = details.retryable ?? false
  }
}

/**
 * Fetch implementation carrying the required PRTS identity. ark-info accepts a
 * `fetch` override, so operator queries can reuse the same headers/signal.
 *
 * @param {AbortSignal} [signal]
 */
export function prtsFetch (signal) {
  return (input, init = {}) => fetch(input, { ...init, headers: { ...HEADERS, ...(init.headers ?? {}) }, signal })
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * One MediaWiki API call, with a timeout, one retry for transient failures, and
 * explicit cancellation support.
 *
 * @param {Record<string, string | number | boolean | undefined>} params
 * @param {{ signal?: AbortSignal, timeoutMs?: number, retries?: number }} [options]
 */
export async function apiGet (params, options = {}) {
  const { signal, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 1 } = options
  const url = new URL(API_ENDPOINT)
  for (const [key, value] of Object.entries({ format: 'json', formatversion: '2', ...params })) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }

  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const timeout = AbortSignal.timeout(timeoutMs)
    const composed = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const response = await fetch(url, { headers: HEADERS, signal: composed, redirect: 'follow' })
      const text = await response.text()
      if (!response.ok) {
        throw new PrtsError(`PRTS 接口返回 HTTP ${response.status}`, {
          status: response.status,
          retryable: response.status === 429 || response.status >= 500
        })
      }
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        throw new PrtsError('PRTS 返回的响应不是合法 JSON')
      }
      if (payload && typeof payload === 'object' && payload.error) {
        throw new PrtsError(`PRTS 接口错误：${payload.error.info ?? payload.error.code}`, {
          code: String(payload.error.code ?? '')
        })
      }
      return payload
    } catch (error) {
      lastError = normalizeError(error, { signal, timeout })
      if (!lastError.retryable || attempt === retries) break
      await sleep(250 * (attempt + 1))
    }
  }
  throw lastError
}

function normalizeError (error, { signal, timeout }) {
  if (error instanceof PrtsError) return error
  if (signal?.aborted) return new PrtsError('调用方已取消查询', { code: 'ABORTED' })
  if (timeout.aborted) return new PrtsError(`PRTS 请求超时（>${DEFAULT_TIMEOUT_MS}ms）`, { code: 'TIMEOUT', retryable: true })
  const cause = error?.cause?.code ?? error?.code ?? ''
  return new PrtsError(`无法连接 PRTS：${error?.message ?? String(error)}${cause ? ` (${cause})` : ''}`, {
    code: 'NETWORK',
    retryable: true
  })
}

/**
 * Run one Cargo query (structured PRTS tables).
 *
 * @param {{ tables: string, fields: string, where?: string, orderBy?: string, limit?: number }} query
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Array<Record<string, string>>>}
 */
export async function cargoQuery (query, options = {}) {
  const payload = await apiGet({
    action: 'cargoquery',
    tables: query.tables,
    fields: query.fields,
    where: query.where,
    order_by: query.orderBy,
    limit: String(query.limit ?? 20)
  }, options)
  return (payload?.cargoquery ?? []).map(row => row.title ?? {})
}

/**
 * Page titles matching a full-text query.
 *
 * @param {string} query
 * @param {{ signal?: AbortSignal, limit?: number }} [options]
 */
export async function searchTitles (query, options = {}) {
  const payload = await apiGet({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: String(options.limit ?? 8),
    srnamespace: '0'
  }, options)
  return (payload?.query?.search ?? []).map(hit => hit.title)
}

/**
 * Raw wikitext of one page, following redirects.
 *
 * @param {string} title
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ title: string, missing: boolean, content: string }>}
 */
export async function pageContent (title, options = {}) {
  const payload = await apiGet({
    action: 'query',
    prop: 'revisions',
    rvslots: 'main',
    rvprop: 'content',
    titles: title,
    redirects: '1'
  }, options)
  const rawPages = payload?.query?.pages ?? []
  const pages = Array.isArray(rawPages) ? rawPages : Object.values(rawPages)
  const page = pages[0]
  if (!page || page.missing) return { title, missing: true, content: '' }
  return {
    title: page.title ?? title,
    missing: false,
    content: page.revisions?.[0]?.slots?.main?.content ?? ''
  }
}

/**
 * Extract the parameters of the first matching `{{模板|k=v|...}}` invocation.
 * Nested templates and links are handled; the outermost match wins.
 *
 * @param {string} wikitext
 * @param {string[]} templateNames
 * @returns {Record<string, string> | null}
 */
export function extractTemplateParams (wikitext, templateNames) {
  for (const templateName of templateNames) {
    let from = 0
    for (;;) {
      const start = wikitext.indexOf('{{' + templateName, from)
      if (start < 0) break
      const inner = balancedInner(wikitext, start)
      if (inner !== null) {
        const params = splitParams(inner)
        if (params) return params
      }
      from = start + 2
    }
  }
  return null
}

/**
 * Every `{{模板|...}}` invocation whose template name matches `namePattern`,
 * in document order. Nested templates are skipped once matched, so a table of
 * identical templates (skill slots, talent blocks) comes back one entry each.
 *
 * @param {string} wikitext
 * @param {RegExp} namePattern
 * @param {{ limit?: number, before?: number }} [options]
 * @returns {Array<{ name: string, params: Record<string, string>, before: string }>}
 */
export function extractTemplates (wikitext, namePattern, options = {}) {
  const { limit = 12, before = 200 } = options
  const found = []
  if (typeof wikitext !== 'string') return found
  for (let index = 0; index < wikitext.length; index += 1) {
    if (wikitext.slice(index, index + 2) !== '{{') continue
    const inner = balancedInner(wikitext, index)
    if (inner === null) continue
    const name = splitTopLevel(inner, '|')[0].trim()
    if (namePattern.test(name)) {
      const params = splitParams(inner)
      if (params) {
        found.push({
          name,
          params,
          before: before > 0 ? wikitext.slice(Math.max(0, index - before), index) : ''
        })
        if (found.length >= limit) break
      }
    }
    // Skip the whole invocation so nested templates are not reported again.
    index += inner.length + 3
  }
  return found
}

/** Return the text between `{{` and its matching `}}`, or null when unbalanced. */
function balancedInner (text, start) {
  let depth = 0
  for (let index = start; index < text.length; index += 1) {
    const pair = text.slice(index, index + 2)
    if (pair === '{{') {
      depth += 1
      index += 1
      continue
    }
    if (pair === '}}') {
      depth -= 1
      if (depth === 0) return text.slice(start + 2, index)
      index += 1
    }
  }
  return null
}

/** Split one template body into its name plus `key=value` parameters. */
function splitParams (inner) {
  const parts = splitTopLevel(inner, '|')
  if (parts.length === 0) return null
  const params = {}
  for (const part of parts.slice(1)) {
    const separator = topLevelIndexOf(part, '=')
    if (separator < 0) continue
    const key = part.slice(0, separator).trim()
    if (!key) continue
    params[key] = part.slice(separator + 1).trim()
  }
  return Object.keys(params).length > 0 ? params : null
}

function splitTopLevel (text, separator) {
  const parts = []
  let start = 0
  let templateDepth = 0
  let linkDepth = 0
  for (let index = 0; index < text.length; index += 1) {
    const pair = text.slice(index, index + 2)
    if (pair === '{{') {
      templateDepth += 1
      index += 1
      continue
    }
    if (pair === '}}') {
      templateDepth -= 1
      index += 1
      continue
    }
    if (pair === '[[') {
      linkDepth += 1
      index += 1
      continue
    }
    if (pair === ']]') {
      linkDepth -= 1
      index += 1
      continue
    }
    if (text[index] === separator && templateDepth === 0 && linkDepth === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

function topLevelIndexOf (text, needle) {
  const parts = splitTopLevel(text, needle)
  return parts.length > 1 ? parts[0].length : -1
}

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' '
}

const HTML_TAGS = /<\/?(?:br|span|div|p|b|i|u|s|big|small|sup|sub|ref|nowiki|center|font|code|pre|table|tr|td|th|ul|ol|li|hr)\b[^>]*>/gi

/** Templates that render as an icon only — dropping them keeps the text readable. */
const ICON_TEMPLATES = new Set(['fa', '图标', '技能图标', '材料图标', '职业图标', '干员图标', '物品图标', '模组图标', '头像', '立绘'])

/**
 * Render one innermost `{{...}}` body as plain text.
 *
 * PRTS templates that carry prose put it in the *last* positional parameter
 * (`{{color|#0098DC|+30}}`, `{{术语|ba.stun|晕眩}}`, `{{修正|新文本|原文=…}}`),
 * while named parameters are metadata and must not leak into the text.
 */
function templateText (body) {
  const parts = splitTopLevel(body, '|')
  const name = parts[0].trim()
  const positional = parts.slice(1).filter(part => topLevelIndexOf(part, '=') < 0)
  if (ICON_TEMPLATES.has(name)) return ''
  if (positional.length === 0) return ''
  if (name === '材料消耗') return positional[0].trim()
  return positional[positional.length - 1].trim()
}

/**
 * Turn PRTS wikitext/HTML fragments into single-line plain text.
 *
 * @param {unknown} value
 * @param {number} [maxLength]
 */
export function cleanText (value, maxLength = 600) {
  if (typeof value !== 'string') return ''
  let text = value
  for (let pass = 0; pass < 3; pass += 1) {
    const replaced = text.replace(/\{\{([^{}]*)\}\}/g, (_match, body) => templateText(body))
    if (replaced === text) break
    text = replaced
  }
  text = text
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\[(?:https?:)?\/\/[^\s\]]+\s+([^\]]*)\]/g, '$1')
    .replace(HTML_TAGS, ' ')
    .replace(/'{2,}/g, '')
  for (const [entity, char] of Object.entries(ENTITIES)) {
    text = text.split(entity).join(char)
  }
  text = text.replace(/\s+/g, ' ').trim()
  return text.length > maxLength ? text.slice(0, maxLength - 1) + '…' : text
}

/** Strip HTML/wiki markup without truncation (for short structured fields). */
export function cleanShort (value) {
  return cleanText(value, 200)
}

/** Parse a numeric wiki field, returning null when it is not a number. */
export function toNumber (value) {
  const parsed = Number(String(value ?? '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

/** Split a comma/、/whitespace separated wiki list into clean entries. */
export function splitList (value, maxItems = 24) {
  return String(value ?? '')
    .split(/[,，、;；\n]/)
    .map(entry => cleanShort(entry))
    .filter(Boolean)
    .slice(0, maxItems)
}

export { splitTopLevel }
