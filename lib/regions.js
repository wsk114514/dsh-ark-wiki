/**
 * Shared region (国家/势力) aliases used by both the banner predictor and the
 * story-signal index. Kept in its own module so `banners.js` and
 * `story-signals.js` can agree on what "莱塔尼亚" means without importing each
 * other.
 */

export const REGION_ALIASES = [
  ['莱塔尼亚', ['莱塔尼亚']],
  ['维多利亚', ['维多利亚']],
  ['龙门', ['龙门']],
  ['炎国', ['炎国', '大炎', '炎']],
  ['叙拉古', ['叙拉古']],
  ['拉特兰', ['拉特兰']],
  ['乌萨斯', ['乌萨斯']],
  ['哥伦比亚', ['哥伦比亚']],
  ['卡西米尔', ['卡西米尔']],
  ['谢拉格', ['谢拉格']],
  ['伊比利亚', ['伊比利亚']],
  ['阿戈尔', ['阿戈尔']],
  ['萨尔贡', ['萨尔贡']],
  ['米诺斯', ['米诺斯']],
  ['萨米', ['萨米']],
  ['雷姆必拓', ['雷姆必拓']],
  ['玻利瓦尔', ['玻利瓦尔']],
  ['东国', ['东国']],
  ['汐斯塔', ['汐斯塔']],
  ['罗德岛', ['罗德岛']],
  ['企鹅物流', ['企鹅物流']],
  ['莱茵生命', ['莱茵生命']],
  ['喀兰贸易', ['喀兰贸易']],
  ['深海猎人', ['深海猎人']],
  ['整合运动', ['整合运动']]
]

/** True when the operator's faction fields mention any alias of `region`. */
export function operatorMatchesRegion (entry, region) {
  if (!region?.keys) return false
  const fields = [entry?.nation, entry?.organization, entry?.team]
    .filter(Boolean)
    .map(value => String(value))
  return fields.some(field => region.keys.some(key => field.includes(key)))
}

/**
 * Every canonical region an operator belongs to, e.g. `炎-龙门` → 龙门 (and
 * 炎国, because the alias list contains 炎). Used to attribute story
 * appearances to regions.
 */
export function canonicalRegions (entry) {
  const canonical = []
  for (const [name, keys] of REGION_ALIASES) {
    if (operatorMatchesRegion(entry, { canonical: name, keys })) canonical.push(name)
  }
  return canonical
}

/** Resolve a canonical region name back to its `{canonical, keys}` descriptor. */
export function regionForCanonical (canonical) {
  const hit = REGION_ALIASES.find(([name]) => name === canonical)
  return hit ? { canonical: hit[0], keys: hit[1] } : null
}
