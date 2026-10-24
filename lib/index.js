/**
 * dsh-ark-wiki — PRTS 明日方舟 Wiki lookup tool.
 *
 * The tool contract is deliberately narrow: one query in, one canonical JSON
 * record out. Data access lives in `sources.js` / `prts.js`, so this module only
 * owns the model-facing schema, the structured error envelope, and rendering.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { API_ENDPOINT, PrtsError } from './prts.js'
import { resolveLookup } from './sources.js'
import { runBannerPrediction } from './banners.js'

const STATUS_VALUES = ['ok', 'not_found', 'error']
const CATEGORY_VALUES = ['operator', 'item', 'stage', 'story', 'world', 'unknown']
const MATCH_VALUES = ['exact', 'prefix', 'fuzzy', 'redirect', 'search', 'none']

export const arkWikiLookup = defineTool({
  name: 'ark_wiki_lookup',
  description: [
    '查询明日方舟 PRTS Wiki 的结构化资料：干员（职业、星级、特性、阵营、上线时间、获取方式、',
    '战斗技能及其各等级数值、天赋与潜能增强、基建技能、体检档案与档案资料、干员密录）、',
    '物品/材料（稀有度、描述、用途、获得方式）、关卡（理智消耗、推荐等级、掉落、敌人构成、突袭条件、关联剧情）、',
    '剧情（按标题查主线/活动/密录剧情，返回所属章节、登场角色与台词节选；也可查「某干员的出场剧情」',
    '——按时间顺序返回该干员在主线/活动/密录中登场的剧情列表与最早出场）、',
    '世界观（泰拉大典：地理、组织、种族、人物考据、百科词条、泰拉年表与泰拉词库术语译名）。',
    '回答明日方舟相关问题时先调用本工具，再依据返回值作答；返回字段为 null 表示 PRTS 未提供该字段，',
    'status 为 not_found 或 error 时不要凭记忆补全，应按 message 与 candidates 处理或如实说明查不到。'
  ].join(''),
  parameters: {
    query: {
      type: 'string',
      required: true,
      description: '要查询的名称或代号，用简体中文正式译名，例如「阿米娅」「至纯源石」「1-7」「S4-7」「0-1 坍塌 行动前」「克莱门莎 出场」「维多利亚」。也接受干员的英文名、日文名（如「Amiya」「アーミヤ」）与剧情页标题（如「12F 干员密录」）。'
    },
    category: {
      type: 'string',
      enum: CATEGORY_VALUES.slice(0, 5),
      description: '限定词条类型：operator 干员、item 物品/材料、stage 关卡、story 剧情或干员出场、world 泰拉大典世界观条目。省略时按名称自动判断（含「行动前/行动后/密录/出场」的按剧情先查，含「泰拉大典/世界观/考据/年表/词库」的按世界观先查，关卡代号先查关卡，其余先查物品再查干员）。同一名称同时对应多类词条时可指定本参数消歧。'
    }
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: {
          type: 'string',
          required: true,
          enum: STATUS_VALUES,
          description: 'ok 表示已命中；not_found 表示 PRTS 没有匹配条目；error 表示数据源或网络失败。'
        },
        category: {
          type: 'string',
          required: true,
          enum: CATEGORY_VALUES,
          description: '实际查询（或尝试）的词条类型；未能判定时为 unknown。'
        },
        query: { type: 'string', required: true, description: '调用方给出的原始查询词。' },
        matchedBy: {
          type: 'string',
          required: true,
          enum: MATCH_VALUES,
          description: '命中方式：exact 完全同名，prefix 前缀近似，fuzzy 模糊近似，redirect 页面重定向，search 搜索结果，none 未命中。'
        },
        entry: {
          type: 'json',
          description: '命中时的结构化词条。干员含 skills（每技能各等级描述与 SP/持续）、talents（天赋与潜能增强）、buildingSkills（基建技能）、profile（体检档案：出身地/身高/感染情况/六维评级）、archives（档案资料全文）、records（干员密录）；物品含 rarity/rarityStars/kind/usage/obtain 等；关卡含 sanityCost/recommendedLevel/firstClearDrops/enemies/challenge/story（关联的行动前/后剧情页）；剧情含 chapter/kind/storyType/storyGroup/characters/lines（台词节选），干员出场（kind=干员出场）含 operator/profession/rarity/total/counts/earliest/appearances（按时间排序的登场剧情，date 仅在 PRTS 有开放时间时给出）；world 含 section/title/summary/infobox/sections/related，或 kind=术语对照 时的 terms（泰拉词库译名）。'
        },
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              category: { type: 'string', required: true, description: '候选词条类型。' },
              name: { type: 'string', required: true, description: '候选名称，可直接用作下一次 query。' },
              detail: { type: 'string', description: '用于消歧的简要说明。' }
            }
          },
          description: '未精确命中时的相近条目，最多 8 条。'
        },
        message: { type: 'string', required: true, description: '状态说明：命中方式、未找到原因、数据源错误或转义建议。' },
        source: {
          type: 'object',
          additionalProperties: false,
          properties: {
            endpoint: { type: 'string', required: true, description: 'PRTS MediaWiki API 端点。' },
            page: { type: 'string', description: '对应 PRTS 页面地址（仅命中时给出）。' }
          }
        }
      }
    },
    render (args, value) {
      return [{ type: 'text', text: renderLookup(value) }]
    }
  },
  timeoutMs: 30000,
  isConcurrencySafe: true,
  async execute (args, exec) {
    try {
      return await resolveLookup(args.query, args.category, { signal: exec?.signal })
    } catch (error) {
      const message = error instanceof PrtsError
        ? `${error.message}${error.retryable ? '（网络类错误，可稍后重试）' : ''}`
        : `查询 PRTS 时出现未预期的错误：${error?.message ?? String(error)}`
      return {
        status: 'error',
        category: args.category ?? 'unknown',
        query: String(args.query ?? ''),
        matchedBy: 'none',
        entry: null,
        candidates: [],
        message,
        source: { endpoint: API_ENDPOINT }
      }
    }
  }
})

// ---------------------------------------------------------------------------
// ark_banner_predict: probabilistic next-banner prediction.
// ---------------------------------------------------------------------------

const BANNER_TYPE_VALUES = ['debut', 'standard', 'limited', 'rerun', 'kernel']
const REGION_VALUES = ['cn', 'global', 'jp', 'kr', 'tw']
const CONFIDENCE_VALUES = ['high', 'medium', 'low']
const SIGNAL_VALUES = [
  'skin_rerun',
  'interval_overdue',
  'story_tie_in',
  'story_appearance',
  'story_recent',
  'collab_cameo',
  'alter_candidate',
  'long_tenure',
  'anniversary_window',
  'merch_or_ep'
]

export const arkBannerPredict = defineTool({
  name: 'ark_banner_predict',
  description: [
    '预测明日方舟接下来可能上线的卡池，默认目标是「剧情里已经出场、但还没有进过卡池的新角色」以及最可能异格的老角色，',
    '返回候选、置信度、理由与所用信号。数据来自 PRTS 剧情页台词统计（2019 年至今全部主线/活动剧情，约 1500 段）、',
    '「干员剧情一览」的出场记录与「卡池一览」的历史排期。',
    '新角色信号：地区线索（如「下个版本回阿戈尔/伊比利亚」）会提高该地区剧情里反复出现的未实装人物；',
    '地区吻合要求该地区剧情票 ≥5 且占该人物出场票的一半以上，避免被同场其他阵营的干员「带票」（普瑞赛斯、奥卢斯这类跨地区人物会被排除）；',
    '计算占比时会排除剧情常驻机构「罗德岛」的同场票——它几乎每段剧情都有大量干员出场，会把主线本地角色稀释成「罗德岛人物」（费奥多尔过去因此拿不到乌萨斯占比）；',
    '主线高频、塑造完整、呼声高的未实装角色（如维特、仲裁人）会因出场段数多而排前；',
    '但 BOSS 模板或主线核心这类「叙事分量极重」的角色常被官方留作大型活动主角，因此整体票数会下调 5%；',
    '纯活动高频（主线 0 段、活动 ≥10 段）的角色有补偿加分，不会被主线戏份系统性压过。',
    '异格信号：老角色 2 年以上没有新剧情时，异格实装概率上升（阈值 730 天，3 年以上加权更重）；',
    '首次进池时间超过 4 年的干员，异格概率再按规则提高约 18%（上限 20%），并在理由里给出首次进池日期。',
    '联动信号：联动剧情（源石尘行动/水晶箭行动/无忧梦呓这类联动SideStory）与泰拉主线的排期关系弱、参考价值较小，',
    '在其中出场过的角色只加约 2%，未在联动剧情出场的角色不扣分。',
    '实装校验：给出候选前会对照 PRTS「干员一览」的代号、外文名/日文名，以及干员页「客观履历」里声明的本名与外号（如梅捷缇克缇＝缇缇、阿娜特＝莎草），',
    '候选定下来后再按标题检索候选名、命中干员页即判为已实装干员的本名/别名（如「玛嘉烈」→「玛嘉烈・临光」→干员「临光」），',
    '凡是已经推出过的干员一律从候选中排除，并在 caveats 里写明「实装校验」的排除项。',
    '已公布名单：官方前瞻直播/公告常常比 PRTS 干员页提前一两周公布六星，这段窗口用 data/announced-operators.json 兜底——名单里的角色（如塔露拉、乌萨斯小皇帝＝费奥多尔、内卫）不进候选，caveats 会写明「已公布实装」；PRTS 建页后运行期实装校验会自动接管。',
    '官方 B 站动态（data/bili-news.json 快照）：把「干员『X』技能展示PV」也当作已公布实装剔除（caveats 注明来源是 B 站），把 SideStory/故事集/主线 PV 与地区提及写进 prediction_basis 的「官方动态」一行；',
    '这些只做旁证、不参与打分——B 站接口只能读到视频标题与文案，图文长图公告没有文本，快照超过 30 天会提示更新。',
    '地区线索补充：hint 里带地区时，会再从该地区挑最多 3 名已实装干员，读其档案与干员密录，摘出提到该地区的句子放进 prediction_basis 末尾的「档案/密录线索」与 dossier_clues 字段；',
    '这些片段（如「谬因」档案「原哥伦比亚卢米内斯大学副教授」）只是文本弱信号，不参与排序，也不能当作官方预告。',
    '已知限制：说话者靠台词 `[name="…"]` 统计，别名可能与本人重复计数，群众角色可能被误当成人物；',
    '地区归属用同场出场干员的阵营投票，跨地区剧情会高估地区新鲜度；地区吻合按 5 票 + 50% 占比过滤后，剧情里只是客串的人物不会再被当成当地角色。',
    '卡池排期模式下（standard/limited/rerun/kernel）：往期限定干员不会进入后续卡池，只能在对应限定寻访中通过兑换（井）获得，',
    '因此限定/复刻类预测不把已有限定列为候选，只推断同池陪跑 6★。春节/新年限定不预测，遇到此类 hint 会直接返回空候选。',
    '这是概率性预测，不是官方排期：confidence 为 low 时表示线索不足或数据降级，必须在回答中转述 prediction_basis 与 caveats，',
    '不要把它说成确定消息，也不要伪造 high 置信度。输出末尾固定附一张「预测结果」表格（顺序/角色/类型/置信度/关键依据），'
      + '回答时可直接转述该表格，不要自行改动其中的顺序与置信度。',
    '如果用户问的是某个具体干员「下次什么时候 UP」，可先调用 ark_wiki_lookup 查该干员的上线时间与阵营，再调用本工具。'
  ].join(''),
  parameters: {
    hint: {
      type: 'string',
      required: true,
      description: '预测线索，例如「下个版本回阿戈尔」「主线维多利亚」「安洁莉娜很久没剧情了」「塔露拉会实装吗」或「随便猜猜」。可包含版本方向、活动地区、季节、角色名与卡池类型；没提到卡池类型时默认按「新角色/异格」预测。春节/新年限定会被直接跳过（返回空候选）。'
    },
    banner_type: {
      type: 'string',
      enum: BANNER_TYPE_VALUES,
      description: '预测模式：debut 新角色/异格（默认）、standard 常驻标准轮换、limited 限定寻访（庆典/夏季/联动，只推断陪跑 6★）、rerun 复刻（同陪跑）、kernel 中坚寻访。省略时按 hint 自动推断。'
    },
    region: {
      type: 'string',
      enum: REGION_VALUES,
      description: '服务器排期：cn 国服（默认）、global 国际服、jp 日服、kr 韩服、tw 繁中服。非国服只在 caveats 中提示版本偏移，不做精确换算。'
    }
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prediction_basis: {
          type: 'string',
          required: true,
          description: '本次预测的依据：用了哪些卡池页、多少期历史、当前时间、hint 识别出的信号，以及数据降级说明。'
        },
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              operator: { type: 'string', required: true, description: '候选名称（干员代号或未实装人物名），可直接用 ark_wiki_lookup 继续查。' },
              kind: {
                type: 'string',
                enum: ['new', 'alter'],
                description: '仅新角色/异格模式返回：new 未实装的新角色、alter 已有干员的异格候选。'
              },
              confidence: {
                type: 'string',
                required: true,
                enum: CONFIDENCE_VALUES,
                description: 'high 表示多条信号共振，medium 表示有单一强信号，low 表示线索不足或数据降级。'
              },
              reason: { type: 'string', required: true, description: '该候选的排序理由，含具体天数与信号。' },
              signals: {
                type: 'array',
                items: { type: 'string', enum: SIGNAL_VALUES },
                description: '命中的信号：story_appearance 剧情中反复出现的未实装人物、story_tie_in 剧情地区与 hint 吻合、story_recent 近期剧情活跃、collab_cameo 在联动剧情里出场过（+2% 弱信号）、alter_candidate 老角色长期无新剧情的异格候选、long_tenure 首次进池已超过 4 年（异格 +18%）、skin_rerun 皮肤/时装复刻、interval_overdue 进店间隔超期、anniversary_window 周年/季节窗口、merch_or_ep 周边或 EP 线索（当前可能为空）。'
              }
            }
          },
          description: '按分数排序的 3–4 名候选；新角色/异格模式含 kind 字段，春节/新年限定或数据不可用时为空数组。'
        },
        caveats: {
          type: 'string',
          required: true,
          description: '必须转述给用户的不确定性说明：预测性质、数据滞后、复刻窗口规律、服务器偏移等。'
        },
        dossier_clues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              operator: { type: 'string', required: true, description: '档案/密录所属的已实装干员。' },
              source: { type: 'string', required: true, enum: ['档案', '密录'], description: '片段来源：干员档案或干员密录。' },
              title: { type: 'string', description: '档案段标题（如「档案资料三」）或密录标题。' },
              text: { type: 'string', required: true, description: '提及本次地区的片段原文（已截断）。' },
              url: { type: 'string', description: 'PRTS 页面链接。' }
            }
          },
          description: '仅新角色/异格模式且 hint 含地区时返回：本地区相关干员的档案与密录里提到该地区的片段，属弱信号，不参与候选排序。'
        }
      }
    },
    render (args, value) {
      return [{ type: 'text', text: renderBanner(value) }]
    }
  },
  timeoutMs: 30000,
  isConcurrencySafe: true,
  async execute (args, exec) {
    try {
      return await runBannerPrediction(
        { hint: args.hint, banner_type: args.banner_type, region: args.region },
        { signal: exec?.signal }
      )
    } catch (error) {
      throw new Error(`卡池预测失败：${error?.message ?? String(error)}`)
    }
  }
})

// ---------------------------------------------------------------------------
// Rendering: bounded, key-first plain text for the model.
// ---------------------------------------------------------------------------

function compact (parts) {
  return parts.filter(Boolean).join(' · ')
}

function push (lines, text) {
  if (text) lines.push(text)
}

function renderDrops (drops) {
  return (drops ?? [])
    .map(drop => (drop.condition ? `${drop.name}（${drop.condition}）` : drop.name))
    .filter(Boolean)
    .join('、')
}

function renderEnemies (enemies) {
  const shown = (enemies ?? []).slice(0, 16)
  const text = shown
    .map(enemy => `${enemy.name}${enemy.count ? `×${enemy.count}` : ''}`)
    .join('、')
  return (enemies ?? []).length > shown.length ? `${text} 等 ${enemies.length} 种` : text
}

function renderOperator (entry, lines) {
  push(lines, `**${entry.name}** — 干员${entry.stars ? ` · ${entry.stars}★` : ''}`)
  push(lines, compact([
    entry.profession && `职业：${entry.profession}${entry.subProfession ? ` / ${entry.subProfession}` : ''}`,
    entry.position && `站位：${entry.position}`
  ]))
  push(lines, compact([
    (entry.nation || entry.organization || entry.team) && `阵营：${compact([entry.nation, entry.organization, entry.team])}`,
    entry.race && `种族：${entry.race}`,
    entry.sex && `性别：${entry.sex}`,
    entry.birthday && `生日：${entry.birthday}`
  ]))
  push(lines, entry.tags?.length ? `标签：${entry.tags.join('、')}` : '')
  push(lines, entry.feature ? `特性：${entry.feature}` : '')
  push(lines, entry.obtainMethod?.length ? `获取方式：${entry.obtainMethod.join('、')}` : '')
  push(lines, entry.releasedAt ? `上线时间：${entry.releasedAt.slice(0, 10)}` : '')
  push(lines, compact([
    entry.painter && `画师：${entry.painter}`,
    entry.designer && `设计：${entry.designer}`,
    entry.aliases?.length ? `其他名称：${entry.aliases.join(' / ')}` : ''
  ]))
  push(lines, entry.id ? `PRTS 条目 ID：${entry.id}` : '')

  if (entry.skills?.length) {
    lines.push('', `技能（${entry.skills.length} 个）：`)
    for (const skill of entry.skills) {
      push(lines, compact([
        `${skill.index}. ${skill.name}`,
        compact([skill.chargeType, skill.triggerType]),
        skill.unlock
      ]))
      for (const level of selectSkillLevels(skill.levels)) {
        const timing = skillTiming(level)
        push(lines, `   ${level.level}：${level.description}${timing ? `（${timing}）` : ''}`)
      }
    }
  }

  if (entry.talents?.length) {
    lines.push('', '天赋：')
    for (const talent of entry.talents) {
      talent.levels.forEach((level, index) => {
        const effect = `${level.effect}${level.potentialEffect ? `；潜能增强：${level.potentialEffect}` : ''}`
        const condition = level.condition ? `（${level.condition}）` : ''
        push(lines, index === 0 ? `- ${talent.name}${condition}：${effect}` : `  · ${level.condition ?? '默认'}：${effect}`)
      })
    }
  }

  if (entry.buildingSkills?.length) {
    push(lines, '', `基建技能：${entry.buildingSkills
      .map(skill => compact([skill.name, skill.phase, skill.level ? `Lv${skill.level}` : '']))
      .join('；')}`)
  }

  if (entry.profile) {
    const profile = entry.profile
    lines.push('', '体检档案：')
    push(lines, compact([
      profile.combatExperience && `战斗经验：${profile.combatExperience}`,
      profile.birthplace && `出身地：${profile.birthplace}`,
      profile.height && `身高：${profile.height}`,
      profile.infectionStatus && `矿石病：${profile.infectionStatus}`
    ]))
    push(lines, compact([
      profile.physicalStrength && `物理强度 ${profile.physicalStrength}`,
      profile.mobility && `战场机动 ${profile.mobility}`,
      profile.endurance && `生理耐受 ${profile.endurance}`,
      profile.tactics && `战术规划 ${profile.tactics}`,
      profile.combatSkill && `战斗技巧 ${profile.combatSkill}`,
      profile.artsAdaptability && `源石技艺 ${profile.artsAdaptability}`
    ]))
    push(lines, compact([
      profile.cellFusionRate && `体细胞与源石融合率：${profile.cellFusionRate}`,
      profile.crystalDensity && `血液源石结晶密度：${profile.crystalDensity}`
    ]))
  }

  if (entry.archives?.length) {
    lines.push('', `档案资料（${entry.archives.length} 段）：`)
    for (const archive of entry.archives) {
      lines.push(`- ${archive.title}${archive.condition ? `（${archive.condition}）` : ''}：${archive.text}`)
    }
  }

  if (entry.records?.length) {
    lines.push('', '干员密录：')
    for (const record of entry.records) {
      lines.push(`- ${record.set ?? '密录'}${record.index ? ` 第${record.index}话` : ''}：${record.page}`)
    }
  }
}

/** Render the ranks players actually ask about, not all ten rows. */
function selectSkillLevels (levels) {
  const wanted = ['7级', '专1', '专3']
  const picked = (levels ?? []).filter(level => wanted.includes(level.level))
  return picked.length > 0 ? picked : (levels ?? []).slice(-1)
}

