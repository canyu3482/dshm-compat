/**
 * dshm-compat 浏览器半边：把「兼容市场」挂成 **插件页 / 设置 → 插件** 里的一个标签页。
 *
 * ── 为什么形态是这样（实证结论，不是取舍偏好）─────────────────────────────
 * 插件页的标签页契约来自 `@deepseek-ai/dsh-client-ui-settings-plugin-inventory`
 * （核心树里唯一一个注册到 `settings.plugins.tab` 的只读清单）：
 *
 *     ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
 *         name: "settings.plugins.tab", id: "all", order: 10,
 *         label: () => t("tab"), locale: NS, inject: injected
 *     }, Component))
 *
 * **但客户端跑不了宿主插件的代码。** 想从浏览器半边调用 `lib/market.js`，
 * 需要在宿主侧提供一个 Remote 命名空间（`TypertRemoteService` + 每个方法上的
 * `Remote` 标记）。标记本身只是原型上一个字符串键的属性
 * （`@deepseek-ai/dsh-typert-protocol/remote-methods`，`{version:1, methods:[…]}`），
 * 但网关真正消费的是**编译器生成的输入 codec**（`descriptor.input`、
 * `result.mode`）：`isTypertRemoteMethod()` 要求 `input`/`invoke` 都是函数。
 * 那是 `dsh-typert` 编译产物的形状，插件侧无法在运行期自己造 —— 造出来网关也不认。
 *
 * 所以本标签页做三件**确定能成立**的事：
 *   1. 列出候选插件（目录内联 + 可选的全量索引），按 dshmarket 的方式逛：
 *      分类筛选、最热/最新排序、卡片网格、分页加载；
 *   2. 通过**已有的** `remote.pluginInventory` 读真实已装清单，标出「已装」；
 *   3. 给出可直接粘贴的适配指令（一键复制），执行仍由宿主工具 `compat_market` 完成。
 *
 * 这不是「降级」，是把边界说清楚：**这个页面负责发现与决策，执行在宿主。**
 * 等哪天 DSHM 给插件开了 Remote 扩展点，把第 3 步换成一次调用即可，界面不用动。
 *
 * ── dshmarket 的四条模式，这里照搬（参照其 src/client/）────────────────────
 * · **搜索防抖且 IME 安全**（SearchInput.tsx）：250ms 才提交；中文组合输入期间
 *   绝不提交（否则每打一个拼音字母就重筛一次）；清除按钮清的是草稿不是已提交值。
 * · **缺席不冒充**（registry.ts 的 downloads 注释）：没有 star 数就不显示 ★，
 *   而不是显示成 0；没有版本号就不显示版本段，而不是显示占位符。
 * · **未扫描 ≠ 未检出**（capabilities 的措辞纪律）：全量索引条目没做过兼容分析，
 *   徽章一律写「未分析」——这是"我们没看过"，不是"它不兼容"。
 * · **条目只是描述，不是结论**：目录的 `expect` 是分析器的预期策略，渲染成
 *   「预期可直装」这类措辞；能不能装永远由宿主工具的 `compat_market` 说了算。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * · 只 require `react`：多 require 一个包就多一个加载失败点。
 * · `inject` 只声明 `slots`/`locale`/`remote` 三个硬依赖；`remote.pluginInventory`
 *   **不写进 inject**（缺了会连累整个插件不挂载），改为调用时 try/catch。
 * · 任何一步失败都不阻断挂载：locale 注册、已装清单、剪贴板各自兜底。
 * · 不新增权限、不写文件。**网络请求只有一次，且由你点**：载入全部插件时会从
 *   unpkg 拉社区目录（约 20 MB），结果进 localStorage，之后不再请求。
 *
 * @module dshm-compat/client
 */
