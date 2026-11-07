# Changelog

## 0.2.0

**304 个真实插件 CAP 普查驱动的修 bug + 自动适配增强：让"装上就能用"的插件更多。**

修 bug（全部由真插件实证）：

- **裸域名 GitHub 地址可解析**：`github.com/owner/repo`（无 scheme、可带 www）此前掉进搜索短语落到 npm 查询 NOTFOUND；intake/fetch 三处统一识别，`tree/` 分支与子目录形式同步支持。
- **`pkg@version` 版本规格可解析**：工具文档一直承诺支持，实际被分类成搜索短语——70+ 个合法 spec（含真机装过的 dsh-pet@0.3.8）被误杀。分类器与 parseNpmSpec 对齐（空 range=latest）。
- **宿主级风险按可达性判定**：新增 `lib/reach.js`——从包入口（main / exports['.'] / client / 启用的 patch 行）出发做 import 闭包，只有宿主真正加载得到的文件才计致命项。此前 30% 热门插件被误拦：Skill 资源目录（bundledSkillDir）、MCP 子进程、`disabled: true` 行里的 process.exit / async-throw 都被当成宿主杀手。不可达文件的命中**降级为提示而非静默跳过**；入口解析不出则回退旧的目录名扫描。
- **exports-only 入口可解析**：dsh-aris 无 main、入口在 package exports 映射——行名 `pkg/sub` 现在按 exports 解析。
- **`github.com/../etc` 路径穿越形态拒绝解析**。

自动适配增强：

- **孤儿 import 自动携带**：转换前对最终树做 import 闭包审计，作者引用了但没声明的依赖只要 registry 上有就按最新版自动 vendor（如 dsh-pet 的 undici）。wallpaper-engine 实证：9 个未声明的 monorepo 兄弟包全部自动携带，产物 8.2MB→14.3MB，从"装上必挂"变"完整可用"。解析不了的降级为警告；vendor 自身失败不拖垮转换。
- **npm 缺失条目按目录仓库重试**：约 50 个纯 GitHub 目录条目此前直接"未找到"；现在判定时自动查社区索引里记的仓库地址重试（dsh-uppercase 实证 not-found → analyzed）。结果带说明，不静默。
- **GitHub 判定缓存**：verdict 落盘记录 repo 别名，同一仓库的复测 1 小时内不再重新下载扫描（moving-ref 纪律与归档缓存一致）。
- **市场返回瘦身**：成功路径不再重复携带 plan/verification/declared 清单等冗余字段（失败路径全保留）——一轮安装对话省约 25% token。

目录：唯一 ★精选（dshm-boot-rescue）的安装源指向 GitHub main（`spec` 字段，卡片复制指令随之变化）。

测试：**102/102**（新增 5：可达性四形态+exports、闭包缺口与孤儿 vendor、patchRows、目录重试）。CAP 总账：304 唯一样本，转换 130、真实安装 55、零崩溃零卡死。

## 0.1.35

**复制完指令然后呢？——真机反馈：界面从没告诉过用户下一步。**

- 复制成功后，按钮下方展开四步指引：① 打开和 AI 助手的对话粘贴并发送 → ② 助手给成本预览 → ③ 说「确认安装」即带 confirm 重跑 → ④ 装完重启 DSHM 生效。常驻显示直到下一次复制；剪贴板不可用时附手动选中文案。
- 覆盖两处入口：卡片上的「复制适配指令」和搜索框下的「适配这个输入」；按钮文案改为「已复制 ✓」。
- 测试 97/97（指引为复制后瞬时 UI，初始渲染不变，既有断言不受影响）。

## 0.1.34

**Device-review round: the first real-device run (dsh-deepseek-pet, 31 MB, ~4.5 min) named four fixable problems — all fixed here.**

- **失败要带原因**（真机复盘第一条）：`compat_market` 在 classify 失败时结果 JSON 里有 `error.message`，但 `renderMarketCard` 不渲染 `error` 字段——设备 agent 只看到一行无信息标记，被迫换工具拿证据。现在错误码+原因直接画进卡片。
- **下载单列一行，慢在哪一眼可辨**：`loadArchive` 把下载来源主机、体积、耗时写到 resolved 上；报告 `resolved.downloadMs/downloadBytes/downloadSource`、卡片新增「下载   来源 · 体积 · 耗时（缓存命中）」行、每个步骤带墙钟时间（≥500ms 才标）。31 MB 下载 2 分钟 → 卡片明写"registry.npmjs.org · 31.2 MB · 168.3s"，**慢是网络不是插件**。
- **DSHM 默认走 npmmirror 镜像**：`defaultRegistry()`——`DSHM_PLATFORM=ohos` 默认 `registry.npmmirror.com`（同字节同 integrity，校验链不破），PC 保持官方源，`DSHM_COMPAT_REGISTRY` 环境变量全局覆盖。真机上 31 MB 从 2–3 分钟变秒级。
- **下载超时 120s → 300s**：31 MB 在手机网络下超了旧默认，`classify:failed` 的真凶大概率就是它——下载中止被报成了分析失败。
- **`compat_analyze` 缓存命中**：判定缓存现在记录 `reportFile`；npm 规格再次 analyze 时若同版本全量报告已在盘上，直接返回（`cached:true`），不再重新下载/解包/扫描——真机复盘里第 3 步的全量重扫不再发生。
- 测试：**97/97**（新增 2 —— defaultRegistry 三态、verdict 落盘 reportFile）。

## 0.1.33

**The market tab's offline view is just ★ 精选 now — the hand-written 目录 section is gone (user request, device feedback).**

- 兼容市场标签页离线空态移除「目录 · 11」手写目录段：精选之外的候选交给「载入全部插件」之后的 2 万条全量网格（分类/排序/分页都在那边）。已安装段保留。
- `CATALOG` / `assets/catalog.json` 不动：宿主货架（`compat_market_browse`）与已装徽章映射仍依赖它，只是不再作为标签页的独立浏览段渲染。
- 测试断言同步：离线初始渲染含精选条目及其预期徽章，不含「目录」段；95/95。

## 0.1.32

**Line-by-line audit of the adaptation core (analyze → convert → pack → install), plus an optimization pass; fixed locally; not published yet.**

优化（性能/一致性，行为不变）：

- **货架判定索引单次读取**：`marketShelf` 此前对每条条目各读一遍 verdicts.json（50 条 = 50 次文件读 + JSON 解析）；现在 `readVerdictIndex()` 读一次全表共享。
- **客户端全量索引模块级 memo**：标签页每切回来一次就重读 ~9MB localStorage + JSON.parse（手机 webview 上几十到上百毫秒）；现在进程内缓存，TTL 照查。
- **analyze 大文件注释剥离只做一次**：electron 与 BrowserWindow 两个计数此前各自剥一遍正则，现在 `stripComments()` 共享。
- `convert` 打包路径去掉了重复的一次映射（行为等价）。