function skillTiming (level) {
  const sp = level.initialSp !== null && level.initialSp !== undefined && level.spCost !== null && level.spCost !== undefined
    ? `SP ${level.initialSp}/${level.spCost}`
    : level.spCost !== null && level.spCost !== undefined ? `SP ${level.spCost}` : ''
  const hasDuration = level.duration !== null && level.duration !== undefined && level.duration > 0
  return compact([sp, hasDuration ? `持续 ${level.duration}s` : ''])
}

function renderItem (entry, lines) {
  const qualifiers = compact([entry.rarityStars ? `${entry.rarityStars}★` : '', entry.kind])
  push(lines, `**${entry.name}** — 物品${qualifiers ? ` · ${qualifiers}` : ''}`)
  push(lines, entry.description ? `描述：${entry.description}` : '')
  push(lines, entry.usage ? `用途：${entry.usage}` : '')
  push(lines, entry.obtain ? `获得方式：${entry.obtain}` : '')
  push(lines, entry.rarity !== null && entry.rarity !== undefined ? `稀有度原始值：${entry.rarity}（0 起算，游戏内为 ${entry.rarity + 1} 星）` : '')
  push(lines, entry.itemId ? `物品 ID：${entry.itemId}` : '')
}

function renderStage (entry, lines) {
  const qualifiers = compact([
    entry.type,
    entry.subtype,
    entry.difficulty,
    entry.sanityCost !== null && entry.sanityCost !== undefined ? `消耗 ${entry.sanityCost} 理智` : ''
  ])
  const title = [entry.code, entry.name].filter(Boolean).join(' ') || entry.page
  push(lines, `**${title}** — 关卡${qualifiers ? ` · ${qualifiers}` : ''}`)
  push(lines, entry.region ? `区域：${entry.region}` : '')
  push(lines, entry.unlock ? `解锁条件：${entry.unlock}` : '')
  push(lines, compact([
    entry.recommendedLevel && `推荐等级：${entry.recommendedLevel}`,
    entry.squadLimit !== null && entry.squadLimit !== undefined ? `部署上限：${entry.squadLimit}` : '',
    entry.initialCost !== null && entry.initialCost !== undefined ? `初始 COST：${entry.initialCost}` : '',
    entry.lifePoints !== null && entry.lifePoints !== undefined ? `目标点耐久：${entry.lifePoints}` : '',
    entry.enemyCount !== null && entry.enemyCount !== undefined ? `敌人数量：${entry.enemyCount}` : ''
  ]))
  push(lines, compact([
    entry.mapSize && `地图：${entry.mapSize}`,
    entry.fastestClear && `最短用时：${entry.fastestClear}`,
    entry.drillCost !== null && entry.drillCost !== undefined ? `演习消耗：${entry.drillCost}` : ''
  ]))
  push(lines, entry.description ? `描述：${entry.description}` : '')
  push(lines, entry.firstClearDrops?.length ? `首次掉落：${renderDrops(entry.firstClearDrops)}` : '')
  push(lines, entry.normalDrops?.length ? `常规掉落：${renderDrops(entry.normalDrops)}` : '')
  push(lines, entry.extraMateriel?.length ? `额外物资：${entry.extraMateriel.join('、')}` : '')
  push(lines, entry.reward ? `报酬：${entry.reward}` : '')
  push(lines, entry.note ? `关卡情报：${entry.note}` : '')
  push(lines, entry.terrain ? `特殊地形：${entry.terrain}` : '')
  if (entry.challenge) {
    const challenge = entry.challenge
    push(lines, `突袭：${compact([
      challenge.sanityCost !== null && challenge.sanityCost !== undefined ? `消耗 ${challenge.sanityCost} 理智` : '',
      challenge.drillCost !== null && challenge.drillCost !== undefined ? `演习 ${challenge.drillCost} 理智` : ''
    ])}${challenge.condition ? `；附加条件：${challenge.condition}` : ''}`.trim())
    push(lines, challenge.unlock ? `　解锁：${challenge.unlock}` : '')
    push(lines, challenge.firstClearDrops?.length ? `　首次掉落：${renderDrops(challenge.firstClearDrops)}` : '')
  }
  push(lines, entry.enemies?.length ? `敌人构成（${entry.enemies.length} 种）：${renderEnemies(entry.enemies)}` : '')
  if (entry.story) {
    const parts = []
    if (entry.story.before) parts.push(`行动前「${entry.story.before.title}」`)
    if (entry.story.after) parts.push(`行动后「${entry.story.after.title}」`)
    push(lines, parts.length ? `关联剧情：${parts.join('；')}（可用 story 类别按标题查台词）` : '')
  }
  push(lines, entry.id ? `关卡内部 ID：${entry.id}` : '')
}