window.__ModuleLoader__.load({
  id: 'dshm-compat',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    const NS = 'dshmCompatMarket'
    const TAB_ID = 'dshm-compat-market'

    /**
     * 目录内联。与 `assets/catalog.json` 同源，但**故意复制一份**：
     * 客户端 bundle 拿不到宿主文件系统，构建期不引入打包步骤的前提下，
     * 内联是唯一不撒谎的办法。改目录时两边一起改，测试会比对条目数。
     */
    const CATALOG = [
      { name: 'dshm-boot-rescue', desc: '启动救援：卡死时恢复插件', expect: 'S0', recommend: true, verified: '2026-11-07 GitHub main（dshm-boot-rescue@1.1.0）判定 S0 通过', spec: 'github:huangshou1/dshm-boot-rescue-plugin#main' },
      { name: 'dsh-pet', desc: '桌宠：蓝色大肥鱼', expect: 'S0', verified: '真机已安装，待重启验证' },
      { name: 'dsh-free-search', desc: '免费网页搜索，内置 27 个引擎', expect: 'S0', verified: '2026-10-24 转换通过' },
      { name: 'dsh-context', desc: '上下文用量查看与清理', expect: 'S0', verified: '2026-10-24 转换通过' },
      { name: 'dsh-cost-meter', desc: '会话费用与用量统计', expect: 'S0', verified: '2026-10-24 转换通过' },
      { name: 'dsh-plugin-mgr', desc: '在设置页管理已装插件', expect: 'S0', verified: '2026-10-24 转换通过' },
      { name: 'dsh-plugin-model-proxy', desc: '给指定模型单独走代理', expect: 'S0', verified: '2026-10-24 转换通过' },
      { name: 'dsh-mnemon', desc: '可组合的上下文记忆', expect: 'S0', verified: '2026-10-24 转换通过' },
      { name: '@michengai/dsh-archive-manager', desc: '会话归档、恢复与清理', expect: 'S0', verified: '2026-10-24 转换通过' },
      { name: '@dfy-plugins/dsh-image-generation', desc: '图像生成与编辑', expect: 'S0', verified: '2026-10-24 转换通过' },
      { name: 'dsh-ops', desc: '运维工具集，带原生 worker', expect: 'S2', verified: '需 arm64 worker 或源码构建' },
      { name: 'dshm-compat', desc: '就是本插件：兼容分析与转译', expect: 'S0', verified: '自装验证' },
    ]

    /**
     * 预期策略 → 一句人话。措辞是**描述**（"预期"），不是承诺（"能装"）：
     * 结论只能来自宿主工具对具体设备的分析。未收录的策略原样显示，不猜。
     */
    const STRATEGY_LABEL = {
      S0: '预期可直装',
      S1: '需替代依赖',
      S2: '需原生 worker',
      S3: '需源码构建',
      S4: '预计不支持',
    }

    /** 目录分类的中文标签；未知 slug 原样显示（社区目录随时可能加新类）。 */
    const CATEGORY_LABELS = {
      tool: '工具',
      ui: '界面',
      integration: '集成',
      workflow: '工作流',
      provider: '模型接入',
      theme: '主题',
      other: '其他',
    }

    /** 卡片网格一次渲染多少条（dshmarket 查询文法里的 limit 的页内对应物）。 */
    const PAGE_SIZE = 60

    /** 搜索防抖：与 dshmarket SearchInput 的 SEARCH_DELAY_MS 同值。 */
    const SEARCH_DELAY_MS = 250

    /** `expect` → 徽章文字；空值/未知策略不发明文案。 */
    function strategyLabel(expect) {
      if (typeof expect !== 'string' || expect === '') return undefined
      return STRATEGY_LABEL[expect] ?? expect
    }

    /** 分类 slug → 中文；未知 slug 原样返回（显示原话好过显示错译）。 */
    function categoryLabel(id) {
      return CATEGORY_LABELS[id] ?? id
    }

    /**
     * 分类 chips：`全部` 置顶，其余按条目数降序、同数按名称。没有分类字段的行
     * （精选目录、已装未收录）不进任何分类，只在「全部」里出现 —— 不给它们
     * 编造一个「未分类」桶。
     */
    function categoryChips(rows) {
      const counts = new Map()
      for (const row of rows) {
        const id = row?.category
        if (typeof id !== 'string' || id === '') continue
        counts.set(id, (counts.get(id) ?? 0) + 1)
      }
      const rest = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      return [
        { id: '', label: '全部', count: rows.length },
        ...rest.map(([id, count]) => ({ id, label: categoryLabel(id), count })),
      ]
    }

    /**
     * 排序。缺席的 stars/published 排在**已知值的后面**，但不参与相邻已知值之间的
     * 相对顺序 —— 缺席是"不知道"，不是"更差"（dshmarket 对 downloads 的同款纪律，
     * 这里用"稳定排序 + 缺席垫底"落实）。
     */
    function sortRows(rows, mode) {
      const copy = [...rows]
      if (mode === 'hot') {
        copy.sort((a, b) => (b?.stars ?? -1) - (a?.stars ?? -1))
      } else if (mode === 'new') {
        copy.sort((a, b) => String(b?.published ?? '').localeCompare(String(a?.published ?? '')))
      }
      return copy
    }

    /** 分页切片：负数/超界都安全。 */
    function pageSlice(rows, shown) {
      return rows.slice(0, Math.max(0, shown))
    }

    /*
     * 全量索引（可选）：浏览器自己从 CDN 取社区目录，页内就能搜 2 万多个插件。
     *
     * 为什么走 CDN 而不是宿主路由：客户端 bundle 拿不到宿主缓存的文件，而挂一条
     * `webServer.register` 路由要处理鉴权与 base 路径，任一处没对上就是白屏。
     * unpkg 直接按文件路径服务 npm 包、带 CORS（实测 jsDelivr 在部分网络下不通，
     * 所以选 unpkg）。index.json 再指向分片，拉完就能在页内搜。
     *
     * 三条分寸：
     *   · **失败不影响主体**：拉不到就用目录（13 条），只多一行灰字说明。
     *   · **不阻塞渲染**：进入标签页后后台拉，加载中显示进度。
     *   · **去重规则与宿主一致**：同名多行时优先"有 repo、有摘要"的那条，再取新版本；
     *     只按最新会让 `dsh-pet` 这类 commit-hash 发行版覆盖掉正常条目。
     */
    const INDEX_CDN = 'https://unpkg.com/dsh-plugin-shop-catalog@latest/v1/'
    const INDEX_CACHE_KEY = 'dshm-compat:index:v2'
    const INDEX_TTL_MS = 7 * 24 * 3600 * 1000

    /*
     * 模块级 memo：这个 bundle 在页面里是常驻的，而标签页每切回来一次组件就重挂载
     * 一次——没有它，每次都要从 localStorage 读 ~9MB 再 JSON.parse（手机 webview
     * 上是几十到上百毫秒的卡顿）。TTL 照查，过期照样回源。
     */
    let fullIndexMemo

    function readCachedIndex() {
      if (fullIndexMemo !== undefined) {
        if (Date.now() - fullIndexMemo.fetchedAt <= INDEX_TTL_MS) return fullIndexMemo
        fullIndexMemo = undefined
      }
      try {
        const raw = window.localStorage.getItem(INDEX_CACHE_KEY)
        if (raw === null) return undefined
        const value = JSON.parse(raw)
        if (!Array.isArray(value?.entries) || typeof value.fetchedAt !== 'number') return undefined
        if (Date.now() - value.fetchedAt > INDEX_TTL_MS) return undefined
        fullIndexMemo = value
        return value
      } catch (error) {
        return undefined
      }
    }

    function writeCachedIndex(value) {
      fullIndexMemo = value
      try {
        window.localStorage.setItem(INDEX_CACHE_KEY, JSON.stringify(value))
      } catch (error) {
        /* 配额满或隐私模式：内存 memo 已经兜住本次会话 */
      }
    }

    /** 与宿主 compactEntry/dedupeByName 同一套判断，只是压得更狠。 */
    function compactRows(items, stars) {
      const best = new Map()
      const score = row => (row.repo === undefined ? 0 : 2) + (row.desc === undefined ? 0 : 1)
      for (const item of items) {
        const name = typeof item?.name === 'string' ? item.name : undefined
        if (name === undefined) continue
        const catalog = item.catalog ?? {}
        const summary = catalog.summary ?? {}
        const desc = summary.zh ?? summary['zh-CN'] ?? summary.en
        const repo = typeof item.repository === 'string' ? item.repository : undefined
        const match = repo === undefined ? null : /github\.com\/([^/]+)\/([^/#?]+)/i.exec(repo)
        const key = match === null ? undefined : `${match[1]}/${match[2].replace(/\.git$/, '')}`.toLowerCase()
        const row = {
          name,
          version: item.version,
          desc: typeof desc === 'string' ? desc.trim() : undefined,
          category: catalog.category,
          repo,
          published: typeof item.publishedAt === 'string' ? item.publishedAt.slice(0, 10) : undefined,
          stars: (key === undefined ? undefined : stars[key]) ?? stars[name.toLowerCase()] ?? 0,
        }
        const current = best.get(name)
        if (current === undefined) { best.set(name, row); continue }
        const delta = score(row) - score(current)
        if (delta > 0) { best.set(name, row); continue }
        if (delta < 0) continue
        if (String(row.published ?? '') > String(current.published ?? '')) best.set(name, row)
      }
      return [...best.values()]
    }

    async function fetchFullIndex() {
      const indexResponse = await fetch(`${INDEX_CDN}index.json`, { credentials: 'omit' })
      if (!indexResponse.ok) throw new Error(`index.json ${indexResponse.status}`)
      const index = await indexResponse.json()
      const shardName = index?.plugins?.url
      if (typeof shardName !== 'string') throw new Error('index 里没有 plugins 分片')
      const [shardResponse, starResponse] = await Promise.all([
        fetch(`${INDEX_CDN}${shardName}`, { credentials: 'omit' }),
        typeof index?.stars?.url === 'string'
          ? fetch(`${INDEX_CDN}${index.stars.url}`, { credentials: 'omit' }).catch(() => undefined)
          : Promise.resolve(undefined),
      ])
      if (!shardResponse.ok) throw new Error(`plugins 分片 ${shardResponse.status}`)
      const shard = await shardResponse.json()
      let stars = {}
      try {
        if (starResponse !== undefined && starResponse.ok) {
          const parsed = await starResponse.json()
          stars = parsed?.stars ?? {}
          for (const key of Object.keys(stars)) {
            if (typeof stars[key] !== 'number') delete stars[key]
          }
        }
      } catch (error) {
        stars = {}
      }
      const items = Array.isArray(shard?.plugins) ? shard.plugins : []
      return {
        entries: compactRows(items, stars),
        version: index?.builtAt ?? '',
        fetchedAt: Date.now(),
      }
    }


    /** 与设置页一致的视觉语言：设计令牌直接用 CSS 变量，主题切换自动跟随。 */
    const css = {
      wrap: {
        display: 'flex',
        flexDirection: 'column',
        gap: '14px',
        width: '100%',
        maxWidth: '760px',
        color: 'var(--dsw-alias-label-primary, inherit)',
        fontSize: '13px',
      },
      hint: { margin: 0, color: 'var(--dsw-alias-label-secondary, inherit)', lineHeight: 1.6, opacity: 0.75 },
      searchRow: { display: 'flex', alignItems: 'center', gap: '8px', position: 'relative' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '8px 28px 8px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-default, rgba(128,128,128,0.35))',
        background: 'var(--dsw-alias-bg-elevated, rgba(128,128,128,0.10))',
        color: 'inherit',
        fontSize: '13px',
      },
      searchClear: {
        appearance: 'none',
        cursor: 'pointer',
        position: 'absolute',
        right: '6px',
        padding: '0 4px',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        fontSize: '14px',
        lineHeight: 1.4,
      },
      chipRow: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      chip: {
        appearance: 'none',
        cursor: 'pointer',
        padding: '3px 9px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-alias-border-default, rgba(128,128,128,0.35))',
        background: 'transparent',
        color: 'inherit',
        fontSize: '12px',
      },
      chipOn: {
        borderColor: 'var(--dsw-alias-border-pick, rgba(230,150,40,0.6))',
        color: 'var(--dsw-alias-label-pick, inherit)',
        fontWeight: 600,
      },
      sectionTitle: { fontWeight: 600, fontSize: '13px', margin: '2px 0 0' },
      grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
        gap: '10px',
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '12px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-default, rgba(128,128,128,0.35))',
        background: 'var(--dsw-alias-bg-elevated, rgba(128,128,128,0.10))',
      },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      spread: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' },
      name: { fontWeight: 600 },
      dim: { color: 'var(--dsw-alias-label-secondary, inherit)', opacity: 0.72, fontSize: '12px' },
      badge: {
        padding: '1px 6px',
        borderRadius: '6px',
        fontSize: '11px',
        border: '1px solid var(--dsw-alias-border-default, rgba(128,128,128,0.35))',
        color: 'var(--dsw-alias-label-secondary, inherit)',
      },
      badgePick: {
        padding: '1px 6px',
        borderRadius: '6px',
        fontSize: '11px',
        border: '1px solid rgba(230,150,40,0.6)',
        color: 'var(--dsw-alias-label-pick, inherit)',
        fontWeight: 600,
      },
      badgeOk: {
        padding: '1px 6px',
        borderRadius: '6px',
        fontSize: '11px',
        border: '1px solid var(--dsw-alias-border-success, rgba(76,175,80,0.55))',
        color: 'var(--dsw-alias-label-success, inherit)',
      },
      badgeWarn: {
        padding: '1px 6px',
        borderRadius: '6px',
        fontSize: '11px',
        border: '1px solid rgba(230,150,40,0.6)',
        color: 'var(--dsw-alias-label-pick, inherit)',
      },
      badgeBad: {
        padding: '1px 6px',
        borderRadius: '6px',
        fontSize: '11px',
        border: '1px solid rgba(220,80,80,0.55)',
        color: 'var(--dsw-alias-label-danger, inherit)',
      },
      badgeInstalled: {
        padding: '1px 6px',
        borderRadius: '6px',
        fontSize: '11px',
        border: '1px solid var(--dsw-alias-border-success, rgba(76,175,80,0.55))',
        color: 'var(--dsw-alias-label-success, inherit)',
      },
      body: { margin: 0, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, inherit)', opacity: 0.78 },
      ellipsis: {
        margin: 0,
        lineHeight: 1.6,
        color: 'var(--dsw-alias-label-secondary, inherit)',
        opacity: 0.78,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      button: {
        appearance: 'none',
        cursor: 'pointer',
        padding: '5px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-default, rgba(128,128,128,0.35))',
        background: 'transparent',
        color: 'inherit',
        fontSize: '12px',
      },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
        padding: '8px 10px',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-sunken, rgba(128,128,128,0.16))',
        wordBreak: 'break-all',
      },
      guide: {
        margin: 0,
        padding: '8px 10px',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-sunken, rgba(128,128,128,0.16))',
        lineHeight: 1.7,
        fontSize: '12px',
        color: 'var(--dsw-alias-label-secondary, inherit)',
        whiteSpace: 'pre-line',
      },
    }

    /** 复制到剪贴板；不可用时返回 false，由调用方改为「请手动选中」。 */
    function copyText(text) {
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) {
          navigator.clipboard.writeText(text)
          return true
        }
      } catch (error) {
        /* 无剪贴板权限：退化为可选中文本 */
      }
      return false
    }

    /** 用户看到的那条指令。宿主工具的入参就是它，不需要额外解释。 */
    function commandFor(input) {
      return `compat_market { input: ${JSON.stringify(input)} }`
    }

    /**
     * 复制成功后的"然后呢"——真机反馈（0.1.33）：按钮复制完就完了，没人知道
     * 指令要贴去哪、贴完会发生什么。四步说完，常驻到下一次复制。
     */
    function guideNode(showManual) {
      return h('div', { style: css.guide },
        '已复制 ✓ 下一步：\n'
        + '① 打开和 AI 助手的对话，粘贴并发送这条指令\n'
        + '② 助手会先给成本预览（改什么、多大、要不要重启）\n'
        + '③ 想装就说「确认安装」，助手会带 confirm 重新执行\n'
        + '④ 装完重启 DSHM 生效',
        showManual === true ? h('p', { style: { ...css.body, margin: '4px 0 0' } }, '剪贴板不可用：请手动选中上面那行指令复制。') : null)
    }

    /** ★ 星数：0 或缺席不显示 —— 没有数据不冒充"没人要"。 */
    function formatStars(stars) {
      return typeof stars === 'number' && stars > 0 ? `★ ${stars.toLocaleString()}` : ''
    }

    /** 徽章按策略分级：S0 绿、S2/S3 琥珀、S4 红，其余中性。未分析的行不进这里。 */
    function compatBadge(expect) {
      const label = strategyLabel(expect)
      if (label === undefined) return null
      const style = expect === 'S0' ? css.badgeOk : (expect === 'S2' || expect === 'S3') ? css.badgeWarn
        : expect === 'S4' ? css.badgeBad : css.badge
      return h('span', { style }, label)
    }

    /**
     * 兼容市场标签页。参照 dshmarket 的逛法：搜索（防抖 + IME 安全 + 可清除）、
     * 分类 chips、最热/最新排序、卡片网格、分页加载。
     * @param props - 槽位注入的 `listInstalled`（可能缺席）。
     */
    function CompatMarketTab(props) {
      const [draft, setDraft] = react.useState('')
      const [query, setQuery] = react.useState('')
      const [composing, setComposing] = react.useState(false)
      const [category, setCategory] = react.useState('')
      const [sort, setSort] = react.useState('hot')
      const [shown, setShown] = react.useState(PAGE_SIZE)
      const [copied, setCopied] = react.useState(null)
      const [installed, setInstalled] = react.useState(null)
      const [full, setFull] = react.useState({ status: 'idle', entries: [] })

      react.useEffect(() => {
        let alive = true
        const load = typeof props?.listInstalled === 'function' ? props.listInstalled : undefined
        if (load === undefined) return undefined
        Promise.resolve()
          .then(load)
          .then(names => { if (alive) setInstalled(Array.isArray(names) ? names : []) })
          .catch(() => { if (alive) setInstalled([]) })
        return () => { alive = false }
      }, [])

      // 全量索引：命中缓存直接就绪；否则等你点一下再拉（约 20 MB，一次，之后走缓存）。
      react.useEffect(() => {
        const cached = readCachedIndex()
        if (cached !== undefined) {
          setFull({ status: 'ready', entries: cached.entries, version: cached.version, cached: true })
          return
        }
        setFull({ status: 'idle', entries: [] })
      }, [])

      /*
       * 搜索防抖（dshmarket SearchInput 模式）：草稿停稳 250ms 才提交；清空立即提交；
       * 中文组合输入期间完全不提交，组合结束（或回车/失焦）才落地。依赖里带 composing，
       * 组合结束时这一效果会补一次调度，不会把最后一次输入丢掉。
       */
      react.useEffect(() => {
        if (draft === '') {
          setQuery('')
          return undefined
        }
        if (composing) return undefined
        const timer = setTimeout(() => setQuery(draft), SEARCH_DELAY_MS)
        return () => clearTimeout(timer)
      }, [draft, composing])

      // 查询/分类/排序变了，页码回到第一页。
      react.useEffect(() => { setShown(PAGE_SIZE) }, [query, category, sort])

      const loadAll = () => {
        setFull({ status: 'loading', entries: [] })
        Promise.resolve()
          .then(fetchFullIndex)
          .then(value => {
            writeCachedIndex(value)
            setFull({ status: 'ready', entries: value.entries, version: value.version })
          })
          .catch(error => setFull({ status: 'error', entries: [], reason: String(error?.message ?? error) }))
      }

      const installedSet = new Set(installed ?? [])
      /*
       * 有全量索引就逛全量，没有就逛目录。加载是后台的、可失败的：拉不到只影响
       * 逛的范围，标签页本身照常可用。
       */
      const pool = full.status === 'ready' && full.entries.length > 0
        ? full.entries.map(row => ({ ...row, origin: 'index' }))
        : CATALOG.map(row => ({ ...row, origin: 'catalog' }))

      const trimmed = query.trim()
      const matches = trimmed === ''
        ? []
        : sortRows(pool.filter(item => `${item.name} ${item.desc ?? ''}`.toLowerCase().includes(trimmed.toLowerCase())), sort)

      const picked = CATALOG.filter(item => item.recommend === true)
        .map(item => ({ ...item, origin: 'catalog', installed: installedSet.has(item.name) }))
      const installedRows = [
        ...CATALOG.filter(item => installedSet.has(item.name))
          .map(item => ({ ...item, origin: 'catalog', installed: true })),
        ...[...installedSet]
          .filter(name => !CATALOG.some(item => item.name === name))
          .map(name => ({ name, desc: '已安装，未收录在目录里', origin: 'index', installed: true })),
      ]

      // 浏览网格只来自全量索引（载入后）。离线的 13 条手写目录段已移除：
      // 精选之外逛什么，交给"载入全部插件"之后的 2 万条全量网格。
      const browsePool = full.status === 'ready' && full.entries.length > 0 ? pool : []
      const categorized = category === '' ? browsePool : browsePool.filter(item => item.category === category)
      const sorted = sortRows(categorized, sort)
      const visible = pageSlice(sorted, shown)
      const chips = browsePool.length > 0 ? categoryChips(pool) : []

      /** dshmarket 式卡片：名字+版本+徽章 / 一句话 / ★·日期+一个动作。 */
      const card = item => {
        const isCatalog = item.origin === 'catalog'
        const compat = isCatalog ? compatBadge(item.expect) : h('span', { style: css.badge }, '未分析')
        const meta = [
          formatStars(item.stars),
          typeof item.published === 'string' && item.published !== '' ? `更新 ${item.published}` : '',
          item.category !== undefined ? categoryLabel(item.category) : '',
        ].filter(part => part !== '').join(' · ')
        return h('div', { key: `${item.origin}:${item.name}`, style: css.card },
          h('div', { style: css.row },
            h('span', { style: css.name }, item.name),
            item.version === undefined || item.version === '' ? null : h('span', { style: css.dim }, `@${item.version}`),
            item.recommend === true ? h('span', { style: css.badgePick }, '★ 精选') : null,
            compat,
            item.installed === true ? h('span', { style: css.badgeInstalled }, '已装') : null),
          item.desc === undefined || item.desc === '' ? null : h('p', { style: css.ellipsis, title: item.desc }, item.desc),
          item.verified === undefined ? null : h('p', { style: css.body }, item.verified),
          h('div', { style: css.spread },
            h('span', { style: css.dim }, meta),
            h('button', {
              style: css.button,
              onClick: () => {
                // spec 字段优先：收录条目的推荐安装源可以与 npm 名不同
                //（如锁定到 GitHub 仓库）。名字仍是展示与"已装"判定的键。
                const done = copyText(commandFor(item.spec ?? item.name))
                setCopied(done ? item.name : `${item.name}!(manual)`)
              },
            }, copied === item.name ? '已复制 ✓' : '复制适配指令')),
          copied === item.name || copied === `${item.name}!(manual)`
            ? guideNode(copied === `${item.name}!(manual)`)
            : null)
      }

      const sectionHeader = (title, count) => h('div', { key: `h:${title}`, style: css.sectionTitle },
        count === undefined ? title : `${title} · ${count.toLocaleString()}`)

      const children = []

      children.push(h('p', { key: 'hint', style: css.hint },
        '搜名字、贴 GitHub 地址、或直接说想干什么。'))

      // 搜索框：防抖 + IME 安全 + 可清除（dshmarket SearchInput 的直版移植）。
      children.push(h('div', { key: 'search', style: css.searchRow },
        h('input', {
          key: 'q',
          style: css.input,
          value: draft,
          placeholder: '搜索插件，例如：桌宠、记忆、终端…',
          spellCheck: false,
          'aria-label': '搜索插件',
          onChange: event => setDraft(event?.target?.value ?? ''),
          onCompositionStart: () => setComposing(true),
          onCompositionEnd: event => {
            setComposing(false)
            if (event?.target?.value !== undefined) setDraft(event.target.value)
          },
          onKeyDown: event => {
            if ((event?.key === 'Enter' || event?.keyCode === 13) && composing !== true) {
              const next = event?.target?.value ?? draft
              setDraft(next)
              setQuery(next)
            }
          },
          onBlur: event => {
            if (composing !== true && event?.target?.value !== undefined) setQuery(event.target.value)
          },
        }),
        draft === '' ? null : h('button', {
          key: 'clear',
          style: css.searchClear,
          'aria-label': '清除搜索',
          onClick: () => { setDraft(''); setQuery('') },
        }, '×')))

      children.push(full.status === 'ready'
        ? h('p', { key: 'scope', style: css.hint },
          `可搜全部插件 · ${full.entries.length.toLocaleString()} 个${full.cached === true ? '（本地缓存）' : ''}`)
        : full.status === 'loading'
          ? h('p', { key: 'scope', style: css.hint }, '正在载入全部插件…（约 20 MB，只需一次）')
          : h('div', { key: 'scope', style: { ...css.row, marginTop: '-6px' } },
            h('button', { style: css.button, onClick: loadAll },
              full.status === 'error' ? '重试载入全部插件' : '载入全部插件'),
            h('span', { style: css.hint },
              full.status === 'error'
                ? `上次没成功（${full.reason ?? '网络'}）；此时只搜目录`
                : '约 20 MB，一次；之后走本地缓存')))

      if (trimmed !== '') {
        children.push(h('div', { key: 'cmd', style: css.card },
          h('div', { style: css.spread },
            h('span', { style: css.name }, '适配这个输入'),
            h('button', {
              style: css.button,
              onClick: () => {
                const done = copyText(commandFor(trimmed))
                setCopied(done ? trimmed : `${trimmed}!(manual)`)
              },
            }, copied === trimmed ? '已复制 ✓' : '复制指令')),
          h('div', { style: css.code }, commandFor(trimmed)),
          copied === trimmed || copied === `${trimmed}!(manual)`
            ? guideNode(copied === `${trimmed}!(manual)`)
            : null))
      }

      if (trimmed !== '') {
        if (matches.length > 0) {
          children.push(sectionHeader('匹配', matches.length))
          children.push(h('div', { key: 'matches', style: css.grid },
            pageSlice(matches, shown).map(card)))
          if (matches.length > shown) {
            children.push(h('button', {
              key: 'more:matches', style: css.button,
              onClick: () => setShown(shown + PAGE_SIZE),
            }, `加载更多（还有 ${(matches.length - shown).toLocaleString()} 个）`))
          }
        } else {
          /*
           * Mirrors the host: a miss is a miss. No fuzzy guesses — a wrong package that
           * looks like a hit is worse than "没有".
           */
          children.push(h('div', { key: 'empty', style: css.card },
            h('p', { style: { ...css.body, margin: 0 } }, `未找到该项目：${trimmed}`),
            h('p', { style: { ...css.body, margin: 0 } },
              '目录里没有；可以直接贴完整包名或 GitHub 地址，或到会话里搜全部插件：'),
            h('div', { style: css.code }, `compat_market_index { query: "${trimmed}" }`)))
        }
      } else {
        children.push(...(picked.length > 0 ? [sectionHeader('★ 精选', picked.length),
          h('div', { key: 'picked', style: css.grid }, picked.map(card))] : []))

        children.push(...(installedRows.length > 0 ? [sectionHeader('已安装', installedRows.length),
          h('div', { key: 'installed', style: css.grid }, installedRows.map(card))] : []))

        // 分类 chips + 排序 + 浏览网格：只在全量索引就绪后出现。
        if (full.status === 'ready' && browsePool.length > 0) {
          if (chips.length > 1) {
            children.push(h('div', { key: 'chips', style: css.chipRow },
              chips.map(chipItem => h('button', {
                key: `chip:${chipItem.id}`,
                style: category === chipItem.id ? { ...css.chip, ...css.chipOn } : css.chip,
                onClick: () => setCategory(chipItem.id),
              }, `${chipItem.label} ${chipItem.count.toLocaleString()}`)),
              h('span', { style: { ...css.dim, marginLeft: 'auto' } },
                h('button', {
                  style: sort === 'hot' ? { ...css.chip, ...css.chipOn } : css.chip,
                  onClick: () => setSort('hot'),
                }, '最热'),
                ' ',
                h('button', {
                  style: sort === 'new' ? { ...css.chip, ...css.chipOn } : css.chip,
                  onClick: () => setSort('new'),
                }, '最新'))))
          }

          children.push(sectionHeader('全部插件', sorted.length))
          children.push(h('div', { key: 'browse', style: css.grid }, visible.map(card)))
          if (sorted.length > visible.length) {
            children.push(h('button', {
              key: 'more:browse', style: css.button,
              onClick: () => setShown(shown + PAGE_SIZE),
            }, `加载更多（还有 ${(sorted.length - visible.length).toLocaleString()} 个）`))
          }
        }
      }

      children.push(h('p', { key: 'foot', style: { ...css.hint, marginTop: '2px' } },
        '执行前可先加 dryRun 看成本：compat_market { input: "…", dryRun: true }；'
        + '安装需要 confirm:true，装完要重启 DSHM。'))

      return h('div', { style: css.wrap }, children)
    }

    const zh = {
      tab: '兼容市场',
      title: '兼容市场',
    }
    const en = {
      tab: 'Compatibility',
      title: 'Compatibility market',
    }

    /**
     * 缺服务的兜底实现。键必须与 `lib/service-shims.js` 的 `SERVICE_SHIMS` 一致
     * （有测试比对）。
     *
     * 为什么要做这件事：`dsh-rewind@0.11.12` 的客户端 inject 里要
     * `conversationEvents`，而本部署没有这个服务 ⇒ cordis 让整行停在 `pending`，
     * 插件永远不激活，启动还报 `did not activate`。它自己对该服务的用法是
     * `if (events?.subscribe !== undefined)`，两个成员都当可选 ⇒ 空实现等于
     * "去重逻辑静默跳过"，而不是给出错误数据。
     *
     * 只在**确实没有提供者**时才补：先看 `ctx.get(name)`，再看 `reflect.props`，
     * 任一存在就让开（将来 DSHM 真提供了这个服务，我们不会遮蔽它）。
     */
    const SHIM_FACTORIES = {
      conversationEvents: () => ({
        entries: () => [],
        subscribe: () => () => {},
      }),
    }

    /**
     * @param ctx - 浏览器半边 context。
     * @returns 实际补上的服务名（供日志与测试）。
     */
    function provideServiceShims(ctx) {
      const provided = []
      const reflect = ctx?.reflect
      if (reflect === undefined || typeof reflect.provide !== 'function') return provided
      for (const [name, factory] of Object.entries(SHIM_FACTORIES)) {
        try {
          if (typeof ctx.get === 'function' && ctx.get(name) !== undefined) continue
          if (reflect.props !== undefined && reflect.props[name] !== undefined) continue
          reflect.provide(name, factory(), undefined)
          provided.push(name)
        } catch (error) {
          // 补不上就如实退回"缺服务"的行为，不假装成功。
        }
      }
      return provided
    }

    /** 只声明真正需要的服务；`remote.pluginInventory` 缺失不应连累挂载。 */
    const inject = ['slots', 'locale', 'remote']

    function apply(ctx) {
      /*
       * 先补服务，再注册界面：补服务这一步是"让别的插件能激活"，与市场面板无关，
       * 所以放在最前面，且失败不影响后面。
       */
      const shimmed = provideServiceShims(ctx)
      if (shimmed.length > 0) {
        try { ctx.logger?.info?.(`[dshm-compat] 已补服务：${shimmed.join(', ')}（提供者缺失，空实现）`) } catch { /* logging only */ }
      }

      let t = label => label
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dshm-compat: market dictionary')
        t = ctx.locale.bind(NS)
      } catch (error) {
        // 字典注册失败只影响文案语言，不影响标签页本身。
      }

      /**
       * 已装清单。走宿主已有的 `pluginInventory` 命名空间；任何失败都退化为空表
       * （页面仍然可用，只是不显示「已装」标记）。
       */
      const listInstalled = async () => {
        try {
          const inventory = ctx.remote?.pluginInventory
          if (inventory === undefined || typeof inventory.list !== 'function') return []
          const result = await inventory.list()
          if (result?.ok !== true) return []
          const rows = result.value
          const items = Array.isArray(rows) ? rows : (Array.isArray(rows?.items) ? rows.items : [])
          return items
            .map(row => (typeof row?.name === 'string' ? row.name : (typeof row?.id === 'string' ? row.id : undefined)))
            .filter(name => typeof name === 'string')
        } catch (error) {
          return []
        }
      }

      /**
       * 同一个面板挂到两个页面。它们不是替换关系：
       *
       *  · `plugins.tab` —— **左栏「插件」页**（`dsh-client-ui-plugin-manager`
       *    注册到 `main` 槽位的那个页面）里的标签页。这是用户说的「添加插件那里」，
       *    也是主入口。该槽位是 `kind:"list", scope:"root"`，页面用
       *    `ctx.slots.entries("plugins.tab")` 动态枚举标签，按 `order` 排序，
       *    选中时 `renderSlot("plugins.tab", {install, openPackage}, {only: tab})`
       *    ⇒ 只要注册进去就会出现在标签条上，不需要预先登记 id。
       *  · `settings.plugins.tab` —— 设置 → 插件（内置只读清单所在的页面）。
       *    留一份，页面没开放时还找得到入口。
       *
       * 两个都注册是**冗余**，不是重复：任何一个槽位缺失都不影响另一个。
       */
      const registerTab = (slotName, order) => {
        try {
          ctx.slots.inject(slotName, () => ctx.slots.register({
            name: slotName,
            id: TAB_ID,
            order,
            label: () => t('tab'),
            locale: NS,
            inject: () => ({ listInstalled }),
          }, CompatMarketTab))
        } catch (error) {
          // 槽位已被占用或页面未开放：不阻断另一个页面。
        }
      }

      registerTab('plugins.tab', 30)
      registerTab('settings.plugins.tab', 20)
    }

    exports.NS = NS
    exports.CATALOG = CATALOG
    exports.STRATEGY_LABEL = STRATEGY_LABEL
    exports.CATEGORY_LABELS = CATEGORY_LABELS
    exports.PAGE_SIZE = PAGE_SIZE
    exports.strategyLabel = strategyLabel
    exports.categoryLabel = categoryLabel
    exports.categoryChips = categoryChips
    exports.sortRows = sortRows
    exports.pageSlice = pageSlice
    exports.SHIM_NAMES = Object.keys(SHIM_FACTORIES)
    exports.provideServiceShims = provideServiceShims
    exports.commandFor = commandFor
    exports.CompatMarketTab = CompatMarketTab
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
