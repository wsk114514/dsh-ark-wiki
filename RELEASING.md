# 发布清单（RELEASING）

把 `dsh-ark-wiki` 发布到 npm、让它在 DSH「插件中心」可一键安装，并提交到社区收录站。

> 没有「官方插件市场」。官方唯一发现面是 GitHub topic **`dsh-plugin`**；DSH 内置的插件中心只展示
> 能用 `dsh plugin --profile web add <包名>` 安装的 **npm 包**。收录站由社区维护。

---

## 0. 仓库地址（已替换）

包元数据已指向 `https://github.com/wsk114514/dsh-ark-wiki`：

| 字段 | 值 |
| --- | --- |
| `package.json` → `repository.url` | `git+https://github.com/wsk114514/dsh-ark-wiki.git` |
| `package.json` → `homepage` | `https://github.com/wsk114514/dsh-ark-wiki#readme` |
| `package.json` → `bugs.url` | `https://github.com/wsk114514/dsh-ark-wiki/issues` |
| `README.md` 徽章 | 未发布 npm、未收录 dsh-plugin.org 时只放 CI / License 徽章；收录后再换成 `dsh-plugin.org/badges/listed.svg`（见第 6 节） |

若以后改仓库名或换账号，一次性替换并自查（应输出 0 行）：

```powershell
(Get-ChildItem package.json,README.md,LICENSE | Select-String -Pattern 'YOUR-GITHUB-USER').Count
```

## 1. 发布前自检（不联网 + 联网）

```powershell
# 契约与生命周期（离线，秒级）；CI 跑的就是这条
npm install        # 只装 devDependency @deepseek-ai/dsh-tools
npm test
node tools/harness.mjs offline

# 剧情卡司快照过期时重建（联网，约 4–6 分钟；产物 data/story-cast.json 随包发布）
npm run data:cast

# 真实数据端到端（24 个 lookup + 10 个卡池/新角色预测用例，需要访问 prts.wiki）
$env:HARNESS_SUMMARY='1'; node tools/harness.mjs live

# npm 会打包哪些文件、manifest 是否合法
npm run pack:check
```

要求：`offline` 全 PASS；`live` 输出 `allValid: true`；`npm pack --dry-run` 里只出现
`lib/`、`data/`、`cordis.patch.yml`、`README.md`、`LICENSE`、`package.json`（`tools/` 不进包）。

CI：`.github/workflows/ci.yml` 在 push / PR 时执行 `npm ci` → `npm test` → `npm run pack:check`，
只验证离线契约与打包清单，不访问 prts.wiki（线上用例靠手动跑 `live`）。

## 2. 版本与兼容声明

- `version`：当前 `0.10.0`。以后每次发布递增，不要复用版本号（npm 上版本永久占用）。
- `engines.dsh: ">=0.2.1-rc.1"`：宿主据此决定是否加载。DSH 从 **0.2.1-alpha.4** 起优先读
  `engines.dsh`，不再读 `peerDependencies` 里的 `@deepseek-ai/dsh*` 范围；更老的宿主才走 peer 检查。
  **不要**在 `dependencies` 里列 `@deepseek-ai/*`（会被 pnpm 装进 profile，和宿主形成双实例）。
- `peerDependencies`：`@deepseek-ai/cordis ^4.0.2`、`@deepseek-ai/dsh-tools ^0.2.1-rc.2`（两者都在 npm 上存在）。
  升级宿主大版本后，同步放宽这两个范围并提升 `engines.dsh` 的下限。
- 实测宿主：`@deepseek-ai/dsh@0.2.1-rc.2` / `dsh-tools@0.2.1-rc.2`（desktop nightly 通道）。

## 3. 建仓库并发布 npm

```powershell
# 首次需要登录（发布必须用你自己的 npm 账号；本仓库不保存任何 token）
npm adduser
npm whoami        # 应打印你的用户名，而不是 ENEEDAUTH

git init
git add -A
git commit -m "feat: dsh-ark-wiki 0.10.0 - Arknights PRTS lookup + story-cast predictions for DSH"

# 在 GitHub 上新建同名公开仓库，然后：
git remote add origin https://github.com/<你的用户名>/dsh-ark-wiki.git
git branch -M main
git push -u origin main
```

仓库设置里加 topics（点仓库右上角 ⚙ Topics）：

