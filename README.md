# dsh-ark-wiki

为 DSH 提供两个模型可调用的工具：`ark_wiki_lookup` 查询 PRTS Wiki 的《明日方舟》数据（干员及其技能/天赋/档案/密录、物品、关卡、剧情、干员出场表与「泰拉大典」世界观考据），返回结构化结果，由模型据此作答；`ark_banner_predict` 默认根据剧情卡司快照做**概率性**的新角色 / 异格候选预测（剧情里反复出现但没进过卡池的人物、长期无新剧情的干员异格），也可按 PRTS「卡池一览」的历史排期预测下期卡池与 UP 干员；两者都带置信度、理由与信号。

[![CI](https://github.com/wsk114514/dsh-ark-wiki/actions/workflows/ci.yml/badge.svg)](https://github.com/wsk114514/dsh-ark-wiki/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

> **目前的分发方式只有 GitHub 源码安装**：npm 尚未发布（2026 年的 2FA 政策，见 [RELEASING.md](RELEASING.md)），dsh-plugin.org 收录申请已提交、等待人工核实。

> **非官方粉丝项目**：与 Hypergryph（鹰角网络）、《明日方舟》官方及 PRTS Wiki 均无隶属关系；所有游戏数据与 wiki 文本的版权归原权利方，本项目仅做实时查询与展示，仅供个人非商业用途。详见[免责声明](#免责声明与权限)。

## 安装

### 方式一：从 GitHub 源码安装（当前可用）

```bash
# 1. 装到目标 profile（把 web 换成 desktop / 你实际使用的 profile 名）
dsh plugin --profile web add github:wsk114514/dsh-ark-wiki
# 2. 把包名 "dsh-ark-wiki" 写进该 profile package.json 的 dsh.profile.bundles 数组
```

### 方式二：npm

包**尚未发布到 npm**（npm 2026 年起要求发布者使用安全密钥 / 2FA，见 [RELEASING.md](RELEASING.md) 的「已知阻塞」一节）。发布后改为：

```bash
dsh plugin --profile web add dsh-ark-wiki
```

装完直接在对话里用自然语言提问，例如：

- 「阿米娅的属性、技能和天赋」
- 「至纯源石是干什么用的」
- 「1-7 的掉落和敌人」
- 「0-1 坍塌 行动前 有哪些台词」「12F 干员密录」
- 「克莱门莎最早在哪个剧情出场」（走干员出场表，返回按时间排序的完整登场列表）
- 「矿石病是什么」「维多利亚的首都」「整合运动」「泰拉年表」（走泰拉大典世界观检索）

## 安装（本地开发路径）

插件是标准 DSH bundle（`dsh.bundle.patch` 指向 `cordis.patch.yml`）。已实测可用的挂载方式：

```powershell
# A. 在 DSH 会话里用 plugin_manager 工具（推荐，自动完成 link + bundles 注册）
#    action: install_bundle
#    target: C:\path\to\dsh-ark-wiki
#    实测返回 {"stage":"enable","enabled":true,"changed":true,"application":"applied","warnings":[]}
#    并在 profile 里生成 node_modules\dsh-ark-wiki junction，
#    同时把 "dsh-ark-wiki" 追加进 profile package.json 的 dsh.profile.bundles。

# B. 命令行（real syntax，注意 --profile 是必需参数）
dsh plugin --profile desktop add C:\path\to\dsh-ark-wiki
# 等价于在 %DSH_HOME%\profiles\desktop 里执行 pnpm add <该路径>；之后仍需把包名加进
# 该 profile package.json 的 dsh.profile.bundles 数组（或由 plugin_manager 代劳）。
```

**开发期热重载**：插件是 junction 链入的，改完 `lib/*.js` 后不必重启 DSH——在会话里对 loader entryId 执行一次 disable → enable 即可让宿主重新 import 模块（实测 `{"application":"applied","warnings":[]}`，随后 `Tool/listTools` 立即出现新 schema）：

```jsonc
// plugin_manager, action: set_plugin, target 用 entryId 而不是包名
{ "action": "set_plugin", "target": "include:dsh-ark-wiki", "enabled": false }
{ "action": "set_plugin", "target": "include:dsh-ark-wiki", "enabled": true }
```

注意：`set_plugin` 传包名 `dsh-ark-wiki` 会返回 `{"application":"failed","error":{"code":"unknown-plugin"}}`，必须用 `include:<包名>`（可从 `plugin_manager` list_plugins 里查，或读 profile 的 `node_modules/<包名>/cordis.patch.yml` 中的 `id`）。

它依赖宿主注入的 `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools`（peerDependencies，宿主自行解析，插件不打包它们）。

## 工具契约

```jsonc
// 参数
{ "query": "阿米娅", "category": "operator" }   // category 可选：operator | item | stage | story | world
```

`category` 省略时按查询词自动判定：含「泰拉大典 / 世界观 / 考据 / 年表 / 词库」时先查泰拉大典；含「行动前 / 行动后 / 密录 / 剧情 / 序曲 / 出场 / 戏份 / 登场」或 `/BEG`、`/END` 时先当剧情查；形如 `1-7`、`S4-7`、`CE-5` 的代号先当关卡查；其余先查物品（仅接受完全同名），再查干员，然后关卡、剧情，最后泰拉大典。

剧情类别同时接受剧情页标题（`0-1 坍塌 行动前`）、章节/活动名（`黑暗时代·上`）与**干员名 + 出场**（`克莱门莎 出场`）；章节名返回 `candidates`（最多 8 条），模型可据此再查具体标题；干员出场会返回该干员在主线/活动/密录里的完整登场表。

世界观类别（`world`）覆盖 PRTS「泰拉大典」命名空间（143 页：角色/地理/组织/百科/生物/道具/剧情/关卡/成就/集成战略等）与附表 `泰拉年表`、`泰拉词库`、`泰拉文字`：先按页面标题精确/前缀匹配，再退到「泰拉大典」命名空间全文检索，解析其中的 `{{角色考据}}`/`{{地理考据}}`/`{{组织考据}}`/`{{种族考据}}`/`{{百科词条}}` 块；`泰拉词库` 另做译名对照（中文/英文/日文）。

返回值是一个 canonical JSON envelope（`output.schema` 已声明，`additionalProperties: false`）：

| 字段 | 含义 |
| --- | --- |
| `status` | `ok` / `not_found` / `error` |
| `category` | `operator` / `item` / `stage` / `story` / `world` / `unknown` |
| `query` | 原始查询词 |
| `matchedBy` | `exact` / `prefix` / `fuzzy` / `redirect` / `search` / `none` |
| `entry` | 命中条目的结构化数据（`type: 'json'` 节点，字段随类别而定） |
| `candidates` | 未命中时的近似条目建议（最多 8 条） |
| `message` | 给模型看的说明（模糊匹配、未找到、错误原因） |
| `source` | `{ endpoint, page }`，可回溯到 PRTS 页面 |

`render(args, value)` 把 envelope 渲染成 `[{ type: 'text', text }]` 的 Markdown 摘要；非精确命中会附「匹配说明」，末尾附 PRTS 来源链接。

`entry` 的主要字段（`entry.category` 表明类别，`entry.url` 指向 PRTS 页面）：

- `operator`：`name`、`aliases[]`（中/英/日其他名称）、`stars`、`profession`、`subProfession`、`position`、`tags[]`、`feature`、`nation`、`organization`、`team`、`race`、`sex`、`birthday`（如 `12月23日`）、`designer`、`painter`、`obtainMethod[]`、`releasedAt`、`id`、`index`、`page`
  - `skills[]`：`{ index, name, nameEn, nameJa, chargeType, triggerType, unlock, levels[] }`，`levels[]` 为 `{ level, description, initialSp, spCost, duration }`（`level` 形如 `1级`…`7级`、`专1`…`专3`）
  - `talents[]`：`{ slot, name, levels[] }`，`levels[]` 为 `{ condition, effect, potentialEffect }`（`condition` 如 `精英2 X模组3级`，`potentialEffect` 为满潜时的效果）
  - `buildingSkills[]`：`{ name, phase, level }`（基建技能）
  - `profile`：体检档案，`{ gender, combatExperience, birthplace, birthday, race, height, infectionStatus, infected, physicalStrength, mobility, endurance, tactics, combatSkill, artsAdaptability, cellFusionRate, crystalDensity }`（缺失字段省略；六维为「优良/标准/普通…」评级文本）
  - `archives[]`：`{ title, condition, text }`（基础档案、综合体检测试、客观履历、临床诊断分析、晋升记录等；`？？？` 占位段被过滤）
  - `records[]`：`{ set, index, page, url }`（干员密录：密录集名、第几话、PRTS 页面；`page` 可直接用 `category: story` 查台词）
- `item`：`name`、`itemId`、`rarity`（0 起算）、`rarityStars`、`kind`（分类）、`description`、`usage`、`obtain`、`page`
- `stage`：`code`、`name`、`type`、`subtype`、`difficulty`、`sanityCost`、`region`、`unlock`、`recommendedLevel`、`squadLimit`、`initialCost`、`costLimit`、`lifePoints`、`enemyCount`、`mapSize`、`fastestClear`、`drillCost`、`description`、`firstClearDrops[]`、`normalDrops[]`、`extraMateriel[]`、`reward`、`terrain`、`note`、`challenge{}`、`enemies[]`、`id`（游戏内部关卡 ID）、`story{}`（`{ before, after, extra? }`，每项 `{ title, page, url }`）、`page`
- `story`：`title`、`storyType`（主线/活动/干员密录…）、`storyGroup`（章节目录标题）、`chapter`、`kind`（`主线剧情`/`活动剧情`/`特殊剧情`/`干员密录`）、`textPath`（剧本资源路径）、`characters[]`（登场角色前 20）、`lineCount`、`truncated`、`lines[]`（最多 60 条，`{ speaker, text }`，`speaker` 为 null 表示旁白）、`operator`（干员密录所属干员）、`page`
  - 干员出场（`kind: '干员出场'`，来自剧情类别）：`operator`、`profession`、`rarity`、`total`、`counts`（`{ main, event, memory }`）、`earliest`（最早登场 `{ title, page, group, kind, date }`，`date` 可能为 null）、`appearances[]`（最多 48 条，`{ title, page, url, column, group, kind, date }`，按开放时间 → 主线章节顺序排序）、`truncated`、`source`
- `world`：`section`（人物考据/地理/组织/百科事典/生态调查/商品目录/剧情分析/附表…）、`title`、`summary`（正文首段，约 900 字）、`infobox`（地理页信息框键值，如 `{ 首都: '伦蒂尼姆' }`）、`details`（`{ 英文名, 日文名, 成员, 主要种族, 登场 }` 等模板参数，按页面可得性出现）、`sections[]`（小标题，最多 14 个）、`related[]`（`{ section, name, page, url }`，正文里的 `{{泰拉大典|…}}` 内链）、`terms[]`（`泰拉词库` 命中时为 `{ zh, en, other, ja, yostar, section }`）、`page`

掉落项形如 `{ name, condition }`（`condition` 为「固定掉落」「三星获得」等，可能为 null）；敌人项形如 `{ name, count, level }`。

### 第二个工具：`ark_banner_predict`

它回答两类不同的问题，默认是第一类：

```jsonc
// 新角色 / 异格（默认 debut 模式）
{ "hint": "下个版本可能回阿戈尔或伊比利亚" }        // 地区线索 → 该地区剧情里的未实装人物
{ "hint": "塔露拉会实装吗" }                        // 点名未实装人物
{ "hint": "安洁莉娜很久没新剧情了，会不会异格" }      // 异格候选
// 卡池排期模式（必须给出卡池类型关键词或 banner_type）
{ "hint": "莱塔尼亚活动", "banner_type": "standard" } // 常驻标准轮换
{ "hint": "夏季限定池" }                             // 限定：只推断同池陪跑 6★
// banner_type 可选 debut | standard | limited | rerun | kernel，region 默认 cn
```

返回 canonical JSON（`output.schema` 同样声明了 `additionalProperties: false`）：

| 字段 | 含义 |
| --- | --- |
| `prediction_basis` | 新角色模式：扫描了多少段剧情、识别出多少未实装人物/异格候选、数据生成日期、hint 里的地区与点名；排期模式：用了哪几页卡池历史与多少期 |
| `candidates[]` | 3–4 名候选：`{ operator, kind?, confidence, reason, signals[] }`；春节/新年限定或数据不可用时为空数组 |
| `candidates[].kind` | 仅新角色模式：`new` 剧情里出现但未实装的**新角色**、`alter` 已有干员的**异格**候选 |
| `candidates[].confidence` | `high`（多信号共振）/ `medium`（单一强信号）/ `low`（弱信号或数据降级，仅方向性参考） |
| `candidates[].signals` | `story_appearance` 剧情中反复出现的未实装人物、`story_tie_in` 剧情地区与 hint 吻合、`story_recent` 近期剧情活跃、`alter_candidate` 长期无新剧情的异格候选、`skin_rerun` 皮肤复刻、`interval_overdue` 进店间隔超期、`anniversary_window` 周年/季节窗口、`merch_or_ep` 周边/EP |
| `caveats` | 必须转述给用户的不确定性说明（预测性质、剧情出场只是弱信号、别名漏判、兑换规则等） |

**新角色 / 异格（默认）**：数据来自 `data/story-cast.json`——用 `tools/build-story-cast.mjs` 扫描 2019 年以来**全部** 1495 段主线/活动剧情，按台词 `[name="…"]` 统计每个说话者的出场段数、主线/活动分布、最近出场日期；再用 `tools/build-story-aliases.mjs` 查 PRTS 页面，把真实姓名/化名（`{{干员页面名|…}}`）归并回已实装干员，剩下的就是「剧情里反复出现但没进过卡池」的人物。打分：出场段数（上限 +2.5）、主线权重（+0.7/+0.5）、近期活跃（240 天内 +1.2）、首领级敌人模板（+0.3）、**hint 地区与该人物剧情地区吻合（+2.1；要求该地区剧情票 ≥5 且占该人物出场票的一半以上，否则只算客串——普瑞赛斯、奥卢斯这类跨地区人物不会再被当成当地角色）**；hint 直接点名的未实装人物再加 +2.6。异格候选来自「干员剧情一览」：出场 ≥5 次且 **≥730 天没有新剧情**，1095 天以上加权更重；已经异格的（如 `予愿安洁莉娜`）会被排除并在 `caveats` 里说明。地区归属用同场出场干员的阵营投票（`阿戈尔(64)` 这类计数），所以跨地区剧情的角色可能同时带多个地区标签。**往期限定干员不会作为新角色候选**：它们只能在对应限定寻访中兑换（井）获得。给出候选前会做两次**实装校验**：① 拿候选名对照 PRTS「干员一览」的代号、外文名/日文名，以及干员页「客观履历」里声明的本名与外号（`data/operator-aliases.json`，见[数据来源](#数据来源)第 12 条）；② 候选定下来后再去 PRTS 按**标题检索**一遍，命中干员页（`{{干员页面名|…}}`）就说明它其实是已实装干员的本名/别名（例如「玛嘉烈」→ 页面「玛嘉烈・临光」→ 干员「临光」）。两次校验命中的候选一律剔除，并在 `caveats` 里写明「实装校验」的排除项（例如「阿娜特＝干员『莎草』、梅捷缇克缇＝干员『缇缇』」）。

**卡池排期（standard / limited / rerun / kernel）**：解析 hint 里的地区 / 季节（庆典、夏季、联动）/ 卡池类型 / 皮肤信号；按历史间隔加权——标准轮换看「距上次进店天数 ÷ 个人轮换周期」，中坚寻访看 120–240 天轮换与「久未回归」，标准池会排除已转入中坚池的干员（`kernelMoved`）。**限定与复刻池不预测限定 6★**：往期限定干员不会进入后续卡池，只能在对应限定寻访中通过兑换（井）获得，所以这两个分支会把 `limited=1` 的干员全部排除，只给同池的陪跑 6★（按标准轮换间隔排序），并在 `prediction_basis` 与 `caveats` 里写明这条兑换规则。春节/新年限定**不预测**：hint 命中「春节 / 新年」时直接返回空候选，不拉取任何网络数据（省时省 token）。所有结果都是概率性推断，**不是官方排期**。

## 免责声明与权限

- **非官方**：本项目是第三方粉丝工具，与上海鹰角网络科技有限公司（Hypergryph）、《明日方舟》官方运营方以及 PRTS Wiki 维护团队均无任何隶属或授权关系。
- **版权**：干员资料、剧情台词、物品描述等文本在运行时从 PRTS Wiki 实时读取，其版权归原权利方所有。本项目不打包、不分发、不缓存到磁盘；仅将单次查询结果交给当前对话中的模型用于回答。
- **用途**：仅供个人学习、研究与非商业查询使用。请遵守 PRTS Wiki 的访问规则，不要用本插件做批量抓取或高频轮询（插件内部有 10 分钟内存缓存与 8–12 秒超时）。
- **权限范围**：只读。仅通过 HTTPS 访问 `prts.wiki` 的公开 `api.php`；不读取本地文件、不读取任何凭据或环境变量、不上传对话内容、无遥测、无需 API Key。网络请求可通过宿主的 `AbortSignal` 取消。
- **风险**：查询结果依赖 PRTS 的页面模板结构（详见[已知限制](#已知限制)），PRTS 改版时相应字段会降级为空而不是编造数据；模型回答前应核对返回的 `source` 链接。

## 数据来源

全部走 PRTS 官方接口 `https://prts.wiki/api.php`，没有第三方爬虫或缓存服务：

1. **干员**：`ark-info` 包（`getOperators({ extraFields })`）→ 内部使用 MediaWiki Cargo `chara` / `chara_extra_info` / `char_obtain` 三张表。干员列表在进程内缓存 10 分钟，并按 zh/en/ja 名称建索引。
2. **技能 / 天赋**：PRTS **没有**这两类数据的 Cargo 表（`action=cargotables` 只返回 `building_skill2`、`char_building_skill`、`char_memory`、`char_mod`、`chara`、`chara_data`、`item`、`loot` 等），所以改为解析干员页 wikitext：`{{技能|…}}`/`{{技能2|…}}` 每个模板块一个技能（模板名的数字后缀随技能而变，**不是**槽位号），`{{天赋列表3|…}}` 里的 `天赋N`/`天赋N效果`/`天赋N条件` 与 `潜能增强_天赋N*`。基建技能另外走 Cargo `char_building_skill`（按 `_pageName` 过滤）。页面结果按干员缓存 10 分钟；页面取不到时静默降级为「只有基础档案」，不影响其余字段。
3. **物品**：Cargo `item` 表（`where: name LIKE '%关键词%'`）拿 `itemId`/`rarity`/`description`，再取页面 `{{道具信息}}` 模板补 `用途`/`获得方式`/`分类`（补全失败不影响主结果）。
4. **关卡**：直接按标题取页面正文，解析 `{{普通关卡信息}}` / `{{剿灭关卡信息}}` / `{{突袭关卡信息}}` / `{{敌方情报}}`；标题不存在时用 `action=query&list=search` 找候选页再解析前 3 个。命中后还会用剧情索引补出关联的「行动前 / 行动后」剧情链接。
5. **剧情**：PRTS 同样**没有**剧情 Cargo 表，所以分两条腿：① `Template:剧情导航`（约 146 KB）按表格行解析出 1700+ 条剧情页链接与所属章节/类型，得到「标题 → 页面」索引；② `char_memory` Cargo 表提供干员密录的 `storySetName/storyIndex/storyTxt`（`storyTxt` 是页面指针）。命中后取剧情页 wikitext 里的 `{{剧情模拟器|…}}`，解析 `剧情类型`/`剧情分组`/`文本路径` 与 `文本数据` 演出脚本（`[name="杜宾"] 台词`、`[Character(...)]`、`[Dialog]` 等），台词截断到 60 条。两个索引各缓存 10 分钟。
6. **干员档案**：解析干员页的 `{{人员档案set|…}}`（体检档案键值）与 `{{人员档案|档案N=…|档案N条件=…|档案N文本=…}}`（档案资料多段），与技能/天赋共用同一次页面请求。
7. **干员出场**：抓 PRTS 的 `干员剧情一览/六星干员`…`/一二星干员` 五个页面的 wikitable（列：干员 / 主线剧情 / 活动剧情 / 干员密录，单元格是 `[[页面|标题]]` 列表），得到「干员 → 登场剧情」全表；时间排序用 SMW `action=ask` 查 `[[活动开始时间::+]]`（约 317 条，`printouts['活动开始时间'][0].timestamp` 是秒级时间戳）给每个活动/章节补开放日期，没有日期的旧主线章节按 `Template:剧情导航` 的章节顺序插值估算（`date: null`，渲染时提示「顺序按剧情进度估算」）。索引缓存 10 分钟。
8. **泰拉大典（世界观）**：`action=query&list=allpages&apnamespace=3000` 列出命名空间「泰拉大典」的 143 个页面作为标题索引，另加主命名空间的 `泰拉年表`、`泰拉词库`、`泰拉文字`。标题命中直接取页面解析；列表页（`泰拉大典:角色/其他`、`地理/其他`、`组织/其他`、`生物`、`百科/*`）的值是 `{{角色考据|姓名=…|…}}`/`{{地理考据|名称|…}}`/`{{百科词条|词条名|情报=…}}` 块（位置参数用模板解析器的 `positional`），所以先精确/前缀匹配块名，再退到 `list=search&srwhat=text&srnamespace=3000` 全文检索；`百科/*` 目录页命中时整页全文当作词条解释。`泰拉词库` 解析成中/英/日译名对照行。
9. **卡池历史（预测）**：解析 PRTS「卡池一览」的静态 wikitable，共 6 页——`常驻标准寻访/{year}`、`常驻标准寻访/{year-1}`、`限时寻访`、`常驻中坚寻访/{year}`、`常驻中坚寻访/{year-1}`、`常驻中坚寻访/{year-2}`。标准页列是「序号 / 寻访页面 / 开启时间 / 6★ / 5★」，限时页是「寻访页面 / 开启时间 / 6★ / 5★」且单元格可能嵌套表格；6★/5★ 单元格里的 `{{干员头像|名字|limited=1}}` 决定「限定」只标在该干员身上（不会被整行污染）。五页并行拉取、合并后缓存 30 分钟；解析器支持同一行 `| a || b || c` 与逐行 `|` 两种写法，标准页只有 `[[文件:…|link=寻访模拟/干员轮换卡池N]]` 时用 `link=` 兜底取标题。
10. **剧情信号（卡池排期用）**：复用第 7 条的「干员剧情一览」索引，统计每位干员在主线 / 活动 / 密录中的出场次数与最近一次剧情登场日期（用第 7 条的 SMW 日期与主线插值）；再按干员的 `nation/organization/team` 归并到地区，得到「每个地区最近一次有新剧情」的日期。地区距今超过 270 天（9 个月）即进入 `staleRegions`，排期模式预测时给该地区角色加分。整份信号缓存 15 分钟。
11. **剧情卡司（新角色预测用）**：`tools/build-story-cast.mjs` 扫描 `Template:剧情导航` 里**全部** 1495 段主线/活动剧情（2019 年至今，早先只扫 2024 年以后，导致卡西米尔、谢拉格这类老地区票数为 0），取 `/BEG`、`/END` 子页的演出脚本，按 `[name="…"]` 统计每个说话者的出场段数、主线/活动分布、最近出场日期与同场干员的阵营投票（得到 `阿戈尔(64)` 这类地区计数），产物 `data/story-cast.json`（约 349 KB，1007 名说话者，只保留 ≥2 段；台词里的通用职业称呼如「修士/公证人/企业员工」在扫描阶段就被丢掉）。`tools/build-story-aliases.mjs` 再对 817 名非干员说话者查 PRTS 页面：命中 `{{干员页面名|…}}` 的归并回已实装干员（如 恩雅→初雪、维娜→维娜·维多利亚），命中 `{{敌人信息…}}` 的标为 `enemy`，其余分 `story` / `unknown`（实测 unknown 721、story 10、enemy 64、operator 21、未分类 1）。这份数据随包发布，运行时直接读文件，不联网（`npm run data:cast` 可重新生成，需联网）；读取时按文件 mtime 判缓存，重建后不用重启宿主就能生效。
12. **干员本名/外号（实装校验用）**：PRTS 没有「干员本名」列表页（`干员一览` 由 Cargo 驱动，只有代号/外文名/日文名），干员页也没有 `/档案` 子页——档案内嵌在干员页模板参数里（`|档案3=客观履历`、`|档案3文本=…`）。`tools/build-operator-aliases.mjs` 因此逐个抓取干员页、从「客观履历」段落里认出说话者的本名与外号（句式：`X，曾任…`、`只有朋友才叫她「X」`、`本名是 X`），只保留唯一命中的映射，产物 `data/operator-aliases.json`（实测扫描 434 名干员、命中 23 条，1 条歧义「护卫→断崖/白雪」被丢弃）。运行时与 `ark-info` 的 `enName/jaName` 合并成 `releasedBy` 表。另有 `lib/wiki-roster.js` 做第二道**运行时检索校验**：候选定下来后拿名字去 PRTS `list=search&srwhat=title` 搜标题，命中页面若有 `{{干员页面名|…}}` 就判定为「已实装干员的本名/别名」（例如「玛嘉烈」→ 页面「玛嘉烈・临光」→ 干员「临光」），剔除后还会用 `exclude` 重跑预测补足候选名额。快照超过 45 天未更新时，预测的 `caveats` 会提醒重新生成（避免新实装干员漏判）。

`lib/prts.js` 负责 HTTP 细节：默认 8 秒超时（干员页/剧情索引放宽到 12 秒）、网络/5xx 重试 1 次、`AbortSignal` 透传（宿主取消会真正中断请求）、API 错误包装成 `PrtsError`。工具整体 `timeoutMs: 30000`：首次调用要先拉干员列表（约 1 秒，PRTS 偶尔到 10 秒）+ 详情页，后续命中缓存。

## 目录结构

```
dsh-ark-wiki/
├── package.json         # name/version/type/exports/dsh.bundle.patch/peerDependencies/scripts
├── package-lock.json    # CI 用 npm ci 锁定 devDependency（@deepseek-ai/dsh-tools）
├── cordis.patch.yml     # 插件加载补丁（- insert: id: dsh-ark-wiki）
├── .github/workflows/
│   └── ci.yml           # push/PR：npm ci + 离线契约 + npm pack 清单
├── lib/
│   ├── index.js         # defineTool 定义（ark_wiki_lookup + ark_banner_predict）、output schema、render、apply(ctx)
│   ├── prts.js          # PRTS HTTP 层：apiGet / cargoQuery / searchTitles / pageContent / 模板解析
│   ├── sources.js       # 六类词条解析（含剧情/密录/档案/干员出场/泰拉大典）、匹配评分、缓存、resolveLookup 调度
│   ├── regions.js       # 地区别名与「干员 ↔ 地区」匹配（预测用）
│   ├── story-signals.js # 剧情出场次数 / 地区最近新剧情日期 / staleRegions（排期预测用）
│   ├── debut.js         # 剧情卡司库读取、新角色/异格候选打分、实装校验（新角色预测用）
│   └── banners.js       # 卡池一览解析、索引构建、hint 解析、打分与 ark_banner_predict 执行
├── data/
│   ├── story-cast.json  # 剧情卡司快照（脚本生成，随包发布）
│   └── operator-aliases.json # 干员本名/外号映射（实装校验用，脚本生成）
├── tools/
│   ├── harness.mjs      # 本地契约 + 数据端到端测试（node tools/harness.mjs live）
│   ├── build-story-cast.mjs    # 扫描剧情正文统计说话者 → data/story-cast.json
│   ├── build-story-aliases.mjs # 把化名/真名归并回已实装干员，标注敌人/剧情角色
│   └── build-operator-aliases.mjs # 从干员页「客观履历」提取本名/外号 → data/operator-aliases.json
├── README.md
├── LICENSE              # 代码 MIT；数据版权归属见文件末尾
└── RELEASING.md         # 发布清单（npm + GitHub topic + 收录站提交）
```

## 本地测试

```powershell
npm install                      # 只为跑测试装 @deepseek-ai/dsh-tools（devDependency，不进包）
npm test                         # = node tools/harness.mjs offline，不联网
node tools/harness.mjs offline   # 不联网：schema 编译、参数校验、apply(ctx) 生命周期、effect 清理
node tools/harness.mjs live      # 联网：24 个 lookup 真实查询 + 9 个卡池预测用例（5 排期 + 4 新角色/异格）+ 期望断言（技能/天赋/档案/密录/剧情/干员出场/泰拉大典/卡池/剧情信号），输出 allValid
npm run data:cast                # 联网重建剧情卡司与别名快照（story-cast + story-aliases + operator-aliases，约 5–8 分钟）
$env:HARNESS_SUMMARY='1'; node tools/harness.mjs live              # 只打印「allValid + 每例耗时/状态/失败标记」
$env:HARNESS_REPORT='tools/report.json'; node tools/harness.mjs live  # 额外落盘完整 JSON（绕开 PowerShell 5.1 重定向写 UTF-16 的坑）
```

CI（`.github/workflows/ci.yml`）在每次 push / PR 时跑 `npm ci` + `npm test` + `npm pack --dry-run`，只验证离线契约与打包清单，不需要访问 prts.wiki。

`harness.mjs` 直接 import `lib/index.js`，用真实 `defineTool` 编译出的 JSON Schema 配合 `@deepseek-ai/dsh-tools` 的 `validateJsonSchemaValue` 校验，因此与宿主行为一致；它还用假的 `ctx`（`tools.register` + `effect`）调用 `apply(ctx)`，验证注册数量、名称与 dispose 链。live 用例里阿米娅/12F/银灰/玫兰莎/剧情用例带 `assert`：技能条数、专精行、天赋层级、潜能增强、`？？？` 占位被过滤、体检档案出身地、档案段落、密录页面指针、剧情 kind/章节/登场角色/台词截断、关卡关联剧情 before/after；干员出场用例断言 `total`/`earliest`（克莱门莎 = `BP-ST-1 浪潮守望者`，2024-06-05）、主线与密录分布；世界观用例断言地理信息框 `首都`、组织模板参数、`泰拉词库` 译名与相关信息。

## 已知限制

- PRTS 的 Cargo `item` 表只做 `LIKE` 粗筛，最终排序在本地用精确/前缀/包含三级评分完成；中文分词不做，查询词越短召回越宽。
- 物品与干员同名时以 `category` 为准；不传 `category` 时物品只接受完全同名，避免「阿米娅」被解析成「阿米娅的信物」。
- 关卡模板是 wiki 文本，`{{color|...}}`/`[[a|b]]` 等标记会被清洗；若 PRTS 改模板字段名，需要同步 `lib/sources.js` 的 `parseStagePage()` 键映射与 `extractStageParams()` 的模板名匹配规则。
- 技能/天赋同理：`parseSkillsFromPage()` 认 `{{技能N|…}}` 的 `技能{1..7,专精1..3}描述|初始|消耗|持续` 键，`parseTalentsFromPage()` 认 `{{天赋列表3|…}}` 的 `天赋N`/`潜能增强_天赋N*` 键（PRTS 偶尔把键写成 `潜能增强_{N}天赋效果`，已兼容）；两者都是「PRTS 改模板就失效」的脆弱点，失败时只会少这两个字段，不会影响基础档案。
- PRTS 用 `？？？` 占位尚未公开的天赋，这类条目会被过滤掉，因此某些干员的 `talents[]` 可能只有一条。
- 只读公开页面，不涉及登录态；高频调用会受 PRTS 限流，插件内仅对干员列表、干员页、剧情索引与密录索引做缓存。
- 剧情索引依赖 `Template:剧情导航` 的 wikitext 表格结构（`!` 章节 / `!` 主线|活动|剧情 / `|` 链接列表），一旦 PRTS 改版该索引会整体失效（表现为剧情查询全部 `not_found`，其余类别不受影响）。`活动一览` 由 SMW `#ask` 渲染、`干员密录一览` 由 `{{#Widget:MemoryList}}` 动态生成，两者都没有可直接解析的静态列表，因此活动剧情只覆盖导航模板里出现的条目。
- 剧情正文只取页面内嵌的 `文本数据` 演出脚本，台词截断到 60 条、角色到 20 个；`演出补充`/分支选项不解析，纯音频/图片指令按旁白丢弃（无文本时直接跳过）。关卡与剧情的关联用「`关卡代号 + 关名 + 空格` 前缀匹配导航标题」猜出来的，个别关卡若命名不一致会漏掉 `story` 字段。
- 干员出场表依赖 `干员剧情一览/*` 的 wikitable 结构（职业二级标题 + 4 列），PRTS 改版会让整类查询失败；表格里只有剧情标题，没有集数/排序号，因此日期来自 SMW `活动开始时间`。旧主线章节（黑暗时代、异卵同生、二次呼吸、急性衰竭、靶向药物、苦难摇篮、怒号光明）在 PRTS 上没有开放时间，这部分 `date` 为 null、顺序按剧情导航估算，渲染时会明确提示；同一活动内的条目按导航顺序而不是真实游玩顺序排列。
- 泰拉大典只有 143 个页面，角色专页仅覆盖约 100 名干员，其余角色走 `泰拉大典:角色/其他` 的 `{{角色考据}}` 汇总块；不在这些页面里的名词查不到（返回 `not_found`，不编造）。世界观搜索是「标题优先 + 全文检索兜底」的启发式，`百科/*` 目录页命中时返回整页词条摘录而非单条定义。信息框解析只取页面第一张 wikitable 的 `!键`→`|值` 配对，且对组织页/附表页禁用（这两类的表格常是布局表或编辑格式示例）。
- 新角色 / 异格预测是**剧情启发式，不是内幕排期**：唯一依据是 2019 年以来的剧情台词统计（1495 段）与干员实装状态——「剧情里出场多」不等于「会进卡池」（大量重要 NPC 至今未实装），「很久没有新剧情」也不等于「一定异格」。`confidence` 只表示信号是否共振，`high` 也不保证命中；`prediction_basis` 里会给出数据生成日期，之后的新剧情不会被计入。
- 台词说话者可能写成本名/化名（恩雅、维娜、阿娜特、梅捷缇克缇…）：能用 PRTS 页面 `{{干员页面名|…}}` 识别的已归并回已实装干员（如 恩雅→初雪、维娜→维娜·维多利亚），其余靠干员页「客观履历」的本名/外号做**实装校验**（实测 16 条：阿娜特→莎草、梅捷缇克缇→缇缇…），命中即从候选中剔除。这套校验依赖 PRTS 文本的写法，仍有漏判：没有页面的名字（实测 464 个 `unknown`）与履历里没写明本名的干员无法判定，可能把已实装角色当成新角色推荐，`caveats` 会提示这一限制。
- 地区归属是代理指标：用同场出场干员的 `nation/organization/team` 投票推断说话者归属，跨地区剧情的角色会同时挂多个地区（如塔露拉同时计入罗德岛与维多利亚），所以「回阿戈尔/伊比利亚」这类地区线索只能做粗略排序。为了让「客串」不算「本地角色」，地区命中要求该地区剧情票 ≥5 且占该人物出场票的一半以上；数据里每个角色只保留票数前三的地区，占比按这三项估算，所以极少数角色会因地区太多而被低估。
- 卡池排期（standard / limited / rerun / kernel）仍是**统计启发式**：标准轮换按「距上次进店天数 ÷ 个人周期」、中坚按 120–240 天估算，权重是社区经验拟合，无法保证命中；线索不足时统一降为 `low` 并在 `prediction_basis` 里明说。
- **限定池只给陪跑 6★**：往期限定干员不会进入后续卡池、只能通过限定寻访兑换（井）获得，因此 `limited` / `rerun` 分支会把 `limited=1` 的干员全部排除，只推断同池的非限定 6★，并在 `prediction_basis` / `caveats` 写明这条规则；新限定 6★ 在官方公布前无法预测。
- 剧情信号的口径限制：只统计「干员剧情一览」收录的剧情页（主线/活动/密录），密录不计入「最近新剧情」；地区是否「9 个月无新剧情」以该地区角色的最近一次登场为代理指标，角色跨地区出场会高估地区新鲜度。早期主线章节的日期是估算值，只用于粗判。PRTS 若改版该表，剧情信号会整体降级为空，预测退回纯排期启发式（`caveats` 会提示）。
- 春节/新年限定**不预测**：`hint` 命中「春节 / 新年 / 过年」时直接返回空候选与说明，不拉取任何网络数据；这是有意为之（该档期规律弱、证据少），不是数据缺失。
- 卡池历史只覆盖 PRTS「卡池一览」里静态列出的 6 页（约 272 期）；页面若改版、或新一期尚未被编辑补录，预测会缺最近数据（`prediction_basis` 会给出「最近一期」日期，模型应把它转述给用户）。
- 非国服（`region=global/jp/kr/tw`）只做提示：PRTS 卡池页基本是国服排期，工具不会换算外服时间，`caveats` 里会说明版本偏移。

## 兼容性

- 运行时：Node.js ≥ 22；DSH `@deepseek-ai/dsh` ≥ 0.2.1-rc.1（见 `package.json` 的 `engines.dsh`，实测宿主 0.2.1-rc.2）。
- 依赖：`@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools` 由宿主提供（peerDependencies，不随插件打包）；唯一的运行期依赖是 `ark-info@^0.1.1`（MIT），它只是一个 PRTS 客户端，不包含游戏数据。
- 平台：纯 JS、无原生模块，Windows / macOS / Linux 通用。
- DSH 的版本门禁会读 `engines.dsh`（0.2.1-alpha.4 起优先于 peerDependencies）；若你的宿主版本更老，可用插件管理器对该包授予版本豁免，或回退到源码安装。

## 发布

- GitHub：仓库已公开，`dsh-plugin` topic 已加，tag `v0.8.2` 已推送（`v0.8.0` 起剧情卡司改为全量扫描，`v0.8.2` 起地区信号要求票数与占比）。
- npm：**未发布**。npm 2026 年起要求发布者使用安全密钥 2FA，而新账号已无法登记 TOTP（`npm profile enable-2fa` 返回 E404）；在满足该条件前只走 GitHub 源码安装。
- dsh-plugin.org：收录申请已提交（[dshplugin/dsh-plugin-hub#324](https://github.com/dshplugin/dsh-plugin-hub/issues/324)），等待人工核实时状态为 `unconfirmed`。

完整步骤与已知阻塞见 [RELEASING.md](./RELEASING.md)。