function renderStory (entry, lines) {
  const extras = []
  if (entry.kind) extras.push(entry.kind)
  if (entry.storyType && entry.kind && !entry.kind.includes(entry.storyType)) extras.push(entry.storyType)
  if (entry.chapter && entry.chapter !== entry.storyGroup && entry.chapter !== entry.kind) extras.push(`章节：${entry.chapter}`)
  if (entry.storyGroup && !extras.some(item => item.includes(entry.storyGroup))) extras.push(`分组：${entry.storyGroup}`)
  push(lines, `**${entry.title}** — 剧情${extras.length ? ` · ${extras.join(' · ')}` : ''}`)
  push(lines, entry.characters?.length
    ? `登场角色：${entry.characters.slice(0, 20).join('、')}${entry.characters.length > 20 ? ` 等 ${entry.characters.length} 位` : ''}`
    : '')
  push(lines, entry.lineCount
    ? `台词/旁白共 ${entry.lineCount} 条${entry.truncated ? `，以下为前 ${entry.lines.length} 条` : ''}：`
    : '')
  for (const line of entry.lines ?? []) {
    lines.push(`- ${line.speaker ? `${line.speaker}：` : ''}${line.text}`)
  }
  push(lines, entry.textPath ? `剧本路径：${entry.textPath}` : '')
  if (entry.operator) push(lines, `所属干员：${entry.operator}`)
}

