#!/usr/bin/env node
// Builds data/collab-events.json — the list of 联动剧情 (collab SideStories).
//
// 用户要求（0.9.0）：联动剧情参考价值较小，在联动剧情里出场过的角色只给约
// +2% 的轻微加成，未出场角色不扣分。要判断「是否在联动剧情里出场过」，就得
// 先知道哪些剧情是联动——PRTS 没有给剧情表打联动标记，但「联动」页面会逐个
// 作品列出「联动SideStory《[[…]]》开启」，从那里取名字即可。
//
// Usage:
//   node tools/build-collab-events.mjs [--out data/collab-events.json]

import { writeFile } from 'node:fs/promises'
import { pageContent, cleanShort } from '../lib/prts.js'

const args = process.argv.slice(2)
const readArg = (name, fallback) => {
  const index = args.indexOf(name)
  if (index >= 0 && args[index + 1]) return args[index + 1]
  const prefixed = args.find(arg => arg.startsWith(`${name}=`))
  return prefixed ? prefixed.split('=')[1] : fallback
}

const out = readArg('--out', 'data/collab-events.json')

const page = await pageContent('联动', { timeoutMs: 25000, retries: 2 })
if (page.missing) {
  console.error('PRTS「联动」页面不存在，无法识别联动剧情')
  process.exit(1)
}

// 只认「联动SideStory《[[标题]]》」：同一页里还有大量「作为联动内容出现在
// 其它作品」的记录（三角洲行动、Muse Dash 等），那些不是泰拉侧的剧情。
const names = []
for (const match of page.content.matchAll(/联动SideStory《\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/g)) {
  const name = cleanShort(match[1])
  if (name && !names.includes(name)) names.push(name)
}
if (names.length === 0) {
  console.error('没有在「联动」页面里找到联动SideStory，数据未更新')
  process.exit(1)
}

const payload = {
  generatedAt: new Date().toISOString(),
  source: 'PRTS「联动」页面中的联动SideStory',
  count: names.length,
  events: names
}

await writeFile(out, JSON.stringify(payload, null, 1) + '\n', 'utf8')
console.error(`identified ${names.length} collab story events: ${names.join('、')}`)
console.log(`wrote ${out}`)
