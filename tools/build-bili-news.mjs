#!/usr/bin/env node
// Offline builder: 抓取 B 站「明日方舟」官方账号（mid 161775300）的动态快照。
//
// 为什么需要它：PRTS 的干员页要等角色上线前后才建立，而官方的「干员技能展示PV」
// 「活动先导PV」往往提前一两周就发了。把这些标题/文案收进 data/bili-news.json，
// 运行期就能在 basis / caveats 里说明「官方最近在宣什么」，并自动识别已经公布的
// 干员（省掉 data/announced-operators.json 里的人工维护）。
//
// 用法：
//   node tools/build-bili-news.mjs [--pages 3] [--out data/bili-news.json] [--mid 161775300]
//   node tools/build-bili-news.mjs --from-raw tmp-dynamics.json   # 用已抓到的原始响应重建
//
// 说明：
// - 只抓「动态」接口（x/polymer/web-dynamic/v1/feed/space）。B 站的投稿列表接口
//   （x/space/wbi/arc/search）现在对匿名请求基本一律返回 -352 风控，动态接口在
//   带上 buvid3/buvid4 + wbi 签名后通常还能用。
// - 图文长图公告（活动详情、干员立绘）在 API 里没有文本，只能拿到图片地址，
//   所以快照只保留视频标题与文案，不要指望能读到公告正文。
// - 运行期不联网：本脚本按需重跑，产物提交进仓库。

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { extractEventAnnouncements, extractOperatorAnnouncements } from '../lib/bili-news.js'

const args = process.argv.slice(2)
const readArg = (name, fallback) => {
  const index = args.indexOf(name)
  if (index >= 0 && args[index + 1]) return args[index + 1]
  const prefixed = args.find(arg => arg.startsWith(`${name}=`))
  return prefixed ? prefixed.split('=')[1] : fallback
}

const MID = Number(readArg('--mid', '161775300'))
const PAGES = Math.max(1, Number(readArg('--pages', '3')) || 3)
const OUT = readArg('--out', 'data/bili-news.json')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const SPACE_URL = `https://space.bilibili.com/${MID}/dynamic`
const MIXIN_KEY_ENC_TAB = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]

const jar = new Map()
const cookieHeader = () => [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ')

function storeCookies (res) {
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';')
    const index = pair.indexOf('=')
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
  }
}

async function request (url, extra = {}) {
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      referer: SPACE_URL,
      origin: 'https://space.bilibili.com',
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      cookie: cookieHeader(),
      ...extra
    },
    signal: AbortSignal.timeout(25000)
  })
  storeCookies(res)
  return res
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// buvid3 / buvid4：没有它们，动态接口会直接 -412 风控。
async function primeCookies () {
  const res = await request('https://api.bilibili.com/x/frontend/finger/spi')
  const json = JSON.parse(await res.text())
  const b3 = json?.data?.b_3
  const b4 = json?.data?.b_4
  if (b3) jar.set('buvid3', b3)
  if (b4) jar.set('buvid4', b4)
  if (!b3) throw new Error('bilibili: 没能从 x/frontend/finger/spi 拿到 buvid3')
}

async function wbiKeys () {
  const res = await request('https://api.bilibili.com/x/web-interface/nav')
  const json = JSON.parse(await res.text())
  const imgUrl = json?.data?.wbi_img?.img_url ?? ''
  const subUrl = json?.data?.wbi_img?.sub_url ?? ''
  const imgKey = imgUrl.slice(imgUrl.lastIndexOf('/') + 1, imgUrl.lastIndexOf('.'))
  const subKey = subUrl.slice(subUrl.lastIndexOf('/') + 1, subUrl.lastIndexOf('.'))
  if (!imgKey || !subKey) throw new Error('bilibili: nav 没返回 wbi 密钥')
  const raw = imgKey + subKey
  return MIXIN_KEY_ENC_TAB.map(index => raw[index] ?? '').join('').slice(0, 32)
}