const APPEARANCE_COUNTS = [['main', '主线'], ['event', '活动'], ['memory', '密录']]

function renderAppearance (entry, lines) {
  const qualifiers = compact([
    entry.rarity ? `${entry.rarity}★` : '',
    entry.profession,
    entry.total ? `共 ${entry.total} 条出场` : ''
  ])
  push(lines, `**${entry.operator}** — 干员出场${qualifiers ? ` · ${qualifiers}` : ''}`)
  if (entry.earliest) {
    const group = entry.earliest.group && entry.earliest.group !== '干员密录' ? `《${entry.earliest.group}》` : ''
    push(lines, `最早出场：${group}${entry.earliest.title}${entry.earliest.date ? `（${entry.earliest.date}）` : ''}`)
  }
  const counts = entry.counts ?? {}
  const distribution = APPEARANCE_COUNTS
    .filter(([key]) => counts[key])
    .map(([key, label]) => `${label} ${counts[key]}`)
  if (distribution.length > 0) push(lines, `分布：${distribution.join('、')}`)
  if (entry.appearances?.length) {
    lines.push('', `登场剧情（按时间顺序${entry.truncated ? `，以下为前 ${entry.appearances.length} 条` : ''}）：`)
    for (const item of entry.appearances) {
      const date = item.date ? `${item.date} ` : ''
      const group = item.group && item.group !== '干员密录' ? `《${item.group}》` : ''
      const kind = item.kind && item.kind !== '干员密录' ? `（${item.kind}）` : ''
      lines.push(`- ${date}${group}${item.title}${kind}`)
    }
    if (entry.truncated) push(lines, '…（其余条目见 PRTS「干员剧情一览」）')
  }
  push(lines, entry.appearances?.some(item => item.date === null)
    ? '> 未标注日期：PRTS 未给出开放时间的旧章节/密录，顺序按剧情进度估算。'
    : '')
}