- **`convert` 子目录收窄（真 bug）**：`github:…&path:/sub` / `…/tree/main/<sub>` 规格此前只有 analyze 做了子树收窄，convert 没有——monorepo 插件（dsh-pet 即是）会被拿**仓库根**的 package.json 改写打包，装进来的不是用户指名的那个包。现在与 analyze 同一收窄逻辑（monorepo 的另一半坑补上了）。
- **`packTarGz` pax 长路径（真硬伤）**：路径超 ustar 100+155 字节时直接抛 "tar path is too long"——vendor 拍平的 node_modules 深路径会炸掉整个转换。现在按 POSIX 写 pax `x` 扩展头（长度字段迭代到稳定），自家 reader/宿主/npm 均消费该格式。**非 ASCII 超长路径仍拒绝**（宿主 pax 解析器历史上按字节量长度、按字符下标切片，非 ASCII 名会损坏——ASCII 长路径字节=字符，安全）。
- **`packTarGz` 确定性排序**：`localeCompare` → 码点排序。ICU 环境不同会让同一输入产出不同字节、不同 sha256——构建必须可复现。
- **`tar.js` GNU base-256**：首字节高位是标记不是数据，此前未掩码（>8 GB 才会触发，理论 bug，一行修掉）。
- **`analyze` platformBlocked 通配符**：`os:['*']` / `cpu:['*']` 此前被误判为平台受阻——与 market.js quickSignals 的读法对齐（含 `*` 或含 linux/openharmony/arm64 即放行）。
- **`convert` → `vendor` 缓存贯通**：vendored 依赖的 tarball 此前绕过归档缓存，每次转换重新下载整棵树。`cacheDir` 现在贯通到 `loadArchive`。
- **`convert` 文件数护栏**：产物会被 20,000 条目上限的 reader 回读校验/安装——vendored 树越界会产出 compat 自己读不回的东西。打包前如实拒绝（`too-many-files`）。
- **`local-install` 回滚诚实性**：恢复失败时不再谎报 "previous files restored"，改报 `RESTORE FAILED` 并给出备份位置。
- **`quarantineRow` 翻转诚实性（真 bug）**：手工编辑过、flag 不可机读的行（如 `disabled: false # 备注`）此前被原样写回却返回 `ok:true, changed:true`——谎报停用成功。现在如实返回失败并指引手改；顺带清了一行死代码。
- 测试：**95/95**（新增 3 —— pax 长路径往返 + 字节确定性、`os:['*']` 不误判、quarantine 翻转/幂等/诚实拒绝）；另有 pax 边界 smoke（100/101/260 字节、非 ASCII 拒绝、50 条长路径）全过。
- 已知测试空档：convert 的子目录收窄与 analyze 同构但无直接用例（需要 stub 模块内 resolveSpec），待真机走一次 `github:…&path:/sub` 转换验证。

## 0.1.31

**Bug-fix pass over 0.1.28–0.1.30, reviewed against its real host: DSHM on a HarmonyOS phone, not dsh on a PC.**

- **归档缓存读取链加固**（`loadArchive`）：`existsSync → statSync → readFileSync` 三步之间文件可能被并发写/删（Windows 与 hmdfs 都常见），此前任何一步抛错会让整个下载路径崩掉。现在整段读取包在 try/catch 里——**缓存有任何疑点就等于没有缓存**，静默回退到下载。写入改为**原子发布**（临时文件 + rename，Windows/hmdfs 拒绝替换式 rename 时回退直写）：并发读者永远看不到半个 tarball。
- **TTL 条目补上内容校验**：移动 ref / 裸 URL / 缺 integrity 的 npm 条目此前读缓存时零校验——磁盘上损坏的字节会被当成真包送出去。现在写入时落 sha256 侧车（`.sha`），读取时逐字节核对，不符即删重下；修复后第三次读取恢复缓存命中。原则：**缓存只回答它证明得了的字节**。
- **缓存上限 + 淘汰**（鸿蒙环境）：手机磁盘小、沙箱有配额，归档缓存此前无界。现在 256 MB / 64 个文件封顶，写后按 mtime 最旧优先淘汰（含侧车）；淘汰本身 best-effort，失败只影响下一次。
- **`marketVerdict` 与 `marketAdapt` 的判定形状对齐**：`coreVersion` 此前一边在 `services` 里、一边在顶层——同一事实两种形状。统一为顶层 `services` + `coreVersion` 并排（与 `servicesPatch()` 一致）。
- 测试：92/92（新增 2 —— TTL 条目损坏检测与自愈、淘汰顺序恰好保留最新 64 个）。

## 0.1.30

**Shelf states: the badge is this device's conclusion, or an honest 预期 — never the two blurred.** (待办 #2 的地基)

- 新 `shelfState()`（`lib/catalog.js`）：把 **L2 判定缓存（0.1.29）+ 安装账本 + pendingVerify 清单** 合成每条货架条目的状态徽章。两种话严格分开，`source` 字段说明徽章是哪一种：
  - `verdict` / `ledger` —— 本机结论：`可装` / `需 worker` / `需源码构建` / `不支持` / `服务缺失` / `会杀宿主` / `不是插件` / `需复核` / `已装` / `已装·待复核` / `可适配（未装）`（旧账本只有策略没有结局，不敢替本机承诺"可装"）
  - `expect` —— 目录描述：`预期可直装` / `预期需 worker` / `预期需源码构建` / `预计不支持`
- 交接文档的六态之外诚实扩了两态：**会杀宿主**（host-killing 值得自己的标签，归进"不支持"会把用户引去错误的下一步）和**服务缺失**（同因）。宿主级风险不是"不兼容"。
- `marketShelf` 每条挂 `state`；`renderShelf` 的徽章改用状态标签（原来显示的是 `lastVerdict ?? expect ?? '?'` —— 策略码和描述混在一格）。
- `verdicts.js` 新增 `readLatestVerdictByName`：货架只知道名字不知道版本时取最新判定的查找。
- 测试：90/90（新增 2 —— 状态映射的"结论/描述不混淆"表、marketShelf 从判定+账本+待复核合成状态）。

## 0.1.29