function wbiSign (params, mixinKey) {
  const all = { ...params, wts: Math.round(Date.now() / 1000) }
  const query = Object.keys(all)
    .sort()
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(all[key]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  const wRid = createHash('md5').update(query + mixinKey).digest('hex')
  return `${query}&w_rid=${wRid}`
}

async function fetchFeed (mixinKey) {
  const items = []
  const seen = new Set()
  let offset = ''
  for (let page = 0; page < PAGES; page++) {
    const query = wbiSign({
      host_mid: MID,
      offset,
      timezone_offset: -480,
      platform: 'web'
    }, mixinKey)
    let json = null
    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await request(`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?${query}`)
      const text = await res.text()
      try {
        json = JSON.parse(text)
      } catch {
        throw new Error(`bilibili: 动态接口返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`)
      }
      if (json.code === 0) break
      if (![412, -352, -799].includes(json.code)) {
        throw new Error(`bilibili: 动态接口返回 ${json.code} ${json.message ?? ''}`)
      }
      console.error(`bilibili: 风控 ${json.code}（第 ${attempt} 次），${attempt * 1500}ms 后重试`)
      await sleep(attempt * 1500)
      json = null
    }
    if (!json) throw new Error('bilibili: 动态接口连续被风控，稍后再跑（间隔 1~2 分钟），或换网络环境')
    const batch = json.data?.items ?? []
    if (page === 0 && batch.length === 0) {
      console.error(`bilibili: 首页返回 code=${json.code} items=0 keys=${Object.keys(json.data ?? {}).join(',')} offset=${json.data?.offset ?? ''} has_more=${json.data?.has_more}`)
    }
    for (const item of batch) {
      if (!item?.id_str || seen.has(item.id_str)) continue
      seen.add(item.id_str)
      items.push(item)
    }
    offset = json.data?.offset ?? ''
    if (!json.data?.has_more || !offset) break
    await sleep(400)
  }
  return items
}

function normalize (item) {
  const modules = item.modules ?? {}
  const author = modules.module_author ?? {}
  const dynamic = modules.module_dynamic ?? {}
  const major = dynamic.major ?? {}
  const desc = dynamic.desc ?? {}
  const rich = (desc.rich_text_nodes ?? []).map(node => node.text ?? '').join('')
  const title = (major?.opus?.title ?? major?.archive?.title ?? '').trim()
  const opusSummary = major?.opus?.summary?.text ?? ''
  const archiveDesc = major?.archive?.desc ?? ''
  const text = [desc.text ?? rich, opusSummary, archiveDesc].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
  const ts = Number(author.pub_ts) * 1000
  const date = Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString().slice(0, 10) : String(author.pub_time ?? '')
  const bvid = major?.archive?.bvid
  const url = bvid ? `https://www.bilibili.com/video/${bvid}` : `https://t.bilibili.com/${item.id_str}`
  return {
    id: item.id_str,
    date,
    type: String(item.type ?? '').replace('DYNAMIC_TYPE_', '') || 'UNKNOWN',
    title,
    text: text.slice(0, 400),
    url
  }
}

// --from-raw <path>：跳过网络，直接用之前抓到的原始响应数组重建快照。
// B 站对匿名请求的限流时松时紧，抓不到的时候可以先手工存一份原始 JSON 再重建。
const fromRaw = readArg('--from-raw', '')
let raw = []
if (fromRaw) {
  const parsed = JSON.parse(await readFile(fromRaw, 'utf8'))
  raw = Array.isArray(parsed) ? parsed : (parsed.items ?? [])
  console.error(`bilibili: 从 ${fromRaw} 读取 ${raw.length} 条原始动态`)
} else {
  await primeCookies()
  const mixinKey = await wbiKeys()
  raw = await fetchFeed(mixinKey)
}
if (raw.length === 0) throw new Error('bilibili: 没有抓到任何动态')

const items = raw
  .map(normalize)
  .filter(item => item.title || item.text)
  .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

const operators = extractOperatorAnnouncements(items)
const events = extractEventAnnouncements(items)
const dates = items.map(item => item.date).filter(Boolean).sort()
const payload = {
  generatedAt: new Date().toISOString().slice(0, 10),
  source: {
    name: '明日方舟（B 站官方账号）',
    mid: MID,
    spaceUrl: `https://space.bilibili.com/${MID}`,
    note: '只收录带文字的视频标题/文案；图文长图公告在 API 里没有文本。'
  },
  window: { from: dates[0] ?? null, to: dates[dates.length - 1] ?? null, fetched: raw.length, kept: items.length, pages: PAGES },
  operators,
  events,
  items
}

await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
console.error(`wrote ${OUT}: ${items.length} items (${payload.window.from} ~ ${payload.window.to}), ${operators.length} operator PV, ${events.length} event PV`)