function renderWorld (entry, lines) {
  const qualifiers = entry.kind === '术语对照' ? '泰拉词库 · 术语对照' : `泰拉大典 · ${entry.section ?? '条目'}`
  push(lines, `**${entry.title}** — ${qualifiers}`)
  push(lines, entry.summary ? `简介：${entry.summary}` : '')
  for (const [key, value] of Object.entries(entry.infobox ?? {}).slice(0, 8)) {
    if (value) push(lines, `- ${key}：${value}`)
  }
  for (const [key, value] of Object.entries(entry.details ?? {}).slice(0, 6)) {
    if (value) push(lines, `- ${key}：${value}`)
  }
  for (const term of (entry.terms ?? []).slice(0, 4)) {
    const parts = compact([
      term.zh && `中文：${term.zh}`,
      term.en && `英文：${term.en}`,
      term.ja && `日文：${term.ja}`,
      term.other && `其他：${term.other}`,
      term.yostar && `悠星英文：${term.yostar}`,
      term.group && `分类：${term.group}`
    ])
    if (parts) push(lines, `- ${parts}`)
  }
  if (entry.sections?.length) push(lines, `章节：${entry.sections.join(' / ')}`)
  if (entry.related?.length) {
    push(lines, `相关条目：${entry.related.map(link => `${link.section}·${link.name}`).join('；')}`)
  }
}