```
dsh-plugin
deepseek-harness
arknights
prts
```

### npm 发布（现状：0.10.0 已上线，后续走 OIDC）

`dsh-ark-wiki@0.10.0` 于 2026-10-21 发布：`npm publish --access public`，凭据是一次性使用的 granular access token（勾选 *Bypass 2FA*）。此后发布不再依赖任何长期 token：

1. **一次性配置 trusted publisher**（需要过一次交互式 2FA——安全密钥 / passkey；bypass token 不能代替，实测连 `npm trust list` 都返回 403）：
   - 网页：npmjs.com → 包页面 → Settings → **Trusted Publishers** → Add publisher → GitHub Actions，填 repo `wsk114514/dsh-ark-wiki`、workflow 文件名 `release.yml`，environment 留空。
   - 或 CLI：`npx npm@11 trust github dsh-ark-wiki --repo wsk114514/dsh-ark-wiki --file release.yml --allow-publish -y`
2. **以后发版只打 tag**：`git tag -a v0.10.1 -m "..." && git push origin v0.10.1`。`.github/workflows/release.yml` 用 GitHub Actions 的 OIDC 身份换取短期凭据，执行 `npm publish --provenance`，仓库与本地都不需要 `NPM_TOKEN`。
3. **时机**：npm 的 2FA-bypass token 直发权限预计 **2027-01** 起完全收紧（之后只允许 staged publish + 人工批准）；OIDC 可信发布不受影响，且能让包页显示 provenance 徽章。
4. 首次发布用的 bypass token 已经用完，可在 npmjs.com 的 Access Tokens 页面吊销（`.npmrc.bak-20261021` 里的旧 token 同理）。

本地那次 `npm publish` 的报错（留作背景）：未勾选 bypass 的 token 会得到
`403 - Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.`；
新账号也不能再登记 TOTP（`npm profile enable-2fa auth-and-writes` → `Adding a new TOTP ... is no longer supported`），只能在 `https://www.npmjs.com/settings/<user>/tfa` 注册安全密钥。

仍可用 GitHub 源码安装（适合跟最新提交）：`dsh plugin --profile web add github:wsk114514/dsh-ark-wiki`。

**GitHub 源安装实测（2026-10-19）**：在空目录 `npm i github:wsk114514/dsh-ark-wiki` → 22s 装完 25 个包，
随后 Node 直接加载该包：导出 `name`、`inject: ['tools']`、注册 1 个 `ark_wiki_lookup`，
live 查询「至纯源石」返回 `status: ok / category: item / matchedBy: exact`，`render` 返回 1 个文本块。

> 若 `git push` 报 `Recv failure: Connection was reset` 或 `Couldn't connect to server`，先重试，
> 再不行用 `git -c http.version=HTTP/1.1 push`（本机实测该参数一次成功，而默认 HTTP/2 连续失败）。

发布后立刻验证别人能装：

```powershell
npm view dsh-ark-wiki version dist-tags
# 干净 profile 试装（profile 名按需要替换）
dsh plugin --profile web add dsh-ark-wiki
```

> 注意：DSH 启动时会校验版本门禁。若提示某插件因版本不兼容被禁用，用插件管理器对该包做版本豁免，
> 或把 `engines.dsh` 下限调到用户实际版本（这会把老宿主也放进白名单，谨慎使用）。

**本机实测记录（2026-10-19，Windows + desktop nightly `0.2.1-rc.2`）**：本机的 `dsh` 命令是桌面版
的 shim —— `dsh --help`、`dsh plugin --help`、`dsh plugin --profile pkgtest add <tgz>` 全部
**静默退出 0 且不落盘**（不创建 profile），所以不能用它做安装验证。改用两步验证：

```powershell
npm pack
# 在临时空目录里装 tarball，再直接用 Node 加载打包产物
npm i C:\path\to\dsh-ark-wiki-0.10.0.tgz --no-audit --no-fund
node -e "import('dsh-ark-wiki').then(async m => { const reg=[]; await m.apply({ tools:{ register:t=>(reg.push(t),()=>{}) }, effect:f=>f() }); console.log(reg.map(t=>t.name)); const v=await reg[0].execute({query:'银灰'},{}); console.log(v.status, v.entry.name, v.entry.skills.length, v.entry.talents.length); })"
```

