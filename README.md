# dsh-ark-wiki

为 DSH 提供一个模型可调用的工具 `ark_wiki_lookup`：查询 PRTS Wiki 的《明日方舟》数据（干员及其技能/天赋/档案/密录、物品、关卡、剧情），返回结构化结果，由模型据此作答。

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/wsk114514/dsh-ark-wiki)

> **非官方粉丝项目**：与 Hypergryph（鹰角网络）、《明日方舟》官方及 PRTS Wiki 均无隶属关系；所有游戏数据与 wiki 文本的版权归原权利方，本项目仅做实时查询与展示，仅供个人非商业用途。详见[免责声明](#免责声明与权限)。

## 快速安装（npm）

```bash
# 1. 装到目标 profile（把 web 换成 desktop / 你实际使用的 profile 名）
dsh plugin --profile web add dsh-ark-wiki
# 2. 把包名写进该 profile package.json 的 dsh.profile.bundles 数组
```

装完直接在对话里用自然语言提问，例如：

- 「阿米娅的属性、技能和天赋」
- 「至纯源石是干什么用的」
- 「1-7 的掉落和敌人」
- 「0-1 坍塌 行动前 有哪些台词」「12F 干员密录」

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
{ "query": "阿米娅", "category": "operator" }   // category 可选：operator | item | stage | story
```

`category` 省略时按查询词自动判定：含「行动前 / 行动后 / 密录 / 剧情 / 序曲」或 `/BEG`、`/END` 时先当剧情查；形如 `1-7`、`S4-7`、`CE-5` 的代号先当关卡查；其余先查物品（仅接受完全同名），再查干员，然后关卡，最后剧情。

剧情类别同时接受剧情页标题（`0-1 坍塌 行动前`）与章节/活动名（`黑暗时代·上`）；后者返回 `candidates`（最多 8 条），模型可据此再查具体标题。

返回值是一个 canonical JSON envelope（`output.schema` 已声明，`additionalProperties: false`）：

| 字段 | 含义 |
| --- | --- |
| `status` | `ok` / `not_found` / `error` |
| `category` | `operator` / `item` / `stage` / `story` / `unknown` |
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

掉落项形如 `{ name, condition }`（`condition` 为「固定掉落」「三星获得」等，可能为 null）；敌人项形如 `{ name, count, level }`。

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

`lib/prts.js` 负责 HTTP 细节：默认 8 秒超时（干员页/剧情索引放宽到 12 秒）、网络/5xx 重试 1 次、`AbortSignal` 透传（宿主取消会真正中断请求）、API 错误包装成 `PrtsError`。工具整体 `timeoutMs: 30000`：首次调用要先拉干员列表（约 1 秒，PRTS 偶尔到 10 秒）+ 详情页，后续命中缓存。

## 目录结构

```
dsh-ark-wiki/
├── package.json         # name/version/type/exports/dsh.bundle.patch/peerDependencies
├── cordis.patch.yml     # 插件加载补丁（- insert: id: dsh-ark-wiki）
├── lib/
│   ├── index.js         # defineTool 定义、output schema、render、apply(ctx)
│   ├── prts.js          # PRTS HTTP 层：apiGet / cargoQuery / searchTitles / pageContent / 模板解析
│   └── sources.js       # 四类词条解析（含剧情/密录/档案）、匹配评分、缓存、resolveLookup 调度
├── tools/
│   └── harness.mjs      # 本地契约 + 数据端到端测试（node tools/harness.mjs live）
├── README.md
├── LICENSE              # 代码 MIT；数据版权归属见文件末尾
└── RELEASING.md         # 发布清单（npm + GitHub topic + 收录站提交）
```

## 本地测试

```powershell
node tools/harness.mjs offline   # 不联网：schema 编译、参数校验、apply(ctx) 生命周期、effect 清理
node tools/harness.mjs live      # 联网：17 个真实查询 + 期望断言（技能/天赋/档案/密录/剧情），输出 allValid
$env:HARNESS_SUMMARY='1'; node tools/harness.mjs live              # 只打印「allValid + 每例耗时/状态/失败标记」
$env:HARNESS_REPORT='tools/report.json'; node tools/harness.mjs live  # 额外落盘完整 JSON（绕开 PowerShell 5.1 重定向写 UTF-16 的坑）
```

`harness.mjs` 直接 import `lib/index.js`，用真实 `defineTool` 编译出的 JSON Schema 配合 `@deepseek-ai/dsh-tools` 的 `validateJsonSchemaValue` 校验，因此与宿主行为一致；它还用假的 `ctx`（`tools.register` + `effect`）调用 `apply(ctx)`，验证注册数量、名称与 dispose 链。live 用例里阿米娅/12F/银灰/玫兰莎/剧情用例带 `assert`：技能条数、专精行、天赋层级、潜能增强、`？？？` 占位被过滤、体检档案出身地、档案段落、密录页面指针、剧情 kind/章节/登场角色/台词截断、关卡关联剧情 before/after。

## 已知限制

- PRTS 的 Cargo `item` 表只做 `LIKE` 粗筛，最终排序在本地用精确/前缀/包含三级评分完成；中文分词不做，查询词越短召回越宽。
- 物品与干员同名时以 `category` 为准；不传 `category` 时物品只接受完全同名，避免「阿米娅」被解析成「阿米娅的信物」。
- 关卡模板是 wiki 文本，`{{color|...}}`/`[[a|b]]` 等标记会被清洗；若 PRTS 改模板字段名，需要同步 `lib/sources.js` 的 `parseStagePage()` 键映射与 `extractStageParams()` 的模板名匹配规则。
- 技能/天赋同理：`parseSkillsFromPage()` 认 `{{技能N|…}}` 的 `技能{1..7,专精1..3}描述|初始|消耗|持续` 键，`parseTalentsFromPage()` 认 `{{天赋列表3|…}}` 的 `天赋N`/`潜能增强_天赋N*` 键（PRTS 偶尔把键写成 `潜能增强_{N}天赋效果`，已兼容）；两者都是「PRTS 改模板就失效」的脆弱点，失败时只会少这两个字段，不会影响基础档案。
- PRTS 用 `？？？` 占位尚未公开的天赋，这类条目会被过滤掉，因此某些干员的 `talents[]` 可能只有一条。
- 只读公开页面，不涉及登录态；高频调用会受 PRTS 限流，插件内仅对干员列表、干员页、剧情索引与密录索引做缓存。
- 剧情索引依赖 `Template:剧情导航` 的 wikitext 表格结构（`!` 章节 / `!` 主线|活动|剧情 / `|` 链接列表），一旦 PRTS 改版该索引会整体失效（表现为剧情查询全部 `not_found`，其余类别不受影响）。`活动一览` 由 SMW `#ask` 渲染、`干员密录一览` 由 `{{#Widget:MemoryList}}` 动态生成，两者都没有可直接解析的静态列表，因此活动剧情只覆盖导航模板里出现的条目。
- 剧情正文只取页面内嵌的 `文本数据` 演出脚本，台词截断到 60 条、角色到 20 个；`演出补充`/分支选项不解析，纯音频/图片指令按旁白丢弃（无文本时直接跳过）。关卡与剧情的关联用「`关卡代号 + 关名 + 空格` 前缀匹配导航标题」猜出来的，个别关卡若命名不一致会漏掉 `story` 字段。

## 兼容性

- 运行时：Node.js ≥ 22；DSH `@deepseek-ai/dsh` ≥ 0.2.1-rc.1（见 `package.json` 的 `engines.dsh`，实测宿主 0.2.1-rc.2）。
- 依赖：`@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools` 由宿主提供（peerDependencies，不随插件打包）；唯一的运行期依赖是 `ark-info@^0.1.1`（MIT），它只是一个 PRTS 客户端，不包含游戏数据。
- 平台：纯 JS、无原生模块，Windows / macOS / Linux 通用。
- DSH 的版本门禁会读 `engines.dsh`（0.2.1-alpha.4 起优先于 peerDependencies）；若你的宿主版本更老，可用插件管理器对该包授予版本豁免，或回退到源码安装。

## 发布

发布到 npm、打 `dsh-plugin` topic、提交 dsh-plugin.org / dsh.works 收录的完整步骤见 [RELEASING.md](./RELEASING.md)。