function renderLookup (value) {
  if (!value || typeof value !== 'object') return 'PRTS 查询没有返回可用结果。'
  const lines = []

  if (value.status !== 'ok' || !value.entry) {
    lines.push(`**${value.status === 'error' ? '查询失败' : '未找到'}** · ${value.query ?? ''}（${value.category ?? 'unknown'}）`)
    push(lines, value.message)
    if (value.candidates?.length) {
      lines.push('', '可选候选：')
      for (const candidate of value.candidates) {
        lines.push(`- ${candidate.name}${candidate.detail ? ` — ${candidate.detail}` : ''}（${candidate.category}）`)
      }
    }
    return lines.join('\n')
  }

  const entry = value.entry
  if (entry.category === 'operator') renderOperator(entry, lines)
  else if (entry.category === 'item') renderItem(entry, lines)
  else if (entry.category === 'stage') renderStage(entry, lines)
  else if (entry.category === 'story') {
    if (entry.kind === '干员出场') renderAppearance(entry, lines)
    else renderStory(entry, lines)
  } else if (entry.category === 'world') renderWorld(entry, lines)
  else lines.push('```json\n' + JSON.stringify(entry) + '\n```')

  if (value.matchedBy && value.matchedBy !== 'exact') {
    lines.push('', `> 匹配说明：${value.message || `命中方式为 ${value.matchedBy}`}`)
  }
  if (entry.url) lines.push('', `来源：${entry.url}`)
  return lines.join('\n')
}