本次打包产物实测 10/10：导出 `name/inject/apply`、注册 1 个 `ark_wiki_lookup`、`parameters`/`output.schema`/`render`
齐全、live 查询「银灰」返回 3 技能 + 2 天赋、`render` 返回 1 个文本块。宿主内再用
`plugin_manager` 的 `install_bundle` / `set_plugin`（entryId `include:dsh-ark-wiki`）验证加载。

## 4. 在 DSH 里挂载

npm 包发布前用 GitHub 源码安装：

```powershell
dsh plugin --profile web add github:wsk114514/dsh-ark-wiki
# 然后把 "dsh-ark-wiki" 追加到 %DSH_HOME%\profiles\web\package.json 的 dsh.profile.bundles 数组
```

npm 包发布后（见第 3 节「已知阻塞」）改用 `dsh plugin --profile web add dsh-ark-wiki`。

或在会话里用 `plugin_manager`：`action: install_bundle`，`target: dsh-ark-wiki`。
之后直接提问「阿米娅的技能和天赋」验证工具被调用。

## 5. 提交到社区收录站

### 5.1 dsh-plugin.org（DSH Plugin Hub，免费，初始 `unconfirmed`，人工核实后 `verified`）

前置条件（全部已满足后再提）：公开仓库 + `dsh-plugin` topic + 根目录 `package.json` +
README 含安装命令（npm 未发布时写 `dsh plugin --profile web add github:wsk114514/dsh-ark-wiki`）+ 导出 `apply(ctx)`。

**提交记录**：2026-10-20 已用 GitHub API 向 `dshplugin/dsh-plugin-hub` 提交 Issue
[#324](https://github.com/dshplugin/dsh-plugin-hub/issues/324)（模板见下，含真实输出示例）。
审核通过前这里的状态是 `unconfirmed`，README 不放 `listed.svg` 徽章；通过后再按第 6 节替换。

打开 <https://dsh-plugin.org/zh/submit>，用模板提 Issue，可直接复制：

```markdown
### 仓库地址
<https://github.com/wsk114514/dsh-ark-wiki>

### 一句话价值
在 DSH 对话里直接查明日方舟资料——干员属性/技能/天赋/档案/密录、物品、关卡、剧情台词，全部来自 PRTS Wiki 实时数据。

### 能力分类
工具与能力

### 安装命令
dsh plugin --profile web add github:wsk114514/dsh-ark-wiki

### 兼容与运行要求
DSH >= 0.2.1-rc.1（engines.dsh），Node >= 22，Windows/macOS/Linux；需要访问 https://prts.wiki；只读、无需 API Key。

### 许可证
MIT（游戏数据与 wiki 文本版权归 Hypergryph / PRTS，插件为非官方粉丝工具）

### 截图 / 演示
<贴一张对话里问「阿米娅的技能和天赋」的截图，或贴一段真实输出>

### 补充说明
外部服务：仅 prts.wiki 的公开 api.php；权限：只读，不读本地文件/凭据，无遥测。
已知限制：依赖 PRTS 页面模板结构，改版时对应字段降级为空；剧情台词截断 60 条。
```

### 5.2 dsh.works（自动扫 topic）

无需提交：打了 `dsh-plugin` topic 后会被自动抓取，证据文件用 `package.json` 的
`dsh.bundle` 字段（本插件已具备）。想加速可以 PR 到
`https://github.com/dshworks/awesome-dsh-plugins` 的 `data/plugins.json`。

### 5.3 其它聚合源

`dsh.so`、`dshmarket` 与 DSH 里的 `find_dsh_plugins` 会聚合上面几家的数据，无需单独提交。

## 6. 收录后

- 用详情页 URL 替换 README 顶部徽章中的 `<owner>/<slug>`：
  `[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/<owner>/<slug>)`
- 打 git tag 并写 Release：`git tag v0.10.0 && git push --tags`。
- 后续发版：改 `version` → `npm publish` → `git tag`。不要 force-push 已发布 tag。

## 7. 合规提醒

本项目是非官方粉丝工具：与 Hypergryph（鹰角网络）、《明日方舟》官方及 PRTS Wiki 无隶属关系；
数据版权归原权利方，仅做实时读取与展示，仅供个人非商业使用。不要把查询结果批量落盘再分发，
也不要在 README 或宣传中暗示官方授权。详见 `README.md` 的「免责声明与权限」与 `LICENSE`。