**L2 verdict cache — analyze once, answer from disk.** (待办 #1；主功能是自动适配，这一层直接加速适配管线)

- **归档缓存**（`loadArchive` 新增 `cacheDir`）：下载过的 tarball 落盘复用，一次 `compat_market` 里 analyze→convert 的**双重下载**消失。不可变性分级：npm 带 `sha512` integrity 的包按内容寻址——**永久缓存，读时逐字节校验**，校验不过（篡改/截断）就删除重下，绝不提供坏字节；GitHub 的 40 位 commit ref 同样视为不可变；移动的 ref（`main`）、裸 URL、缺 integrity 的 npm 条目按 1 小时 TTL 处理——过期的答案不是"差一点"而是"错的"。
- **判定缓存**（新 `lib/verdicts.js`，`<compat>/verdicts.json`）：`name@version → {strategy, confidence, hostRisk, hasDsh, services, outcome, blockedReason, analyzedAt}`。`compat_market` 的每个终点（blocked / needs-worker / needs-review / dry-run / installed）都落一条；包侧字段对固定版本永不过时，服务判定带 `coreVersion`——core 升级自动重开这个问题。上限 500 条按时间淘汰，与 `state.json` 账本分文件（查找表 ≠ 人类账本）。
- **新工具 `compat_verdict`**："点一下测"的单发判定——策略、host-risk、服务门禁，不转换不安装。缓存命中时只查 packument 确认版本仍是最新（**tarball 一字节不下载**）；未命中则下载一次、记录、作答。全量索引里的任何条目都可以这样低成本测；完整适配仍走 `compat_market`。本地 .tgz 输入跳过缓存读——它的身份要开包才知道，没有可查的键。
- `compat_status` 新增 `verdictsCount`。
- 测试：88/88（新增 2 —— 归档缓存的完整性校验/防篡改、判定缓存的记录与零-tarball 复查）。

## 0.1.28

**The market tab is rebuilt the way dshmarket browses.**

参照 `dshmarket/src/client/` 的交互模式重做兼容市场标签页；四条模式直接移植，纪律原样保留：

- **搜索**（SearchInput.tsx 模式）：250ms 防抖；**IME 组合安全**——中文拼音组合期间绝不提交（组合结束、回车、失焦才落地），清除按钮清的是草稿不是已提交值；`spellCheck:false`（插件名不是散文）。
- **分类 chips**：全量索引就绪后按目录分类（工具/界面/集成/工作流/模型接入/主题/其他）带计数，`全部` 置顶；无分类的行（精选目录、已装未收录）不编造「未分类」桶。离线 13 条目录时 chips 和排序都不出现——13 条不需要两层过滤。
- **排序**：最热（stars）/ 最新（发布日期）。缺席值垫底但不冒充 0（registry.ts 对 downloads 的同款纪律）；0 星或缺席不显示 ★——没有数据不冒充"没人要"；版本缺席不显示版本段。
- **卡片网格 + 分页**：`repeat(auto-fill, minmax(300px,1fr))`，60 条一页「加载更多」；卡片 = 名字 + 版本 + 徽章 / 一句话（省略号，title 悬停全文）/ ★ · 更新日期 · 分类 + 复制适配指令。
- **诚实徽章**：目录条目的 `expect` 渲染成「预期可直装 / 需原生 worker / 预计不支持」——措辞是描述，结论永远归宿主工具；全量索引条目一律「未分析」（未扫描 ≠ 未检出，capabilities 措辞纪律）；未知策略原样透传，不发明文案。
- 执行边界没动：页面仍只负责发现与决策（复制 `compat_market` 指令），安装仍在宿主。
- **没动的东西**：`compactRows` 与宿主索引管线一字未改（parity 测试钉着）；宿主半边（market.js/intake.js/index-source.js）零改动；`commandFor`、双槽位注册（plugins.tab order 30 / settings.plugins.tab order 20）、服务 shim 全部保持原契约。
- 新增导出 `strategyLabel` / `categoryLabel` / `categoryChips` / `sortRows` / `pageSlice` / `PAGE_SIZE` / `STRATEGY_LABEL` / `CATEGORY_LABELS`，全部有测试钉住。离线回归 **86/86**。

## 0.1.27

**The full index — taken from the community catalog, not crawled here.**

`compat_market_index` searches **21,402 distinct plugins** instead of the dozen on the
shelf. The data is `dsh-plugin-shop-catalog` (npm, v5 schema): `v1/index.json` points at a
sharded `plugins.<sha256>.json` plus `stars.<sha256>.json`. npm-hosted matters for the
same reason dshmarket chose it — GitHub Pages and the public GitHub proxies are unusable
from mainland China, npm mirrors are not.

- `lib/index-source.js`: resolve catalog version → download → **verify the shard sha256
  before parsing** → compact 23,542 rows to the dozen fields the market renders → cache
  as one ~9 MB file under `<compat>/index/current.json`. The raw 22 MB shard is dropped;
  parsing it on every open would not be acceptable on a phone.
- **Measured on the real catalog**: 9.4 MB tarball, 3.5 s, 23,542 rows → 21,402 unique,
  `builtAt 2026-11-04`; categories tool 8,839 / ui 5,637 / integration 2,113 / other
  1,520 / workflow 1,352 / provider 1,308 / theme 766.
- Three upstream quirks, each now pinned by a test:
  - **Duplicate rows** — the catalog lists a name once per version, commit-hash versions
    included (`dsh-session-delete` appears 28 times). `dedupeByName` keeps one row per
    plugin, scored by *evidence* (has repo, has summary) before recency. Keeping the
    newest blindly set `stars` to 0 for `dsh-pet` (5,493 stars), because commit-hash rows
    carry no repository.
  - **Star keys are heterogeneous** — `owner/repo` for most rows, bare package name
    (`dsh-pet`), scoped npm name (`@hellosz/dsh-pets`). Lookup tries the repo key first,
    then the package name; `dsh-pet` reads 5,493 instead of 0.
  - **Schema guard** — a catalog newer than v5 raises instead of guessing field meanings.
- Entries are descriptions, never verdicts: the index says "this exists", compatibility
  still comes from `compat_market` / `compat_analyze`, and the tool output says so.
- **The single input box no longer answers with an error** (`lib/intake.js`). Names,
  phrases, browser URLs, tarball paths and typos all arrive at the same box; the old
  `resolve-or-fail` shape turned every one of them into `RESOLVE_FAILED`.
  - `classifyInput()` sorts the input into `github` (`/tree/<ref>/<sub>` included),
    `url`, `path`, `npm`, `phrase` or `empty`. A phrase never touches the resolver — it
    is a search — and `empty` returns `need-input` instead of an error page.
  - **A miss is a miss**: an unresolvable name or URL returns `status:"not-found"` with
    `未找到该项目：<输入>` and one hint. No fuzzy candidates. The first attempt did offer
    them, and `dsh-pett` came back headed by an unrelated popular package — which reads
    as "this exists, try it". dshmarket answers the same way, and its local-match module
    is explicitly built to "refuse the same wrong guesses".
  - A genuine search phrase still searches, strictly by substring
    (`桌宠` → 8 entries), and reports the same "not found" when nothing matches.
- **The tab is laid out like a market, not a list.** Three sections when the box is
  empty — `★ 精选` (recommended first), `已安装` (from the profile, including plugins
  the catalog does not carry), `目录` — and a single `匹配` section while typing. Each
  card keeps the same four things: name, one-line description, status badge, one action.
  An empty result shows `未找到该项目：<输入>` with the deep-search command, which is the
  same sentence the host returns.
- **In-page search over the full index** — by request, and against the plugin's earlier
  "no network from the client" rule, which is now stated honestly in the file header.
  The tab cannot call host code (a Typert remote needs compiler-generated codecs), so the
  browser fetches the catalog itself:
  - `https://unpkg.com/dsh-plugin-shop-catalog@latest/v1/` — measured: `index.json` 676 B,
    shard **21.6 MB gzip, 34 s** on this link, CORS `*`. **jsDelivr was unreachable** in
    this network for both `@latest` and pinned versions, hence unpkg.
  - Because 34 s is a real cost, it is **not automatic**: the tab shows a
    `载入全部插件` button (≈20 MB, once), then caches the compacted list in
    `localStorage` and starts instantly. Failure degrades to the 13-entry shelf with a
    retry button — never a blank page.
  - `compactRows()` is a port of the host's `compactEntry` + `dedupeByName` (the bundle
    cannot import host code). A test extracts that function from the bundle and runs the
    host's fixtures through it, so the two rules cannot drift silently.
- Offline regression suite: 85/85.

## 0.1.26

**A service list that could not be read was allowed to veto an install. It blocked `dsh-pet`.**