const SIGNAL_LABEL = {
  skin_rerun: '皮肤复刻',
  interval_overdue: '间隔超期',
  story_tie_in: '剧情地区',
  story_appearance: '剧情常驻角色',
  story_recent: '近期活跃',
  collab_cameo: '联动出场',
  alter_candidate: '异格候选',
  long_tenure: '首发超四年',
  anniversary_window: '周年/季节窗口',
  merch_or_ep: '周边/EP'
}

const KIND_LABEL = { new: '新角色', alter: '异格' }

function renderBanner (value) {
  const isDebut = value.candidates?.some(candidate => candidate.kind === 'new' || candidate.kind === 'alter')
  const lines = [isDebut
    ? '**新角色预测** — 概率性候选，不是官方排期'
    : '**卡池预测** — 概率性候选，不是官方排期']
  push(lines, value.prediction_basis ? `依据：${value.prediction_basis}` : '')
  if (value.candidates?.length) {
    lines.push('', isDebut ? '候选角色：' : '候选干员：')
    for (const candidate of value.candidates) {
      const signals = candidate.signals?.length
        ? `（${candidate.signals.map(signal => SIGNAL_LABEL[signal] ?? signal).join('、')}）`
        : ''
      const kind = candidate.kind ? `[${KIND_LABEL[candidate.kind] ?? candidate.kind}] ` : ''
      lines.push(`- ${kind}${candidate.operator} · ${candidate.confidence}${signals}`)
      if (candidate.reason) lines.push(`　${candidate.reason}`)
    }
  } else {
    const skipped = /不预测/.test(value.prediction_basis ?? '')
    lines.push('', skipped
      ? '本次不预测春节/新年限定。'
      : '本次没有可给出的候选：卡池历史或干员档案不可用。')
  }
  if (value.candidates?.some(candidate => candidate.confidence === 'low')) {
    lines.push('', '提示：其中 low 置信度只表示「方向性参考」，回答时不要当成确定排期。')
  }
  if (value.dossier_clues?.length) {
    lines.push('', '档案 / 密录线索（弱信号，不参与排序）：')
    for (const clue of value.dossier_clues) {
      const title = [clue.source, clue.title].filter(Boolean).join('·')
      lines.push(`- 【${clue.operator}】${title}：${clue.text}`)
    }
  }
  if (value.caveats) lines.push('', `注意：${value.caveats}`)
  // 统一在末尾给出结果表格，方便直接转发/对比。
  if (value.candidates?.length) {
    const cell = (text) => String(text ?? '').replace(/\|/g, '｜')
    lines.push('', '预测结果：')
    lines.push('| 顺序 | 角色 | 类型 | 置信度 | 关键依据 |')
    lines.push('| --- | --- | --- | --- | --- |')
    value.candidates.forEach((candidate, index) => {
      const kind = KIND_LABEL[candidate.kind] ?? (isDebut ? '新角色' : '干员')
      const signals = candidate.signals?.length
        ? candidate.signals.map(signal => SIGNAL_LABEL[signal] ?? signal).join('、')
        : '—'
      lines.push(`| ${index + 1} | ${cell(candidate.operator)} | ${kind} | ${candidate.confidence} | ${signals} |`)
    })
  }
  return lines.join('\n')
}

export const name = 'dsh-ark-wiki'

export const inject = ['tools']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply (ctx) {
  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(arkWikiLookup),
      ctx.tools.register(arkBannerPredict)
    ].filter(dispose => typeof dispose === 'function')
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'dsh-ark-wiki: register ark_wiki_lookup + ark_banner_predict')
}