`dsh-pet@0.3.8` requires six client services
(`commandUi, connection, locale, remote, remote.commands, slots`). The market blocked it
with three "missing" — and one of those was false: `@deepseek-ai/dsh-client-connection`'s
own `lib/client.js` contains `ctx.provide("connection", handle)`. It was never scanned,
because the inventory only ever looked in the core tree, while that package is resolved
for the plugin that names it in `dsh.client.inject` and therefore sits in the *profile's*
`node_modules`.

- **Both roots are scanned now** (core tree and profile `node_modules`). Reproduced against
  the real package: with the connection package in range the verdict drops from
  `connection, remote, remote.commands` to `remote, remote.commands` — exactly the two that
  no published package provides.
- **The cheap pass has a fallback.** Files were only accepted under the exact name
  `client.js`; one build rename (`dist/client.mjs`, `client/index.js`) zeroed the inventory
  and every declared service became "missing". When a root yields nothing by name, scripts
  carrying the client-bundle marker `__ModuleLoader__.load` are read instead, and
  `pass2: true` says so.
- **An unread inventory is reported, not counted.** `clientServiceNames` now returns
  `ok:false` when it read zero bundles, and `compareServices` puts those names in
  `unknownClient` instead of `missingClient` — the same "empty means unknown, not
  nothing" distinction the host half already made. The market prints
  `无法验证：…` as a warning and lets the install proceed, because unverified is not broken.
- The inventory cache key now carries a fingerprint of each root's top-level package names,
  so installing or removing a plugin invalidates it. A cache built before an install is
  exactly what makes a correct scan answer for a tree it never saw.

What this does *not* do: make a genuinely missing service appear. If `remote` /
`remote.commands` have no provider on the installed core, the block is correct — the
difference now is that the report can be trusted about which ones those are.

## 0.1.25

**A plugin can install cleanly and still be unusable; both halves of that were invisible.**

`dsh-pet` on the phone profile: host routes answered 200, the settings section rendered,
the screen stayed empty. Three gaps kept that from being one readable line.

- **The host log was looked for in the wrong place.** `pendingFromLogs()` read
  `join($DSH_HOME, 'dshm-host.log')`, but on device the log is a *sibling* of `$DSH_HOME`
  (`<…>/files/dshm-host.log` next to `<…>/files/dsh/home`). Every install verdict was
  therefore `unknown` — indistinguishable from "nothing to report" — and `compat_verify`,
  whose entire evidence base is that file, could never settle anything. Logs are now
  located by walking the ancestors of `$DSH_HOME` (bounded; no HarmonyOS module name is
  hardcoded), a `log` field in `host-ready.json` is honoured if the host ever publishes
  one, and a miss now says where it looked instead of only "no host log found".
- **`compat_audit` (new)** finds the files the host installer named wrong. DSHM's tar
  reader measured pax record lengths in bytes and sliced the decoded string by character
  index, so every non-ASCII path swallowed the beginning of the record that followed:
  `东张西望.webm` landed as `东张西望.webm\n19 mtim`. The bytes are intact and the name is
  wrong, so every route that serves an asset *by name* answers 404 — and the host log stays
  clean, because a 404 is a successful response. The tool reports what each name should be;
  `apply: true` renames them. Names only: contents are never read or compared, nothing is
  deleted, and a name whose target already exists is reported instead of overwritten. What
  it cannot fix is stated in the result — a path longer than 100 bytes can also land under a
  truncated `?` name, which no rename can recover.
- **An install now ends with that audit.** `compat_install` reports `assets` when the
  unpacked plugin has a broken name, and the doctor grew an `assets` check (same scan,
  read-only) — so "installed, but every asset 404s" stops looking like a healthy profile.

The installer fix itself belongs to the host (`parsePax` operating on the Buffer, plus a
gate case built on a non-ASCII pax record). This release is the receiver-side repair, and
the evidence that used to be thrown away.

## 0.1.24（已发布）

Two bugs found by a real install attempt (`dsh-pet` via `github:…/tree/main/<sub>`),
both in this plugin, neither in the target plugin:

- **GitHub's own URL form is parsed now.** `https://github.com/owner/repo/tree/main/sub`
  (what a browser's copy button gives you) failed `resolveSpec` outright. `parseGithubSpec`
  accepts `/tree/<ref>[/<sub>]` and `/blob/<ref>/…` in addition to npm's `#ref&path:/sub`.
- **Electron detection counts real API imports, outside comments and probes.** The old
  heuristic counted the *word* `electron`: dependency names (`@electron/get`), an optional
  desktop helper's own code, and doc comments. `dsh-pet` — a pure-JS web widget whose only
  live reference is a `try { require('electron') } catch` **probe** that degrades to pure
  Node — was forced into S2 while its own report said `nativeFiles: 0, nativeSource: false`.
  Now comments are stripped and `try { … }` blocks removed before counting, so an
  electron **probe** is not an electron **dependency**.

With both fixes, `dsh-pet@0.3.8` analyzes as **S0** and converts in dry-run. It is
installed on the device already (with `autoRollback: true`), pending a restart — the
shelf lists it first with that exact status.

- **The market tab follows the light theme.** Every inline style used
  `var(--dsw-alias-…, <dark hex>)`; when the host page does not define those tokens the
  dark fallbacks won — `#1c1c1c` cards and `#e8e8e8` text on a white page. Fallbacks are
  now theme-neutral: text `inherit`, surfaces and borders alpha-grey, secondary text
  expressed as opacity. When the host *does* define the tokens, nothing changes.

## 0.1.23

**The shelf is filled from the plugin board, and the copy got short.**

- **8 plugins verified end to end** — not merely classified, but actually run through
  `compat_market` in dry-run mode and converted: `dsh-free-search`, `dsh-context`,
  `dsh-cost-meter`, `dsh-plugin-mgr`, `dsh-plugin-model-proxy`, `dsh-mnemon`,
  `@michengai/dsh-archive-manager`, `@dfy-plugins/dsh-image-generation`. All S0.
  Two more sit on the shelf with their real status: `dsh-ops` (S2, needs an arm64
  worker or a source build) and `dshm-compat` itself.
- **Descriptions are one line now.** The old entries carried a paragraph of reasoning;
  ten of those push the plugin names off the screen and make the list unreadable. The
  schema is `desc` (≤ 28 chars, pinned by a test) plus `verified`; the conversation
  shelf renders each plugin on a single line with a `✓` when it was proven.
- **Two false positives fixed**, both found by running the audit over the real board:
  - `dsh-pet` was reported `host-killing` because of `process.exit` in an Electron
    helper process, a `standalone.js` CLI and a build script. None of them runs inside
    the host. `isScannableSource()` now excludes auxiliary entrypoints (`standalone/`,
    `runtime/`, `scripts/`, `bin/`, `*.test.*`, `*.d.ts`) — a rule that disables a
    working plugin is worse than no rule.
  - `Promise.reject(...)` inside a `.then` chain that has a `.catch` is idiomatic and
    harmless; it is no longer reported unless the file has no `catch` at all.
- Offline regression suite: 71/71.

## 0.1.22

**Route as much as possible through compat — without pretending to be a hard gate.**

The user's framing, after `dshm-brickpack/v04`: not "force", just "尽量都走". So there are
three layers, and only the middle one is a refusal:

1. **进入口** — the market tab in the plugin page, and `compat_market` itself. Anything
   started here gets `host-risk` (0.1.21) and the service check before a byte is written.
2. **拒绝** — `host-killing` is refused, with file and line.
3. **兜底** — `compat_guard` (new) audits what was installed **by any other path**.

- `lib/quarantine.js` — reads and writes `<profile>/.dshm-plugin-rows.yml`, the one file
  DSHM never overwrites (its entry script appends it to `cordis.patch.yml` at boot).
  `- id: <row>\n  disabled: true` means "do not mount this row next start".
  - `guardInstalled()` walks every installed bundle row, audits the package's own source
    (not its dependencies), and reports what would kill the host.
  - `apply:true` writes the disabled rows — idempotent, and it **flips** an existing
    `disabled: false` instead of adding a contradictory second entry for the same id.
  - It never touches a bundle that merely looks suspicious, and never touches a safe one.
- `DSHM_COMPAT_AUTO_QUARANTINE=1` turns on a once-per-start watchman that does the same
  automatically. Off by default: writing another plugin's rows is the user's call.
- Honest limit, stated in the module and in the tool description: **it cannot save the
  current run.** Whatever killed the process already did. What it changes is "dies on
  every boot until the user finds the row" → "one bad boot, then clean".
- Offline regression suite: 71/71.

## 0.1.21

New capability: **host-risk audit** — refuse the plugins that do not fail, they kill the
host (`lib/host-risk.js`).

`dshm-brickpack/v04-throw-async` is the case. Its source is three lines:

```js
export function apply(ctx) {
  return Promise.reject(new Error('dshm-brickpack deliberate async throw'));
}
```

The loader does not await `apply`, so the rejection lands at process level. The result
was not a failure page but a stuck「正在应用配置」, an uncancellable install and
`waitForInstall failed: Failed to fetch` — and DSHM's rescue only mounts on a failure
page, so nothing could step in. That class cannot be handled after the fact: the thing
that would report the error is already dead. It has to be refused before the install.

- `scanText()` / `summariseHostRisk()` detect, with file, line and snippet:
  - `kills-host` — `process.exit` / `process.abort`
  - `parks-forever` — `await new Promise(() => {})`, an install that never settles
  - `async-apply-throws` — `async apply()` containing `throw`
  - `apply-returns-rejection` — `return Promise.reject(…)` from `apply`/`activate`
  - `top-level-throw`, `unhandled-rejection`, `effect-async-throws` — suspicion only,
    reported but not refused, because refusing on a hunch is worse than installing
- `analyze()` now reports `signals.hostRisk`; `compat_market` refuses
  `level:"host-killing"` at a `host-risk` step before conversion, with the first
  evidence quoted and a next step that starts with "send this to the author".
- **Subdirectory specs are supported** (`parseGithubSpec`): `github:owner/repo#ref&path:/sub`
  now resolves the ref and analyzes that subtree instead of the repository root. Before
  this, the exact spec in the report would have been analyzed as whatever `main`
  exports — a different package entirely.
- Verified against the real repository: the spec above now returns
  `status:"blocked"`, `hostRisk.level:"host-killing"`, evidence
  `lib/index.js:2 apply-returns-rejection`.
- Offline regression suite: 69/69.

## 0.1.20

> 0.1.19 was prepared but never published; everything below ships together.

- **Worker triage without running the binary** (`lib/worker-scan.js`, tool
  `compat_worker_scan`). Reads a prebuilt worker's ELF, lists which
  link/metadata/rename symbols it *imports* (undefined dynsym), and checks whether
  it also carries the means to bypass the C library — a `syscall` import or raw
  `svc #0` / `syscall` instruction bytes in executable sections. Verdict:
  `preload-viable` / `needs-ptrace` / `no-publication` / `unknown`.
  - This is the question that cost several releases: an `LD_PRELOAD` shim can never
    fix a worker that issues the syscall directly, and that was never established up
    front. When the symbol table is stripped the verdict refuses to claim
    interposability from a string sweep and says `unknown` instead.
  - Verified on real data: the bundled `assets/qemu-x86_64/qemu-x86_64` is an
    aarch64 ELF with 396 raw `svc` instructions and no `linkat` import →
    `needs-ptrace`, which is exactly right for a binary that talks to the kernel
    directly.
- **Honest vendoring warning** (`lib/plan.js`): the S0 plan still claimed vendoring
  was "not implemented yet" long after `lib/vendor.js` shipped and `convert()` began
  using it. It now says what actually happens (missing pure-JS deps are vendored
  during conversion) and states the limit (native payloads, or anything still
  missing afterwards, fails the conversion instead of being flattened).
- **Post-install verification with opt-in rollback** (`lib/verify.js`, tool
  `compat_verify`). A successful install records an intent to check; the next boot
  evaluates it from evidence that already exists — `pending (waiting for service: X)`
  in the host log, and the plugin inventory when the host exposes it — and reports
  `active` / `failed` / `unknown` per install.
  - Rollback happens **only** for entries that are provably failed *and* were
    installed with `autoRollback:true`. `unknown` is never acted on: an automated
    uninstall based on a guess destroys the evidence along with the plugin.
  - `state.js` grew a `pendingVerify` field. It had to be declared explicitly —
    `readState()` is a whitelist, so a field that is written but not listed is
    silently dropped on the next read (that bug cost a test cycle).
- **Shims are now opted in per half** (`lib/service-shims.js`): `sides: ['client',
  'host']`, and the host half provides its own copy through
  `provideHostServiceShims()`. Host gaps default to *not shimmable* — the table has
  to say a name is safe on that side. The mechanism is general; the table stays
  narrow (still only `conversationEvents`) because each entry needs its consumer's
  source as evidence.
- Offline regression suite: 64/64.

## 0.1.19

**From "we warned you" to "it runs".** 0.1.18 could only refuse a plugin whose
required service was missing; this release makes it work.

- `lib/service-shims.js` — a deliberately narrow table of missing client services
  the compat client half can supply itself. `conversationEvents` is the first entry,
  because `dsh-rewind@0.11.12` reads it defensively:
  `if (events?.subscribe !== undefined) { patch(); const off = events.subscribe(patch) }`.
  The shim is `{ entries: () => [], subscribe: () => () => {} }` — the plugin
  activates, and its instruction-hint dedup patch quietly does nothing. That is the
  honest outcome: this deployment has no such event stream to dedup in the first
  place.
- The client half calls `provideServiceShims(ctx)` **before** registering the market
  tabs, and only for names with no provider: it checks `ctx.get(name)` and
  `reflect.props[name]` first, so a future real service is never shadowed.
- `compat_market` no longer blocks on a shimmable gap. The step becomes
  `services:shimmed`, the gap is listed in `services.shimmable`, and `warnings[]`
  states exactly what degrades. A gap compat cannot fill — any host-side service, or
  an unknown client one — still returns `status:"blocked"`.
  - **Blocking is still the default**, and a row with one shimmable gap plus one
    unfillable gap stays blocked. The blocked message now separates the two reasons
    (host-side: nothing compat can invent is correct; client-side: simply not in the
    fallback table) and still lists the shimmable gap in a next step, so it is clear
    that compat tried.
- Fixed a false-positive that would have blocked working installs: an **empty host
  inventory** used to be read as "this host provides nothing", so every plugin looked
  like it needed `commands`. It now means "unread", and `verified.host` says so.
- Verified end to end against the real package: `dsh-rewind@0.11.12` goes
  `resolve → classify → services:shimmed → transform` (no longer blocked), while
  `0.11.8` reports `services:ok` with no shim needed.
- Offline regression suite: 56/56.
- To be confirmed on-device: whether cordis activates the already-pending row when
  the shim appears at boot. The `pending` state is by definition "waiting", so it
  should, but that specific transition has not been observed on hardware.

## 0.1.18

New capability: **service-dependency analysis**, the check that would have stopped
`dsh-rewind` from taking the boot down.

A plugin row declares the cordis services it needs (`export const inject = […]`).
If one is absent, cordis leaves the row `pending` and DSHM reports
`web boot: 1 entry did not activate … pending (waiting for service: X)` — the user
sees a broken install, not a compatibility verdict.

- `lib/services.js` answers three questions without guessing:
  - `declaredServices()` — parses all three shapes found in the wild: the array form,
    `{ required, optional }`, and dynamic `ctx.inject([...])`.
  - `packageServiceDeps()` — splits a package's requirements into host (`lib/index.js`)
    and client (`lib/client.js`).
  - `hostServiceNames(ctx)` — the host's live cordis registry, exact.
  - `clientServiceNames(core)` — scans the core tree's provider bundles, cached per
    core version. **Three** provider idioms are matched (`super(ctx, "x")`,
    `provide("x")`, `accessor("x")`) because `dsh-api-session-controller` provides
    `sessions` with a bare `provide(...)`. A scan that only knew `super(...)` invented
    a missing `sessions` and would have blocked a working install: over-inclusive is
    the safe direction, since a false "missing" blocks while a false "available" only
    costs a warning.
  - `pendingFromLogs()` — reads `pending (waiting for service: X)` back out of
    `dshm-host.log` / `node-output.log`, i.e. "which row is stuck, and on what".
- `compat_market` now runs the check **before** converting or installing and returns
  `status:"blocked"` with the missing names when a required service is absent. A
  missing service is a hard block: no manifest rewrite can supply one.
- `compat_doctor` gained two checks: `services` (host count + client inventory with
  its provenance) and `pending` (rows that never activated on this device).
- Verified against real data: scanning 75 client bundles of
  `0.2.1-alpha.4+dshm.56` yields 36 services; `dsh-rewind@0.11.12` is reported missing
  exactly `conversationEvents` — the same service the boot log names — while
  `0.11.8` reports none. The scan is labelled with its provenance everywhere
  (`scan:` / `cache:` / `skipped`) and never presented as ground truth.
- Offline regression suite: 55/55 (six new cases covering the three declaration
  shapes, host/client split, missing-vs-optional, inventory scan + cache, log
  parsing, and the market refusing to install).

## 0.1.17

Two defects made the 0.1.16 market tab invisible on-device. Both are fixed here;
the panel itself is unchanged.

- **Wrong page.** The tab was registered only into `settings.plugins.tab`
  (Settings → Plugins, where the built-in read-only inventory lives). The page
  users mean by「插件」in the left rail is owned by
  `@deepseek-ai/dsh-client-ui-plugin-manager`, which registers into `main` and
  declares its own `plugins.tab` list slot. The panel now registers into **both**:
  `plugins.tab` (order 30, the primary entry) and `settings.plugins.tab`
  (order 20, fallback). Both are `kind:"list", scope:"root"` and are enumerated
  with `ctx.slots.entries(...)`, so a registration shows up as a tab without
  pre-registering an id.
- **`dsh.client.inject` named a package that does not exist.** It listed
  `@deepseek-ai/dsh-client-ui-slots`, copied from a core-tree plugin built against
  a different version; this build's `slots` service is provided by
  `@deepseek-ai/dsh-client-ui-renderer`. An unresolvable entry in that list is
  enough to keep the whole client bundle from loading. The list is now
  locale + renderer + settings + api-remotes, all of which exist and all of which
  declare `dsh.client` themselves.
- A test now pins both slots (name, id, order, label, injected loader) and guards
  against `dsh.client.inject` ever naming `@deepseek-ai/dsh-client-ui-slots`
  again. Offline suite: 49/49.

## 0.1.16

- **The market now has a tab in Settings → Plugins** (`lib/client.js`,
  `dsh.client` in `package.json`, `exports["./client"]`). It registers into
  `settings.plugins.tab` — the same slot the built-in inventory uses — as
  `id: "dshm-compat-market"`, `order: 20`, label 兼容市场.
  - Contents: an input for a name / `owner/repo` / tarball URL / `.tgz` path, the
    inlined catalog with each entry's expected strategy, 已装 badges read from the
    host's existing `remote.pluginInventory`, and a copy button yielding the exact
    host command (`compat_market { input: "…" }`).
  - **Execution stays on the host on purpose.** A browser half cannot call this
    plugin's host code: host services go through Typert Remote namespaces, which
    need compiler-generated codecs (`descriptor.input`, `result.mode`); a plugin
    cannot synthesise that at runtime and there is no generic "run a tool" RPC.
    So the tab owns discovery and the decision, and the host tool owns the write.
  - Only `react` is required. `inject` declares just `slots`/`locale`/`remote` —
    `remote.pluginInventory` is looked up defensively so a missing namespace
    degrades the badges instead of preventing the plugin from mounting.
- A test loads `lib/client.js` through a stub `__ModuleLoader__`, asserts the slot
  contract (name/id/order/label), that the injected loader reaches the inventory
  namespace, that rendering uses plain elements only, and that the inlined catalog
  is identical to `assets/catalog.json` (so the two copies cannot drift).
- `INSTALL.md` now separates the two surfaces and gives a four-step ladder for
  "tools work but the tab is missing".
- Offline regression suite: 49/49.
- **Known limitation, unchanged by this release**: creating a *new* file from a
  native worker on the 9p share still fails. The root cause is `hard_link` over
  9p/hmdfs, and the fix lives below this plugin — either the QEMU 9p patch
  (`v9fs_linkat` copy fallback + `user.hmdfs.*` xattr tolerance, see the sibling
  `dshm-9p-patches/`) or a source build with the publication patch. What 0.1.16
  adds is the machinery to say so precisely (`patches[].semantics`,
  `anchorsMissing`, `compat_doctor`'s `link` check) instead of failing silently.

## 0.1.15

- The 9p publication patch is no longer a bare `hard_link` → `rename` swap. It now
  emits one of three explicitly-labelled forms, chosen by evidence found in the
  source file (`lib/publish-patch.js`, `patternId: publish-link@2`):
  - `guarded` — the file proves `io::Result` and a stat primitive exist, so the
    rewrite keeps `hard_link` as the primary path and only falls back to `rename`
    after `PermissionDenied`/`Unsupported`, and only when the target is confirmed
    absent (`AlreadyExists` is returned otherwise). No semantics are lost.
  - `guarded-no-stat` / `rename` — evidence is missing, so the rewrite is
    narrower; `patches[].semantics` records exactly what was weakened
    (`weakened-no-clobber`, `weakened-errno-filter`) and `warnings[]` says so.
    Nothing is silently upgraded.
- A `hard_link` call the patcher cannot rewrite (e.g. a receiver with a call in
  it) is now reported in `anchorsMissing` instead of being skipped. Passing
  `requireNoClobber:true` to `compat_build` turns either weakening or a missing
  anchor into `status:"patch-unsafe"` rather than a build that looks fine.
- New `lib/hostcap.js`: device facts that used to be assumed globally.
  - `readHostReady()` / `readHostLogFacts()` read DSHM's own readout
    (`<DSHM_HOME>/host-ready.json` `runtime.*`, falling back to the one-line
    `探针读数（日志副本）` copy in `dshm-host.log`, which is the only readout
    available on profiles where `home` is 0700).
  - `probeLinkSupport(dir)` asks the filesystem directly by linking two temp
    files — dshm-compat runs inside the DSHM host, so this is authoritative for
    the current device/profile rather than inferred from a device class.
  - `linkPolicyFor(route, probe)` — `in-process` follows the probe, `guest` always
    patches, because a host that supports links says nothing about how 9p exports
    it. This is what stops a green PC-profile run from being read as "works
    everywhere" (the PC/2in1 profile allows hard links; the phone profile does not).
- `compat_doctor` reports two new checks, `host` and `link`, plus structured
  `host.*` / `link.{ok,code,policy}` fields. The link check prints the patch
  policy for both routes.
- `compat_convert{ buildNative:true }` now returns `build.patchSummary` and
  `build.warnings` alongside `build.patches`.
- New market layer (`lib/market.js`), exposed as two tools:
  - `compat_market` — the one-input pipeline. Give it a name, npm spec, GitHub
    URL, tarball URL, or local `.tgz`; it resolves, classifies, rewrites, and
    installs, then returns a card (strategy, what changed, restart needed,
    verification steps). `dryRun:true` stops after the transform; installing
    needs `confirm:true`. An S2 plugin without `workerPath` is not a dead end:
    the source is prepared and the exact PC/CI build command is handed back.
  - `compat_market_browse` — registry search (or an explicit name list) that
    reports packument-level signals only (missing `dsh` manifest, foreign
    `os`/`cpu` gates, peer/engines gate, platform-specific optional deps) and
    labels every entry `needsAnalysis:true`. No tarball is downloaded.
  - Neither tool adds adaptation logic: every step delegates to the engine that
    already owns it. `verificationStepsFor()` names the exact post-install
    checks, including the create-new-file case for native plugins.
- Offline regression suite: 44/44 at that point (was 32/32): the guarded form, the
  weakened form, `requireNoClobber`, anchor-missing reporting, the four hostcap
  entry points, and five market behaviours (dry run stops before the profile,
  confirmed install writes manifest + bundles + files, non-DSH packages are
  refused, browse signals, verification steps).
- The market now has a **home screen that works offline**: `compat_market_browse`
  with no arguments returns the shelf — `assets/catalog.json` (hand-written
  descriptions, overridable with `DSHM_COMPAT_CATALOG`) merged with the ledger of
  every plugin this device already analyzed, where the real verdict wins over the
  catalog's guess. A registry search that fails degrades to the shelf instead of
  an empty page, and a search that matches nothing falls back to shelf matches.
- Both market tools render **prose cards instead of JSON** (`renderMarketCard`,
  `renderShelf`): status badge, size/sha256, what changed, step trace, next steps.
- `state.js` records the package's own name/version (`report.package`) ahead of the
  resolved spec, because a local tarball resolves to a filename — the ledger used to
  list a path where a plugin name belonged.
- Offline regression suite: 48/48. New cases cover the offline shelf, the
  ledger-wins merge, shelf search, and that both renderers emit prose rather than
  a JSON blob.

## 0.1.14

- Fixed the x86_64 wrapper template: the primary branch now interpolates the
  concrete `<worker>-x64` name instead of leaving `${realName}` in the shell
  script.
- The wrapper now creates `libpthread.so.0`, `libdl.so.2`, `librt.so.1`
  symlinks to the staged libc and copies `libm.so.6`, so glibc workers start on
  the guest.
- `compat_convert` accepts `buildNative:true`: it builds a 9p-patched native
  AArch64 worker from the package source in the guest and converts with that
  worker. This is the path for prebuilt workers whose new-file publication uses
  `hard_link` (9p rejects it).
- Not published until verified on-device.
- Offline regression suite: 32/32.

## 0.1.13

- `compat_build` now applies a generic 9p source compatibility patch when it
  prepares a Rust worker: a staged `hard_link(&temporary, ...)` publication is
  rewritten to `rename(&temporary, ...)`, because 9p/hmdfs does not support
  hard links. This is pattern-based, not a package-name branch; the result
  reports the patched files in `patches`.
- Offline regression suite: 32/32.

## 0.1.12

- The x86_64 compatibility shim now also turns failed `link`/`linkat` calls into
  `rename`/`renameat`. `dsh-ops` `publish_new()` uses a hard link as its atomic
  no-clobber step; 9p/hmdfs rejects hard links, so new-file writes failed while
  overwrites (rename) succeeded. With this fallback, new-file creation no longer
  depends on hard-link support.
- Offline regression suite: 31/31.

## 0.1.11

- Bundled an x86_64 `LD_PRELOAD` compatibility shim that turns
  `chmod`/`fchmod`/`fchmodat` `EPERM`, `EACCES`, `ENOTSUP`, and `ENOSYS` into a
  successful no-op. DSHM's 9p/hmdfs rejects chmod, which made native workers
  fail writes with `ACCESS_DENIED` even though bash could write the same path.
  It is loaded only for x86_64 QEMU workers via `qemu -E LD_PRELOAD=...`;
  native AArch64 workers are untouched.
- Offline regression suite: 31/31.

## 0.1.10

- The generic S2 adapter now prefers an AArch64 worker when a package contains
  both `runtime/linux-arm64` and `runtime/linux-x64`, instead of taking the
  first file. Native AArch64 avoids the QEMU user-mode `openat2`/9p no-follow
  behavior that makes `ops_stat` return `ELOOP`.
- x86_64 QEMU conversions now carry a warning that no-follow stat on 9p
  mountpoints can fail with `ELOOP`; provide an AArch64 worker for that class.
- Offline regression suite: 31/31.

## 0.1.9

- Fixed the 0.1.8 launch regression. Running `ld-linux` as the QEMU main binary
  produced `Exec format error`; the wrapper now copies the x86_64 loader and
  glibc libraries into the guest's real `/lib64` and `/lib/x86_64-linux-gnu`,
  then runs `qemu-x86_64 <worker>` **without** `-L`. Absolute guest paths are no
  longer prefixed, while the worker still gets its host-root symlink bridge.
  If `/lib` is not writable, it falls back to `qemu -L` with rootfs symlinks.
- Offline regression suite: 30/30.

## 0.1.8

- Fixed the x86_64 worker launch: QEMU's `-L <rootfs>` prefixes absolute guest
  paths with the glibc rootfs, so `dsh-ops` could not see `/storage/...` or
  `/data/...` even though the guest mounts existed. The wrapper now runs
  `ld-linux-x86-64.so.2 --library-path <rootfs>/lib/x86_64-linux-gnu <worker>`
  directly, so guest absolute paths are passed through unchanged.
- Kept the host app-files prefix symlink for workers that canonicalize the host
  `policy.workspaceRoot`.
- Offline regression suite: 30/30.

## 0.1.7

- Re-release of the 0.1.6 content. npm accepted 0.1.6 into staged publishing but
  it never became visible (404), and npm refuses to publish over a staged
  version. 0.1.7 is the installable build.
- Native worker wrappers bridge the DSHM host app-files prefix
  `/data/storage/el2/base/haps/entry/files` to the guest's `/mnt/share` 9p
  mount. `dsh-ops` passes the host `policy.workspaceRoot` as the worker's
  `root`; the worker canonicalizes it before doing anything, so an unmapped
  host path made every `ops_*` call fail with `NOT_FOUND` even when the guest
  path existed. The wrapper creates the symlink only when the guest mount
  exists and the host prefix is absent.
- Offline regression suite: 30/30.

## 0.1.6

- Native worker wrappers now bridge the DSHM host app-files prefix
  `/data/storage/el2/base/haps/entry/files` to the guest's `/mnt/share` 9p
  mount. `dsh-ops` passes the host `policy.workspaceRoot` as the worker's
  `root`; the worker canonicalizes it before doing anything, so an unmapped
  host path made every `ops_*` call fail with `NOT_FOUND` even when the guest
  path existed. The wrapper creates the symlink only when the guest mount
  exists and the host prefix is absent.
- Offline regression suite: 30/30.

## 0.1.5

- Spawn rewriting now uses `['bash', file]` plus a staged shell wrapper instead
  of `bash -c 'exec "$0" "$@"'`. `dshm-vm-bash` drops positional parameters for
  `-c`, so the old form produced `Permission denied` and lost worker arguments.
- `runGuestFile` and sidecars use the same non-`-c` path (`bash <wrapper> <args>`).
- Release acquisition tries the package-version tag first, then the latest
  release, falls back to the API asset endpoint, verifies `sha256` when
  available, and returns attempts instead of a silent failure.
- Source-only packages return `needs-build` with an external build contract;
  when the same package has a published npm build, `convert` automatically
  retries that build instead. Verified with `dsh-ops` 0.4.0 GitHub source:
  it falls back to `dsh-ops@0.3.0` and produces a validated package.
- Added `compat_build`: a source build planner for `Cargo.toml`/Node
  `build`/`prepack` packages, plus an opt-in `backend:"guest"` attempt that
  provisions Rust or Node in the Alpine guest and runs the build there. The
  guest path depends on guest network/disk and is explicitly experimental.
- Added `compat_uninstall` and `engines.dsh` normalization.
- Offline regression suite: 30/30.

## 0.1.4

- The generic S2 adapter now accepts **x86_64** workers: it bundles
  `qemu-x86_64` and a minimal x86_64 glibc rootfs, stages a shell wrapper, and
  runs the worker under QEMU in the guest. No AArch64 rebuild is required for
  plugins that publish a `linux-x64` runtime.
- If the package contains no worker, the adapter looks at the GitHub repository
  release assets, prefers `linux-arm64` then `linux-x64`, extracts the archive
  (ZIP or tar.gz), and uses the first AArch64/x86_64 ELF. No package name is
  special-cased.
- Source-only native packages (for example a Rust `native/` tree with no
  prebuilt runtime) now classify as S2 instead of S0, so the native adapter gets
  a chance to build or acquire a worker.
- Verified end-to-end: `compat_convert("https://github.com/T-Auto/dsh-ops")`
  with **no workerPath** acquires the upstream `linux-x64` release asset, wraps
  it in QEMU, patches the runtime/spawn/peer/os-cpu gates, and validates.
- Spawn rewrite now uses `['bash', file]` and stages a shell wrapper around the
  real worker instead of `bash -c 'exec "$0" "$@"'`. `dshm-vm-bash` drops
  `$0`/`$@` for `-c` commands, which caused `Permission denied` and lost
  arguments; the non-`-c` path preserves them.
- Release selection first tries the tag matching the package version (`vX.Y.Z`),
  then the latest release with assets; missing tags fall through instead of
  returning an empty asset list.
- Release download falls back from `browser_download_url` to the GitHub API
  asset endpoint (`Accept: application/octet-stream`), records every attempt,
  and verifies the asset `sha256` digest when GitHub provides one. Failures are
  returned in `acquisition.attempts`, not swallowed.
- The adapter also rewrites resolved-shell spawns (`[file, '-c', command]` and
  `[file, scriptPath]`) to `['bash', '-c', command]` / `['bash', scriptPath]`,
  so the shell component does not exec an ELF from the app sandbox.
- `runGuestFile` now invokes `bash <script> <args>` instead of
  `bash -c 'exec "$0" "$@"'`; sidecars stage a wrapper script so positional
  arguments survive `dshm-vm-bash`.
- Source packages with no built `main` and a `build`/`prepack` script return
  `needs-build` with an external `npm ci && npm run build && npm pack` contract
  instead of `recipe-mismatch`.
- Added `compat_uninstall` for profile-local removal (node_modules + dependency
  + bundle entry), and `engines.dsh` is stripped alongside `os`/`cpu`.
- Offline regression suite: 28/28.

## 0.1.3

- Added a **generic S2 native adapter** (`lib/s2-native.js`). It discovers the
  worker and the runtime matrix in the package, appends the DSHM target,
  rewrites `${platform}-${arch}` templates, wraps standard `const/let argv =
  [file]` spawn calls in `bash -c`, removes foreign `os`/`cpu` gates and
  non-Linux optional payloads, and relaxes the DSH `peerDependencies` range.
  There are no package-name branches and no built-in per-package rules.
- Added a generic guest sidecar bridge (`compat_sidecar` / `lib/sidecar.js`):
  stage a Linux/AArch64 worker from a converted tarball into
  `$DSH_HOME/dshm-compat/sidecars/<id>`, list/probe it, and call it with one
  JSON request/response through the Alpine guest.
- `compat_plan` now infers `rust`, `c/c++`, or `node-gyp` from source files in
  the report instead of relying on a package-specific rule.
- S2 conversion dispatches on the strategy and the generic patterns, not on a
  package name; GitHub specs work through the same path.
- Offline regression suite: 25/25.

## 0.1.2

- Added `compat_doctor`: one read-only diagnosis of DSHM mode, core version,
  owning profile/bundle registration, install queue, state, and the Alpine
  guest (bash/apk/node).
- Local installs now stage into a sibling directory, move the old install to a
  backup, and restore it if writing the new tree or the profile manifest fails.
- GitHub specs now carry codeload fallbacks (`HEAD`, `refs/heads/main`,
  `refs/heads/master`) when the API tarball endpoint fails or is rate-limited.
- Offline regression suite: 23/23.

## 0.1.1

- Tool results are now lossless JSON: `undefined`-valued fields are stripped at
  the tool boundary. This fixes `compat_analyze` / `compat_plan` / `compat_scan`
  failing with `value is not lossless JSON` on DSHM.
- Local tarball installation: `compat_install` (and `compat_convert` with
  `install:true`) unpacks a `.tgz` into the owning DSH profile's `node_modules`,
  records the dependency, and appends the bundle. This works around DSHM's host
  installer rejecting local paths, `file:` and `http://` specs. A restart is
  required, and the result says `restartRequired: true`.
- Local install preserves the tarball's file modes (needed for native worker
  binaries such as `dsh-ops-worker`).
- Docs updated with the DSHM `pnpm view` limitation and the local install path.

## 0.1.0

- Initial analyzer, S0/S1 converter, dependency preflight/vendoring, guest
  probe/provision, install queue, and dsh-ops 0.3.x recipe.
