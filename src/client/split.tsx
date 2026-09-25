import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { parentPathOf } from './pathutil'
import { CHANGELOG_V030 } from './changelog'
import { LOCAL_VERSION, checkUpdate, getAutoCheck, readCache, setAutoCheck as storeAutoCheck, setSkipVersion, type UpdateInfo, type UpdateStatus } from './updateCheck'
import { Terminal } from 'xterm'
import { GlobePane } from './globe'
import { GameDevPane } from './gamedev'
import { DigitalHumanPane, type DhEnv } from './digitalhuman'

import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/core'
import hljsTypescript from 'highlight.js/lib/languages/typescript'
import hljsJavascript from 'highlight.js/lib/languages/javascript'
import hljsCss from 'highlight.js/lib/languages/css'
import hljsJson from 'highlight.js/lib/languages/json'

hljs.registerLanguage('typescript', hljsTypescript)
hljs.registerLanguage('javascript', hljsJavascript)
hljs.registerLanguage('css', hljsCss)
hljs.registerLanguage('json', hljsJson)

/** 「股票检测」内建入驻项目（layout 项目卡；index.tsx 种子化 + CustomPane 预填共用） */
export const STOCK_WATCH_ID = 'stock-watch'
export const STOCK_WATCH_ICON = '📈'

/**
 * dsh-worktable 乐高式工作区 M1：通用分栏引擎（PRD §13）。
 * 布局模型：标题栏 + 顶部通栏行(可选) + 主行内容窗 + 聊天窗（官方会话视图区整体，
 * 贴右或贴左，由 chatSide 决定；marginLeft/marginRight + marginTop 组合挤法）。
 * 内容三态：null（未指派 → 6 选 1 选择器）/ iframe / builtin（浏览器/资源管理器/SCM/任务/终端）。
 * 窗位调整：标题栏拖拽换位（同行或跨行）；工具栏 ⇄ 切换聊天窗左右。
 * 会话切换重新锚定不关闭；宽度按 layoutId 持久化 dsh.worktable.split.v2；
 * 内容与 chatSide 的变更经 onSpecMutated 回调交给工作台持久化（布局条目）。
 */

export type BuiltinType = 'browser' | 'anim' | 'explorer' | 'scm' | 'tasks' | 'terminal' | 'custom' | 'console' | 'globe' | 'digitalhuman' | 'gamedev'

export type SplitContent =
  | { kind: 'iframe'; url: string; title?: string }
  | { kind: 'builtin'; type: BuiltinType; url?: string }
  | { kind: 'file'; path: string }

/** 一个内容标签页 */
export type PaneTab = { id: string; title: string; content: SplitContent }

export type SplitPane = {
  id: string
  title: string
  min: number
  /** 向后兼容：单内容声明（打开时归一化为一个标签页） */
  content?: SplitContent | null
  /** 标签页模型：内容标签列表（空 = 未指派，显示 6 选 1 选择器） */
  tabs?: PaneTab[]
  /** 激活的标签下标 */
  active?: number
  /** 头部折叠：true = 隐藏窗格标题与标签栏（内容占满；随 spec 持久化） */
  collapsed?: boolean
}

export type LayoutSpec = {
  id: string
  title: string
  top: SplitPane[] | null
  main: SplitPane[]
  /** 左列整高内容窗（可选；存在时右侧列 = top 行 + 底部聊天，chatSide 固定 right） */
  left?: SplitPane | null
  leftWidth?: { default: number; min: number; max: number }
  chatWidth: { default: number; min: number; max: number }
  topHeight?: { default: number; min: number; max: number }
  /** 聊天窗贴边位置：'right'（右列/右下，默认）| 'left'（左列/左下） */
  chatSide?: 'left' | 'right'
  /** 布局条目图标（emoji；工作台侧栏展示，点击可换） */
  icon?: string
  /** 聊天窗通高（整列）：为 true 时聊天占整条右/左列，内容区（含 top 行）全部排在其另一侧 */
  chatFullHeight?: boolean
  /** 顶行首次打开时高度占可用高度比例（0~1；0.5 = 上下等分）；拖动后由存档值覆盖 */
  topHeightRatio?: number
}

type Geom = { left: number; top: number; right: number; bottom: number }

type PaneRow = 'left' | 'top' | 'main'

type SplitState = {
  active: boolean
  spec: LayoutSpec | null
  geom: Geom | null
  chatW: number
  topH: number
  leftW: number
  paneWs: number[]
  topWs: number[]
  leftWs: number[]
  root: HTMLElement | null
  header: HTMLElement | null
  viewArea: HTMLElement | null
  savedMarginLeft: string
  savedMarginRight: string
  savedMarginTop: string
  /** 打开前会话根上 --dsh-chat-user-width 的内联值（关闭时原样恢复；0.1.1 上该变量闲置无害） */
  savedWidthVar: string
  observer: ResizeObserver | null
  fallback: MutationObserver | null
  yieldObserver: MutationObserver | null
  lastMarginLeft: string
  lastMarginRight: string
  lastMarginTop: string
  onSpecMutated: ((spec: LayoutSpec) => void) | null
  listeners: Set<() => void>
  open(spec: LayoutSpec): boolean
  close(): void
  syncAnchor(): void
  refreshGeom(): void
  applyMargin(): void
  setChatW(w: number): void
  setTopH(h: number): void
  setLeftW(w: number): void
  setPaneW(i: number, w: number): void
  setTopW(i: number, w: number): void
  setPaneContent(row: PaneRow, i: number, content: SplitContent | null): void
  openTab(row: PaneRow, i: number, content: SplitContent): void
  /** 锁定窗格：清空原有标签，把内容作为该窗唯一的固定标签（挂载产物的「锁死」语义） */
  lockPane(row: PaneRow, i: number, content: SplitContent): void
  closeTab(row: PaneRow, i: number, tabId: string): void
  setActiveTab(row: PaneRow, i: number, tabId: string): void
  toggleCollapsed(row: PaneRow, i: number): void
  moveTab(fromRow: PaneRow, fromI: number, tabId: string, toRow: PaneRow, toI: number): void
  swapPanes(aRow: PaneRow, aI: number, bRow: PaneRow, bI: number): void
  setChatSide(side: 'left' | 'right'): void
  persist(): void
  subscribe(fn: () => void): () => void
  notify(): void
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)
const GAP = 1           // 窗格之间真实布局间隙：1px（分隔细线即间隙，底色贴线）
const DIVIDER = 4       // 分隔条热区宽度：透明覆盖层，细线画在热区中间与两侧内容贴齐
const BAR_H = 26
const PERSIST_KEY = 'dsh.worktable.split.v2'

/** 内置内容窗图标 */
const BUILTIN_ICONS: Record<BuiltinType, string> = {
  browser: '🌐',
  anim: '🎬',
  explorer: '📁',
  scm: '🔀',
  tasks: '✅',
  terminal: '▸_',
  custom: '✨',
  console: '🖥️',
  globe: '🌍',
  digitalhuman: '💃',
  gamedev: '🎮',
}

const BUILTIN_LABEL_KEYS: Record<BuiltinType, string> = {
  browser: 'pane.browser',
  anim: 'pane.anim',
  explorer: 'pane.explorer',
  scm: 'pane.scm',
  tasks: 'pane.tasks',
  terminal: 'pane.terminal',
  custom: 'pane.custom',
  console: 'pane.console',
  globe: 'pane.globe',
  digitalhuman: 'pane.digitalhuman',
  gamedev: 'pane.gamedev',
}

function tabTitleOf(content: SplitContent): string {
  if (content.kind === 'builtin') return T(BUILTIN_LABEL_KEYS[content.type])
  if (content.kind === 'file') return basenameOf(content.path)
  if (content.kind === 'iframe' && content.title) return content.title
  try {
    const u = new URL(content.url)
    return u.hostname || content.url
  } catch {
    return content.url
  }
}

/** 取路径最后一段作为标签标题 */
function basenameOf(p: string): string {
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || String(p)
}

/** 内容同一性（openTab 去重：同窗内同内容只保留一个标签，再次打开切过去） */
function sameContent(a: SplitContent, b: SplitContent): boolean {
  if (a.kind === 'iframe' && b.kind === 'iframe') return a.url === b.url
  if (a.kind === 'file' && b.kind === 'file') return a.path === b.path
  if (a.kind === 'builtin' && b.kind === 'builtin') return a.type === b.type
  return false
}

/** 分栏 UI 文案提供者（由工作台注入 locale t） */
let uiT: ((key: string, params?: Record<string, string>) => string) | null = null
export function setSplitT(fn: ((key: string, params?: Record<string, string>) => string) | null) {
  uiT = fn
}
const T = (key: string, params?: Record<string, string>): string => (uiT ? uiT(key, params) : key)

/** 工作区环境（由工作台注入：当前会话作用域与后台任务列表） */
export type SplitScope = { sessionId: string; cwd: string }
export type SplitJob = {
  id: string
  kind: string
  label: string
  status: string
  detail?: string
  startedAt: number
  finishedAt?: number
}
/** 控制室卡片数据（index.tsx 组装；纯读镜像，零轮询零 Token） */
export type ConsoleCardData = {
  id: string
  name: string
  icon: string
  /** 三态 + 空闲：need(待决黄) > done(完成绿) > busy(工作中蓝) > idle */
  status: 'idle' | 'busy' | 'need' | 'done'
  /** 正在运行时的本轮已用毫秒；非运行态 null */
  runtimeMs: number | null
  /** 子代理数量 */
  kids: number
  /** 最近一条消息预览（单行文本，可能为空） */
  preview: string
  /** 是否绑定对话 */
  bound: boolean
  /** 是否为「工作台」自己（卡片点击无操作） */
  self: boolean
  /** 完成/待决且未被确认：卡片发对应色光（点击确认后熄灭） */
  glow: boolean
}

type SplitEnv = {
  getScope: () => SplitScope | null
  getJobs: () => SplitJob[]
  getSubagents: () => any[]
  /** 自定义窗口：项目列表 + 会话列表 + 当前项目 + 新建会话 / 发送到已有会话 */
  custom?: {
    getProjects: () => { id: string; name: string }[]
    currentProjectId: () => string | null
    getSessions: () => Promise<{ groups: { title: string; sessions: { id: string; title: string; isCurrent: boolean }[] }[]; current: string }>
    /** 内建项目（股票检测 / 待办清单…）任务起始文案：自定义窗预填需求框 */
    getProjectStarter?: (projectId: string) => string
    submit: (projectId: string, projectName: string, requirement: string) => Promise<void>
    sendToSession: (sessionId: string, projectName: string, requirement: string) => Promise<void>
  }
  /** 控制室：卡片数据订阅 + 打开项目 / 跳绑定对话 + 主题 */
  console?: {
    subscribe: (fn: () => void) => () => void
    getCards: () => ConsoleCardData[]
    /** 宿主当前活跃会话是否在运行（未绑定对话时的「我正思考」信号；忙碌特效触发源之一） */
    getScopeBusy?: () => boolean
    /** 「操控电脑」：把指令发到控制室绑定会话由其 AI 执行（系统级操作仍需宿主授权） */
    sendRemote?: (text: string) => Promise<boolean>
    onOpen: (id: string) => void
    onJump: (id: string) => void
    /** 点发光卡片：确认（熄灭光）再打开 */
    onAck: (id: string) => void
    /** 冷会话消息预热（打开控制室时拉最近消息） */
    refreshPreviews: () => void
    /** 创建卡片：打开「添加项目」流程（同侧栏 ＋） */
    onAdd: () => void
    /** 数字人打开开关（网格里「添加项目」旁那张磁贴） */
    toggleDh?: () => void
    getTheme: () => 'dark' | 'light' | 'system'
    setTheme: (th: 'dark' | 'light' | 'system') => void
    getCols: () => number
    setCols: (n: number) => void
    getShape: () => 'square' | 'circle'
    setShape: (s: 'square' | 'circle') => void
    getBg: () => 'off' | 'plain' | 'glow' | 'photo'
    setBg: (m: 'off' | 'plain' | 'glow' | 'photo') => void
    /** 控制室自身背景透明度（0-100，100 = 不透明；0 = 全透明 → 露出后面的全屏壁纸）*/
    getBgAlpha: () => number
    setBgAlpha: (n: number) => void
    getPhotoLib: () => Promise<{ list: { id: string; kind: 'photo' | 'video'; url: string }[]; activeId: string | null }>
    addPhoto: (blob: Blob) => Promise<{ id: string; kind: 'photo' | 'video'; url: string }>
    setPhotoId: (id: string) => void
    getPhotoHsl: (id: string) => { h: number; s: number; l: number }
    setPhotoHsl: (id: string, v: { h: number; s: number; l: number }) => void
    removePhoto: (id: string) => Promise<void>
    reorderPhotos: (ids: string[]) => Promise<void>
    getPhotoGrid: () => boolean
    setPhotoGrid: (v: boolean) => void
    getGridOpacity: () => number
    setGridOpacity: (v: number) => void
    getCardBlur: () => number
    setCardBlur: (v: number) => void
    getPlainBlur: () => number
    setPlainBlur: (v: number) => void
    getGlowBlur: () => number
    setGlowBlur: (v: number) => void
    getPlainGrid: () => number
    setPlainGrid: (v: number) => void
    getGlowGrid: () => number
    setGlowGrid: (v: number) => void
    getGlowSpeed: () => number
    setGlowSpeed: (v: number) => void
    /** 「看板娘」Live2D 挂件：开关 / 模型索引 / 相对右下角的偏移（px）。
     *  模型与运行时都在运行期从 CDN 取，不进发布包（见 ConsolePet 注释）。 */
    getPetOn: () => boolean
    setPetOn: (v: boolean) => void
    getPetModel: () => number
    setPetModel: (v: number) => void
    getPetPos: () => { x: number; y: number }
    setPetPos: (v: { x: number; y: number }) => void
    getPlainHsl: () => { h: number; s: number; l: number }
    setPlainHsl: (v: { h: number; s: number; l: number }) => void
    getGlowHsl: () => { h: number; s: number; l: number }
    setGlowHsl: (v: { h: number; s: number; l: number }) => void
    getPhotoHsl: () => { h: number; s: number; l: number }
    setPhotoHsl: (v: { h: number; s: number; l: number }) => void
  }
  /** 数字人窗格：会话快照订阅 + 最近回复读取（index.tsx 组装，纯读镜像零 Token） */
  dh?: DhEnv
}
let splitEnv: SplitEnv | null = null
export function setSplitEnv(env: SplitEnv | null) {
  splitEnv = env
}

/** 数字人窗格取值函数（splitEnv 保持模块私有；用函数而非值，避开挂载前注入的时序空洞） */
const dhEnvOf = (): DhEnv | null => splitEnv?.dh ?? null
const dhScopeOf = (): string => splitEnv?.getScope()?.sessionId ?? ''

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}

/** 拖拽换位暂存 */
let dragPane: { row: PaneRow; index: number } | null = null
/** 标签拖拽暂存（跨窗移动） */
let dragTab: { row: PaneRow; index: number; tabId: string } | null = null
/** 标签拖放目标（吸附高亮；模块级，PaneBody 与窗容器共用） */
let dropTarget: { row: PaneRow; index: number } | null = null
let dropTargetListeners: Set<() => void> = new Set()
function setDropTarget(t: { row: PaneRow; index: number } | null) {
  if (dropTarget === t) return
  dropTarget = t
  for (const fn of dropTargetListeners) fn()
}

/** ——「指哪打哪」标注引擎：按钮 → 蓝色冒泡光标 → 点击弹输入框 → ✓ 打包进对话框（不发送） —— */
type AnnotState = {
  on: boolean
  started: boolean
  drawing: boolean
  px: number
  py: number
  bx0: number
  by0: number
  bx1: number
  by1: number
  ex: number
  ey: number
  draft: string
  resp: string
  stat: string
}
let annotState: AnnotState = { on: false, started: false, drawing: false, px: 0, py: 0, bx0: 0, by0: 0, bx1: 0, by1: 0, ex: 0, ey: 0, draft: '', resp: '', stat: '' }
const annotListeners = new Set<() => void>()
function setAnnot(patch: Partial<AnnotState>) {
  annotState = { ...annotState, ...patch }
  for (const fn of annotListeners) fn()
}
function subscribeAnnot(fn: () => void) { annotListeners.add(fn); return () => { annotListeners.delete(fn) } }

/** 进入瞄准模式（resp = 窗口编号等上下文，由调用方拼好） */
function startAnnot(resp: string) {
  document.body.classList.add('dsh-wt-annotating')
  setAnnot({ on: true, started: false, drawing: false, resp, stat: '', draft: '' })
}
function cancelAnnot() {
  document.body.classList.remove('dsh-wt-annotating')
  setAnnot({ on: false, started: false, drawing: false })
}

/** 窗口身份（约定：左栏 → 顶行 → 主行，从 1 起；附窗格标题与内容类型/URL，让接收方无需猜"这是哪个界面"） */
function windowLabelOf(row: PaneRow, index: number): string {
  const spec = splitStore.spec
  if (!spec) return '窗口?'
  let num = spec.left ? 2 : 1
  if (row === 'left') num = 1
  else if (row === 'top') num = num + index
  else { num += (spec.top?.length ?? 0) + index }
  let label = '窗口' + num
  const pane = row === 'left' ? spec.left : row === 'top' ? spec.top?.[index] : spec.main?.[index]
  const title = pane?.title
  if (title) label += '「' + title + '」'
  const tab = pane?.tabs?.[pane.active ?? 0]
  const c = tab?.content
  if (c) {
    try {
      if (c.kind === 'iframe' && c.url) label += '（网页 ' + new URL(c.url).hostname + '）'
      else if (c.kind === 'builtin') {
        label += '（内置·' + c.type
        try { if (c.url) label += ' ' + new URL(c.url).hostname } catch {}
        label += '）'
      }
      else if (c.kind === 'file') label += '（文件）'
    } catch {}
  }
  return label
}

/** 被点元素上下文（标签 + 类名 + 文字） */
function ctxOf(t: EventTarget | null): string {
  const el = t instanceof Element ? t : null
  if (!el || el === document.documentElement || el === document.body) return ''
  const tag = el.tagName.toLowerCase()
  const cls = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean).slice(0, 4).join('.')
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)
  let out = '<' + tag + (cls ? ' .' + cls : '') + '>'
  if (text) out += '「' + text + '」'
  try { const cs = getComputedStyle(el); out += '（字号 ' + cs.fontSize + '）' } catch {}
  return out
}

/** 框选 payload v3.1：主目标 = 框中心点【光标下的字符】所在的 Text 节点（caretPositionFromPoint，
 *  标签即使不是独立元素也能取到真正的词/段）；样式取该 Text 节点的父元素（真实渲染值）；
 *  整行 = 最近的高度≤44px 祖先的内容（供「这行字是什么」类问题）；候选 = 相交的独立短文本。 */
function boxPayload(x0: number, y0: number, x1: number, y1: number): { primary: { text: string; fontSize: string; lineHeight: string; color: string } | null; line: string; candidates: string[]; limited: boolean; src: string } {
  const L = Math.min(x0, x1)
  const T = Math.min(y0, y1)
  const R = Math.max(x0, x1)
  const B = Math.max(y0, y1)
  const cx = (L + R) / 2
  const cy = (T + B) / 2
  let primary: { text: string; fontSize: string; lineHeight: string; color: string } | null = null
  let line = ''
  let candidates: string[] = []
  let limited = false
  let src = ''
  // 在某 document 内取字（rect = 该 doc 视口在顶层页面的偏移）
  const readDoc = (doc: Document, ox: number, oy: number): boolean => {
    let ok = false
    let textParent: HTMLElement | null = null
    try {
      const pd = doc as any
      const px = cx - ox
      const py = cy - oy
      let pos: any = null
      try { if (pd.caretPositionFromPoint) pos = pd.caretPositionFromPoint(px, py) } catch {}
      if (!pos) { try { if (pd.caretRangeFromPoint) pos = pd.caretRangeFromPoint(px, py) } catch {} }
      const textNode: Node | null = pos ? (pos.offsetNode ?? pos.startContainer ?? null) : null
      if (textNode) {
        const parent = textNode.parentElement
        if (parent) {
          textParent = parent
          const text = (textNode.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60)
          if (text) {
            const cs = getComputedStyle(parent)
            primary = { text, fontSize: cs.fontSize, lineHeight: cs.lineHeight, color: cs.color }
            ok = true
          }
        }
      }
    } catch {}
    // 整行
    if (textParent) {
      try {
        let el: HTMLElement | null = textParent
        while (el && el !== doc.body) {
          const r = el.getBoundingClientRect()
          if (r.height >= 8 && r.height <= 44 && r.width > 0) {
            const t = (el.innerText || '').replace(/\s+/g, ' ').trim()
            if (t) { line = t.slice(0, 120); break }
          }
          el = el.parentElement
        }
      } catch {}
    }
    // 候选
    const seen = new Set<string>()
    if (primary) seen.add(primary.text)
    const cs: string[] = []
    try {
      for (const el of Array.from(doc.querySelectorAll<HTMLElement>('*'))) {
        const tag = el.tagName.toLowerCase()
        if (tag === 'script' || tag === 'style' || tag === 'svg' || tag === 'path' || tag === 'br' || tag === 'template' || tag === 'iframe') continue
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) continue
        if (rect.right + ox < L || rect.left + ox > R || rect.bottom + oy < T || rect.top + oy > B) continue
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ')
        if (text.length < 1 || text.length > 30) continue
        if (seen.has(text)) continue
        seen.add(text)
        cs.push(text)
        if (cs.length >= 4) break
      }
    } catch {}
    if (ok || cs.length > 0) candidates = cs
    return ok
  }
  // 1) 顶层文档
  readDoc(document, 0, 0)
  // 2) 顶层取不到 → 中心点所在 iframe 下钻（同源可读；跨域标记受限于 src）
  if (!primary) {
    try {
      for (const iframe of Array.from(document.querySelectorAll<HTMLIFrameElement>('iframe'))) {
        try {
          const r = iframe.getBoundingClientRect()
          if (r.width <= 0 || r.height <= 0) continue
          if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue
          src = iframe.getAttribute('src') ?? ''
          let inner: Document | null = null
          try { inner = iframe.contentDocument } catch { inner = null }
          if (inner) readDoc(inner, r.left, r.top)
          else limited = true
          break
        } catch { continue }
      }
    } catch {}
  }
  return { primary, line, candidates, limited, src }
}

/** 更新方法：复制给 AI 的升级指令（插件不自更新；升级由用户或其 Agent 执行 + 重启） */
const UPGRADE_CMD = 'dsh plugin --profile web add "https://github.com/Aisland-SJL/dsh-worktable/releases/latest/download/dsh-worktable.tgz"'
const UPGRADE_AI = '帮我升级 dsh-worktable：执行 ' + UPGRADE_CMD + '，完成后提醒我重启 dsh web 并刷新页面'

async function copyTextSafe(text: string): Promise<boolean> {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true } } catch {}
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch { return false }
}

/** 注入宿主对话框输入框（不发送）；失败返回 false */
function fillHostInput(text: string): boolean {
  try {
    const ta = document.querySelector<HTMLTextAreaElement>('textarea[data-phase]')
      ?? Array.from(document.querySelectorAll<HTMLTextAreaElement>('textarea')).pop()
    if (!ta) return false
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    // 连续标注：已有内容不顶掉，换行追加（用户可以同一对话连续标注多处）
    const next = ta.value && ta.value.trim() ? ta.value + '\n\n' + text : text
    if (setter) setter.call(ta, next)
    else ta.value = next
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    try {
      ta.focus()
      ta.dispatchEvent(new Event('change', { bubbles: true }))
      ta.setSelectionRange(ta.value.length, ta.value.length)
    } catch {}
    return true
  } catch {
    return false
  }
}

/** ✓ 确认：打包并注入，不发送 */
function confirmAnnot() {
  const s = annotState
  const text = '📌 标注-' + s.resp + '\n' + (s.stat || '') + '\n要求：' + (s.draft.trim() || '（未填写）')
    + '\n【工作台标注·已定位，直接作答，无需再问；仅当确实无法从标注定位时才问一次。数据缺失或标注标注读取受限时，如实说明无法确定，禁止编造数值；可建议提供截图或使用视觉模型会话】'
  const ok = fillHostInput(text)
  if (!ok) {
    try {
      navigator.clipboard?.writeText(text).catch(() => { try { window.prompt('标注已生成，请手动复制：', text) } catch {} })
    } catch {
      try { window.prompt('标注已生成，请手动复制：', text) } catch {}
    }
  }
  cancelAnnot()
}

/** 标注浮层：瞄准气泡 + 输入编辑器（每个工作区渲染一次；fixed 定位） */
function AnnotationOverlay() {
  const [, setTick] = useState(0)
  useEffect(() => subscribeAnnot(() => setTick((t) => t + 1)), [])
  const s = annotState
  useEffect(() => {
    if (!s.on || s.started) return
    let sx = 0
    let sy = 0
    let dragging = false
    const isUi = (e: MouseEvent) => e.target instanceof Element && e.target.closest('.dsh-wt_annotUi') != null
    const onMove = (e: MouseEvent) => {
      if (!annotState.on || annotState.started) return
      if (annotState.drawing) setAnnot({ bx1: e.clientX, by1: e.clientY, px: e.clientX, py: e.clientY })
      else setAnnot({ px: e.clientX, py: e.clientY })
    }
    const onDown = (e: MouseEvent) => {
      if (!annotState.on || annotState.started || isUi(e)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      sx = e.clientX
      sy = e.clientY
      dragging = true
      setAnnot({ drawing: true, bx0: sx, by0: sy, bx1: sx, by1: sy })
    }
    const onUp = (e: MouseEvent) => {
      if (!annotState.on || annotState.started || !dragging) return
      e.preventDefault()
      e.stopImmediatePropagation()
      dragging = false
      const w = Math.abs(e.clientX - sx)
      const h = Math.abs(e.clientY - sy)
      const paneEl = (e.target instanceof Element ? e.target.closest('.dsh-wt_pane') : null) as HTMLElement | null
      let stat = ''
      if (Math.max(w, h) >= 8) {
        // 框选：中心/宽高 + 窗口内百分比 + 框内可见文字聚合
        const L = Math.min(sx, e.clientX)
        const T = Math.min(sy, e.clientY)
        const R = Math.max(sx, e.clientX)
        const B = Math.max(sy, e.clientY)
        stat = '框选屏幕 (' + Math.round(L) + ',' + Math.round(T) + ') → (' + Math.round(R) + ',' + Math.round(B) + ') 宽高 (' + Math.round(w) + '×' + Math.round(h) + 'px)'
        if (paneEl) {
          const pr = paneEl.getBoundingClientRect()
          const rx1 = (((L - pr.left) / Math.max(1, pr.width)) * 100).toFixed(1)
          const ry1 = (((T - pr.top) / Math.max(1, pr.height)) * 100).toFixed(1)
          const rx2 = (((R - pr.left) / Math.max(1, pr.width)) * 100).toFixed(1)
          const ry2 = (((B - pr.top) / Math.max(1, pr.height)) * 100).toFixed(1)
          stat += '，窗口内 (' + rx1 + '%,' + ry1 + '%)→(' + rx2 + '%,' + ry2 + '%)'
        }
        const hit = boxPayload(L, T, R, B)
        if (hit.primary) stat += '，主目标：' + hit.primary.text + '（字号 ' + hit.primary.fontSize + '，行高 ' + hit.primary.lineHeight + '）'
        if (hit.line) stat += '；整行：' + hit.line
        if (hit.limited) stat += '；读取受限：跨域页面内容不可见（浏览器安全限制），窗口身份见上（' + (hit.src ? hit.src : '无URL') + '）'
        if (hit.candidates.length > 0) stat += '；候选：' + hit.candidates.map((t, i) => '[' + (i + 1) + ']' + t).join(' ')
      } else {
        stat = '屏幕坐标 (' + Math.round(e.clientX) + ', ' + Math.round(e.clientY) + ')'
        if (paneEl) {
          const r = paneEl.getBoundingClientRect()
          const rx = (((e.clientX - r.left) / Math.max(1, r.width)) * 100).toFixed(1)
          const ry = (((e.clientY - r.top) / Math.max(1, r.height)) * 100).toFixed(1)
          stat += '，窗口内 (' + rx + '%, ' + ry + '%)'
        }
        const ctx = ctxOf(e.target)
        if (ctx) stat += '，元素 ' + ctx
      }
      document.body.classList.remove('dsh-wt-annotating')
      const ex = Math.max(8, Math.min(e.clientX + 10, window.innerWidth - 288))
      const ey = Math.max(8, Math.min(e.clientY + 14, window.innerHeight - 148))
      setAnnot({ started: true, drawing: false, ex, ey, stat })
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancelAnnot() }
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('mouseup', onUp, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('mouseup', onUp, true)
      window.removeEventListener('keydown', onKey, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.on, s.started])
  // 首次进入标注：右侧气泡提示「拖动也可框选」，仅显示一次
  const [hintOnce] = useState<boolean>(() => { try { return localStorage.getItem('dsh.worktable.annotHint.v1') !== '1' } catch { return false } })
  const [hintVisible, setHintVisible] = useState(false)
  useEffect(() => {
    if (!s.on || !hintOnce) return
    setHintVisible(true)
    try { localStorage.setItem('dsh.worktable.annotHint.v1', '1') } catch {}
    const t = window.setTimeout(() => setHintVisible(false), 4200)
    return () => window.clearTimeout(t)
  }, [s.on, hintOnce])
  if (!s.on) return null
  {hintVisible && (
    <div className="dsh-wt_annotUi dsh-wt_annotHint">{T('annot.hint')}</div>
  )}
  if (s.drawing) {
    const L = Math.min(s.bx0, s.bx1)
    const T = Math.min(s.by0, s.by1)
    const R = Math.max(s.bx0, s.bx1)
    const B = Math.max(s.by0, s.by1)
    return <div className="dsh-wt_annotUi dsh-wt_annotSel" style={{ left: L, top: T, width: R - L, height: B - T }} />
  }
  if (!s.started) {
    return (
      <div className="dsh-wt_annotUi dsh-wt_annotBubble" style={{ left: s.px, top: s.py }} aria-hidden>
        <svg width="12" height="12" viewBox="0 0 16 16"><path d="M8 3.2v9.6M3.2 8h9.6" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" /></svg>
      </div>
    )
  }
  return (
    <div className="dsh-wt_annotUi dsh-wt_annotEditor" style={{ left: s.ex, top: s.ey }}>
      <textarea
        className="dsh-wt_annotInput"
        autoFocus
        value={s.draft}
        placeholder={T('annot.placeholder')}
        onChange={(e) => setAnnot({ draft: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); confirmAnnot() }
          if (e.key === 'Escape') cancelAnnot()
        }}
      />
      <div className="dsh-wt_annotBtns">
        <button type="button" className="dsh-wt_annotOk" title={T('annot.ok')} aria-label={T('annot.ok')} onClick={confirmAnnot}>✓</button>
        <button type="button" className="dsh-wt_annotNo" title={T('annot.cancel')} aria-label={T('annot.cancel')} onClick={cancelAnnot}>✕</button>
      </div>
    </div>
  )
}

/** 找到会话根容器：data-phase 元素中排除输入框、取含子元素者。
 * DSH 0.1.1-rc.2 与 0.1.2-rc.1 的会话阶段一致：active（有消息）/ hero（无会话或空会话）/ settling（过渡）。
 * 优先 active，其次 hero（空会话/无会话时也能打开分栏），settling 兜底（锚定后由观察器修正）。 */
function findConversationRoot(): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('[data-phase]'))
  const ok = (el: HTMLElement) => el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT'
    && el.children.length >= 1 && !/input/i.test(String(el.className))
  const rank = (el: HTMLElement) => (el.dataset.phase === 'active' ? 0 : el.dataset.phase === 'hero' ? 1 : 2)
  let best: HTMLElement | null = null
  let bestRank = Infinity
  for (const el of candidates) {
    if (!ok(el)) continue
    const r = rank(el)
    if (r < bestRank) { bestRank = r; best = el }
  }
  return best
}

/** 从首个槽位元素里解析「可见头部」：
 * - 0.1.1：children[0] 就是 <header> 本身（可见时自身有高度）。
 * - 0.1.2：children[0] 是零高的槽位包装（display:contents 式），真实头部渲染在其内部——
 *   此时向内找第一个可见后代（文档序 = 头部自身，先于其子元素）。
 * - 空会话（headerHidden，整棵子树 display:none）：找不到任何可见元素 → null（顶部 = 根顶部）。 */
function visibleHeaderIn(first: HTMLElement): HTMLElement | null {
  if (first.getBoundingClientRect().height > 0) return first
  for (const el of Array.from(first.querySelectorAll<HTMLElement>('*'))) {
    const r = el.getBoundingClientRect()
    if (r.height > 0 && r.width > 0) return el
  }
  return null
}

/** 从会话根解析分栏锚点（兼容 0.1.1 与 0.1.2 两种 DOM 结构）：
 * - 0.1.1 与 0.1.2 会话打开：root.children = [头部(或头部包装), 内容滚动区]（0.1.2 多一层 body 包装，不影响取 children[1]）。
 * - 0.1.2 无会话：root.children = [body]（无头部元素）。
 * - 空会话（blank）：头部带 headerHidden 样式（高度为 0），按「无头部」处理（顶部 = 根顶部）。
 * header 仅当存在第二个子元素且能解析出可见头部时生效；viewArea = 第二个子元素，只有一个时 = 第一个。 */
function resolveAnchor(root: HTMLElement): { header: HTMLElement | null; viewArea: HTMLElement } {
  const first = root.children[0] as HTMLElement | undefined
  const second = root.children[1] as HTMLElement | undefined
  const header = !!second && !!first ? visibleHeaderIn(first) : null
  return { header, viewArea: second ?? first! }
}

function loadSaved(layoutId: string): { chatW: number; topH: number; leftW: number; paneWs: number[]; topWs: number[]; leftWs: number[] } | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    if (!raw) return null
    const s = JSON.parse(raw)?.[layoutId]
    if (!s || typeof s !== 'object') return null
    return {
      chatW: Number.isFinite(s.chatW) ? s.chatW : -1,
      topH: Number.isFinite(s.topH) ? s.topH : -1,
      leftW: Number.isFinite(s.leftW) ? s.leftW : -1,
      paneWs: Array.isArray(s.paneWs) ? s.paneWs : [],
      topWs: Array.isArray(s.topWs) ? s.topWs : [],
      leftWs: Array.isArray(s.leftWs) ? s.leftWs : [],
    }
  } catch {
    return null
  }
}

function persistSaved(layoutId: string, s: { chatW: number; topH: number; leftW: number; paneWs: number[]; topWs: number[]; leftWs: number[] }) {
  try {
    const raw = localStorage.getItem(PERSIST_KEY)
    const all = raw ? JSON.parse(raw) : {}
    all[layoutId] = s
    localStorage.setItem(PERSIST_KEY, JSON.stringify(all))
  } catch {}
}

/** 共享互斥协议：其他接入本协议的分栏引擎声明占用时，本引擎让位（同一时刻仅一个分栏工作区） */
window.addEventListener('dsh:split-claim', ((e: any) => {
  const id = e?.detail?.id
  if (splitStore.active && id && id !== splitStore.spec?.id) splitStore.close()
}) as EventListener)

export const splitStore: SplitState = {
  active: false,
  spec: null,
  geom: null,
  chatW: 320,
  topH: 200,
  leftW: 260,
  paneWs: [],
  topWs: [],
  leftWs: [],
  root: null,
  header: null,
  viewArea: null,
  savedMarginLeft: '',
  savedMarginRight: '',
  savedMarginTop: '',
  savedWidthVar: '',
  observer: null,
  fallback: null,
  yieldObserver: null,
  lastMarginLeft: '',
  lastMarginRight: '',
  lastMarginTop: '',
  onSpecMutated: null,
  listeners: new Set(),

  open(spec) {
    if (this.active) {
      // 反选：同一布局再点 = 关闭；不同布局 = 替换（先关旧的）
      if (this.spec?.id === spec.id) {
        this.close()
        return true
      }
      this.close()
    }
    // 跨插件互操作桥：自带分栏实现的入驻插件（未接入共享引擎）打开时，运行时点击其关闭按钮让位
    try {
      const taClose = document.querySelector<HTMLElement>('.ta_splitClose')
      taClose?.click()
    } catch {}
    // 声明占用：接入共享协议的其他引擎收到后让位
    try {
      window.dispatchEvent(new CustomEvent('dsh:split-claim', { detail: { id: spec.id } }))
    } catch {}
    const root = findConversationRoot()
    if (!root) return false
    const { header, viewArea } = resolveAnchor(root)
    this.spec = { ...spec, chatSide: spec.chatSide === 'left' ? 'left' : 'right' }
    // 向后兼容归一化：单内容声明 → 一个标签页
    const normalize = (p: SplitPane): SplitPane => {
      if (p.tabs && p.tabs.length > 0) return p
      if (p.content) {
        return { ...p, content: null, tabs: [{ id: 't1', title: tabTitleOf(p.content), content: p.content }], active: 0 }
      }
      return { ...p, content: null, tabs: [], active: 0 }
    }
    if (spec.top) this.spec.top = spec.top.map(normalize)
    if (spec.left) this.spec.left = normalize(spec.left)
    this.spec.main = (spec.main ?? []).map(normalize)
    const main = this.spec.main ?? []
    const top = spec.top ?? []
    const left = spec.left ?? null
    const saved = loadSaved(spec.id)
    const hasChatW = !!saved && saved.chatW >= 0
    const hasTopH = !!saved && saved.topH >= 0
    const hasLeftW = !!saved && saved.leftW >= 0
    const hasPaneWs = !!saved && saved.paneWs.length === main.length
    const hasTopWs = !!saved && saved.topWs.length === top.length
    const hasLeftWs = !!saved && saved.leftWs.length === (left ? 1 : 0)
    this.chatW = hasChatW ? saved!.chatW : spec.chatWidth.default
    this.topH = hasTopH ? saved!.topH : (spec.topHeight?.default ?? 200)
    this.leftW = hasLeftW ? saved!.leftW : (spec.leftWidth?.default ?? 260)
    this.paneWs = hasPaneWs ? [...saved!.paneWs] : main.map((p) => p.min)
    this.topWs = hasTopWs ? [...saved!.topWs] : top.map((p) => p.min)
    this.leftWs = hasLeftWs ? [...saved!.leftWs] : (left ? [left.min] : [])
    this.root = root
    this.header = header
    this.viewArea = viewArea
    this.savedWidthVar = root.style.getPropertyValue('--dsh-chat-user-width')
    this.savedMarginLeft = viewArea.style.marginLeft
    this.savedMarginRight = viewArea.style.marginRight
    this.savedMarginTop = viewArea.style.marginTop
    this.refreshGeom()
    // 存档 sanitize：chatW 等尺寸按本布局规格钳制（防老版本/脏存值越界，如 1067 > max 600）
    if (this.geom) {
      const minContent = main.reduce((a: number, p: SplitPane) => a + p.min, 0) + Math.max(0, main.length - 1) * GAP
      const hi = Math.max(spec.chatWidth.min, (this.geom.right - this.geom.left) - minContent)
      this.chatW = clamp(Math.round(this.chatW), spec.chatWidth.min, hi)
    }
    // 均衡默认：无存档尺寸时按当前可用空间比例分配，
    // 不再出现“其余窗全部贴 min、最后一个吃掉全部余量”的悬殊观感。
    const g0 = this.geom
    if (g0) {
      const colW0 = g0.right - g0.left
      const rowH0 = g0.bottom - g0.top
      if (!hasChatW) {
        const hi = Math.max(spec.chatWidth.min, colW0 - 60)
        this.chatW = clamp(Math.round(colW0 * 0.3), spec.chatWidth.min, hi)
      }
      if (left && !hasLeftW) {
        const lo = spec.leftWidth?.min ?? 160
        this.leftW = clamp(Math.round(colW0 * 0.38), lo, Math.max(lo, colW0 - 260))
      }
      if (top.length > 0 && !hasTopH) {
        const lo = spec.topHeight?.min ?? 80
        const ratio = spec.topHeightRatio ?? 0.35
        this.topH = clamp(Math.round((rowH0 - BAR_H) * ratio), lo, Math.max(lo, rowH0 - BAR_H - 80))
      }
      if (!hasPaneWs) {
        const contentW = Math.max(0, colW0 - this.chatW)
        const avail = Math.max(main.length * 120, contentW - Math.max(0, main.length - 1) * GAP)
        const share = Math.round(avail / main.length)
        this.paneWs = main.map((p) => Math.max(p.min, share))
      }
      if (!hasTopWs) {
        // chatFull 时顶行只占内容侧（扣除聊天列宽）
        const chatW0 = spec.chatFullHeight === true ? this.chatW : 0
        const rowW = Math.max(0, colW0 - chatW0 - (left ? this.leftW : 0))
        const avail = Math.max(top.length * 120, rowW - Math.max(0, top.length - 1) * GAP)
        const share = Math.round(avail / top.length)
        this.topWs = top.map((p) => Math.max(p.min, share))
      }
      if (left && !hasLeftWs) this.leftWs = [Math.max(left.min, this.leftW)]
    }
    this.applyMargin()
    this.observer = new ResizeObserver(() => {
      const r = this.root
      if (!(r && r.isConnected)) { this.syncAnchor(); return }
      const anchor = resolveAnchor(r)
      if (anchor.header !== this.header || anchor.viewArea !== this.viewArea) { this.syncAnchor(); return }
      this.refreshGeom()
      this.applyMargin()
      this.notify()
    })
    this.observer.observe(root)
    // 兜底：会话根被替换/子结构变化（如 hero→active 头部出现）时 RO 可能不再回调，
    // 用 body 级 MutationObserver 驱动重锚定；锚点未变时静默（避免流式消息期间高频刷新）
    this.fallback = new MutationObserver(() => {
      const r = this.root
      if (!(r && r.isConnected)) { this.syncAnchor(); return }
      const anchor = resolveAnchor(r)
      if (anchor.header !== this.header || anchor.viewArea !== this.viewArea) this.syncAnchor()
    })
    this.fallback.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-phase'] })
    // 让位观察器：会话视图区 margin 被外部改写（其他未接入协议的分栏引擎接管）时关闭自身
    this.yieldObserver = new MutationObserver(() => {
      if (!this.active || !this.viewArea) return
      if (this.viewArea.style.marginLeft !== this.lastMarginLeft
        || this.viewArea.style.marginRight !== this.lastMarginRight
        || this.viewArea.style.marginTop !== this.lastMarginTop) {
        this.close()
      }
    })
    this.yieldObserver.observe(viewArea, { attributes: true, attributeFilter: ['style'] })
    this.active = true
    this.notify()
    return true
  },

  /** 会话根失效（切换会话 / hero↔active 结构变化）时重新锚定：左侧内容保持不关闭；无会话根才关闭 */
  syncAnchor() {
    if (!this.active) return
    const next = findConversationRoot()
    if (!next) {
      this.close()
      return
    }
    const ph = next.dataset.phase
    if (ph !== 'active' && ph !== 'hero') return // settling 等过渡态：保持等待（phase 变化会再次触发）
    const anchor = resolveAnchor(next)
    if (next === this.root && anchor.header === this.header && anchor.viewArea === this.viewArea) {
      // 同锚点：头部可能由隐藏变可见（hero→active），刷新几何与挤位
      this.refreshGeom()
      this.applyMargin()
      this.notify()
      return
    }
    const viewArea = anchor.viewArea
    const oldRoot = this.root
    const oldViewArea = this.viewArea
    // 恢复旧锚点（若仍连接），锚定到新会话根
    if (oldViewArea && oldViewArea.isConnected && oldViewArea !== viewArea) {
      oldViewArea.style.marginLeft = this.savedMarginLeft
      oldViewArea.style.marginRight = this.savedMarginRight
      oldViewArea.style.marginTop = this.savedMarginTop
    }
    if (oldRoot && oldRoot.isConnected && oldRoot !== next) {
      if (this.savedWidthVar) oldRoot.style.setProperty('--dsh-chat-user-width', this.savedWidthVar)
      else oldRoot.style.removeProperty('--dsh-chat-user-width')
    }
    this.root = next
    this.header = anchor.header
    this.viewArea = viewArea
    // 仅锚点元素真正更换时才记录「打开前」原值——同元素重锚（hero→active 头部出现）
    // 必须保留最初存档，否则关闭时会把已应用的 margin/变量误还原成「新原值」
    if (oldRoot !== next) {
      this.savedWidthVar = next.style.getPropertyValue('--dsh-chat-user-width')
    }
    if (oldViewArea !== viewArea) {
      this.savedMarginLeft = viewArea.style.marginLeft
      this.savedMarginRight = viewArea.style.marginRight
      this.savedMarginTop = viewArea.style.marginTop
    }
    this.observer?.disconnect()
    this.observer.observe(next)
    this.refreshGeom()
    this.applyMargin()
    this.notify()
  },

  refreshGeom() {
    const root = this.root
    if (!root) return
    const rr = root.getBoundingClientRect()
    const hr = this.header ? this.header.getBoundingClientRect() : null
    // 头部隐藏（blank 会话）或无头部（0.1.2 无会话）时以根顶部为分栏上沿
    const top = hr && hr.height > 0 ? hr.bottom : rr.top
    this.geom = { left: rr.left, top, right: rr.right, bottom: rr.bottom }
  },

  applyMargin() {
    const viewArea = this.viewArea
    const g = this.geom
    const spec = this.spec
    if (!viewArea || !g || !spec) return
    const colW = g.right - g.left
    const rowH = g.bottom - g.top
    const hasLeft = !!spec.left
    const hasTop = !!(spec.top && spec.top.length > 0)
    const chatW = clamp(this.chatW, spec.chatWidth.min, Math.max(spec.chatWidth.min, colW - 60))
    // 会话内容宽 clamp(680px, …, 920px) 不随挤出的聊天列收缩 → 显式钉到挤出的列宽
    // （close/重锚定时原样恢复；0.1.1 上该 CSS 变量闲置，设置无害）
    if (this.root && this.root.isConnected) {
      this.root.style.setProperty('--dsh-chat-user-width', Math.round(chatW) + 'px')
    }
    const topH = hasTop
      ? clamp(this.topH, spec.topHeight?.min ?? 80, Math.max(spec.topHeight?.min ?? 80, rowH - BAR_H - 80))
      : 0
    const leftW = hasLeft
      ? clamp(this.leftW, spec.leftWidth?.min ?? 160, Math.max(spec.leftWidth?.min ?? 160, colW - 260))
      : 0
    const chatFull = spec.chatFullHeight === true
    const gap = Math.max(0, colW - chatW) + 'px'
    const mt = (BAR_H + (hasTop && !chatFull ? topH : 0)) + 'px'
    const chatLeft = !hasLeft && spec.chatSide === 'left'
    this.lastMarginLeft = hasLeft ? leftW + 'px' : (chatLeft ? '' : gap)
    this.lastMarginRight = hasLeft ? '' : (chatLeft ? gap : '')
    this.lastMarginTop = mt
    viewArea.style.marginLeft = this.lastMarginLeft
    viewArea.style.marginRight = this.lastMarginRight
    viewArea.style.marginTop = mt
  },

  setChatW(w) {
    const g = this.geom
    const spec = this.spec
    if (!g || !spec) return
    const colW = g.right - g.left
    const main = spec.main ?? []
    const minContent = main.reduce((a, p) => a + p.min, 0) + Math.max(0, main.length - 1) * GAP
    const hi = Math.max(spec.chatWidth.min, colW - minContent)
    this.chatW = clamp(Math.round(w), spec.chatWidth.min, hi)
    this.applyMargin()
    this.persist()
    this.notify()
  },

  setTopH(h) {
    const g = this.geom
    const spec = this.spec
    if (!g || !spec) return
    const rowH = g.bottom - g.top
    const lo = spec.topHeight?.min ?? 80
    const hi = Math.max(lo, rowH - BAR_H - 80)
    this.topH = clamp(Math.round(h), lo, hi)
    this.applyMargin()
    this.persist()
    this.notify()
  },

  setLeftW(w) {
    const g = this.geom
    const spec = this.spec
    if (!g || !spec || !spec.left) return
    const colW = g.right - g.left
    const lo = spec.leftWidth?.min ?? 160
    const hi = Math.max(lo, colW - 260)
    this.leftW = clamp(Math.round(w), lo, hi)
    this.applyMargin()
    this.persist()
    this.notify()
  },

  setPaneW(i, w) {
    const g = this.geom
    const spec = this.spec
    if (!g || !spec) return
    const main = spec.main ?? []
    if (i < 0 || i >= main.length) return
    const colW = g.right - g.left
    const chatW = clamp(this.chatW, spec.chatWidth.min, Math.max(spec.chatWidth.min, colW - 60))
    const contentW = Math.max(0, colW - chatW)
    const othersMin = main.reduce((a, p, k) => a + (k === i ? 0 : p.min), 0)
    const lo = main[i].min
    const hi = Math.max(lo, contentW - othersMin - Math.max(0, main.length - 1) * GAP)
    const next = this.paneWs.slice()
    next[i] = clamp(Math.round(w), lo, hi)
    this.paneWs = next
    this.persist()
    this.notify()
  },

  setTopW(i, w) {
    const g = this.geom
    const spec = this.spec
    if (!g || !spec) return
    const top = spec.top ?? []
    if (i < 0 || i >= top.length) return
    const colW = g.right - g.left
    const othersMin = top.reduce((a, p, k) => a + (k === i ? 0 : p.min), 0)
    const lo = top[i].min
    const hi = Math.max(lo, colW - othersMin - Math.max(0, top.length - 1) * GAP)
    const next = this.topWs.slice()
    next[i] = clamp(Math.round(w), lo, hi)
    this.topWs = next
    this.persist()
    this.notify()
  },

  setPaneContent(row, i, content) {
    if (content) this.openTab(row, i, content)
  },

  lockPane(row, i, content) {
    const spec = this.spec
    if (!spec) return
    const tab: PaneTab = { id: 't' + Date.now().toString(36), title: tabTitleOf(content), content, active: 0 }
    const mutate = (pane: SplitPane): SplitPane => ({ ...pane, content: null, tabs: [tab], active: 0 })
    if (row === 'left') {
      if (!spec.left || i !== 0) return
      this.spec = { ...spec, left: mutate(spec.left) }
    } else if (row === 'top') {
      const top = [...(spec.top ?? [])]
      if (!top[i]) return
      top[i] = mutate(top[i])
      this.spec = { ...spec, top }
    } else {
      const main = [...spec.main]
      if (!main[i]) return
      main[i] = mutate(main[i])
      this.spec = { ...spec, main }
    }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  /** 更新指定标签页的内容（浏览器/动画窗地址栏回车时回写），并持久化到布局条目 */
  setTabContent(row, index, tabId, content) {
    const spec = this.spec
    if (!spec) return
    const mutate = (pane: SplitPane): SplitPane => {
      const tabs = (pane.tabs ?? []).map((t) => (t.id === tabId ? { ...t, content, title: tabTitleOf(content) } : t))
      return { ...pane, tabs }
    }
    if (row === 'left') {
      if (spec.left && index === 0) this.spec = { ...spec, left: mutate(spec.left) }
    } else if (row === 'top') {
      const top = [...(spec.top ?? [])]
      if (top[index]) { top[index] = mutate(top[index]); this.spec = { ...spec, top } }
    } else {
      const main = [...spec.main]
      if (main[index]) { main[index] = mutate(main[index]); this.spec = { ...spec, main } }
    }
    this.onSpecMutated?.(this.spec)
    this.notify()
  },

  openTab(row, i, content) {
    const spec = this.spec
    if (!spec) return
    const mutate = (pane: SplitPane): SplitPane => {
      const tabs = [...(pane.tabs ?? [])]
      // 去重：同内容已有标签 → 直接激活
      const existing = tabs.findIndex((t) => sameContent(t.content, content))
      if (existing >= 0) return { ...pane, content: null, tabs, active: existing }
      const tab: PaneTab = { id: 't' + Date.now().toString(36), title: tabTitleOf(content), content }
      tabs.push(tab)
      return { ...pane, content: null, tabs, active: tabs.length - 1 }
    }
    if (row === 'left') {
      if (!spec.left || i !== 0) return
      this.spec = { ...spec, left: mutate(spec.left) }
    } else if (row === 'top') {
      const top = [...(spec.top ?? [])]
      if (!top[i]) return
      top[i] = mutate(top[i])
      this.spec = { ...spec, top }
    } else {
      const main = [...spec.main]
      if (!main[i]) return
      main[i] = mutate(main[i])
      this.spec = { ...spec, main }
    }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  closeTab(row, i, tabId) {
    const spec = this.spec
    if (!spec) return
    const mutate = (pane: SplitPane): SplitPane => {
      const tabs = (pane.tabs ?? []).filter((t) => t.id !== tabId)
      return { ...pane, tabs, active: 0 }
    }
    if (row === 'left') {
      if (!spec.left || i !== 0) return
      this.spec = { ...spec, left: mutate(spec.left) }
    } else if (row === 'top') {
      const top = [...(spec.top ?? [])]
      if (!top[i]) return
      top[i] = mutate(top[i])
      this.spec = { ...spec, top }
    } else {
      const main = [...spec.main]
      if (!main[i]) return
      main[i] = mutate(main[i])
      this.spec = { ...spec, main }
    }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  moveTab(fromRow, fromI, tabId, toRow, toI) {
    const spec = this.spec
    if (!spec) return
    if (fromRow === toRow && fromI === toI) return
    const top = [...(spec.top ?? [])]
    const main = [...spec.main]
    const left = spec.left ? { ...spec.left } : null
    const arrOf = (row: PaneRow): SplitPane[] => (row === 'left' ? (left ? [left] : []) : row === 'top' ? top : main)
    const fromArr = arrOf(fromRow)
    const toArr = arrOf(toRow)
    const fromPane = fromArr[fromI]
    const toPane = toArr[toI]
    if (!fromPane || !toPane) return
    const tab = (fromPane.tabs ?? []).find((t) => t.id === tabId)
    if (!tab) return
    const fromTabs = (fromPane.tabs ?? []).filter((t) => t.id !== tabId)
    const toTabs = [...(toPane.tabs ?? []), tab]
    const setPane = (row: PaneRow, i: number, pane: SplitPane) => {
      if (row === 'left') spec.left = pane
      else if (row === 'top') top[i] = pane
      else main[i] = pane
    }
    setPane(fromRow, fromI, { ...fromPane, tabs: fromTabs, active: 0 })
    setPane(toRow, toI, { ...toPane, tabs: toTabs, active: toTabs.length - 1 })
    this.spec = { ...spec, left: left ?? null, top: top.length > 0 ? top : null, main }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  setActiveTab(row, i, tabId) {
    const spec = this.spec
    if (!spec) return
    const mutate = (pane: SplitPane): SplitPane => {
      const idx = (pane.tabs ?? []).findIndex((t) => t.id === tabId)
      if (idx < 0) return pane
      return { ...pane, active: idx }
    }
    if (row === 'left') {
      if (!spec.left || i !== 0) return
      this.spec = { ...spec, left: mutate(spec.left) }
    } else if (row === 'top') {
      const top = [...(spec.top ?? [])]
      if (!top[i]) return
      top[i] = mutate(top[i])
      this.spec = { ...spec, top }
    } else {
      const main = [...spec.main]
      if (!main[i]) return
      main[i] = mutate(main[i])
      this.spec = { ...spec, main }
    }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  toggleCollapsed(row, i) {
    const spec = this.spec
    if (!spec) return
    const mutate = (pane: SplitPane): SplitPane => ({ ...pane, collapsed: !pane.collapsed })
    if (row === 'left') {
      if (!spec.left || i !== 0) return
      this.spec = { ...spec, left: mutate(spec.left) }
    } else if (row === 'top') {
      const top = [...(spec.top ?? [])]
      if (!top[i]) return
      top[i] = mutate(top[i])
      this.spec = { ...spec, top }
    } else {
      const main = [...spec.main]
      if (!main[i]) return
      main[i] = mutate(main[i])
      this.spec = { ...spec, main }
    }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  swapPanes(aRow, aI, bRow, bI) {
    const spec = this.spec
    if (!spec) return
    const top = [...(spec.top ?? [])]
    const main = [...spec.main]
    const left = spec.left ? { ...spec.left } : null
    const arrOf = (row: PaneRow): SplitPane[] => (row === 'left' ? (left ? [left] : []) : row === 'top' ? top : main)
    const setOf = (row: PaneRow, i: number, pane: SplitPane) => {
      if (row === 'left') spec.left = pane
      else if (row === 'top') top[i] = pane
      else main[i] = pane
    }
    const a = arrOf(aRow)[aI]
    const b = arrOf(bRow)[bI]
    if (!a || !b) return
    setOf(aRow, aI, b)
    setOf(bRow, bI, a)
    const wsOf = (row: PaneRow): number[] => (row === 'left' ? this.leftWs : row === 'top' ? this.topWs : this.paneWs)
    const setWs = (row: PaneRow, i: number, v: number) => {
      if (row === 'left') { const n = this.leftWs.slice(); n[i] = v; this.leftWs = n }
      else if (row === 'top') { const n = this.topWs.slice(); n[i] = v; this.topWs = n }
      else { const n = this.paneWs.slice(); n[i] = v; this.paneWs = n }
    }
    const aW = wsOf(aRow)[aI]
    const bW = wsOf(bRow)[bI]
    setWs(aRow, aI, bW)
    setWs(bRow, bI, aW)
    this.spec = { ...spec, left: left ?? null, top: top.length > 0 ? top : null, main }
    this.onSpecMutated?.(this.spec)
    this.persist()
    this.notify()
  },

  setChatSide(side) {
    const spec = this.spec
    if (!spec) return
    if (spec.left) return // 左列布局：聊天固定右下
    this.spec = { ...spec, chatSide: side }
    this.onSpecMutated?.(this.spec)
    this.applyMargin()
    this.persist()
    this.notify()
  },

  persist() {
    if (!this.spec) return
    persistSaved(this.spec.id, { chatW: this.chatW, topH: this.topH, leftW: this.leftW, paneWs: this.paneWs, topWs: this.topWs, leftWs: this.leftWs })
  },

  close() {
    if (this.root && this.root.isConnected) {
      if (this.savedWidthVar) this.root.style.setProperty('--dsh-chat-user-width', this.savedWidthVar)
      else this.root.style.removeProperty('--dsh-chat-user-width')
    }
    if (this.viewArea) {
      this.viewArea.style.marginLeft = this.savedMarginLeft
      this.viewArea.style.marginRight = this.savedMarginRight
      this.viewArea.style.marginTop = this.savedMarginTop
    }
    this.observer?.disconnect()
    this.observer = null
    this.fallback?.disconnect()
    this.fallback = null
    this.yieldObserver?.disconnect()
    this.yieldObserver = null
    this.root = null
    this.header = null
    this.viewArea = null
    this.savedWidthVar = ''
    this.geom = null
    this.spec = null
    this.active = false
    this.notify()
  },

  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  },

  notify() {
    for (const fn of this.listeners) fn()
  },
}

/** 跨插件互操作桥：自带分栏实现的插件其浮层（.ta_split）出现 = 其引擎打开 → 本引擎让位。
 * 不改动对方插件代码，仅在 DOM 层观察其浮层挂载。 */
if (typeof document !== 'undefined' && document.body) {
  const taObserver = new MutationObserver(() => {
    if (!splitStore.active) return
    if (document.querySelector('.ta_split')) splitStore.close()
  })
  taObserver.observe(document.body, { childList: true, subtree: true })
}

/** 分配各窗宽度（最后一个拿余量） */
function allocate(panes: SplitPane[], ws: number[], total: number) {
  const out: { pane: SplitPane; left: number; width: number }[] = []
  const gapTotal = Math.max(0, panes.length - 1) * GAP
  const avail = Math.max(0, total - gapTotal)
  let x = 0
  panes.forEach((p, i) => {
    const w = i === panes.length - 1 ? Math.max(0, avail - x) : ws[i]
    out.push({ pane: p, left: x, width: w })
    x += w + GAP
  })
  return out
}

/** 通用分隔线拖拽（chat/top/pane/topPane） */
function makeDividerHandler(kind: 'left' | 'chat' | 'top' | 'pane' | 'topPane', index?: number) {
  return (e: any) => {
    e.preventDefault()
    const target = e.currentTarget as HTMLElement
    try { target.setPointerCapture(e.pointerId) } catch {}
    const onMove = (ev: PointerEvent) => {
      const g = splitStore.geom
      if (!g) return
      if (kind === 'left') {
        splitStore.setLeftW(ev.clientX - g.left)
      } else if (kind === 'chat') {
        splitStore.setChatW(g.right - ev.clientX)
      } else if (kind === 'top') {
        splitStore.setTopH(ev.clientY - g.top - BAR_H)
      } else if (kind === 'pane' && index != null) {
        const prefix = splitStore.paneWs.slice(0, index).reduce((a, b) => a + b, 0) + index * GAP
        splitStore.setPaneW(index, ev.clientX - (g.left + prefix))
      } else if (kind === 'topPane' && index != null) {
        const prefix = splitStore.topWs.slice(0, index).reduce((a, b) => a + b, 0) + index * GAP
        splitStore.setTopW(index, ev.clientX - (g.left + prefix))
      }
    }
    const onUp = () => {
      target.removeEventListener('pointermove', onMove)
      target.removeEventListener('pointerup', onUp)
      target.removeEventListener('pointercancel', onUp)
    }
    target.addEventListener('pointermove', onMove)
    target.addEventListener('pointerup', onUp)
    target.addEventListener('pointercancel', onUp)
  }
}

/** 浏览器内置窗：地址栏 + 前往；刷新统一在标签栏最左（重挂载 iframe，跨域也可靠） */
function BrowserPane(props: { row: PaneRow; index: number; tabId: string; content: SplitContent; reloadKey: number }) {
  const initial = props.content?.url || 'https://example.com'
  const [url, setUrl] = useState(initial)
  const [src, setSrc] = useState(initial)
  const go = () => {
    const u = url.trim()
    const ok = /^(\/|https?:\/\/)/i.test(u) ? u : 'about:blank'
    setSrc(ok)
    if (ok !== 'about:blank') {
      // 地址回写：刷新/重开布局时保持当前网址
      splitStore.setTabContent(props.row, props.index, props.tabId, { kind: 'builtin', type: 'browser', url: ok })
    }
  }
  return (
    <>
      <div className="dsh-wt_browserBar">
        <input
          className="dsh-wt_browserInput"
          value={url}
          placeholder="https://"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go() }}
        />
        <button type="button" className="dsh-wt_browserGo" onClick={go}>↗</button>
      </div>
      <iframe key={props.reloadKey} className="dsh-wt_paneFrame" src={src} title="browser" />
    </>
  )
}

/** iframe 内容标签（网页/站点产物）：刷新统一在标签栏最左（重挂载整页刷新，跨域可靠） */
function IframePane(props: { url: string; title?: string; reloadKey: number }) {
  return <iframe key={props.reloadKey} className="dsh-wt_paneFrame" src={props.url} title={props.title ?? ''} />
}

/** 动画播放窗：iframe 壳 + 地址栏（站内自带项目/场景列表、播放、画幅切换、导出等全部控件） */
function AnimPane(props: { row: PaneRow; index: number; tabId: string; content: SplitContent; reloadKey: number }) {
  const initial = props.content?.url || ''
  const [url, setUrl] = useState(initial)
  const [src, setSrc] = useState(initial || 'about:blank')
  const go = () => {
    const u = url.trim()
    const ok = /^(\/|https?:\/\/)/i.test(u) ? u : 'about:blank'
    setSrc(ok)
    if (ok !== 'about:blank') {
      splitStore.setTabContent(props.row, props.index, props.tabId, { kind: 'builtin', type: 'anim', url: ok })
    }
  }
  return (
    <>
      <div className="dsh-wt_browserBar">
        <input
          className="dsh-wt_browserInput"
          value={url}
          placeholder={T('pane.animUrlPh')}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') go() }}
        />
        <button type="button" className="dsh-wt_browserGo" onClick={go}>↗</button>
      </div>
      <iframe key={props.reloadKey} className="dsh-wt_paneFrame" src={src} title="anim" />
    </>
  )
}

/** 主题图标（描边风格）：dark=月 / light=日 / system=电脑；主按钮与下拉共用 */
function ThemeIcon({ mode, size }: { mode: 'dark' | 'light' | 'system'; size?: number }) {
  const s = size ?? 18
  if (mode === 'dark') return <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden><path d="M14 8.53A6 6 0 1 1 7.47 2 4.67 4.67 0 0 0 14 8.53z" fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinejoin="round" /></svg>
  if (mode === 'light') return <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" strokeWidth="0.9" /><path d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2" fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" /></svg>
  return <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden><rect x="2" y="3.2" width="12" height="8.8" rx="1.6" fill="none" stroke="currentColor" strokeWidth="0.9" /><path d="M5.4 14.4h5.2M8 12v2.4" fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" /></svg>
}

/** 两行滑杆图标（设置入口）：2 条轨道 + 2 个旋钮，描边风格 */
function SliderIcon({ size }: { size?: number }) {
  const s = size ?? 14
  return (
    <svg width={s} height={s} viewBox="0 0 16 16" aria-hidden>
      <path d="M2.5 5.6h11M2.5 10.4h11" fill="none" stroke="currentColor" strokeWidth="1.1" />
      <circle cx="10.4" cy="5.6" r="1.8" fill="currentColor" />
      <circle cx="5.8" cy="10.4" r="1.8" fill="currentColor" />
    </svg>
  )
}

/** HSL 数值普通输入框：始终为常规边框输入框，输入提交时自动钳制到 0..max */
function HslValInput(props: { value: number; max: number; min?: number; onCommit: (n: number) => void }) {
  const lo = props.min ?? 0
  const [draft, setDraft] = useState(String(props.value))
  const [focused, setFocused] = useState(false)
  useEffect(() => { if (!focused) setDraft(String(props.value)) }, [props.value, focused])
  const commit = () => {
    let n = parseInt(draft, 10)
    if (!Number.isFinite(n)) n = props.value
    n = Math.min(Math.max(n, lo), props.max)
    props.onCommit(n)
  }
  return (
    <input
      className="dsh-wt_hslInput"
      type="number"
      min={lo}
      max={props.max}
      value={focused ? draft : String(props.value)}
      onFocus={() => { setFocused(true); setDraft(String(props.value)) }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setFocused(false); commit() }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') { setDraft(String(props.value)); (e.target as HTMLInputElement).blur() }
      }}
    />
  )
}

/** 纯色背景默认值（与主题关联）：深色 = 原深蓝黑 #0a0d13；浅色 = 白 #eef1f5；网格线由 --wt-grid 主题变量自动切换 */
const PLAIN_HSL_DARK = { h: -140, s: 31, l: 6 }
const PLAIN_HSL_LIGHT = { h: -146, s: 26, l: 95 }

/** 循环视频背景：首尾帧交叉渐变——双轨重叠过渡（尾帧淡出→头帧淡入），消除循环「卡一下」。
 *  两轨共用同一源；备用轨仅在交接窗口播放，其余时间暂停（解码负担仅 ~1.2s/循环）。 */
function ConsoleVideo(props: { src: string; style?: CSSProperties }) {
  const aRef = useRef<HTMLVideoElement | null>(null)
  const bRef = useRef<HTMLVideoElement | null>(null)
  const roleRef = useRef<'a' | 'b'>('a')
  const firedRef = useRef(false)
  useEffect(() => {
    const role = () => (roleRef.current === 'a' ? aRef.current : bRef.current)
    const spare = () => (roleRef.current === 'a' ? bRef.current : aRef.current)
    firedRef.current = false
    let raf = 0
    let stopped = false
    const onEnded = () => {
      const m = role()
      const s = spare()
      if (!m || !s) return
      // 主轨播完：备用轨已成为新主轨（淡入完成）；旧主轨复位为备用轨
      roleRef.current = roleRef.current === 'a' ? 'b' : 'a'
      firedRef.current = false
      try {
        m.currentTime = 0
        m.pause()
        m.style.opacity = '0'
        m.getAnimations().forEach((an) => an.cancel())
      } catch {}
      try {
        const nm = role()
        if (nm) nm.style.opacity = '1'
      } catch {}
    }
    const tick = () => {
      if (stopped) return
      const m = role()
      const s = spare()
      if (m && s && !m.paused && m.readyState >= 2 && !firedRef.current) {
        const d = m.duration
        if (Number.isFinite(d) && d > 0) {
          const fade = Math.min(2.0, Math.max(1.2, d * 0.18))
          if (m.currentTime >= Math.max(0, d - fade)) {
            firedRef.current = true
            try {
              try { s.currentTime = 0 } catch {}
              const startFade = () => {
                try {
                  try { m.getAnimations().forEach((an) => an.cancel()) } catch {}
                  try { s.getAnimations().forEach((an) => an.cancel()) } catch {}
                  s.play().catch(() => {})
                  s.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fade * 1000, easing: 'linear', fill: 'forwards' })
                  m.animate([{ opacity: 1 }, { opacity: 0 }], { duration: fade * 1000, easing: 'linear', fill: 'forwards' })
                } catch {}
              }
              if (s.readyState >= 2) startFade()
              else s.addEventListener('canplay', startFade, { once: true })
            } catch {}
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    aRef.current?.addEventListener('ended', onEnded)
    bRef.current?.addEventListener('ended', onEnded)
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      aRef.current?.removeEventListener('ended', onEnded)
      bRef.current?.removeEventListener('ended', onEnded)
    }
  }, [])
  return (
    <>
      <video ref={aRef} className="dsh-wt_consoleMedia" src={props.src} muted autoPlay playsInline style={props.style} />
      <video ref={bRef} className="dsh-wt_consoleMedia" src={props.src} muted playsInline style={{ ...props.style, opacity: 0 }} />
    </>
  )
}

/** 看板娘模型清单（最小版先 1 个）。模型来自 Live2D 官方示例素材：个人用户与小规模企业
 *  （年销售额低于 1000 万日元）可自由用于商业与非商业创作，需同意 Free Material License
 *  Agreement 并遵守该角色自身条款；中大型企业不允许。此处只存 URL —— 模型本体不随插件分发。 */
const PET_MODELS = [
  { name: 'Mao', url: 'https://model.hacxy.cn/Mao/Mao.model3.json' },
]
/** 运行时依赖：l2d（MIT）把 Live2D 官方 Cubism Core（专有组件）内联在它的 dist 里。
 *  所以这里恒为「运行时按需加载」，绝不把 Cubism Core 并进发布包：
 *  不开看板娘 = 零请求、零体积；加载失败 = 静默回退并标注，不影响控制室其他功能。 */
const L2D_CDN = 'https://cdn.jsdelivr.net/npm/l2d@2.1.1/dist/index.min.js'
type PetStatus = 'loading' | 'ready' | 'failed'
/** 极简指针事件结构类型（本文件只具名导入 react，不引 React 命名空间） */
type PetPointer = { button: number; clientX: number; clientY: number; pointerId: number; currentTarget: EventTarget & HTMLElement }
let l2dPending: Promise<any> | null = null
function loadL2D(): Promise<any> {
  const w = window as any
  if (w.L2D && typeof w.L2D.init === 'function') return Promise.resolve(w.L2D)
  if (l2dPending) return l2dPending
  l2dPending = new Promise<any>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = L2D_CDN
    s.async = true
    s.onload = () => {
      const L2D = (window as any).L2D
      if (L2D && typeof L2D.init === 'function') resolve(L2D)
      else reject(new Error('L2D global missing'))
    }
    s.onerror = () => reject(new Error('L2D script load failed'))
    document.head.appendChild(s)
  })
  l2dPending.catch(() => { l2dPending = null })
  return l2dPending
}

/** 看板娘：控制室右下角的 Live2D 挂件。
 *  休眠 = 默认半透明且不吃指针事件（不干扰卡片网格），悬停唤醒；按住可拖动，偏移持久化。
 *  位置基准 = 窗格右下角的内边距（px），拖动时按指针位移反向推算。 */
function ConsolePet(props: {
  model: number
  pos: { x: number; y: number }
  pane: { current: HTMLDivElement | null }
  onStatus: (s: PetStatus) => void
  onMove: (p: { x: number; y: number }) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const instRef = useRef<any>(null)
  const [status, setStatus] = useState<PetStatus>('loading')
  const [live, setLive] = useState<{ x: number; y: number } | null>(null)
  const liveRef = useRef<{ x: number; y: number } | null>(null)
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)
  const posRef = useRef(props.pos)
  posRef.current = props.pos
  const statusRef = useRef(props.onStatus)
  statusRef.current = props.onStatus

  useEffect(() => {
    let dead = false
    const put = (s: PetStatus) => { if (!dead) { setStatus(s); statusRef.current(s) } }
    put('loading')
    loadL2D()
      .then((L2D) => {
        if (dead || !canvasRef.current) return
        const inst = L2D.init(canvasRef.current)
        instRef.current = inst
        const url = PET_MODELS[props.model]?.url ?? PET_MODELS[0].url
        return Promise.resolve(inst.load({ path: url, scale: 1, volume: 0, logLevel: 'error' }))
          .then(() => { put('ready') })
          .catch(() => { put('failed') })
      })
      .catch(() => { put('failed') })
    return () => {
      dead = true
      try { instRef.current?.destroy?.() } catch {}
      instRef.current = null
    }
  }, [props.model])

  const p = live ?? props.pos
  const onDown = (e: PetPointer) => {
    if (e.button !== 0) return
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: p.x, oy: p.y }
    const v = { x: p.x, y: p.y }
    liveRef.current = v
    setLive(v)
  }
  const onDrag = (e: PetPointer) => {
    const d = dragRef.current
    if (!d) return
    const maxX = Math.max(0, (props.pane.current?.clientWidth ?? 600) - 60)
    const maxY = Math.max(0, (props.pane.current?.clientHeight ?? 400) - 60)
    const next = {
      x: Math.min(maxX, Math.max(0, d.ox - (e.clientX - d.sx))),
      y: Math.min(maxY, Math.max(0, d.oy - (e.clientY - d.sy))),
    }
    liveRef.current = next
    setLive(next)
  }
  const onUp = () => {
    if (!dragRef.current) return
    dragRef.current = null
    const v = liveRef.current ?? posRef.current
    liveRef.current = null
    setLive(null)
    try { props.onMove(v) } catch {}
  }

  return (
    <div
      className={'dsh-wt_pet' + (live ? ' dsh-wt_petDrag' : '')}
      data-pet={status}
      style={{ right: p.x + 'px', bottom: p.y + 'px' }}
      title={status === 'failed' ? T('console.petFailed') : undefined}
      onPointerDown={onDown}
      onPointerMove={onDrag}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <canvas ref={canvasRef} className="dsh-wt_petCanvas" width={280} height={360} />
    </div>
  )
}

/** 忙碌特效：绑定会话 busy 期间在控制室整页铺「流光炫彩 + 花蝴蝶」；提问瞬间（idle→busy 跳变）
 *  追加一圈彩色脉冲 + 全页闪光。纯装饰层：absolute inset-0、z-index 1、pointer-events:none，
 *  位于背景层之上、卡片/浮层之下；忙完淡出 1.4s 后卸载；prefers-reduced-motion 直接不渲染。 */
type FxBfly = {
  k: number
  a: string; b: string; c: string; d: string; e: string; f: string
  t1: string; t2: string; t3: string; t4: string
  dur: string; delay: string; flap: string; sway: string; size: string; hue: string
  sr1: string; sr2: string; sy1: string; sy2: string; op: string
}
/** 梵高六色蝶翼（铭黄/天蓝/翠绿/朱红/淡紫/群青） */
const BFLY_HUES = [50, 200, 140, 8, 270, 225]
function makeFxBflies(): FxBfly[] {
  const out: FxBfly[] = []
  const N = 55
  for (let i = 0; i < N; i++) {
    // 美学：纵向等距错峰 + 双向航道（一半左→右、一半右→左）+ 前/中/后景分层（诗意层次）
    const x0 = 6 + ((i * 7) % 7)
    const lane = 10 + Math.round((i / (N - 1)) * 76)
    const l2 = 16 + ((i * 23) % 30)
    const l3 = l2 + 22 + ((i * 7) % 10)
    const l4 = l3 + 19 + ((i * 5) % 9)
    const e4 = l4 + 16 + ((i * 7) % 8)
    const fin = 112 + ((i % 3) * 3)
    const y = Math.min(86, Math.max(8, lane + ((i % 2 === 0 ? -1 : 1) * ((i * 5) % 9))))
    const y2 = Math.min(88, y + 6 + ((i * 11) % 9))
    const y3 = Math.max(5, y - 8 - ((i * 13) % 7))
    const y4 = Math.min(90, y2 + 5 + ((i * 9) % 10))
    const rev = i % 2 === 1
    // 层次：zz 0 近景 / 1 中景 / 2 远景（近=大亮快，远=小暗慢）
    const zz = (i * 7) % 3
    const size = zz === 0 ? 20 + ((i * 7) % 10) : zz === 1 ? 14 + ((i * 5) % 8) : 10 + ((i * 3) % 6)
    const op = zz === 0 ? 0.96 : zz === 1 ? 0.72 : 0.5
    const dur = zz === 0 ? 10 + ((i * 7) % 6) : zz === 1 ? 15 + ((i * 5) % 7) : 21 + ((i * 7) % 9)
    // 姿态：每只绕自身中轴的不同角度起伏（诗意翩跹）
    const rot = -16 + ((i * 9) % 32)
    const amp = 9 + ((i * 5) % 12)
    out.push({
      k: i,
      a: (rev ? fin : -x0) + '%', b: (rev ? e4 : l2) + '%', c: (rev ? l3 : l3) + '%',
      d: (rev ? l2 : l4) + '%', e: (rev ? x0 : e4) + '%', f: (rev ? -9 : fin) + '%',
      t1: y + '%', t2: y2 + '%', t3: y3 + '%', t4: y4 + '%',
      dur: dur + 's',
      delay: '-' + (0.5 + i * (30.5 / (N - 1))).toFixed(1) + 's',
      flap: (0.26 + ((i % 5) * 0.07)).toFixed(2) + 's',
      sway: (3.2 + ((i % 5) * 0.6)).toFixed(2) + 's',
      size: size + 'px',
      hue: String(BFLY_HUES[i % 6]),
      sr1: (rot - amp) + 'deg', sr2: (rot + amp) + 'deg',
      sy1: '-' + (5 + ((i * 3) % 9)) + 'px', sy2: (5 + ((i * 4) % 9)) + 'px',
      op: String(op),
    })
  }
  return out
}
const FX_BFLIES = makeFxBflies()

/** 漂浮光尘（仙境光点）：随机慢速上升 + 闪烁，深色下像萤火虫/星光 */
type FxMote = {
  k: number
  l: string; t: string; m: string; rise: string; mx: string
  hue: string; dur: string; delay: string
}
function makeFxMotes(): FxMote[] {
  const out: FxMote[] = []
  for (let i = 0; i < 18; i++) {
    out.push({
      k: i,
      l: (3 + ((i * 37) % 94)) + '%',
      t: (18 + ((i * 53) % 76)) + '%',
      m: (2 + ((i * 3) % 4)) + 'px',
      rise: (110 + ((i * 41) % 340)) + 'px',
      mx: (((i * 29) % 90) - 45) + 'px',
      hue: String(Math.round(i * 137.5 + 40) % 360),
      dur: (6 + ((i * 7) % 9)) + 's',
      delay: '-' + ((i * 1.7) % 9).toFixed(1) + 's',
    })
  }
  return out
}
const FX_MOTES = makeFxMotes()

/** 「操控电脑」快捷动作：把固定指令发到控制室绑定会话（AI 执行，系统级操作仍走宿主授权） */
const REMOTE_ACTIONS: { k: string; icon: string; label: string; text: string }[] = [
  { k: 'sys', icon: '📊', label: '系统状态总览', text: '查看本机 CPU、内存、磁盘占用与主要进程，简短汇总给我。' },
  { k: 'shot', icon: '📸', label: '截屏当前屏幕', text: '截取当前电脑屏幕并简单描述画面内容。' },
  { k: 'app', icon: '🖥️', label: '打开记事本', text: '在电脑上打开「记事本」应用。' },
  { k: 'taskmgr', icon: '📋', label: '打开任务管理器', text: '打开电脑的任务管理器（任务管理器）。' },
  { k: 'fm', icon: '📂', label: '打开文件资源管理器', text: '打开电脑的文件资源管理器窗口。' },
  { k: 'lock', icon: '🔒', label: '锁定电脑', text: '锁定当前电脑（Win+L，需宿主授权后执行）。' },
  { k: 'volu', icon: '🔊', label: '音量加', text: '把电脑系统音量调大一级。' },
  { k: 'vold', icon: '🔉', label: '音量减', text: '把电脑系统音量调小一级。' },
  { k: 'mute', icon: '🔇', label: '静音切换', text: '切换电脑的静音状态。' },
]

/** 特效偏好（localStorage 持久化 + 订阅；控制室 dock ✨ 面板调整）
 *  wall：壁纸档（0 关 / 1 壁纸1=梵高星夜厚涂完整版 / 2 视频壁纸=外部素材）
 *  holoSrc：视频壁纸档的素材地址（/api/worktable/media/<名>、http(s) 或 data:）
 *  wallStyle：视频壁纸的处理风格（native 原画=不调色 / glass 玻璃质感 / holo 全息）
 *  wallAlpha：壁纸浓度%（0=隐藏，默认 100=原样；壁纸在 UI 之下，满浓度也不会挡 UI）
 *  wallBlur：壁纸磨砂 px（默认 0 = 原画最清晰；调大才是玻璃雾面）
 *  glassOn / glassAlpha：玻璃 UI 开关 + UI 透明度%（面板底色 alpha = 1 - glassAlpha/100，上限 GLASS_ALPHA_MAX）
 *  allIdle：全部静息动效总开关（默认 true）。关掉 = 一次停掉所有「待机时还在动」的装饰：
 *    静息层（藤蔓/星系/星尘/蝴蝶）+ 控制室星云 CosmicField + 流光背景光晕动画 + 玻璃浮动/焦散。
 *    只关静息、不碰壁纸与忙碌特效：壁纸照常播放，忙碌特效继续按 busyOn 走。
 *    实现分两处：① React 挂载门（静息层 / CosmicField 不挂 = 不逐帧重绘）
 *              ② <html data-wt-still=on> 上的 CSS 规则（纯 CSS 动画的光晕/玻璃板停帧）
 *  wallV：形态版本（v3 = 壁纸在 UI 之下 + 玻璃 UI；老配置靠它一次性迁移） */
type FxConf = { allIdle: boolean; idleOn: boolean; busyOn: boolean; idleLevel: number; bfly: number; pal: number; wall: number; holoSrc: string; wallStyle: 'glass' | 'holo' | 'native'; wallAlpha: number; wallBlur: number; wallGrade: number; glassOn: boolean; glassAlpha: number; wallV: number }
const FX_CONF_KEY = 'dsh.worktable.fx.v1'
/** 壁纸档位白名单（新增档位必须同时改这里、面板按钮组与 FxOverlay 分支） */
const WALL_LEVELS = [0, 1, 2]
/** 壁纸浓度上限%：壁纸画在 UI 之下（z-index:-1），满浓度也不会挡 UI，故上限 100。 */
const WALL_ALPHA_MAX = 100
/** 壁纸磨砂上限 px（0 = 原画最清晰；数值越大越雾面）。 */
const WALL_BLUR_MAX = 24
/** UI 透明度上限%（玻璃 UI）：越高面板底色越透，上限 95 留一线最低承托防文字彻底浮空。 */
const GLASS_ALPHA_MAX = 95
/** 形态版本：v1 不透明盖板（盖死整个 UI）/ v2 全屏透明叠加 / v3 壁纸在 UI 之下 + 玻璃 UI /
 *  v4（2026-09-14 用户定案「整个 DSH 界面全透明」）：玻璃 UI 覆盖全部底色 token（含弹层/菜单/
 *  气泡/输入框）+ 默认 UI 透明度 80。老配置靠 wallV 迁移直接拿到新默认。 */
const WALL_VIEW_V = 4
/** 视频壁纸默认素材：由插件媒体路由下发 <DSH_HOME>/worktable-media/wall-1080.mp4；
 *  该文件不存在时优雅退化为全息/玻璃占位，不报错、不白屏。 */
const WALL_MEDIA_DEFAULT = '/api/worktable/media/wall-1080.mp4'
/** 流畅档素材（1572×882 = 内容原生像素、无黑边）：像素只有清晰档的 1/2.7，用来解卡顿。 */
const WALL_MEDIA_SMOOTH = '/api/worktable/media/wall-smooth.mp4'
/** 极速档素材（1280×718，无黑边）：像素再砍一半，弱机/省电用。 */
const WALL_MEDIA_LITE = '/api/worktable/media/wall-720.mp4'
const DEFAULT_FX_CONF: FxConf = { allIdle: true, idleOn: true, busyOn: true, idleLevel: 1, bfly: 40, pal: 5, wall: 2, holoSrc: WALL_MEDIA_DEFAULT, wallStyle: 'native', wallAlpha: 100, wallBlur: 0, wallGrade: 0, glassOn: true, glassAlpha: 80, wallV: WALL_VIEW_V }
/** 调色档（客户端 CSS 滤镜，不改素材）：0 原画（默认）/ 1 暖调 / 2 提亮暖调。
 *  配色取自 2026-09-14 那版 ffmpeg 调色（eq 亮度+0.030·gamma1.10+饱和1.03 + colorbalance 暖调）：
 *  eq 的 gamma/亮度用 CSS filter 的 brightness/contrast 近似，暖调用 sepia+saturate 近似，
 *  是「观感接近」而不是逐像素等价 —— 要逐像素等价就用 make-wall-0914-glow.ps1 出调色档素材。 */
const WALL_GRADES: { v: number; l: string; f: string }[] = [
  { v: 0, l: '原画', f: '' },
  { v: 1, l: '暖调', f: 'saturate(1.04) sepia(.10)' },
  { v: 2, l: '提亮暖调', f: 'brightness(1.06) contrast(1.015) saturate(1.06) sepia(.18)' },
]
function wallGradeFilter(g: number): string { return (WALL_GRADES[g] ?? WALL_GRADES[0]).f }
let fxConfCache: FxConf = DEFAULT_FX_CONF
const fxConfListeners = new Set<() => void>()
function loadFxConf(): FxConf {
  try {
    const raw = localStorage.getItem(FX_CONF_KEY)
    if (raw) {
      const o = JSON.parse(raw)
      // 一次性迁移到 v4 形态：老配置直接落到「UI 透明度 80 + 玻璃 UI 覆盖全部底色 token」，
      // 用户不用手点就能拿到「整个 DSH 界面全透明」的新默认（墙纸/风格/浓度沿用既有保存值）。
      const migrate = o.wallV !== WALL_VIEW_V
      const next: FxConf = {
        wallV: WALL_VIEW_V,
        allIdle: o.allIdle !== false,
        idleOn: o.idleOn !== false,
        busyOn: o.busyOn !== false,
        idleLevel: o.idleLevel === 0 || o.idleLevel === 2 ? o.idleLevel : 1,
        bfly: [12, 16, 20].includes(o.bfly) ? 40 : [0, 8, 24, 28, 40, 55].includes(o.bfly) ? o.bfly : 40,
        pal: [0, 1, 2, 3, 4, 5].includes(o.pal) ? o.pal : 5,
        wall: migrate ? 2 : WALL_LEVELS.includes(o.wall) ? o.wall : 2,
        holoSrc: typeof o.holoSrc === 'string' && o.holoSrc.trim() ? o.holoSrc : WALL_MEDIA_DEFAULT,
        wallStyle: migrate ? 'native' : o.wallStyle === 'holo' ? 'holo' : o.wallStyle === 'native' ? 'native' : 'glass',
        wallAlpha: migrate ? WALL_ALPHA_MAX : typeof o.wallAlpha === 'number' && o.wallAlpha >= 0 ? Math.min(WALL_ALPHA_MAX, Math.round(o.wallAlpha)) : WALL_ALPHA_MAX,
        wallBlur: typeof o.wallBlur === 'number' && o.wallBlur >= 0 ? Math.min(WALL_BLUR_MAX, Math.round(o.wallBlur)) : 0,
        wallGrade: [0, 1, 2].includes(o.wallGrade) ? o.wallGrade : 0,
        glassOn: migrate ? true : o.glassOn !== false,
        glassAlpha: migrate ? 80 : typeof o.glassAlpha === 'number' && o.glassAlpha >= 0 ? Math.min(GLASS_ALPHA_MAX, Math.round(o.glassAlpha)) : 80,
      }
      if (migrate) { try { localStorage.setItem(FX_CONF_KEY, JSON.stringify(next)) } catch {} }
      return next
    }
  } catch {}
  return { ...DEFAULT_FX_CONF }
}
fxConfCache = loadFxConf()
export function getFxConf(): FxConf { return fxConfCache }
function persistFxConf(patch: Partial<FxConf>) {
  fxConfCache = { ...fxConfCache, ...patch }
  try { localStorage.setItem(FX_CONF_KEY, JSON.stringify(fxConfCache)) } catch {}
  fxConfListeners.forEach((l) => { try { l() } catch {} })
}
export function subscribeFxConf(fn: () => void): () => void { fxConfListeners.add(fn); return () => { fxConfListeners.delete(fn) } }
/** 忙碌蝴蝶只数上限（0 = 关闭忙碌蝴蝶层内容由 busyOn 控制） */
function bflySliceCount(): number { return fxConfCache.bfly }
/** 四套特效色系（0 星空紫金 / 1 月白银蓝 / 2 霞光暖金 / 3 鸢尾暮光） */
const PAL_BUSY: string[][][] = [
  [
    ['242,226,200', '206,224,238', '232,214,238'],
    ['218,196,164', '182,206,228', '222,202,234'],
    ['232,222,210', '196,216,210', '232,198,222'],
    ['238,232,220', '210,218,240', '242,222,232'],
  ],
  [
    ['244,240,246', '206,220,240', '226,234,246'],
    ['232,234,242', '188,206,232', '214,224,240'],
    ['238,238,242', '196,212,236', '226,230,242'],
    ['242,240,248', '210,218,240', '232,236,246'],
  ],
  [
    ['250,236,214', '246,214,166', '240,196,150'],
    ['252,226,200', '250,206,176', '246,188,168'],
    ['250,240,222', '248,214,184', '244,196,158'],
    ['252,232,208', '246,220,182', '238,200,150'],
  ],
  [
    ['232,220,246', '168,196,244', '244,206,224'],
    ['244,226,200', '246,214,166', '240,196,150'],
    ['204,238,236', '168,224,232', '188,214,240'],
    ['240,212,242', '226,190,238', '200,180,236'],
  ],
  [
    ['236,230,214', '180,206,196', '244,214,170'],
    ['218,232,226', '160,200,190', '240,206,166'],
    ['228,222,210', '176,206,206', '236,216,178'],
    ['240,232,220', '184,212,200', '246,220,180'],
  ],
  [
    ['242,193,78', '100,160,220', '186,150,228'],
    ['38,62,150', '56,150,116', '224,86,64'],
    ['224,86,64', '242,193,78', '100,160,220'],
    ['56,150,116', '186,150,228', '38,62,150'],
  ],
]
function fxPalIdx(): number { return Math.min(5, Math.max(0, fxConfCache.pal)) }


function moteStyle(m: FxMote): any {
  return {
    '--fx-l': m.l, '--fx-t': m.t, '--fx-m': m.m, '--fx-rise': m.rise, '--fx-mx': m.mx,
    '--fx-hue': m.hue, '--fx-dur': m.dur, '--fx-delay': m.delay,
  }
}

/** 静息「流动星空」：左侧竖向星流 + 右下角斜向星流（两颗星参数：位置/漂移/时长/大小/色相） */
type IdleStar = {
  k: number
  sx: string; sy: string; sdx: string; sdy: string
  sm: string; sdur: string; sdel: string; hue: string
}
function makeIdleStars(count: number, dir: 'down' | 'upLeft' | 'still'): IdleStar[] {
  const out: IdleStar[] = []
  for (let i = 0; i < count; i++) {
    const down = dir === 'down'
    const still = dir === 'still'
    out.push({
      k: i,
      sx: (4 + ((i * 37) % 90)).toFixed(1) + '%',
      sy: (2 + ((i * 53) % 92)).toFixed(1) + '%',
      sdx: (still ? ((i * 31) % 44) - 22 : down ? ((i * 17) % 60) - 30 : -((150 + ((i * 41) % 170)))) + 'px',
      sdy: (still ? ((i * 23) % 26) - 13 : down ? 130 + ((i * 43) % 150) : -((50 + ((i * 29) % 130)))) + 'px',
      sm: (still ? 1 + ((i * 5) % 12) / 10 : 1.6 + ((i * 7) % 22) / 10).toFixed(1) + 'px',
      sdur: (still ? 3.2 + ((i * 11) % 40) / 10 : down ? 6 + ((i * 7) % 8) : 8 + ((i * 5) % 9)) + 's',
      sdel: '-' + ((i * 2.3) % (still ? 7 : down ? 11 : 13)).toFixed(1) + 's',
      hue: String(Math.round((i * 47 + 200) % 360)),
    })
  }
  return out
}
const IDLE_LEFT_STARS = makeIdleStars(18, 'down')
const IDLE_RIGHT_STARS = makeIdleStars(22, 'upLeft')
/** 全屏撒星：极淡的原地点闪星尘（只增氛围，不抢阅读区） */
const IDLE_DUST_STARS = makeIdleStars(26, 'still')

/** 静息慢飞蝴蝶：极慢、偏小、低饱和，营造「偶尔有蝶轻轻飞过」的静好氛围 */
function makeIdleBflies(): FxBfly[] {
  const out: FxBfly[] = []
  const N = 20
  for (let i = 0; i < N; i++) {
    const y = 14 + Math.round((i / (N - 1)) * 66)
    const b1 = (20 + ((i * 21) % 26)) + '%'
    const b2 = (52 + ((i * 13) % 18)) + '%'
    const b3 = (84 + ((i * 7) % 10)) + '%'
    const rev = i % 2 === 1
    const zz = i % 3
    const rot = -12 + ((i * 9) % 24)
    const amp = 7 + ((i * 5) % 10)
    out.push({
      k: i,
      a: (rev ? '120%' : '-9%'), b: (rev ? b3 : b1), c: (rev ? b2 : b2), d: (rev ? b1 : b3), e: (rev ? '-6%' : '112%'), f: (rev ? '-9%' : '120%'),
      t1: y + '%', t2: Math.min(88, y + 9 + ((i * 9) % 8)) + '%', t3: Math.max(6, y - 7 - ((i * 11) % 6)) + '%', t4: Math.min(90, y + 14 + ((i * 5) % 10)) + '%',
      dur: (30 + ((i * 9) % 12)) + 's',
      delay: '-' + (1 + i * (28 / (N - 1))).toFixed(1) + 's',
      flap: (1.05 + ((i % 3) * 0.16)).toFixed(2) + 's',
      sway: (5.5 + ((i % 4) * 1.3)).toFixed(1) + 's',
      size: (zz === 0 ? 15 : zz === 1 ? 12 : 9) + 'px',
      hue: String(BFLY_HUES[(i + 2) % 6]),
      sr1: (rot - amp) + 'deg', sr2: (rot + amp) + 'deg',
      sy1: '-' + (4 + ((i * 3) % 7)) + 'px', sy2: (4 + ((i * 4) % 7)) + 'px',
      op: String(zz === 0 ? 0.9 : zz === 1 ? 0.66 : 0.45),
    })
  }
  return out
}
const IDLE_BFLIES = makeIdleBflies()

/** 忙碌星系团：三团星云「向我靠近并放大」（起点/位移/大小/时长/错相） */
type FxGal = { k: string; left: string; top: string; size: string; x: string; y: string; dur: string; del: string; cls: string }
const FX_GALS: FxGal[] = [
  { k: 'a', left: '2%', top: '2%', size: '72vmin', x: '-9vw', y: '-2vh', dur: '8.6s', del: '-1.1s', cls: 'dsh-wt_fxGalBg1' },
  { k: 'b', left: '46%', top: '24%', size: '70vmin', x: '7vw', y: '14vh', dur: '10.2s', del: '-3.8s', cls: 'dsh-wt_fxGalBg2' },
  { k: 'c', left: '22%', top: '-16%', size: '78vmin', x: '-2vw', y: '24vh', dur: '9.4s', del: '-6.4s', cls: 'dsh-wt_fxGalBg3' },
]
function galStyle(g: FxGal): any {
  return { left: g.left, top: g.top, width: g.size, height: g.size, '--ggx': g.x, '--ggy': g.y, '--ggdur': g.dur, '--ggdel': g.del }
}

/** 忙碌「互旋星轨」：多组星流/星群以不同中心、不同倾角、不同转速互相旋转（克制唯美版） */
type SwirlDot = { a: number; rp: number; s: number; tw: number; dl: number; b: number }
type Swirl = {
  k: number; cx: string; cy: string; size: number
  tilt: number; tz: number; spin: number; rev: boolean; hue: number
  dots: SwirlDot[]
}
function makeSwirls(): Swirl[] {
  const defs: { cx: string; cy: string; size: number; tilt: number; tz: number; spin: number; rev: boolean; hue: number }[] = [
    { cx: '18%', cy: '24%', size: 300, tilt: 68, tz: 18, spin: 26, rev: false, hue: 205 },
    { cx: '72%', cy: '20%', size: 280, tilt: 74, tz: -24, spin: 34, rev: true, hue: 300 },
    { cx: '52%', cy: '68%', size: 320, tilt: 70, tz: 6, spin: 41, rev: false, hue: 42 },
    { cx: '84%', cy: '74%', size: 240, tilt: 62, tz: 40, spin: 30, rev: true, hue: 175 },
    { cx: '26%', cy: '78%', size: 260, tilt: 66, tz: -32, spin: 46, rev: false, hue: 260 },
  ]
  return defs.map((d, k) => {
    const n = 14 + ((k * 3) % 6)
    const dots: SwirlDot[] = []
    for (let i = 0; i < n; i++) {
      dots.push({
        a: (360 / n) * i + ((k * 17) % 24),
        rp: Math.round(d.size * 0.34 * (0.92 + Math.random() * 0.22)),
        s: 1.4 + Math.random() * 1.9,
        tw: 1.6 + Math.random() * 2.2,
        dl: -(Math.random() * 2),
        b: Math.random() < 0.3 ? 1 : 0,
      })
    }
    return { k, ...d, dots }
  })
}
const FX_SWIRLS = makeSwirls()

function idleStarStyle(s: IdleStar): any {
  return {
    '--sx': s.sx, '--sy': s.sy, '--sdx': s.sdx, '--sdy': s.sdy,
    '--sm': s.sm, '--sdur': s.sdur, '--sdel': s.sdel, '--shue': s.hue,
  }
}

/** 蝴蝶/光尾共用航线参数 → inline style（可用 over 叠加快照参数，让光尾滞后于蝴蝶本体） */
function flyStyle(b: FxBfly, over: Record<string, string> = {}): any {
  return {
    '--fx-a': b.a, '--fx-b': b.b, '--fx-c': b.c, '--fx-d': b.d, '--fx-e': b.e, '--fx-f': b.f,
    '--fx-t1': b.t1, '--fx-t2': b.t2, '--fx-t3': b.t3, '--fx-t4': b.t4,
    '--fx-dur': b.dur, '--fx-delay': b.delay, '--fx-flap': b.flap, '--fx-sway': b.sway,
    '--fx-size': b.size, '--fx-hue': b.hue,
    '--fx-sr1': b.sr1, '--fx-sr2': b.sr2, '--fx-sy1': b.sy1, '--fx-sy2': b.sy2,
    opacity: b.op,
    ...over,
  }
}

/** 全局特效层（覆盖整个 DeepSeek Harness 界面）：常驻「静息」柔光仙境 + 忙碌时「炸裂」蝴蝶流光。
 *  busy 由 WorktableSection 计算传入（任一卡片 busy 或当前宿主会话 running）。 */
export function FxOverlay({ busy }: { busy: boolean }) {
  const [conf, setConf] = useState<FxConf>(getFxConf)
  useEffect(() => subscribeFxConf(() => setConf(getFxConf())), [])
  const [fxShow, setFxShow] = useState(false)
  const [fxOn, setFxOn] = useState(false)
  const [fxPulse, setFxPulse] = useState(0)
  const prevBusy = useRef(false)
  useEffect(() => {
    const prev = prevBusy.current
    const active = busy && conf.busyOn
    prevBusy.current = active
    if (active) {
      setFxShow(true)
      if (!prev) setFxPulse((n) => n + 1)
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setFxOn(true)))
      return () => cancelAnimationFrame(raf)
    }
    setFxOn(false)
    const t = window.setTimeout(() => setFxShow(false), 2200)
    return () => window.clearTimeout(t)
  }, [busy, conf.busyOn])
  const idleOpacity = conf.idleLevel === 0 ? 0.38 : conf.idleLevel === 2 ? 1 : 0.72
  return (
    <>
      {/* 壁纸层：.dsh-wt_gFx 是 z-index:-1 的固定层 → 画在全部 UI 之下（结构性保证：它不可能遮住任何 UI）。
          满彩显示靠「玻璃 UI」配合（把宿主面板底色放开 + 壁纸磨砂）；--wt-wallAlpha = 壁纸浓度（0=隐藏，默认 100）。 */}
      <div className="dsh-wt_gFx" data-wt-pal={conf.pal} data-wt-wall={conf.wall} style={{ ['--wt-wallAlpha' as any]: String(conf.wallAlpha / 100) }} aria-hidden>
        {conf.wall > 0 && (
          <div className="dsh-wt_wallLayer" data-wall={conf.wall} style={conf.wallBlur > 0 ? { filter: 'blur(' + conf.wallBlur + 'px) saturate(1.04)' } : undefined}>
            {conf.wall === 2 ? <HoloWall src={conf.holoSrc} style={conf.wallStyle} grade={conf.wallGrade} /> : <StarrySky />}
          </div>
        )}
        {/* 左上角装饰：一组 1px 半透明细角标（范围 84×84，全透明，不遮挡任何画面内容）。
            素材左上角那块烧录遮盖按用户定案**不做任何修补**，这里只是把那个角「框」成有意为之的装饰；
            位置固定在左上角、位于壁纸层内（z-index:-1），不会盖到 UI。 */}
        {conf.wall > 0 && <i className="dsh-wt_wallCorner" aria-hidden />}
      </div>
      {/* 装饰层：.dsh-wt_gFxTop 仍是 z-index:55（在 UI 之上），但只画静息/忙碌特效，不铺任何底色。 */}
      <div className="dsh-wt_gFxTop" data-wt-pal={conf.pal} data-wt-wall={conf.wall} aria-hidden>
      {/* 静息装饰层：受「静息特效」与「全部静息动效」两道闸门控制（总开关关掉 = 整层不挂载） */}
      {conf.allIdle && conf.idleOn && (
        <div className={'dsh-wt_fxIdle' + (fxOn ? ' dsh-wt_fxIdleDim' : '')} style={{ opacity: idleOpacity }}>
          {/* 细藤盘旋（开心消消乐式柔化版：极细藤丝铺满屏幕） */}
          <Vines mode="idle" />
          {/* 星系 / 星团 / 星云层 */}
          <i className="dsh-wt_idleGal dsh-wt_idleGalL" />
          <i className="dsh-wt_idleGal dsh-wt_idleGalR" />
          <div className="dsh-wt_idleDust">
            {IDLE_DUST_STARS.map((s) => (
              <i key={'ds' + s.k} className="dsh-wt_idleStar" style={idleStarStyle(s)} />
            ))}
          </div>
          {/* 静息慢飞蝴蝶 */}
          <div className="dsh-wt_idleBflies">
            {IDLE_BFLIES.map((b) => (
              <span key={'ib' + b.k} className="dsh-wt_fxBfly dsh-wt_fxBflyIdle" style={flyStyle(b)}>
                <i className="dsh-wt_fxBflyWing dsh-wt_fxBflyWingL" />
                <i className="dsh-wt_fxBflyWing dsh-wt_fxBflyWingR" />
                <i className="dsh-wt_fxBflyBody" />
              </span>
            ))}
          </div>
          {/* 左侧竖向星流 + 右下角斜向星流 */}
          <div className="dsh-wt_idleZone dsh-wt_idleZoneL">
            {IDLE_LEFT_STARS.map((s) => (
              <i key={'ls' + s.k} className="dsh-wt_idleStar" style={idleStarStyle(s)} />
            ))}
          </div>
          <div className="dsh-wt_idleZone dsh-wt_idleZoneR">
            {IDLE_RIGHT_STARS.map((s) => (
              <i key={'rs' + s.k} className="dsh-wt_idleStar" style={idleStarStyle(s)} />
            ))}
          </div>
        </div>
      )}
      {/* 忙碌特效：互旋星群 + 蝴蝶 + 提问脉冲（布满整屏；可关/可选蝴蝶数） */}
      {fxShow && (() => {
        const bs = FX_BFLIES.slice(0, bflySliceCount())
        return (
        <div className={'dsh-wt_fx' + (fxOn ? ' dsh-wt_fxOn' : '')}>
          <BusyCosmos />
          {fxPulse > 0 && <span key={fxPulse} className="dsh-wt_fxPulseBox"><i className="dsh-wt_fxPulse" /><i className="dsh-wt_fxFlash" /></span>}
          {bs.map((b) => (
            <span key={'bf' + b.k} className="dsh-wt_fxBfly" style={flyStyle(b)}>
              <i className="dsh-wt_fxBflyWing dsh-wt_fxBflyWingL" />
              <i className="dsh-wt_fxBflyWing dsh-wt_fxBflyWingR" />
              <i className="dsh-wt_fxBflyBody" />
            </span>
          ))}
          {bs.map((b) => (
            <Fragment key={'gh' + b.k}>
              <i className="dsh-wt_fxBflyGhost dsh-wt_fxBflyGhost1" style={flyStyle(b, { '--fx-delay': (parseFloat(b.delay) + 0.5).toFixed(2) + 's', '--fx-size': Math.max(9, Math.round(parseFloat(b.size) * 0.68)) + 'px', opacity: '0.34' })} />
              <i className="dsh-wt_fxBflyGhost dsh-wt_fxBflyGhost2" style={flyStyle(b, { '--fx-delay': (parseFloat(b.delay) + 1).toFixed(2) + 's', '--fx-size': Math.max(6, Math.round(parseFloat(b.size) * 0.42)) + 'px', opacity: '0.16' })} />
            </Fragment>
          ))}
          <div className="dsh-wt_fxMotes">
            {FX_MOTES.map((m) => (
              <i key={'mote' + m.k} className="dsh-wt_fxMote" style={moteStyle(m)} />
            ))}
          </div>
          </div>
        )
      })()}
      </div>
    </>
  )
}

/** 细藤盘绕（开心消消乐式主页藤蔓的柔化版）：极细藤丝 + 间隔细叶 + 发光节点，缓慢摇摆。
 *  共享几何：drawVines(ctx,…) 供静息全局层与忙碌星群画布复用；Vines 组件管理全屏 canvas。 */
const VINE_SETS: { x: number; y: number }[][] = [
  [{ x: -0.06, y: 0.5 }, { x: 0.12, y: 0.3 }, { x: 0.34, y: 0.45 }, { x: 0.56, y: 0.22 }, { x: 0.8, y: 0.4 }, { x: 1.04, y: 0.64 }],
  [{ x: 0.14, y: 1.06 }, { x: 0.3, y: 0.82 }, { x: 0.52, y: 0.92 }, { x: 0.72, y: 0.7 }, { x: 0.6, y: 0.46 }],
  [{ x: 0.96, y: 0.0 }, { x: 0.84, y: 0.16 }, { x: 0.91, y: 0.36 }, { x: 0.74, y: 0.32 }, { x: 0.82, y: 0.14 }],
]
function catmull(p0: { x: number; y: number }, p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }, t: number) {
  const t2 = t * t
  const t3 = t2 * t
  return {
    x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  }
}
/** 绘制一组细藤；mode: 'idle' 柔 / 'busy' 亮。每条藤含细叶与流光节点（恢复原始中性配色） */
function drawVines(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, mode: 'idle' | 'busy') {
  const stem = mode === 'idle' ? 'rgba(216,222,240,' : 'rgba(246,234,214,'
  const leaf = mode === 'idle' ? 'rgba(196,212,200,' : 'rgba(214,236,196,'
  const leaf2 = mode === 'idle' ? 'rgba(214,196,176,' : 'rgba(240,206,168,'
  const glowA = mode === 'idle' ? 0.1 : 0.3
  for (let v = 0; v < VINE_SETS.length; v++) {
    const src = VINE_SETS[v]
    // 慢摇（相位错开）
    const pts = src.map((p, i) => ({
      x: p.x * W + Math.sin(t * 0.12 + v * 2 + i) * 14,
      y: p.y * H + Math.cos(t * 0.09 + v + i * 0.7) * 10,
    }))
    const N = 150
    const segs: { x: number; y: number }[] = []
    const step = 1 / (N / (pts.length - 1))
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)]
      const p1 = pts[i]
      const p2 = pts[i + 1]
      const p3 = pts[Math.min(pts.length - 1, i + 2)]
      for (let s = 0; s < 1; s += step) segs.push(catmull(p0, p1, p2, p3, s))
    }
    if (segs.length < 2) continue
    // 藤干：宽柔底 + 细芯（超细盘旋）
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = stem + '0.12)'
    ctx.lineWidth = mode === 'idle' ? 5 : 7
    ctx.beginPath()
    ctx.moveTo(segs[0].x, segs[0].y)
    for (let i = 1; i < segs.length; i++) ctx.lineTo(segs[i].x, segs[i].y)
    ctx.stroke()
    ctx.strokeStyle = stem + (mode === 'idle' ? '0.5' : '0.75') + ')'
    ctx.lineWidth = mode === 'idle' ? 1.1 : 1.8
    ctx.beginPath()
    ctx.moveTo(segs[0].x, segs[0].y)
    for (let i = 1; i < segs.length; i++) ctx.lineTo(segs[i].x, segs[i].y)
    ctx.stroke()
    // 细叶（两侧交替、柔色）与发光节点
    let prev: { x: number; y: number } | null = null
    let side = 1
    for (let i = 0; i < segs.length; i += (mode === 'idle' ? 9 : 7)) {
      const p = segs[i]
      if (prev) {
        const dx = p.x - prev.x
        const dy = p.y - prev.y
        const len = Math.hypot(dx, dy) || 1
        const nx = -dy / len
        const ny = dx / len
        side = -side
        const lx = p.x + nx * 9 * side
        const ly = p.y + ny * 9 * side
        const col = (i % 4 === 0 ? leaf : leaf2)
        ctx.globalAlpha = mode === 'idle' ? 0.32 : 0.55
        ctx.strokeStyle = col + (mode === 'idle' ? '0.5)' : '0.8)')
        ctx.lineWidth = 0.9
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.quadraticCurveTo(p.x + (dx / len) * 4, p.y + (dy / len) * 4, lx, ly)
        ctx.stroke()
        ctx.fillStyle = col + '0.55)'
        ctx.globalAlpha = mode === 'idle' ? 0.3 : 0.5
        ctx.beginPath()
        ctx.ellipse(lx, ly, 2.4, 1.2, Math.atan2(dy, dx), 0, Math.PI * 2)
        ctx.fill()
      }
      prev = p
    }
    ctx.globalAlpha = 1
    // 节点光点（藤末 / 弯点处柔和呼吸）
    for (let k = 0; k < pts.length; k += 1) {
      const tw = 0.45 + 0.55 * Math.sin(t * (mode === 'idle' ? 0.8 : 1.6) + v + k * 1.3)
      ctx.globalAlpha = glowA * (0.5 + tw * 0.5)
      ctx.fillStyle = mode === 'idle' ? '#dbe6f2' : '#ffe9c8'
      ctx.beginPath()
      ctx.arc(pts[k].x, pts[k].y, mode === 'idle' ? 1.6 : 2.4, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.globalAlpha = 1
  }
}
/** 油画布面颗粒：织纹噪点 + 高光粉点（低透明度覆盖全层，统一笔触质感） */
let grainCache: HTMLCanvasElement | null | undefined
function grainTile(): HTMLCanvasElement | null {
  if (grainCache !== undefined) return grainCache
  try {
    const c = document.createElement('canvas')
    c.width = c.height = 96
    const g = c.getContext('2d')
    if (!g) { grainCache = null; return null }
    const id = g.createImageData(96, 96)
    const dd = id.data
    for (let i = 0; i < dd.length; i += 4) {
      const rnd = Math.random()
      let lum: number
      if (rnd < 0.3) lum = 10 + Math.floor(Math.random() * 16)
      else if (rnd < 0.52) lum = 44 + Math.floor(Math.random() * 34)
      else lum = 228 + Math.floor(Math.random() * 24)
      dd[i] = lum; dd[i + 1] = lum; dd[i + 2] = lum
      dd[i + 3] = Math.random() < 0.5 ? 255 : Math.floor(120 + Math.random() * 100)
    }
    g.putImageData(id, 0, 0)
    grainCache = c
  } catch { grainCache = null }
  return grainCache
}
function drawCanvasGrain(ctx: CanvasRenderingContext2D, W: number, H: number, alpha: number) {
  const c = grainTile()
  if (!c) return
  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = alpha
  const pat = ctx.createPattern(c, 'repeat')
  if (pat) { ctx.fillStyle = pat; ctx.fillRect(0, 0, W, H) }
  ctx.restore()
}
/** 滚动「星夜」笔触天幕：群青横波流动（画布底色）+ 铭黄月光光环（idle）+ 光环小星。 */
function drawStarryWaves(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, alpha: number) {
  const bands = ['30,44,112', '52,96,168', '66,150,190', '214,178,90']
  for (let L = 0; L < 5; L++) {
    const col = bands[L % bands.length]
    const base = H * (0.1 + 0.18 * L + (L % 2 ? 0.035 : 0))
    const amp = 6 + (L % 3) * 4.5
    const sp = 0.34 + (L % 2) * 0.13
    ctx.globalAlpha = (0.07 + (L % 2) * 0.05) * alpha
    ctx.strokeStyle = 'rgba(' + col + ',1)'
    ctx.lineWidth = L === 4 ? 2 : 3.2
    ctx.beginPath()
    for (let x = -40; x <= W + 40; x += 13) {
      const y = base + Math.sin(x * 0.011 + L * 2.1 + t * sp) * amp + Math.sin(x * 0.004 + t * 0.25 + L) * 4
      if (x === -40) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}
/** 梵高标志元素：螺旋漩涡云（厚笔触多臂旋转）+ 放射光环星。 */
function drawStarryVortices(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, alpha: number) {
  // 旋涡云（两个主旋 + 一个小旋，画面似《星夜》上部）
  const spots: [number, number, number][] = [
    [0.3, 0.24, 1], [0.68, 0.32, 0.82], [0.12, 0.52, 0.55],
  ]
  const swirlCols = ['28,44,118', '58,110,178', '120,196,214', '242,205,120']
  for (let v = 0; v < spots.length; v++) {
    const cx = W * spots[v][0]
    const cy = H * spots[v][1]
    const R = Math.min(W, H) * 0.2 * spots[v][2]
    const rot = t * 0.06 * (v % 2 === 0 ? 1 : -1) + v * 2.1
    for (let arm = 0; arm < 3; arm++) {
      const th0 = rot + (arm * Math.PI * 2) / 3
      const turns = 2.1
      const steps = 150
      const pts: { x: number; y: number }[] = []
      for (let i = 0; i <= steps; i++) {
        const u = i / steps
        const th = th0 + u * Math.PI * 2 * turns
        const rr = R * Math.pow(u, 0.9)
        const px = cx + Math.cos(th) * rr
        const py = cy + Math.sin(th) * rr * 0.94 + u * 4
        pts.push({ x: px, y: py })
      }
      const lay = (wd: number, colIdx: number, a: number) => {
        ctx.beginPath()
        ctx.moveTo(pts[0].x, pts[0].y)
        for (const p of pts) ctx.lineTo(p.x, p.y)
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.lineWidth = wd
        ctx.strokeStyle = 'rgba(' + swirlCols[colIdx] + ',1)'
        ctx.globalAlpha = a * alpha
        ctx.stroke()
      }
      lay(16, 0, 0.16)
      lay(10, 1, 0.2)
      lay(5, 2, 0.27)
      lay(1.8, 3, 0.52)
      // 旋涡口沿的铭黄短笔触（星夜典型）
      for (let j = Math.floor(steps * 0.75); j < steps; j += 6) {
        const p = pts[j]
        const q = pts[Math.min(steps, j + 2)]
        ctx.globalAlpha = (0.3 + 0.3 * Math.sin(t * 1.4 + v + j)) * alpha
        ctx.strokeStyle = 'rgba(242,205,120,.8)'
        ctx.lineWidth = 1.6
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(q.x, q.y)
        ctx.stroke()
      }
    }
  }
  // 放射光环星（大星 + 同心放射短线）
  const haloC = ['246,238,210', '242,214,130', '214,236,246']
  for (let s = 0; s < 7; s++) {
    const sx = W * (0.08 + ((s * 0.37) % 0.86))
    const sy = H * (0.08 + ((s * 0.53) % 0.34))
    const tw = 0.5 + 0.5 * Math.sin(t * 1.2 + s * 1.9)
    ctx.globalAlpha = (0.5 + 0.4 * tw) * alpha
    for (let r = 0; r < 2; r++) {
      const rr = 7 + r * 5 + tw * 3
      ctx.strokeStyle = 'rgba(' + haloC[r] + ',.6)'
      ctx.lineWidth = 0.8
      ctx.beginPath()
      ctx.arc(sx, sy, rr, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.fillStyle = 'rgba(255,250,232,1)'
    ctx.beginPath()
    ctx.arc(sx, sy, 2.2, 0, Math.PI * 2)
    ctx.fill()
    // 放射短线
    for (let ray = 0; ray < 8; ray++) {
      const ra = (ray * Math.PI) / 4 + s
      ctx.globalAlpha = (0.18 + 0.16 * tw) * alpha
      ctx.strokeStyle = 'rgba(' + haloC[s % 3] + ',.8)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(sx + Math.cos(ra) * 10, sy + Math.sin(ra) * 10)
      ctx.lineTo(sx + Math.cos(ra) * (14 + 6 * tw), sy + Math.sin(ra) * (14 + 6 * tw))
      ctx.stroke()
    }
  }
  ctx.globalAlpha = 1
}
/** 全屏「星夜」层（静息全局）：滚动波幕 + 月光 */
/** 内置素材档（质量降序）：清晰 → 流畅 → 极速。仅用于「首选档文件不存在」时逐级降档，
 *  用户自己填的外部地址永不参与（见 WALL_MEDIA_ORDER）。 */
const WALL_MEDIA_ORDER = [WALL_MEDIA_DEFAULT, WALL_MEDIA_SMOOTH, WALL_MEDIA_LITE]
/** 视频壁纸（wall=2）：外部素材（本地媒体路由 / http(s) / data:）+ 处理层。
 *  style='native' 原画（不调色、不叠扫描线，画质优先；只轻微压暗以配合「透明叠加」）；
 *  style='glass' 玻璃质感（磨砂板 + 边缘高光 + 焦散光斑 + 颗粒噪点）；
 *  style='holo' 全息（扫描线 + 中心光晕 + 边缘色差）。
 *  素材取不到（文件不存在、链接失效）→ 同一素材族内逐级降档（清晰→流畅→极速，只有先检测到
 *  该地址存在才会切过去），全都取不到才退化为自产网格占位，不白屏、不报错。 */
function HoloWall(props: { src: string; style: 'glass' | 'holo' | 'native'; grade?: number }) {
  const src0 = (props.src ?? '').trim()
  const [src, setSrc] = useState(src0)
  useEffect(() => { setSrc(src0) }, [src0])
  const grade = props.grade ?? 0
  const guessed: 'image' | 'video' | 'none' = !src
    ? 'none'
    : /^data:video\//i.test(src) || /\.(mp4|webm|ogv|mov|m4v)(\?|#|$)/i.test(src) ? 'video' : 'image'
  const [bad, setBad] = useState(false)
  useEffect(() => { setBad(false) }, [src])
  const kind = bad ? 'none' : guessed
  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])
  /** 降档：只在「当前地址就是内置档之一」时生效，且先 HEAD 探一下下一档是否存在，
   *  避免把 404 一路播成「占位」。 */
  const onMediaError = () => {
    const i = WALL_MEDIA_ORDER.indexOf(src)
    if (i < 0 || i + 1 >= WALL_MEDIA_ORDER.length) { setBad(true); return }
    const next = WALL_MEDIA_ORDER[i + 1]
    void fetch(next, { method: 'HEAD' })
      .then((r) => { if (!aliveRef.current) return; if (r.ok) setSrc(next); else setBad(true) })
      .catch(() => { if (aliveRef.current) setBad(true) })
  }
  return (
    <div className="dsh-wt_holo" data-holo={kind} data-style={props.style} data-grade={grade}>
      {kind === 'video'
        ? <video className="dsh-wt_holoMedia" src={src} muted autoPlay loop playsInline
            preload="auto" onError={onMediaError} style={grade > 0 ? { filter: wallGradeFilter(grade) } : undefined} />
        : kind === 'image'
          ? <img className="dsh-wt_holoMedia" src={src} alt="" onError={onMediaError} />
          : (
            <span className="dsh-wt_holoEmpty">
              <b>壁纸素材不可用</b>
              <i>{src || '未填写素材地址'}</i>
            </span>
          )}
      {props.style === 'glass' ? (
        <>
          <span className="dsh-wt_glassPane dsh-wt_glassPaneA" />
          <span className="dsh-wt_glassPane dsh-wt_glassPaneB" />
          <span className="dsh-wt_glassPane dsh-wt_glassPaneC" />
          <span className="dsh-wt_glassCaus" />
          <span className="dsh-wt_glassGrain" />
          <span className="dsh-wt_glassEdge" />
        </>
      ) : props.style === 'holo' ? (
        <>
          <span className="dsh-wt_holoScan" />
          <span className="dsh-wt_holoGlow" />
          <span className="dsh-wt_holoChrom" />
        </>
      ) : null}
    </div>
  )
}

function StarrySky() {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    let reduced = false
    try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch {}
    if (reduced) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let W = window.innerWidth
    let H = window.innerHeight
    const onResize = () => {
      W = window.innerWidth
      H = window.innerHeight
      cv.width = Math.max(1, Math.floor(W * dpr))
      cv.height = Math.max(1, Math.floor(H * dpr))
      cv.style.width = W + 'px'
      cv.style.height = H + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    onResize()
    window.addEventListener('resize', onResize)
    const t0 = performance.now()
    let raf = 0
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const t = (now - t0) / 1000
      ctx.clearRect(0, 0, W, H)
      // 全局群青晕染（统一夜色，色彩整体性）
      ctx.globalCompositeOperation = 'source-over'
      const veil = ctx.createLinearGradient(0, 0, 0, H)
      veil.addColorStop(0, 'rgba(24,38,100,.15)')
      veil.addColorStop(0.6, 'rgba(18,26,66,.12)')
      veil.addColorStop(1, 'rgba(10,13,34,.26)')
      ctx.fillStyle = veil
      ctx.fillRect(0, 0, W, H)
      ctx.globalCompositeOperation = 'lighter'
      drawStarryWaves(ctx, W, H, t, 1)
      drawStarryVortices(ctx, W, H, t, 1)
      // 铭黄月光 + 光环（如《星夜》右上）
      const mx = W * 0.8
      const my = H * 0.1
      const R = Math.min(W, H) * 0.045
      const core = ctx.createRadialGradient(mx, my, 0, mx, my, R * 1.6)
      core.addColorStop(0, 'rgba(255,242,205,.72)')
      core.addColorStop(0.4, 'rgba(242,201,96,.3)')
      core.addColorStop(1, 'rgba(242,201,96,0)')
      ctx.globalAlpha = 0.95
      ctx.fillStyle = core
      ctx.beginPath()
      ctx.arc(mx, my, R * 1.6, 0, Math.PI * 2)
      ctx.fill()
      for (let k = 0; k < 3; k++) {
        const rr = R * (1.7 + k * 0.9) + Math.sin(t * 0.5 + k) * 4
        ctx.globalAlpha = 0.14 - k * 0.03
        ctx.strokeStyle = 'rgba(242,201,96,1)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(mx, my, rr, 0, Math.PI * 2)
        ctx.stroke()
      }
      // 光环小星（群青夜空里像星夜里的星星）
      for (let s = 0; s < 6; s++) {
        const sx = W * (0.06 + (s * 0.15) % 0.9)
        const sy = H * (0.05 + (s * 0.31) % 0.4)
        const tw = 0.5 + 0.5 * Math.sin(t * 1.1 + s * 1.7)
        ctx.globalAlpha = (0.25 + 0.35 * tw) * 0.6
        ctx.strokeStyle = 'rgba(242,225,170,1)'
        ctx.lineWidth = 0.7
        ctx.beginPath()
        ctx.arc(sx, sy, 5 + tw * 4, 0, Math.PI * 2)
        ctx.stroke()
        ctx.fillStyle = 'rgba(255,246,220,1)'
        ctx.beginPath()
        ctx.arc(sx, sy, 1.2, 0, Math.PI * 2)
        ctx.fill()
      }
      // 底部夜色丘陵 + 暖窗灯火（画面收束的静底）
      ctx.globalCompositeOperation = 'source-over'
      const top = H * 0.97
      ctx.beginPath()
      ctx.moveTo(-20, H)
      for (let x = -20; x <= W + 20; x += 10) {
        const y = top + Math.sin(x * 0.013 + 1.6) * 9 + Math.sin(x * 0.004 + 0.4) * 13 + 4
        ctx.lineTo(x, Math.max(top + 2, y))
      }
      ctx.lineTo(W + 20, H)
      ctx.closePath()
      ctx.fillStyle = 'rgba(8,11,30,.8)'
      ctx.fill()
      // 山脊暖金细线 + 窗灯
      ctx.strokeStyle = 'rgba(240,206,120,.55)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(-20, top + Math.sin(-20 * 0.013 + 1.6) * 9 + Math.sin(-20 * 0.004 + 0.4) * 13 + 4)
      for (let x = -10; x <= W + 20; x += 10) {
        const y = top + Math.sin(x * 0.013 + 1.6) * 9 + Math.sin(x * 0.004 + 0.4) * 13 + 4
        ctx.lineTo(x, Math.max(top + 2, y))
      }
      ctx.stroke()
      for (let h = 0; h < 9; h++) {
        const lx = W * (0.05 + ((h * 0.31) % 0.9))
        const ly = top + Math.sin(lx * 0.013 + 1.6) * 9 + Math.sin(lx * 0.004 + 0.4) * 13 + 1
        const tw2 = 0.5 + 0.5 * Math.sin(t * 1.5 + h * 1.2)
        ctx.globalAlpha = 0.25 + 0.35 * tw2
        ctx.fillStyle = 'rgba(244,214,132,1)'
        ctx.fillRect(lx - 1, ly - 3, 2.2, 2.2)
      }
      ctx.globalAlpha = 1
      // 油画布面颗粒（统一整幅为画布质感）
      drawCanvasGrain(ctx, W, H, 0.13)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [])
  return <canvas ref={ref} className="dsh-wt_vineCanvas" />
}
/** 全屏细藤层（静息全局） */
function Vines({ mode }: { mode: 'idle' | 'busy' }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    let reduced = false
    try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch {}
    if (reduced) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let W = window.innerWidth
    let H = window.innerHeight
    const onResize = () => {
      W = window.innerWidth
      H = window.innerHeight
      cv.width = Math.max(1, Math.floor(W * dpr))
      cv.height = Math.max(1, Math.floor(H * dpr))
      cv.style.width = W + 'px'
      cv.style.height = H + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    onResize()
    window.addEventListener('resize', onResize)
    const t0 = performance.now()
    let raf = 0
    // 静息「叶片飘落」：细叶自藤间缓缓飘落（idle 专属，增加生命力）
    const leaves = mode === 'idle'
      ? Array.from({ length: 16 }, () => ({
          x: Math.random(), y: Math.random() * 0.3,
          vy: 0.08 + Math.random() * 0.22, ph: Math.random() * Math.PI * 2,
          sz: 1.6 + Math.random() * 1.6, sway: 0.5 + Math.random() * 1.2, tint: Math.random(),
        }))
      : null
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const t = (now - t0) / 1000
      ctx.clearRect(0, 0, W, H)
      drawVines(ctx, W, H, (now - t0) / 1000, mode)
      if (leaves) {
        for (const lf of leaves) {
          lf.y += lf.vy * 0.016
          if (lf.y > 1.02) { lf.y = -0.04; lf.x = Math.random() }
          const xx = (lf.x + Math.sin(t * 0.6 + lf.ph) * lf.sway * 0.02)
          const tw = 0.35 + 0.65 * Math.abs(Math.sin(t * 1.2 + lf.ph * 2))
          ctx.globalAlpha = tw * 0.4
          ctx.fillStyle = lf.tint < 0.5 ? 'rgba(206,226,214,.9)' : 'rgba(238,216,198,.9)'
          ctx.save()
          ctx.translate(((xx % 1) + 1) % 1 * W, lf.y * H)
          ctx.rotate(Math.sin(t * 0.8 + lf.ph) * 0.7)
          ctx.beginPath()
          ctx.ellipse(0, 0, lf.sz * 1.4, lf.sz * 0.62, 0, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()
        }
        ctx.globalAlpha = 1
      }
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [mode])
  return <canvas ref={ref} className="dsh-wt_vineCanvas" />
}

/** 旋涡流彩「触手」：如梵高《星夜》般卷曲发光的实状丝带（宽柔底 + 中色 + 亮芯三层 + 流光节点）。
 *  用于静息/忙碌画布背景，落在星群之下、不抢主体。 */
function drawSwirlStreamers(ctx: CanvasRenderingContext2D, W: number, H: number, t: number, count: number, alphaMul: number) {
  const cols = ['38,62,150', '100,160,220', '242,193,78', '224,86,64', '186,150,228', '56,150,116']
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  for (let k = 0; k < count; k++) {
    const seed = k * 2.13 + 0.7
    const cx = W * (0.5 + 0.28 * Math.sin(seed * 1.1))
    const cy = H * (0.5 + 0.24 * Math.cos(seed * 1.3))
    const R = Math.min(W, H) * 0.42
    const ang = t * 0.05 * (k % 2 === 0 ? 1 : -1) + seed
    const n = 110
    const pts: { x: number; y: number }[] = []
    for (let i = 0; i <= n; i++) {
      const u = i / n
      const th = ang + u * Math.PI * 2.1 * (k % 2 === 0 ? 0.82 : 1)
      const r = R * (0.22 + 0.78 * u)
      pts.push({
        x: cx + Math.cos(th) * r * 1.35 + Math.sin(u * 8 + seed) * R * 0.18,
        y: cy + Math.sin(th) * r + Math.cos(u * 7 + seed) * R * 0.16,
      })
    }
    const stroke = (wd: number, col: string) => {
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (const p of pts) ctx.lineTo(p.x, p.y)
      ctx.lineCap = 'round'
      ctx.lineWidth = wd
      ctx.strokeStyle = col
      ctx.stroke()
    }
    ctx.globalAlpha = 0.5 * alphaMul
    stroke(18, 'rgba(40,66,130,.14)')
    ctx.globalAlpha = 0.65 * alphaMul
    stroke(8, 'rgba(' + cols[k % cols.length] + ',.16)')
    ctx.globalAlpha = 0.85 * alphaMul
    stroke(2.4, 'rgba(' + cols[(k + 2) % cols.length] + ',.4)')
    // 梵高式短笔触（沿丝带切向的彩色小划，如《星夜》笔意）
    for (let j = 8; j < pts.length - 1; j += 9) {
      const p = pts[j]
      const q = pts[j + 1]
      const dx = q.x - p.x
      const dy = q.y - p.y
      const len = Math.hypot(dx, dy) || 1
      const tx = dx / len
      const ty = dy / len
      ctx.globalAlpha = (0.35 + 0.45 * Math.abs(Math.sin(t * 1.3 + j * 0.7))) * alphaMul
      ctx.strokeStyle = 'rgba(' + cols[(j / 9 | 0) % cols.length] + ',.3)'
      ctx.lineWidth = 1.1
      ctx.beginPath()
      ctx.moveTo(p.x - tx * 5, p.y - ty * 5)
      ctx.lineTo(p.x + tx * 5, p.y + ty * 5)
      ctx.stroke()
    }
    for (let j = 6; j < pts.length; j += 14) {
      const p = pts[j]
      ctx.globalAlpha = (0.4 + 0.6 * Math.abs(Math.sin(t * 1.6 + j))) * alphaMul
      ctx.fillStyle = 'rgba(255,236,190,.8)'
      ctx.beginPath()
      ctx.arc(p.x, p.y, 1.7, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.globalAlpha = 1
  ctx.restore()
}

/** 静息宇宙背景板（canvas 粒子星系）：三个旋转星系核心 + 螺旋星流 + 漂浮粒子群 + 星光闪烁。
 *  仅当控制室挂载时运行；尊重 prefers-reduced-motion；canvas 层永远在卡片之下、不拦截事件。 */
function CosmicField() {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    let reduced = false
    try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch {}
    if (reduced) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let W = 0
    let H = 0
    let raf = 0
    const fracs = [[0.16, 0.22], [0.84, 0.3], [0.5, 0.8], [0.3, 0.07]]
    const baseR = [0.16, 0.12, 0.085, 0.062]
    // 特效色系主题（与忙碌画布同源：紫金 / 银蓝 / 暖金）
    const pal: string[][] = PAL_BUSY[fxPalIdx()]
    interface Star { r: number; ang: number; sp: number; sz: number; a: number; ph: number; gi: number; li: number }
    const stars: Star[] = []
    for (let gi = 0; gi < 4; gi++) {
      const rm = Math.min(W || 800, H || 600) * baseR[gi]
      const gn = [150, 108, 76, 54][gi]
      for (let s = 0; s < gn; s++) {
        stars.push({
          r: rm * (0.22 + Math.pow(Math.random(), 1.7) * 0.9),
          ang: Math.random() * Math.PI * 2,
          sp: (0.18 + Math.random() * 0.65) * (gi % 2 === 0 ? 1 : -1),
          sz: 0.5 + Math.random() * 1.4,
          a: 0.22 + Math.random() * 0.6,
          ph: Math.random() * Math.PI * 2,
          gi,
          li: Math.floor(Math.random() * 3),
        })
      }
    }
    interface Fp { x: number; y: number; vx: number; vy: number; sz: number; a: number; ph: number; li: number }
    const fps: Fp[] = []
    for (let i = 0; i < 110; i++) {
      fps.push({
        x: Math.random(), y: Math.random(),
        vx: (Math.random() - 0.5) * 0.03, vy: (Math.random() - 0.5) * 0.03,
        sz: 0.6 + Math.random() * 1.3, a: 0.15 + Math.random() * 0.4,
        ph: Math.random() * Math.PI * 2, li: Math.floor(Math.random() * 3),
      })
    }
    const onResize = () => {
      const p = cv.parentElement as HTMLElement | null
      W = p ? p.clientWidth : window.innerWidth
      H = p ? p.clientHeight : window.innerHeight
      cv.width = Math.max(1, Math.floor(W * dpr))
      cv.height = Math.max(1, Math.floor(H * dpr))
      cv.style.width = W + 'px'
      cv.style.height = H + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    onResize()
    let ro: ResizeObserver | null = null
    try { if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(onResize); ro.observe(cv.parentElement as Element) } } catch {}
    window.addEventListener('resize', onResize)
    const t0 = performance.now()
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const t = (now - t0) / 1000
      ctx.clearRect(0, 0, W, H)
      ctx.globalCompositeOperation = 'lighter'
      // 梵高式旋涡触手（背景，星群之下）
      drawSwirlStreamers(ctx, W, H, t, 2, 0.85)
      // 漂浮粒子群
      for (const p of fps) {
        p.x += p.vx * 0.016
        p.y += p.vy * 0.016
        if (p.x < 0) { p.x = 1; p.y = Math.random() }
        if (p.x > 1) { p.x = 0; p.y = Math.random() }
        if (p.y < 0) p.y = 1
        if (p.y > 1) p.y = 0
        const tw = p.a * (0.55 + 0.45 * Math.sin(t * 1.4 + p.ph))
        ctx.globalAlpha = tw * 0.9
        ctx.fillStyle = 'hsl(' + Math.round(210 + p.li * 40) + ',90%,78%)'
        ctx.beginPath()
        ctx.arc(p.x * W, p.y * H, p.sz, 0, Math.PI * 2)
        ctx.fill()
      }
      // 三个旋转星系 + 螺旋星流
      for (let gi = 0; gi < 4; gi++) {
        const cx = W * fracs[gi][0] + Math.sin(t * 0.07 + gi * 2.1) * 14
        const cy = H * fracs[gi][1] + Math.cos(t * 0.06 + gi * 1.7) * 10
        const rad = Math.min(W, H) * baseR[gi]
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad * 0.55)
        g.addColorStop(0, 'rgba(255,255,255,.30)')
        g.addColorStop(0.25, 'rgba(' + pal[gi][1] + ',.20)')
        g.addColorStop(0.6, 'rgba(' + pal[gi][2] + ',.08)')
        g.addColorStop(1, 'rgba(' + pal[gi][2] + ',0)')
        ctx.globalAlpha = 0.85
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(cx, cy, rad * 0.55, 0, Math.PI * 2)
        ctx.fill()
        for (const st of stars) {
          if (st.gi !== gi) continue
          const ang = st.ang + t * st.sp
          const wob = Math.sin(ang * 2 + st.ph) * 0.12
          const rr = st.r * (1 + wob)
          const px = cx + Math.cos(ang) * rr
          const py = cy + Math.sin(ang) * rr * 0.96
          const tw = st.a * (0.55 + 0.45 * Math.sin(t * 2.2 + st.ph))
          ctx.globalAlpha = tw
          ctx.fillStyle = 'rgba(' + pal[gi][st.li] + ',' + Math.min(1, tw) + ')'
          ctx.beginPath()
          ctx.arc(px, py, st.sz, 0, Math.PI * 2)
          ctx.fill()
          if (st.sz > 1.3) {
            ctx.globalAlpha = tw * 0.6
            ctx.fillStyle = 'rgba(255,255,255,.8)'
            ctx.beginPath()
            ctx.arc(px, py, st.sz * 0.45, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      }
      ctx.globalAlpha = 1
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      if (ro) { try { ro.disconnect() } catch {} }
      window.removeEventListener('resize', onResize)
    }
  }, [])
  return <canvas ref={ref} className="dsh-wt_cosmicCanvas" />
}

/** 忙碌「多中心互旋」粒子宇宙（canvas）：多组星群/星流以各自固定中心 + 不同平面角度缓慢互旋，
 *  刻意的不规则 + 伪 3D 纵深 → 浪漫高级；另有静息光尘衬底。不追踪鼠标。 */
function BusyCosmos() {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    let reduced = false
    try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch {}
    if (reduced) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let W = window.innerWidth
    let H = window.innerHeight
    // 特效色系主题（紫金 / 银蓝 / 暖金）
    const PAL: string[][] = PAL_BUSY[fxPalIdx()]
    interface Star { c: number; r: number; a: number; sp: number; sz: number; al: number; ph: number; ell: number; z: number }
    const stars: Star[] = []
    // 美学：环径呈梯度（大中小错落）、星点细密、速度舒缓（高级感 = 留白 + 慢）
    const ringR = [125, 185, 255, 150, 215, 120, 225, 160]
    const spinSp = [0.26, 0.42, 0.16, 0.52, 0.22, 0.6, 0.14, 0.36]
    const tiltF = [1.0, 0.86, 1.14, 0.7, 0.94, 1.1, 0.8, 1.02]
    const ciBy = [0, 1, 2, 3, 0, 2, 1, 3]
    const counts = [46, 40, 30, 38, 30, 36, 28, 34]
    for (let c = 0; c < 8; c++) {
      for (let i = 0; i < counts[c]; i++) {
        const rr = ringR[c] * (0.45 + Math.random() * 0.7)
        stars.push({
          c,
          r: rr,
          a: Math.random() * Math.PI * 2,
          sp: (Math.random() - 0.5) * spinSp[c] * 2.2,
          sz: 0.6 + Math.random() * 1.5,
          al: 0.13 + Math.random() * 0.34,
          ph: Math.random() * Math.PI * 2,
          ell: 0.34 + Math.random() * 0.3,
          z: Math.random() * 2 - 1, // 纵深：-1 远（小/暗/慢） → 1 近（大/亮/快）
        })
      }
    }
    interface Dust { x: number; y: number; vx: number; vy: number; sz: number; al: number; ph: number }
    const dust: Dust[] = []
    for (let i = 0; i < 110; i++) {
      dust.push({ x: Math.random(), y: Math.random(), vx: (Math.random() - 0.5) * 0.018, vy: (Math.random() - 0.5) * 0.018, sz: 0.5 + Math.random() * 1.0, al: 0.1 + Math.random() * 0.22, ph: Math.random() * 6.28 })
    }
    const onResize = () => {
      W = window.innerWidth
      H = window.innerHeight
      cv.width = Math.max(1, Math.floor(W * dpr))
      cv.height = Math.max(1, Math.floor(H * dpr))
      cv.style.width = W + 'px'
      cv.style.height = H + 'px'
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    // 各星群的固定艺术中心（屏幕比例；互不重叠、有呼吸漂移）
    const CENT: number[][] = [
      [0.14, 0.24], [0.36, 0.46], [0.5, 0.72], [0.84, 0.7],
      [0.16, 0.76], [0.34, 0.56], [0.66, 0.6], [0.5, 0.18],
    ]
    onResize()
    window.addEventListener('resize', onResize)
    const t0 = performance.now()
    let raf = 0
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const t = (now - t0) / 1000
      ctx.clearRect(0, 0, W, H)
      ctx.globalCompositeOperation = 'lighter'
      // 星夜滚波底色（仅壁纸档 1 铺；0=无壁纸层、2=全息御姐自带素材，都不铺星夜）
      if (getFxConf().wall === 1) {
        drawStarryWaves(ctx, W, H, t, 0.8)
        // 梵高旋涡云 + 光环星（忙碌浅量，星群蝴蝶在上）
        drawStarryVortices(ctx, W, H, t, 0.65)
      }
      // 亮藤打底：星群与蝴蝶绕藤流转
      drawVines(ctx, W, H, t, 'busy')
      // 浅影旋涡触手（不抢星群）
      drawSwirlStreamers(ctx, W, H, t, 1, 0.32)
      // 静息光尘（保持休憩，不参与旋群）
      for (const d of dust) {
        d.x += d.vx * 0.016
        d.y += d.vy * 0.016
        if (d.x < 0) { d.x = 1; d.y = Math.random() }
        if (d.x > 1) { d.x = 0; d.y = Math.random() }
        if (d.y < 0) d.y = 1
        if (d.y > 1) d.y = 0
        const tw = d.al * (0.5 + 0.5 * Math.sin(t * 1.1 + d.ph))
        ctx.globalAlpha = tw * 0.8
        ctx.fillStyle = 'rgba(226,224,236,.9)'
        ctx.beginPath()
        ctx.arc(d.x * W, d.y * H, d.sz, 0, Math.PI * 2)
        ctx.fill()
      }
      // 星群：每簇绕自己的固定中心、不同平面角度互旋 + 全群「聚散呼吸」
      for (const s of stars) {
        const c = s.c
        const ccx = W * CENT[c][0] + Math.sin(t * 0.05 + c * 1.7) * 24
        const ccy = H * CENT[c][1] + Math.cos(t * 0.04 + c * 2.3) * 18
        const plane = tiltF[c] + Math.sin(t * 0.09 + c * 1.3) * 0.12
        const ph = s.a + t * s.sp
        // 聚散：每簇以自己相位向中心聚拢再散开（慢节奏呼吸）
        const breath = 0.82 + 0.26 * (0.5 + 0.5 * Math.sin(t * 0.32 + c * 1.13 + s.ph * 0.3))
        const x0 = Math.cos(ph) * s.r * breath
        const y0 = Math.sin(ph) * s.r * s.ell * breath
        // 星流环整体缓慢自旋（绕簇心）
        const orb = t * spinSp[c] * 0.06 * (c % 2 === 0 ? 1 : -1)
        const cos = Math.cos(orb)
        const sin = Math.sin(orb)
        let sx = x0 * cos - y0 * sin
        let sy = x0 * sin + y0 * cos
        sx *= plane
        sy *= plane * 0.92
        // 恰到好处的不规则微扰
        sx += Math.sin(t * 0.55 + s.ph) * 6
        sy += Math.cos(t * 0.47 + s.ph * 1.7) * 6
        const px = ccx + sx
        const py = ccy + sy
        if (px < -30 || px > W + 30 || py < -30 || py > H + 30) continue
        const pal = PAL[ciBy[c]]
        const li = Math.floor(Math.abs(Math.sin(s.ph + c)) * 3) % 3
        const df = (s.z + 1) / 2
        const dd = s.sz * (0.72 + 0.5 * df)
        const tw = s.al * (0.45 + 0.55 * Math.sin(t * 1.7 + s.ph)) * (0.42 + 0.62 * df)
        ctx.globalAlpha = Math.min(1, tw * 0.95)
        ctx.fillStyle = 'rgba(' + pal[li] + ',1)'
        ctx.beginPath()
        ctx.arc(px, py, dd, 0, Math.PI * 2)
        ctx.fill()
        if (dd > 1.5) {
          ctx.globalAlpha = Math.min(1, tw * 0.4)
          ctx.fillStyle = 'rgba(255,255,255,.8)'
          ctx.beginPath()
          ctx.arc(px, py, dd * 0.45, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      // 每簇：极淡柔光 + 精致光环细线（倾角随簇，旋转呼吸）
      for (let c = 0; c < 8; c++) {
        const ccx = W * CENT[c][0] + Math.sin(t * 0.05 + c * 1.7) * 24
        const ccy = H * CENT[c][1] + Math.cos(t * 0.04 + c * 2.3) * 18
        const rad = Math.max(40, ringR[c] * 0.45)
        const glow = ctx.createRadialGradient(ccx, ccy, 0, ccx, ccy, rad)
        glow.addColorStop(0, 'rgba(255,244,224,.05)')
        glow.addColorStop(0.6, 'rgba(214,208,238,.03)')
        glow.addColorStop(1, 'rgba(214,208,238,0)')
        ctx.globalAlpha = 0.6 + 0.4 * Math.sin(t * 0.7 + c)
        ctx.fillStyle = glow
        ctx.beginPath()
        ctx.arc(ccx, ccy, rad, 0, Math.PI * 2)
        ctx.fill()
        // 细环线（elegant）
        const orb = t * spinSp[c] * 0.06 * (c % 2 === 0 ? 1 : -1)
        const ringX = ringR[c] * 0.9 + Math.sin(t * 0.4 + c) * 6
        const ringY = ringR[c] * 0.36
        ctx.save()
        ctx.translate(ccx, ccy)
        ctx.rotate(orb)
        ctx.strokeStyle = 'rgba(' + PAL[ciBy[c]][2] + ',.16)'
        ctx.lineWidth = 0.7
        ctx.beginPath()
        ctx.ellipse(0, 0, ringX, ringY, 0, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
      }
      ctx.globalAlpha = 1
      // 油画布面颗粒
      drawCanvasGrain(ctx, W, H, 0.085)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
    }
  }, [])
  return <canvas ref={ref} className="dsh-wt_busyCosmos" />
}

/** 控制室面板：项目卡片网格（每行 3 张、超出换行）；数据由工作台组装推送（纯读镜像）。
 *  主题：dark/light 直接生效；system = 跟随宿主 html 的 color-scheme（DSH 深色/白色/跟随系统都会反映到它） */
function ConsolePane() {
  const [, setTick] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [cols, setColsState] = useState<number>(() => splitEnv?.console?.getCols?.() ?? 3)
  const [shape, setShapeState] = useState<'square' | 'circle'>(() => splitEnv?.console?.getShape?.() ?? 'square')
  const [bg, setBgState] = useState<'off' | 'plain' | 'glow' | 'photo'>(() => splitEnv?.console?.getBg?.() ?? 'glow')
  const [bgAlpha, setBgAlphaState] = useState<number>(() => splitEnv?.console?.getBgAlpha?.() ?? 25)
  const [bgPhoto, setBgPhoto] = useState<string>('')
  const [photoId, setPhotoIdLocal] = useState<string>('')
  const [photoList, setPhotoList] = useState<{ id: string; kind: 'photo' | 'video'; url: string }[]>([])
  const [bgVideo, setBgVideo] = useState<string>('')
  const [photoGrid, setPhotoGridState] = useState<boolean>(() => splitEnv?.console?.getPhotoGrid?.() ?? true)
  const [gridOpacity, setGridOpacityState] = useState<number>(() => splitEnv?.console?.getGridOpacity?.() ?? 8)
  const [cardBlur, setCardBlurState] = useState<number>(() => splitEnv?.console?.getCardBlur?.() ?? 8)
  const [plainBlur, setPlainBlurState] = useState<number>(() => splitEnv?.console?.getPlainBlur?.() ?? 0)
  const [glowBlur, setGlowBlurState] = useState<number>(() => splitEnv?.console?.getGlowBlur?.() ?? 8)
  const [plainGrid, setPlainGridState] = useState<number>(() => splitEnv?.console?.getPlainGrid?.() ?? 5)
  const [glowGrid, setGlowGridState] = useState<number>(() => splitEnv?.console?.getGlowGrid?.() ?? 8)
  const [glowSpeed, setGlowSpeedState] = useState<number>(() => splitEnv?.console?.getGlowSpeed?.() ?? 50)
  const [petOn, setPetOnState] = useState<boolean>(() => splitEnv?.console?.getPetOn?.() ?? false)
  const [petModel, setPetModelState] = useState<number>(() => splitEnv?.console?.getPetModel?.() ?? 0)
  const [petPos, setPetPosState] = useState<{ x: number; y: number }>(() => splitEnv?.console?.getPetPos?.() ?? { x: 14, y: 14 })
  const [petStatus, setPetStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [annOpen, setAnnOpen] = useState(false)
  const [updStatus, setUpdStatus] = useState<UpdateStatus>(() => readCache().status)
  const [updInfo, setUpdInfo] = useState<UpdateInfo | null>(() => readCache().info)
  const [autoCheckOn, setAutoCheckOn] = useState<boolean>(() => getAutoCheck())
  const updBusyRef = useRef(false)
  const photoUrlRef = useRef<string>('')
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [bgEdit, setBgEdit] = useState<'plain' | 'glow' | 'photo' | null>(null)
  const [plainHsl, setPlainHslState] = useState<{ h: number; s: number; l: number }>(() => {
    const saved = splitEnv?.console?.getPlainHsl?.()
    if (saved) return saved
    return splitEnv?.console?.getTheme?.() === 'light' ? { ...PLAIN_HSL_LIGHT } : { ...PLAIN_HSL_DARK }
  })
  const [glowHsl, setGlowHslState] = useState<{ h: number; s: number; l: number }>(() => splitEnv?.console?.getGlowHsl?.() ?? { h: 0, s: 100, l: 100 })
  const [photoHsl, setPhotoHslState] = useState<{ h: number; s: number; l: number }>({ h: 0, s: 100, l: 100 })
  const gridRef = useRef<HTMLDivElement | null>(null)
  const paneRef = useRef<HTMLDivElement | null>(null)
  const firstRectsRef = useRef<Map<string, { x: number; y: number }> | null>(null)
  const onCols = (n: number) => {
    const grid = gridRef.current
    if (grid) {
      const rects = new Map<string, { x: number; y: number }>()
      grid.querySelectorAll('.dsh-wt_consoleCard').forEach((el) => {
        const key = (el as HTMLElement).dataset.flip ?? ''
        const r = el.getBoundingClientRect()
        rects.set(key, { x: r.left, y: r.top })
      })
      firstRectsRef.current = rects
    }
    setColsState(n)
    splitEnv?.console?.setCols?.(n)
  }
  const onShape = (s: 'square' | 'circle') => {
    setShapeState(s)
    splitEnv?.console?.setShape?.(s)
  }
  /** 选择本地图片文件并入库 */
  const pickPhotoFile = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*,video/*'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      onFilePhoto(file)
    }
    input.click()
  }
  /** 新增媒体（照片/视频）：原始 Blob 存 IndexedDB（零压缩），显示用对象 URL；自动设为当前 */
  const onFilePhoto = async (file: Blob) => {
    let id = ''
    let url = ''
    let kind: 'photo' | 'video' = file.type && file.type.indexOf('video/') === 0 ? 'video' : 'photo'
    const rec = await (splitEnv?.console?.addPhoto?.(file) ?? Promise.resolve(null)).catch(() => null)
    if (rec) { id = rec.id; url = rec.url; kind = rec.kind } else {
      url = URL.createObjectURL(file)
    }
    photoUrlRef.current = url
    setPhotoIdLocal(id)
    if (id) setPhotoList((prev) => [{ id, kind, url }, ...prev])
    if (kind === 'video') { setBgPhoto(''); setBgVideo(url) } else { setBgVideo(''); setBgPhoto(url) }
    setBgState('photo')
    splitEnv?.console?.setBg?.('photo')
  }
  /** 删除一条媒体：当前使用的那条被删 → 切到最新一条；删光 → 回到流光背景 */
  const removePhotoById = async (p: { id: string; kind: 'photo' | 'video'; url: string }) => {
    try { await splitEnv?.console?.removePhoto?.(p.id) } catch {}
    try { URL.revokeObjectURL(p.url) } catch {}
    const nextList = photoList.filter((x) => x.id !== p.id)
    setPhotoList(nextList)
    if (photoId === p.id) {
      const next = nextList[0] ?? null
      if (next) {
        setPhotoIdLocal(next.id)
        splitEnv?.console?.setPhotoId?.(next.id)
        photoUrlRef.current = next.url
        setBgVideo(next.kind === 'video' ? next.url : '')
        setBgPhoto(next.kind === 'video' ? '' : next.url)
        setBgState('photo')
        splitEnv?.console?.setBg?.('photo')
      } else {
        setPhotoIdLocal('')
        photoUrlRef.current = ''
        setBgPhoto('')
        setBgVideo('')
        setBgState('glow')
        splitEnv?.console?.setBg?.('glow')
      }
    }
  }
  const togglePhotoGrid = () => {
    const next = !photoGrid
    setPhotoGridState(next)
    splitEnv?.console?.setPhotoGrid?.(next)
  }
  const onGridOpacity = (n: number) => {
    const v = Math.min(Math.max(Math.round(n), 0), 30)
    setGridOpacityState(v)
    splitEnv?.console?.setGridOpacity?.(v)
  }
  const onCardBlur = (n: number) => {
    const v = Math.min(Math.max(Math.round(n), 0), 20)
    setCardBlurState(v)
    splitEnv?.console?.setCardBlur?.(v)
  }
  const onModeBlur = (kind: 'plain' | 'glow' | 'photo', n: number) => {
    const v = Math.min(Math.max(Math.round(n), 0), 20)
    if (kind === 'plain') { setPlainBlurState(v); splitEnv?.console?.setPlainBlur?.(v) }
    else if (kind === 'glow') { setGlowBlurState(v); splitEnv?.console?.setGlowBlur?.(v) }
    else { setCardBlurState(v); splitEnv?.console?.setCardBlur?.(v) }
  }
  const onModeGrid = (kind: 'plain' | 'glow', n: number) => {
    const v = Math.min(Math.max(Math.round(n), 0), 30)
    if (kind === 'plain') { setPlainGridState(v); splitEnv?.console?.setPlainGrid?.(v) }
    else { setGlowGridState(v); splitEnv?.console?.setGlowGrid?.(v) }
  }
  const onGlowSpeed = (n: number) => {
    const v = Math.min(Math.max(Math.round(n), 0), 100)
    setGlowSpeedState(v)
    splitEnv?.console?.setGlowSpeed?.(v)
  }
  /** 看板娘：开关 / 选模型 / 拖动落点持久化（拖动结束才写，避免每帧落盘） */
  const togglePet = () => {
    const next = !petOn
    setPetOnState(next)
    splitEnv?.console?.setPetOn?.(next)
  }
  const pickPetModel = (i: number) => {
    setPetModelState(i)
    splitEnv?.console?.setPetModel?.(i)
  }
  const onPetMove = useCallback((p: { x: number; y: number }) => {
    setPetPosState(p)
    splitEnv?.console?.setPetPos?.(p)
  }, [])
  const runUpdateCheck = async (force: boolean) => {
    if (updBusyRef.current) return
    updBusyRef.current = true
    setUpdStatus('checking')
    try {
      const r = await checkUpdate(force)
      setUpdStatus(r.status)
      setUpdInfo(r.info)
    } finally {
      updBusyRef.current = false
    }
  }
  const [updCopied, setUpdCopied] = useState(false)
  const onCopyUpgrade = async () => {
    const ok = await copyTextSafe(UPGRADE_AI)
    if (ok) { setUpdCopied(true); window.setTimeout(() => setUpdCopied(false), 2200) }
  }
  const onSkipVersion = () => {
    if (updInfo) { setSkipVersion(updInfo.latest); setUpdInfo(null); setUpdStatus('uptodate') }
  }
  const onAutoCheckToggle = () => {
    const next = !autoCheckOn
    setAutoCheckOn(next)
    storeAutoCheck(next)
    if (next) void runUpdateCheck(false)
  }
  /** 抓手拖拽排序：按住抓手上下移动 → 行实时重排，松手持久化 */
  const dragRowRef = useRef<string | null>(null)
  const dragFlipRef = useRef<Map<string, { x: number; y: number }> | null>(null)
  const lastTargetRef = useRef<number>(-1)
  const [dragRowId, setDragRowId] = useState<string | null>(null)
  // FLIP：落位提交后，其他行从旧位置平滑让位（260ms 缓出）
  useLayoutEffect(() => {
    const first = dragFlipRef.current
    if (!first) return
    dragFlipRef.current = null
    document.querySelectorAll<HTMLElement>('.dsh-wt_photoRow').forEach((el) => {
      const key = el.dataset.rid ?? ''
      const f = first.get(key)
      if (!f) return
      const r = el.getBoundingClientRect()
      const dx = f.x - r.left
      const dy = f.y - r.top
      if (dx || dy) el.animate([{ transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(.25,.6,.3,1)' })
    })
  }, [photoList])
  const onHandleDown = (id: string, e: { button: number; preventDefault: () => void; stopPropagation: () => void }) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    dragRowRef.current = id
    lastTargetRef.current = photoList.findIndex((x) => x.id === id)
    setDragRowId(id)
    const onMove = (ev: PointerEvent) => {
      if (dragRowRef.current !== id) return
      const rows = Array.from(document.querySelectorAll<HTMLElement>('.dsh-wt_photoRow'))
      if (rows.length === 0) return
      // 槽位制：按固定行高算最近槽位；边界 ±0.12 行高为死区，未决定性越过前不切换
      const first = rows[0].getBoundingClientRect()
      const h = first.height
      const rel = (ev.clientY - first.top) / h
      let t = Math.max(0, Math.min(rows.length - 1, Math.floor(rel + 0.5)))
      const frac = rel - Math.floor(rel)
      if (Math.abs(frac - 0.5) < 0.12) t = lastTargetRef.current
      if (t === lastTargetRef.current) return
      const from = photoList.findIndex((x) => x.id === id)
      if (from < 0) return
      const rects = new Map<string, { x: number; y: number }>()
      rows.forEach((el) => { const k = el.dataset.rid ?? ''; const r = el.getBoundingClientRect(); rects.set(k, { x: r.left, y: r.top }) })
      const next = [...photoList]
      const moved = next.splice(from, 1)[0]
      const to = Math.max(0, Math.min(t, next.length))
      next.splice(to, 0, moved)
      dragFlipRef.current = rects
      setPhotoList(next)
      lastTargetRef.current = t
    }
    const onUp = () => {
      dragRowRef.current = null
      setDragRowId(null)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const ids = photoList.map((x) => x.id)
      void splitEnv?.console?.reorderPhotos?.(ids).catch(() => {})
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  /** 在媒体库中选中某条 */
  const selectPhoto = (p: { id: string; kind: 'photo' | 'video'; url: string }) => {
    setPhotoIdLocal(p.id)
    splitEnv?.console?.setPhotoId?.(p.id)
    photoUrlRef.current = p.url
    if (p.kind === 'video') { setBgPhoto(''); setBgVideo(p.url) } else { setBgVideo(''); setBgPhoto(p.url) }
    setBgState('photo')
    splitEnv?.console?.setBg?.('photo')
  }
  const onBgAlpha = (n: number) => {
    setBgAlphaState(n)
    splitEnv?.console?.setBgAlpha?.(n)
  }
  const [smoothMsg, setSmoothMsg] = useState('')
  /** ⚡ 一键修复卡顿壁纸：一次把「壁纸卡顿」的四个真实开销全降下来（每一项都可再单独调回）——
   *  ① 换轻量素材档（1920×882，像素只有高清档的 1/2.8；解码 + 缩放是最贵的一环）
   *  ② 壁纸磨砂 0（视频上不挂任何滤镜/模糊）
   *  ③ 卡片 backdrop-filter 归零（每帧对运动画面做模糊是第二大开销）
   *  ④ 静息特效关（几个全屏 canvas 停止逐帧重绘） */
  const applySmoothFix = () => {
    persistFxConf({ holoSrc: WALL_MEDIA_SMOOTH, wallBlur: 0, idleOn: false })
    setHoloDraft(WALL_MEDIA_SMOOTH)
    onModeBlur(bg === 'photo' ? 'photo' : bg === 'plain' ? 'plain' : 'glow', 0)
    setSmoothMsg('已应用流畅档：素材 ' + WALL_MEDIA_SMOOTH.split('/').pop() + ' · 磨砂 0 · 卡片模糊 0 · 静息特效关')
    window.setTimeout(() => setSmoothMsg(''), 8000)
  }
  const onBg = (m: 'off' | 'plain' | 'glow' | 'photo') => {
    if (m === 'photo') {
      // 直接切换到当前媒体；没有媒体时才进入二级菜单引导上传
      if (photoList.length === 0) { setBgEdit('photo'); return }
      setBgState('photo')
      splitEnv?.console?.setBg?.('photo')
      return
    }
    setBgState(m)
    splitEnv?.console?.setBg?.(m)
  }
  const editHsl = (kind: 'plain' | 'glow' | 'photo', patch: Partial<{ h: number; s: number; l: number }>) => {
    if (kind === 'plain') {
      const next = { ...plainHsl, ...patch }
      setPlainHslState(next)
      splitEnv?.console?.setPlainHsl?.(next)
    } else if (kind === 'glow') {
      const next = { ...glowHsl, ...patch }
      setGlowHslState(next)
      splitEnv?.console?.setGlowHsl?.(next)
    } else {
      const next = { ...photoHsl, ...patch }
      setPhotoHslState(next)
      if (photoId) splitEnv?.console?.setPhotoHsl?.(photoId, next)
    }
  }
  const resetHsl = (kind: 'plain' | 'glow' | 'photo') => {
    // 恢复初始：连同贴片模糊(B)/网格不透明度(T)一起复位（纯色 B=0，流光/自定义 B=8）
    const blurDef = kind === 'plain' ? 0 : 8
    if (kind === 'plain') {
      setPlainBlurState(blurDef); splitEnv?.console?.setPlainBlur?.(blurDef)
      setPlainGridState(5); splitEnv?.console?.setPlainGrid?.(5)
    } else if (kind === 'glow') {
      setGlowBlurState(blurDef); splitEnv?.console?.setGlowBlur?.(blurDef)
      setGlowGridState(8); splitEnv?.console?.setGlowGrid?.(8)
      setGlowSpeedState(50); splitEnv?.console?.setGlowSpeed?.(50)
    } else {
      setCardBlurState(blurDef); splitEnv?.console?.setCardBlur?.(blurDef)
      setGridOpacityState(8); splitEnv?.console?.setGridOpacity?.(8)
    }
    if (kind === 'plain') {
      const def = resolvedTheme === 'light' ? { ...PLAIN_HSL_LIGHT } : { ...PLAIN_HSL_DARK }
      setPlainHslState(def)
      splitEnv?.console?.setPlainHsl?.(def)
    } else if (kind === 'glow') {
      setGlowHslState({ h: 0, s: 100, l: 100 })
      splitEnv?.console?.setGlowHsl?.({ h: 0, s: 100, l: 100 })
    } else {
      setPhotoHslState({ h: 0, s: 100, l: 100 })
      if (photoId) splitEnv?.console?.setPhotoHsl?.(photoId, { h: 0, s: 100, l: 100 })
      // 照片网格线开关一并复位为默认「开」
      setPhotoGridState(true); splitEnv?.console?.setPhotoGrid?.(true)
    }
  }
  useLayoutEffect(() => {
    const first = firstRectsRef.current
    if (!first) return
    const grid = gridRef.current
    if (!grid) return
    grid.querySelectorAll('.dsh-wt_consoleCard').forEach((el) => {
      const key = (el as HTMLElement).dataset.flip ?? ''
      const f = first.get(key)
      if (!f) return
      const r = el.getBoundingClientRect()
      const dx = f.x - r.left
      const dy = f.y - r.top
      if (dx || dy) {
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 450, easing: 'cubic-bezier(.22,.61,.36,1)' })
      }
    })
    firstRectsRef.current = null
  }, [cols])
  const [themeMode, setThemeMode] = useState<'dark' | 'light' | 'system'>(() => splitEnv?.console?.getTheme?.() ?? 'system')
  const [sysDark, setSysDark] = useState(() => {
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches } catch { return true }
  })
  useEffect(() => {
    const env = splitEnv?.console
    if (!env) return
    const bump = () => { setTick((t) => t + 1); setThemeMode(env.getTheme?.() ?? 'system') }
    const un = env.subscribe(bump)
    bump()
    return un
  }, [])
  // 跟随系统：监听 OS 深浅切换（仅 themeMode==='system' 时影响渲染）
  useEffect(() => {
    let mq: MediaQueryList | null = null
    try { mq = window.matchMedia('(prefers-color-scheme: dark)') } catch {}
    if (!mq) return
    const f = (e: any) => setSysDark(!!e?.matches)
    try { mq.addEventListener('change', f) } catch { try { (mq as any).addListener(f) } catch {} }
    return () => { try { mq.removeEventListener('change', f) } catch { try { (mq as any).removeListener(f) } catch {} } }
  }, [])
  // 大屏自动扩容：内容区够宽时自动增加每行卡片数（只增不减，dock「每行数量」仍可手动改）
  useEffect(() => {
    const el = paneRef.current
    if (!el || typeof ResizeObserver !== 'function') return
    let raf = 0
    const ro = new ResizeObserver(() => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        try {
          const w = el.clientWidth
          if (w < 160) return
          const maxCols = Math.min(6, Math.max(1, Math.floor((w - 8 + 56) / (250 + 56))))
          if (maxCols > 1) setColsState((cur) => (maxCols > cur ? (splitEnv?.console?.setCols?.(maxCols), maxCols) : cur))
        } catch { /* 测量失败忽略 */ }
      })
    })
    ro.observe(el)
    return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf) }
  }, [])
  // 打开控制室 = 预热所有绑定会话的最近消息（冷会话走宿主 history 只读通道）
  useEffect(() => {
    splitEnv?.console?.refreshPreviews?.()
  }, [])
  // 自动检查更新（节流一天；手动按钮始终 force）
  useEffect(() => { if (getAutoCheck()) void runUpdateCheck(false) }, [])
  // 背景照片库：IndexedDB 异步加载记录 → 对象 URL；无记录则空
  useEffect(() => {
    let alive = true
    splitEnv?.console?.getPhotoLib?.().then((lib) => {
      if (!alive) return
      setPhotoList(lib.list)
      const active = lib.list.find((p) => p.id === lib.activeId) ?? lib.list[0] ?? null
      if (active) {
        setPhotoIdLocal(active.id)
        photoUrlRef.current = active.url
        setBgVideo(active.kind === 'video' ? active.url : '')
        setBgPhoto(active.kind === 'video' ? '' : active.url)
      }
    }).catch(() => {})
    return () => { alive = false }
  }, [])
  // 当前照片切换 → 载入该照片记住的 HSL 调节值
  useEffect(() => {
    if (!photoId) return
    setPhotoHslState(splitEnv?.console?.getPhotoHsl?.(photoId) ?? { h: 0, s: 100, l: 100 })
  }, [photoId])
  // 面板卸载时释放对象 URL
  useEffect(() => () => { if (photoUrlRef.current) { try { URL.revokeObjectURL(photoUrlRef.current) } catch {} } }, [])
  // 运行时长的分钟级刷新：每秒重渲染一次（仅控制室开着时存在）
  useEffect(() => {
    const iv = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(iv)
  }, [])
  void now
  const env = splitEnv?.console
  const cards = env ? env.getCards() : []

  // ── 特效偏好（✨ 面板）：开关 / 静息浓度 / 忙碌蝴蝶数 ──
  const [fxUi, setFxUi] = useState<FxConf>(getFxConf)
  useEffect(() => subscribeFxConf(() => setFxUi(getFxConf())), [])
  /** 全息素材输入草稿：回车/失焦才落盘（避免边打字边刷新全屏壁纸） */
  const [holoDraft, setHoloDraft] = useState<string>(() => getFxConf().holoSrc)

  // ── 「操控电脑」：快捷指令发到控制室绑定会话（AI 执行，系统操作需宿主授权）──
  const [rmtText, setRmtText] = useState('')
  const [rmtMsg, setRmtMsg] = useState('')
  const [rmtBusy, setRmtBusy] = useState(false)
  const runRemote = async (text: string) => {
    const t = (text || '').trim()
    if (!t || rmtBusy || !env) return
    setRmtBusy(true)
    setRmtMsg('')
    try {
      const ok = await (env.sendRemote?.(t) ?? Promise.resolve(false))
      setRmtMsg(ok ? '✓ 已发送到控制室绑定会话' : '未绑定会话：先点控制室卡片 ⊙ 绑定一个对话')
    } catch (e) {
      setRmtMsg(String(e))
    } finally {
      setRmtBusy(false)
    }
  }
  // 背景一键预设（切换流光并写入对应色相滤镜；光效氛围）
  const applyBgPreset = (p: { h: number; s: number; l: number }) => {
    onBg('glow')
    setGlowHslState({ ...p })
    env?.setGlowHsl?.({ ...p })
    setOpenMenu(null)
  }
  const resolvedTheme: 'dark' | 'light' = (() => {
    if (themeMode !== 'system') return themeMode
    try {
      const cs = getComputedStyle(document.documentElement).colorScheme || ''
      if (cs.includes('dark') && !cs.includes('light')) return 'dark'
      if (cs.includes('light') && !cs.includes('dark')) return 'light'
    } catch {}
    return sysDark ? 'dark' : 'light'
  })()
  const setTheme = (th: 'dark' | 'light' | 'system') => { setThemeMode(th); env?.setTheme?.(th) }
  // 主题联动：切换主题时，若纯色还是另一主题的默认值 → 自动跟随新主题默认；自定义过则保持
  const prevPlainThemeRef = useRef<'dark' | 'light' | null>(null)
  useEffect(() => {
    const prev = prevPlainThemeRef.current
    prevPlainThemeRef.current = resolvedTheme
    if (!prev || prev === resolvedTheme) return
    const isDarkDef = plainHsl.h === PLAIN_HSL_DARK.h && plainHsl.s === PLAIN_HSL_DARK.s && plainHsl.l === PLAIN_HSL_DARK.l
    const isLightDef = plainHsl.h === PLAIN_HSL_LIGHT.h && plainHsl.s === PLAIN_HSL_LIGHT.s && plainHsl.l === PLAIN_HSL_LIGHT.l
    const next = resolvedTheme === 'light' && isDarkDef ? { ...PLAIN_HSL_LIGHT }
      : resolvedTheme === 'dark' && isLightDef ? { ...PLAIN_HSL_DARK } : null
    if (next) {
      setPlainHslState(next)
      splitEnv?.console?.setPlainHsl?.(next)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedTheme])
  const fmtDur = (ms: number) => {
    const s = Math.max(0, Math.floor(ms / 1000))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const ss = s % 60
    return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0') : m + ':' + String(ss).padStart(2, '0')
  }
  const statusLabel: Record<string, string> = { idle: T('console.idle'), busy: T('console.busy'), need: T('console.need'), done: T('console.done') }
  const themeOpts: { mode: 'dark' | 'light' | 'system'; key: string }[] = [
    { mode: 'dark', key: 'console.themeDark' },
    { mode: 'light', key: 'console.themeLight' },
    { mode: 'system', key: 'console.themeSystem' },
  ]
  return (
    <div ref={paneRef} className="dsh-wt_console" data-wt-theme={resolvedTheme} data-wt-shape={shape} data-wt-bg={bg} data-wt-grid={bg === 'photo' && !photoGrid ? 'off' : 'on'} style={{ ...(bg === 'plain' ? { ['--wt-bg' as any]: 'hsl(' + plainHsl.h + ', ' + plainHsl.s + '%, ' + plainHsl.l + '%)', ['--wt-gridPlain' as any]: 'rgba(255,255,255,' + (plainGrid / 100) + ')', ['--wt-gridPlainLight' as any]: 'rgba(27,31,36,' + (plainGrid / 100) + ')' } : {}), ...(bg === 'glow' ? { ['--wt-gridGlow' as any]: 'rgba(255,255,255,' + (glowGrid / 100) + ')', ['--wt-gridGlowLight' as any]: 'rgba(27,31,36,' + (glowGrid / 100) + ')', ['--wt-glowScale' as any]: glowSpeed === 0 ? '100000000' : String(50 / glowSpeed) } : {}), ...(bg === 'photo' ? { ['--wt-gridPhoto' as any]: 'rgba(255,255,255,' + (gridOpacity / 100) + ')' } : {}), ['--wt-cardBlur' as any]: (bg === 'plain' ? plainBlur : bg === 'glow' ? glowBlur : cardBlur) + 'px', ['--wt-bgAlpha' as any]: String(bgAlpha / 100) }}>
      <span className="dsh-wt_consoleBg" aria-hidden style={bg === 'glow' && (glowHsl.h !== 0 || glowHsl.s !== 100 || glowHsl.l !== 100) ? { filter: 'hue-rotate(' + glowHsl.h + 'deg) saturate(' + glowHsl.s + '%) brightness(' + glowHsl.l + '%)' } : undefined}>
        {bg === 'photo' && (bgVideo
          ? <ConsoleVideo src={bgVideo} style={photoHsl.h !== 0 || photoHsl.s !== 100 || photoHsl.l !== 100 ? { filter: 'hue-rotate(' + photoHsl.h + 'deg) saturate(' + photoHsl.s + '%) brightness(' + photoHsl.l + '%)' } : undefined} />
          : bgPhoto ? <img className="dsh-wt_consoleMedia" src={bgPhoto} alt="" style={photoHsl.h !== 0 || photoHsl.s !== 100 || photoHsl.l !== 100 ? { filter: 'hue-rotate(' + photoHsl.h + 'deg) saturate(' + photoHsl.s + '%) brightness(' + photoHsl.l + '%)' } : undefined} /> : null)}
        {bg === 'glow' && (<><i className="dsh-wt_blob dsh-wt_blob1" /><i className="dsh-wt_blob dsh-wt_blob2" /><i className="dsh-wt_blob dsh-wt_blob3" /><i className="dsh-wt_blob dsh-wt_blob4" /></>)}</span>
      {/* 静息宇宙背景板：旋转星系 + 粒子群（canvas，卡片下层唯美动态）。
          它是「静息特效」家族的一员 → 跟随 idleOn 与「全部静息动效」总开关：
          任一道闸门关掉就不挂载（canvas 不再逐帧重绘；⚡一键流畅 会一并关掉它）。 */}
      {fxUi.allIdle && fxUi.idleOn && (
        <div className="dsh-wt_consoleCosmos" aria-hidden>
          <CosmicField key={'cf' + fxUi.pal} />
        </div>
      )}
      {/* 看板娘（Live2D）：叠加层，位于背景/宇宙之上、卡片之下；仅在开启时挂载并加载 CDN */}
      {petOn && <ConsolePet model={petModel} pos={petPos} pane={paneRef} onStatus={setPetStatus} onMove={onPetMove} />}
      {openMenu !== null && <div className="dsh-wt_dropMask" onClick={() => setOpenMenu(null)} />}
      <div className="dsh-wt_consoleScroll">
        {annOpen ? (
          <div className="dsh-wt_announceCtr">
          <div className="dsh-wt_announce">
            <div className="dsh-wt_announceHead">
              <span className="dsh-wt_announceVer">{T('annot.curVer')} v{LOCAL_VERSION}</span>
              <button type="button" className="dsh-wt_announceBtn" disabled={updStatus === 'checking'} onClick={() => runUpdateCheck(true)}>{updStatus === 'checking' ? T('annot.checking') : T('annot.checkNow')}</button>
              <span className="dsh-wt_announceAuto">{T('annot.autoCheck')}</span>
              <button type="button" className={'dsh-wt_switch' + (autoCheckOn ? ' dsh-wt_switchOn' : '')} aria-pressed={autoCheckOn} aria-label={T('annot.autoCheck')} onClick={onAutoCheckToggle}><span className="dsh-wt_switchKnob" /></button>
            </div>
            {updInfo && (
              <div className="dsh-wt_announceUpdate">
                <span className="dsh-wt_announceNewVer">{T('annot.newVer')} v{updInfo.latest}</span>
                <button type="button" className={'dsh-wt_announceUpg' + (updCopied ? ' dsh-wt_announceUpgOk' : '')} onClick={onCopyUpgrade}>{updCopied ? T('annot.copied') : T('annot.copyUpgrade')}</button>
                <button type="button" className="dsh-wt_announceSkip dsh-wt_announceSkipGo" onClick={() => { try { window.open(updInfo.url, '_blank') } catch {} }}>{T('annot.gotoRelease')}</button>
                <button type="button" className="dsh-wt_announceSkip" onClick={onSkipVersion}>{T('annot.skipVer')}</button>
                <div className="dsh-wt_announceHow">{T('annot.howUpdate')}</div>
              </div>
            )}
            {updStatus === 'failed' && <div className="dsh-wt_announceStatus">{T('annot.checkFail')}</div>}
            {updStatus === 'uptodate' && !updInfo && <div className="dsh-wt_announceStatus">{T('annot.latest')}</div>}
            <div className="dsh-wt_announceBody">{CHANGELOG_V030}</div>
          </div>
          </div>
        ) : (
        <div ref={gridRef} className="dsh-wt_consoleGrid" style={{ ['--wt-cols' as any]: cols }}>
        {cards.map((c) => (
          <div
            key={c.id}
            data-flip={c.id}
            role={c.self ? undefined : 'button'}
            tabIndex={c.self ? -1 : 0}
            className={'dsh-wt_consoleCard' + (c.self ? ' dsh-wt_consoleCardSelf' : '')
              + (c.status === 'busy' ? ' dsh-wt_consoleCard-busy' : '')
              + (c.glow && c.status === 'done' ? ' dsh-wt_consoleCard-glowDone' : '')
              + (c.glow && c.status === 'need' ? ' dsh-wt_consoleCard-glowNeed' : '')}
            title={c.name}
            onClick={() => {
              if (c.self || !env) return
              if (c.glow) env.onAck?.(c.id) // 点发光卡片：先确认熄光，再进入
              env.onOpen(c.id)
            }}
          >
            <div className="dsh-wt_consoleCardHead">
              <span className="dsh-wt_consoleIcon" aria-hidden>{c.icon}</span>
              <span className="dsh-wt_consoleName">{c.name}</span>
            </div>
            <div className="dsh-wt_consoleDivider" aria-hidden />
            <div className="dsh-wt_consoleStatusRow">
              <span className={'dsh-wt_consoleStatus dsh-wt_consoleStatus-' + c.status}>{statusLabel[c.status]}</span>
              {c.runtimeMs != null && <span className="dsh-wt_consoleRuntime">{fmtDur(c.runtimeMs)}</span>}
            </div>
            {c.status === 'busy' && <span className="dsh-wt_consoleSweep" aria-hidden />}
            <div className={'dsh-wt_consolePreview' + (c.preview ? '' : ' dsh-wt_consolePreviewNone')} title={c.preview}>
              {c.preview || (c.bound ? T('console.noPreview') : T('console.unboundShort'))}
            </div>
          </div>
        ))}
        {/* 创建卡片：永远最后一位；点击 = 侧栏工作台「添加项目」同款流程 */}
        <div
          role="button"
          tabIndex={0}
          className="dsh-wt_consoleCard dsh-wt_consoleAdd"
          title={T('console.addProject')}
          onClick={() => env?.onAdd?.()}
        >
          <span className="dsh-wt_consoleAddPlus" aria-hidden>＋</span>
          <span className="dsh-wt_consoleAddLabel">{T('console.addProject')}</span>
        </div>
        {cards.length === 0 && <div className="dsh-wt_consoleEmpty">{T('console.empty')}</div>}
        </div>
        )}
      </div>
      <div className="dsh-wt_consoleDockWrap">
        <div className="dsh-wt_consoleDock">
          <button type="button" className={'dsh-wt_dockBtn' + (openMenu === 'theme' ? ' dsh-wt_dockBtnOn' : '')} title={T('console.themeLabel')} aria-label={T('console.themeLabel')} onClick={() => setOpenMenu(openMenu === 'theme' ? null : 'theme')}><ThemeIcon mode={themeMode} /></button>
          <button type="button" className={'dsh-wt_dockBtn' + (openMenu === 'shape' ? ' dsh-wt_dockBtnOn' : '')} title={T('console.shapeLabel')} aria-label={T('console.shapeLabel')} onClick={() => setOpenMenu(openMenu === 'shape' ? null : 'shape')}><svg width="20" height="20" viewBox="0 0 16 16" aria-hidden><rect x="2.2" y="2.2" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="0.9" /><circle cx="10.6" cy="10.6" r="3.8" fill="none" stroke="currentColor" strokeWidth="0.9" /></svg></button>
          <button type="button" className={'dsh-wt_dockBtn' + (openMenu === 'bg' ? ' dsh-wt_dockBtnOn' : '')} title={T('console.bgLabel')} aria-label={T('console.bgLabel')} onClick={() => { setOpenMenu(openMenu === 'bg' ? null : 'bg'); setBgEdit(null) }}><svg width="18" height="18" viewBox="0 0 16 16" aria-hidden><rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.6" fill="none" stroke="currentColor" strokeWidth="0.9" /><circle cx="5.9" cy="6.7" r="1.05" fill="none" stroke="currentColor" strokeWidth="0.8" /><path d="M3.4 11.4l3-3 2.3 2.3 1.9-1.9 3 2.6" fill="none" stroke="currentColor" strokeWidth="0.9" /></svg></button>
          <button type="button" className={'dsh-wt_dockBtn' + (openMenu === 'cols' ? ' dsh-wt_dockBtnOn' : '')} title={T('console.colsLabel')} aria-label={T('console.colsLabel')} onClick={() => setOpenMenu(openMenu === 'cols' ? null : 'cols')}><svg width="20" height="20" viewBox="0 0 16 16" aria-hidden><rect x="2.2" y="3.4" width="2.7" height="9.2" rx="0.9" fill="none" stroke="currentColor" strokeWidth="0.9" /><rect x="6.65" y="3.4" width="2.7" height="9.2" rx="0.9" fill="none" stroke="currentColor" strokeWidth="0.9" /><rect x="11.1" y="3.4" width="2.7" height="9.2" rx="0.9" fill="none" stroke="currentColor" strokeWidth="0.9" /></svg></button>
          <button type="button" className={'dsh-wt_dockBtn' + (annOpen ? ' dsh-wt_dockBtnOn' : '')} title={T('annot.updateTitle')} aria-label={T('annot.updateTitle')} onClick={() => { setOpenMenu(null); setAnnOpen((v) => !v) }}><svg width="18" height="18" viewBox="0 0 16 16" aria-hidden><path d="M2.6 7c0-2.9 2.4-4.9 5.4-4.9s5.4 2 5.4 4.9v2.9l1.2 1.7H1.4l1.2-1.7z" fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinejoin="round" /><path d="M6.2 12.9c.3.7 1 1.2 1.8 1.2s1.5-.5 1.8-1.2" fill="none" stroke="currentColor" strokeWidth="0.9" strokeLinecap="round" /></svg>{updInfo && <span className="dsh-wt_dockBadge" aria-hidden />}</button>
          <button type="button" className={'dsh-wt_dockBtn' + (openMenu === 'pc' ? ' dsh-wt_dockBtnOn' : '')} title="操控电脑" aria-label="操控电脑" onClick={() => { setOpenMenu(openMenu === 'pc' ? null : 'pc'); setAnnOpen(false) }}><span className="dsh-wt_dockEmoji" aria-hidden>⚡</span></button>
          <button type="button" className={'dsh-wt_dockBtn' + (openMenu === 'fx' ? ' dsh-wt_dockBtnOn' : '')} title="特效" aria-label="特效" onClick={() => { setOpenMenu(openMenu === 'fx' ? null : 'fx'); setAnnOpen(false) }}><span className="dsh-wt_dockEmoji" aria-hidden>✨</span></button>
          <button type="button" className={'dsh-wt_dockBtn' + (openMenu === 'pet' ? ' dsh-wt_dockBtnOn' : '')} title={T('console.petLabel')} aria-label={T('console.petLabel')} onClick={() => { setOpenMenu(openMenu === 'pet' ? null : 'pet'); setAnnOpen(false) }}><span className="dsh-wt_dockEmoji" aria-hidden>🐾</span></button>
          <button type="button" className="dsh-wt_dockBtn" title={T('dh.entryHint')} aria-label={T('dh.entryHint')} onClick={() => { setOpenMenu(null); setAnnOpen(false); env?.toggleDh?.() }}><span className="dsh-wt_dockEmoji" aria-hidden>💃</span></button>
        </div>
        {openMenu === 'theme' && (
          <div className="dsh-wt_drop">
            {themeOpts.map((o) => (
              <button key={o.mode} type="button" className={'dsh-wt_dropItem' + (themeMode === o.mode ? ' dsh-wt_dropItemOn' : '')} onClick={() => setTheme(o.mode)}><ThemeIcon mode={o.mode} size={13} />{T(o.key)}</button>
            ))}
          </div>
        )}
        {openMenu === 'shape' && (
          <div className="dsh-wt_drop">
            <button type="button" className={'dsh-wt_dropItem' + (shape === 'square' ? ' dsh-wt_dropItemOn' : '')} onClick={() => onShape('square')}><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><rect x="4" y="4" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>{T('console.shapeSquare')}</button>
            <button type="button" className={'dsh-wt_dropItem' + (shape === 'circle' ? ' dsh-wt_dropItemOn' : '')} onClick={() => onShape('circle')}><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>{T('console.shapeCircle')}</button>
          </div>
        )}
        {openMenu === 'bg' && (
          bgEdit === null ? (
            <div className="dsh-wt_drop">
              <div className="dsh-wt_rmtTitle" style={{ marginBottom: 2 }}>一键氛围预设</div>
              <div className="dsh-wt_dropRow">
                <button type="button" className="dsh-wt_dropItem dsh-wt_dropItemSm" onClick={() => applyBgPreset({ h: 0, s: 100, l: 100 })}>🌌 夜色星云</button>
                <button type="button" className="dsh-wt_dropItem dsh-wt_dropItemSm" onClick={() => applyBgPreset({ h: -28, s: 118, l: 103 })}>🌅 霞光流金</button>
              </div>
              <div className="dsh-wt_dropRow">
                <button type="button" className="dsh-wt_dropItem dsh-wt_dropItemSm" onClick={() => applyBgPreset({ h: 26, s: 112, l: 101 })}>🌸 初雪粉霞</button>
                <button type="button" className="dsh-wt_dropItem dsh-wt_dropItemSm" onClick={() => applyBgPreset({ h: 165, s: 112, l: 102 })}>🌙 月白银蓝</button>
              </div>
              <div className="dsh-wt_dropDiv" />
              <div className="dsh-wt_dropRow">
                <button type="button" className={'dsh-wt_dropItem' + (bg === 'off' ? ' dsh-wt_dropItemOn' : '')} onClick={() => onBg('off')}><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M4.1 11.9 11.9 4.1" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>{T('console.bgOff')}</button>
              </div>
              <div className="dsh-wt_dropRow">
                <button type="button" className={'dsh-wt_dropItem' + (bg === 'plain' ? ' dsh-wt_dropItemOn' : '')} onClick={() => onBg('plain')}><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><rect x="3" y="3" width="10" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>{T('console.bgPlain')}</button>
                <button type="button" className="dsh-wt_dropGear" title={T('console.bgEdit')} aria-label={T('console.bgEdit')} onClick={() => setBgEdit('plain')}><SliderIcon /></button>
              </div>
              <div className="dsh-wt_dropRow">
                <button type="button" className={'dsh-wt_dropItem' + (bg === 'glow' ? ' dsh-wt_dropItemOn' : '')} onClick={() => onBg('glow')}><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><path d="M2.4 5.6c2-1.5 3.9-1.5 5.6 0 1.9 1.6 3.6 1.6 5.6 0M2.4 10.4c2-1.5 3.9-1.5 5.6 0 1.9 1.6 3.6 1.6 5.6 0" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>{T('console.bgGlow')}</button>
                <button type="button" className="dsh-wt_dropGear" title={T('console.bgEdit')} aria-label={T('console.bgEdit')} onClick={() => setBgEdit('glow')}><SliderIcon /></button>
              </div>
              <div className="dsh-wt_dropRow">
                <button type="button" className={'dsh-wt_dropItem' + (bg === 'photo' ? ' dsh-wt_dropItemOn' : '')} onClick={() => onBg('photo')}><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" /><circle cx="5.8" cy="6.6" r="1.1" fill="currentColor" /><path d="M3.2 11.2l2.8-2.8 2.2 2.2 1.8-1.8 2.8 2.4" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>{T('console.bgCustom')}</button>
                <button type="button" className="dsh-wt_dropGear" title={T('console.bgEdit')} aria-label={T('console.bgEdit')} onClick={() => setBgEdit('photo')}><SliderIcon /></button>
              </div>
            </div>
          ) : (
            <div className={'dsh-wt_drop' + (bgEdit === 'photo' ? ' dsh-wt_dropWide' : '')}>
              <div className="dsh-wt_hslHead">
                <button type="button" className="dsh-wt_hslBack" title={T('console.bgEditBack')} aria-label={T('console.bgEditBack')} onClick={() => setBgEdit(null)}><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden><path d="M10.2 3.2 5.4 8l4.8 4.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
                <span className="dsh-wt_hslTitle">{bgEdit === 'plain' ? T('console.bgEditPlain') : bgEdit === 'glow' ? T('console.bgEditGlow') : T('console.bgEditPhoto')}</span>
              </div>
              {bgEdit === 'photo' && (
                <>
                  <div className="dsh-wt_dropRow">
                    <button type="button" className="dsh-wt_dropItem" onClick={pickPhotoFile}><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.2" /><circle cx="5.8" cy="6.6" r="1.1" fill="currentColor" /><path d="M3.2 11.2l2.8-2.8 2.2 2.2 1.8-1.8 2.8 2.4" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>{T('console.bgPhoto')}</button>
                    <div className="dsh-wt_gridHalf">
                      <span className="dsh-wt_gridLabel">{T('console.bgGridLabel')}</span>
                      <button type="button" className={'dsh-wt_switch' + (photoGrid ? ' dsh-wt_switchOn' : '')} aria-pressed={photoGrid} aria-label={T('console.bgGridLabel')} onClick={togglePhotoGrid}><span className="dsh-wt_switchKnob" /></button>
                    </div>
                  </div>
                  {photoList.length > 0 ? (
                    photoList.slice(0, 4).map((p) => (
                      <div key={p.id} data-rid={p.id} className={'dsh-wt_dropRow dsh-wt_photoRow' + (photoId === p.id ? ' dsh-wt_photoRowOn' : '')} onClick={() => selectPhoto(p)}>
                        <span className="dsh-wt_thumbWrap">
                          {p.kind === 'video'
                            ? <video className="dsh-wt_photoThumb" src={p.url} muted playsInline preload="metadata" />
                            : <img className="dsh-wt_photoThumb" src={p.url} alt="" />}
                          <span className="dsh-wt_thumbBadge" aria-hidden>{p.kind === 'video'
                            ? <svg width="8" height="8" viewBox="0 0 16 16"><path d="M4.5 3.8l8 4.2-8 4.2z" fill="currentColor" /></svg>
                            : <svg width="8" height="8" viewBox="0 0 16 16"><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M3.4 11l2.6-2.6 2.1 2.1 1.7-1.7 2.8 2.4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>}</span>
                        </span>
                        <span className="dsh-wt_photoName">{photoId === p.id ? T('console.bgPhotoCurrent') : T('console.bgPhotoUse')}</span>
                        <button type="button" className={'dsh-wt_dragHandle' + (dragRowId === p.id ? ' dsh-wt_dragHandleOn' : '')} title={T('console.bgMediaDrag')} aria-label={T('console.bgMediaDrag')} onPointerDown={(e) => onHandleDown(p.id, e)}><svg width="10" height="12" viewBox="0 0 10 12" aria-hidden><circle cx="2.5" cy="2" r="1.1" fill="currentColor" /><circle cx="7.5" cy="2" r="1.1" fill="currentColor" /><circle cx="2.5" cy="6" r="1.1" fill="currentColor" /><circle cx="7.5" cy="6" r="1.1" fill="currentColor" /><circle cx="2.5" cy="10" r="1.1" fill="currentColor" /><circle cx="7.5" cy="10" r="1.1" fill="currentColor" /></svg></button>
                        <button type="button" className="dsh-wt_dropTrash" title={T('console.bgPhotoDelete')} aria-label={T('console.bgPhotoDelete')} onClick={(e) => { e.stopPropagation(); removePhotoById(p) }}><svg width="11" height="11" viewBox="0 0 16 16" aria-hidden><path d="M2.5 4.2h11M6.5 4.2V2.9c0-.6.4-1 .9-1h1.2c.5 0 .9.4.9 1v1.3M4.2 4.2l.5 8.1c0 .7.5 1.2 1.2 1.2h4.2c.7 0 1.2-.5 1.2-1.2l.5-8.1" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg></button>
                      </div>
                    ))
                  ) : (
                    <div className="dsh-wt_photoEmpty">{T('console.bgPhotoNone')}</div>
                  )}
                  <div className="dsh-wt_hslDivider" />
                </>
              )}
              {(() => {
                const v = bgEdit === 'plain' ? plainHsl : bgEdit === 'glow' ? glowHsl : photoHsl
                const sMax = bgEdit === 'plain' ? 100 : 200
                const lMax = bgEdit === 'plain' ? 100 : 200
                return (<>
                  <div className="dsh-wt_hslRow" data-tip={T('console.bgTipA')}><span className="dsh-wt_hslLabel">A</span><input className="dsh-wt_hslSlider" type="range" min={0} max={100} step={5} value={bgAlpha} onChange={(e) => onBgAlpha(Number(e.target.value))} /><HslValInput value={bgAlpha} min={0} max={100} onCommit={onBgAlpha} /></div>
                  {bgEdit === 'glow' && (
                    <div className="dsh-wt_hslRow" data-tip={T('console.bgTipSpeed')}><span className="dsh-wt_hslLabel">S</span><input className="dsh-wt_hslSlider" type="range" min={0} max={100} step={5} value={glowSpeed} onChange={(e) => onGlowSpeed(Number(e.target.value))} /><HslValInput value={glowSpeed} min={0} max={100} onCommit={onGlowSpeed} /></div>
                  )}
                  <div className="dsh-wt_hslRow" data-tip={T('console.bgTipB')}><span className="dsh-wt_hslLabel">B</span><input className="dsh-wt_hslSlider" type="range" min={0} max={20} step={1} value={bgEdit === 'plain' ? plainBlur : bgEdit === 'glow' ? glowBlur : cardBlur} onChange={(e) => onModeBlur(bgEdit, Number(e.target.value))} /><HslValInput value={bgEdit === 'plain' ? plainBlur : bgEdit === 'glow' ? glowBlur : cardBlur} min={0} max={20} onCommit={(n) => onModeBlur(bgEdit, n)} /></div>
                  <div className="dsh-wt_hslRow" data-tip={T('console.bgTipT')}><span className="dsh-wt_hslLabel">T</span><input className="dsh-wt_hslSlider" type="range" min={0} max={30} step={1} value={bgEdit === 'plain' ? plainGrid : bgEdit === 'glow' ? glowGrid : gridOpacity} onChange={(e) => bgEdit === 'photo' ? onGridOpacity(Number(e.target.value)) : onModeGrid(bgEdit, Number(e.target.value))} /><HslValInput value={bgEdit === 'plain' ? plainGrid : bgEdit === 'glow' ? glowGrid : gridOpacity} min={0} max={30} onCommit={(n) => bgEdit === 'photo' ? onGridOpacity(n) : onModeGrid(bgEdit, n)} /></div>
                  <div className="dsh-wt_hslRow" data-tip={T('console.bgTipH')}><span className="dsh-wt_hslLabel">H</span><input className="dsh-wt_hslSlider" type="range" min={-180} max={180} step={1} value={v.h} onChange={(e) => editHsl(bgEdit, { h: Number(e.target.value) })} /><HslValInput value={v.h} min={-180} max={180} onCommit={(n) => editHsl(bgEdit, { h: n })} /></div>
                  <div className="dsh-wt_hslRow" data-tip={T('console.bgTipS')}><span className="dsh-wt_hslLabel">S</span><input className="dsh-wt_hslSlider" type="range" min={0} max={sMax} step={1} value={v.s} onChange={(e) => editHsl(bgEdit, { s: Number(e.target.value) })} /><HslValInput value={v.s} max={sMax} onCommit={(n) => editHsl(bgEdit, { s: n })} /></div>
                  <div className="dsh-wt_hslRow" data-tip={T('console.bgTipL')}><span className="dsh-wt_hslLabel">L</span><input className="dsh-wt_hslSlider" type="range" min={0} max={lMax} step={1} value={v.l} onChange={(e) => editHsl(bgEdit, { l: Number(e.target.value) })} /><HslValInput value={v.l} max={lMax} onCommit={(n) => editHsl(bgEdit, { l: n })} /></div>
                  <button type="button" className="dsh-wt_hslReset" onClick={() => resetHsl(bgEdit)}>{T('console.bgEditReset')}</button>
                </>)
              })()}
            </div>
          )
        )}
        {openMenu === 'cols' && (
          <div className="dsh-wt_drop">
            <div className="dsh-wt_hbar">
              <span className="dsh-wt_hbarFill" style={{ width: (8 + (cols - 1) * 21) + '%' }} />
              {[1, 2, 3, 4, 5].map((v) => (
                <button key={v} type="button" className="dsh-wt_hbarLine" style={{ left: (8 + (v - 1) * 21) + '%' }} aria-label={String(v)} title={String(v)} onClick={() => onCols(v)}></button>
              ))}
              <span className="dsh-wt_hbarKnob" style={{ left: (8 + (cols - 1) * 21) + '%' }} />
            </div>
          </div>
        )}
        {openMenu === 'pet' && (
          <div className="dsh-wt_drop">
            <div className="dsh-wt_dropRow">
              <span className="dsh-wt_gridLabel">{T('console.petTitle')}</span>
              <button type="button" className={'dsh-wt_switch' + (petOn ? ' dsh-wt_switchOn' : '')} aria-pressed={petOn} aria-label={T('console.petTitle')} onClick={togglePet}><span className="dsh-wt_switchKnob" /></button>
            </div>
            <div className="dsh-wt_dropRow">
              {PET_MODELS.map((m, i) => (
                <button key={m.name} type="button" className={'dsh-wt_dropItem' + (petModel === i ? ' dsh-wt_dropItemOn' : '')} onClick={() => pickPetModel(i)}>{m.name}</button>
              ))}
            </div>
            <div className="dsh-wt_petNote">{!petOn ? T('console.petOff') : petStatus === 'loading' ? T('console.petLoading') : petStatus === 'failed' ? T('console.petFailed') : T('console.petHint')}</div>
          </div>
        )}
        {openMenu === 'pc' && (
          <div className="dsh-wt_drop dsh-wt_dropPc">
            <div className="dsh-wt_rmtTitle">⚡ 操控电脑：指令发给控制室绑定会话的 AI 执行（系统级操作仍需宿主授权）</div>
            {REMOTE_ACTIONS.map((a) => (
              <button key={a.k} type="button" className="dsh-wt_dropItem" disabled={rmtBusy} onClick={() => runRemote(a.text)}>{a.icon} {a.label}</button>
            ))}
            <div className="dsh-wt_dropDiv" />
            <div className="dsh-wt_rmtRow">
              <input className="dsh-wt_consoleInput" value={rmtText} disabled={rmtBusy} placeholder="自定义指令或命令…"
                onChange={(e) => setRmtText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && rmtText.trim() && !rmtBusy) { runRemote(rmtText); setRmtText('') } }} />
              <button type="button" className="dsh-wt_dropItem" disabled={rmtBusy || !rmtText.trim()} onClick={() => { runRemote(rmtText); setRmtText('') }}>{rmtBusy ? '…' : '发送'}</button>
            </div>
            {rmtMsg && <div className="dsh-wt_rmtMsg">{rmtMsg}</div>}
          </div>
        )}
        {openMenu === 'fx' && (
          <div className="dsh-wt_drop dsh-wt_dropFx">
            <div className="dsh-wt_fxRow"><span className="dsh-wt_fxLabel">🧊 全部静息动效</span><button type="button" className={'dsh-wt_switch' + (fxUi.allIdle ? ' dsh-wt_switchOn' : '')} aria-pressed={fxUi.allIdle} aria-label="全部静息动效" onClick={() => persistFxConf({ allIdle: !fxUi.allIdle })}><span className="dsh-wt_switchKnob" /></button></div>
            <div className="dsh-wt_fxNote">总开关：关 = 一次停掉静息层（藤蔓/星系/星尘/蝴蝶）+ 控制室星云 + 流光光晕动画 + 玻璃浮动（壁纸照常播放）。</div>
            <div className="dsh-wt_fxRow"><span className="dsh-wt_fxLabel">🕊️ 静息特效</span><button type="button" className={'dsh-wt_switch' + (fxUi.idleOn ? ' dsh-wt_switchOn' : '')} aria-pressed={fxUi.idleOn} aria-label="静息特效" onClick={() => persistFxConf({ idleOn: !fxUi.idleOn })}><span className="dsh-wt_switchKnob" /></button></div>
            <div className="dsh-wt_fxRow"><span className="dsh-wt_fxLabel">💫 忙碌特效</span><button type="button" className={'dsh-wt_switch' + (fxUi.busyOn ? ' dsh-wt_switchOn' : '')} aria-pressed={fxUi.busyOn} aria-label="忙碌特效" onClick={() => persistFxConf({ busyOn: !fxUi.busyOn })}><span className="dsh-wt_switchKnob" /></button></div>
            <div className="dsh-wt_fxRow"><span className="dsh-wt_fxLabel">静息浓度</span><span className="dsh-wt_fxSeg">
              {[{ v: 0, l: '淡' }, { v: 1, l: '柔' }, { v: 2, l: '亮' }].map((o) => (
                <button key={o.v} type="button" className={'dsh-wt_fxSegBtn' + (fxUi.idleLevel === o.v ? ' dsh-wt_fxSegBtnOn' : '')} onClick={() => persistFxConf({ idleLevel: o.v })}>{o.l}</button>
              ))}
            </span></div>
            <div className="dsh-wt_fxRow"><span className="dsh-wt_fxLabel">🦋 忙碌蝴蝶</span><span className="dsh-wt_fxSeg">
              {[0, 12, 20, 28, 40, 55].map((v) => (
                <button key={v} type="button" className={'dsh-wt_fxSegBtn' + (fxUi.bfly === v ? ' dsh-wt_fxSegBtnOn' : '')} onClick={() => persistFxConf({ bfly: v })}>{v === 0 ? '无' : v}</button>
              ))}
            </span></div>
            <div className="dsh-wt_fxRow"><span className="dsh-wt_fxLabel">🎨 特效色系</span><span className="dsh-wt_fxSeg">
              {[{ v: 0, l: '紫金' }, { v: 1, l: '银蓝' }, { v: 2, l: '暖金' }, { v: 3, l: '鸢尾' }, { v: 4, l: '黛青' }, { v: 5, l: '梵高' }].map((o) => (
                <button key={o.v} type="button" className={'dsh-wt_fxSegBtn' + (fxUi.pal === o.v ? ' dsh-wt_fxSegBtnOn' : '')} onClick={() => persistFxConf({ pal: o.v })}>{o.l}</button>
              ))}
            </span></div>
            <div className="dsh-wt_fxRow"><span className="dsh-wt_fxLabel">🖼️ 壁纸</span><span className="dsh-wt_fxSeg">
              {[{ v: 0, l: '关' }, { v: 1, l: '壁纸1·星夜' }, { v: 2, l: '视频壁纸' }].map((o) => (
                <button key={o.v} type="button" className={'dsh-wt_fxSegBtn' + (fxUi.wall === o.v ? ' dsh-wt_fxSegBtnOn' : '')} onClick={() => persistFxConf({ wall: o.v })}>{o.l}</button>
              ))}
            </span></div>
            <div className="dsh-wt_fxRow dsh-wt_fxRowCol">
              <button type="button" className="dsh-wt_fxFix" onClick={applySmoothFix}>⚡ 一键修复卡顿壁纸</button>
              {smoothMsg && <span className="dsh-wt_fxNote">{smoothMsg}</span>}
            </div>
            {fxUi.wall > 0 && (
              <div className="dsh-wt_fxRow dsh-wt_fxRowCol">
                <span className="dsh-wt_fxLabel">🌫 壁纸浓度 · {fxUi.wallAlpha}%</span>
                <input className="dsh-wt_hslSlider" type="range" min={0} max={WALL_ALPHA_MAX} step={5} value={fxUi.wallAlpha} aria-label="壁纸浓度"
                  onChange={(e) => persistFxConf({ wallAlpha: Number(e.target.value) })} />
                <span className="dsh-wt_fxNote">壁纸画在所有 UI 之下（z-index:-1）：满浓度也只会被 UI 盖住，不可能挡住 UI。100 = 原样，0 = 隐藏。</span>
              </div>
            )}
            <div className="dsh-wt_fxRow dsh-wt_fxRowCol">
              <span className="dsh-wt_fxLabel">🔎 壁纸磨砂 · {fxUi.wallBlur}px</span>
              <input className="dsh-wt_hslSlider" type="range" min={0} max={WALL_BLUR_MAX} step={1} value={fxUi.wallBlur} aria-label="壁纸磨砂"
                onChange={(e) => persistFxConf({ wallBlur: Number(e.target.value) })} />
              <span className="dsh-wt_fxNote">0 = 原画最清晰（默认）；调大 = 玻璃雾面。屏幕分辨率高于 1080p 时源片会被放大，磨砂保持 0 最清楚。</span>
            </div>
            <div className="dsh-wt_fxRow"><span className="dsh-wt_fxLabel">🪟 玻璃 UI</span><span className="dsh-wt_fxSeg">
              {[{ v: true, l: '开' }, { v: false, l: '关' }].map((o) => (
                <button key={String(o.v)} type="button" className={'dsh-wt_fxSegBtn' + (fxUi.glassOn === o.v ? ' dsh-wt_fxSegBtnOn' : '')} onClick={() => persistFxConf({ glassOn: o.v })}>{o.l}</button>
              ))}
            </span></div>
            {fxUi.glassOn && (
              <div className="dsh-wt_fxRow dsh-wt_fxRowCol">
                <span className="dsh-wt_fxLabel">🔍 UI 透明度 · {fxUi.glassAlpha}%</span>
                <input className="dsh-wt_hslSlider" type="range" min={0} max={GLASS_ALPHA_MAX} step={5} value={fxUi.glassAlpha} aria-label="UI 透明度"
                  onChange={(e) => persistFxConf({ glassAlpha: Number(e.target.value) })} />
                <span className="dsh-wt_fxNote">0 = 面板底色不透明（最清晰）；越高越透出壁纸。弹层/菜单保持高不透明度，不受影响。</span>
              </div>
            )}
            {fxUi.wall === 2 && (
              <>
                <div className="dsh-wt_fxRow"><span className="dsh-wt_fxLabel">🎬 素材档</span><span className="dsh-wt_fxSeg">
                  {[{ v: WALL_MEDIA_DEFAULT, l: '清晰' }, { v: WALL_MEDIA_SMOOTH, l: '流畅' }, { v: WALL_MEDIA_LITE, l: '极速' }].map((o) => (
                    <button key={o.v} type="button" className={'dsh-wt_fxSegBtn' + (fxUi.holoSrc === o.v ? ' dsh-wt_fxSegBtnOn' : '')} onClick={() => { persistFxConf({ holoSrc: o.v }); setHoloDraft(o.v) }}>{o.l}</button>
                  ))}
                </span></div>
                <div className="dsh-wt_fxRow"><span className="dsh-wt_fxLabel">🎨 调色</span><span className="dsh-wt_fxSeg">
                  {WALL_GRADES.map((o) => (
                    <button key={o.v} type="button" className={'dsh-wt_fxSegBtn' + (fxUi.wallGrade === o.v ? ' dsh-wt_fxSegBtnOn' : '')} onClick={() => persistFxConf({ wallGrade: o.v })}>{o.l}</button>
                  ))}
                </span></div>
                <div className="dsh-wt_fxRow"><span className="dsh-wt_fxLabel">✨ 处理风格</span><span className="dsh-wt_fxSeg">
                  {[{ v: 'native' as const, l: '原画' }, { v: 'glass' as const, l: '玻璃质感' }, { v: 'holo' as const, l: '全息' }].map((o) => (
                    <button key={o.v} type="button" className={'dsh-wt_fxSegBtn' + (fxUi.wallStyle === o.v ? ' dsh-wt_fxSegBtnOn' : '')} onClick={() => persistFxConf({ wallStyle: o.v })}>{o.l}</button>
                  ))}
                </span></div>
                <div className="dsh-wt_fxRow dsh-wt_fxRowCol">
                  <span className="dsh-wt_fxLabel">素材地址（本地媒体 / http(s) / data:）</span>
                  <input className="dsh-wt_consoleInput" value={holoDraft} placeholder="/api/worktable/media/wall-1080.mp4" aria-label="壁纸素材地址"
                    onChange={(e) => setHoloDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') persistFxConf({ holoSrc: holoDraft.trim() }) }}
                    onBlur={() => persistFxConf({ holoSrc: holoDraft.trim() })} />
                  <span className="dsh-wt_fxNote">{fxUi.holoSrc
                    ? '已应用：' + (fxUi.holoSrc.length > 44 ? fxUi.holoSrc.slice(0, 44) + '…' : fxUi.holoSrc)
                    : '留空时显示网格占位（不会白屏）'}</span>
                  <span className="dsh-wt_fxNote">本地媒体放这里即可直接引用：&lt;DSH_HOME&gt;\worktable-media\</span>
                </div>
              </>
            )}
            <div className="dsh-wt_rmtMsg">设置即时生效（色系在下次进入忙碌/重开控制室时应用），系统「减少动态效果」开启时仍会自动停用。</div>
          </div>
        )}
      </div>
    </div>
  )
}

/** 文件夹图标（重绘 SVG，与 better-sidebar 同款风格） */
function FolderIcon() {
  return (
    <svg className="dsh-wt_treeIcon" width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="M1.75 3.25A1.75 1.75 0 0 1 3.5 1.5h2.63a1.75 1.75 0 0 1 1.34.66l.62.79a1.75 1.75 0 0 0 1.34.66H12.5a1.75 1.75 0 0 1 1.75 1.75v7.39A1.75 1.75 0 0 1 12.5 14.5h-9a1.75 1.75 0 0 1-1.75-1.75V3.25Z" fill="var(--dsw-alias-state-accent-primary,#4f8ef7)" opacity="0.9" />
      <path d="M1.75 5.75h12.5v7a1.75 1.75 0 0 1-1.75 1.75h-9a1.75 1.75 0 0 1-1.75-1.75v-7Z" fill="var(--dsw-alias-state-accent-primary,#4f8ef7)" opacity="0.4" />
    </svg>
  )
}

/** 文件图标（重绘 SVG） */
function FileIcon() {
  return (
    <svg className="dsh-wt_treeIcon" width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <path d="M4 1.5h5.25a1 1 0 0 1 .71.29l3.25 3.25a1 1 0 0 1 .29.71V13.5a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z" fill="var(--dsw-alias-fill-l1,rgba(255,255,255,.06))" stroke="var(--dsw-alias-label-secondary,#9aa4b2)" strokeWidth="1.1" />
      <path d="M9.25 1.5V4.75h3.25" fill="none" stroke="var(--dsw-alias-label-secondary,#9aa4b2)" strokeWidth="1.1" />
    </svg>
  )
}

/** 资源管理器窗：树形展开（懒加载子目录；刷新/上一级均可用；.html 点击开浏览器标签） */
function ExplorerPane(props: { row: PaneRow; index: number }) {
  const cacheRef = useRef<Record<string, any[]>>({})
  const expandedRef = useRef<Set<string>>(new Set())
  const [rootPath, setRootPath] = useState('')
  const [error, setError] = useState('')
  const [, setTick] = useState(0)
  const rerender = () => setTick((t) => t + 1)

  const fetchDir = useCallback(async (path: string, force = false) => {
    if (!force && cacheRef.current[path]) return { path, entries: cacheRef.current[path] }
    try {
      const d = await postJson('/api/worktable/fs', {
        path,
        sessionId: splitEnv?.getScope()?.sessionId ?? '',
        cwd: splitEnv?.getScope()?.cwd ?? '',
      })
      const entries: any[] = d.entries ?? []
      cacheRef.current[d.path] = entries
      setError(d.error ? String(d.error) : '')
      return { path: d.path, entries }
    } catch (e) {
      setError(String(e))
      return { path, entries: [] }
    } finally {
      rerender()
    }
  }, [])

  const initRoot = useCallback(async () => {
    const r = await fetchDir(splitEnv?.getScope()?.cwd ?? '')
    setRootPath(r.path)
    rerender()
  }, [fetchDir])

  useEffect(() => { initRoot() }, [initRoot])

  const toggle = (path: string) => {
    if (expandedRef.current.has(path)) expandedRef.current.delete(path)
    else { expandedRef.current.add(path); fetchDir(path) }
    rerender()
  }

  const refresh = () => {
    cacheRef.current = {}
    expandedRef.current.clear()
    setError('')
    initRoot()
  }

  const goUp = () => {
    if (!rootPath) return
    const parent = parentPathOf(rootPath)
    if (parent === rootPath) return
    cacheRef.current = {}
    expandedRef.current.clear()
    setError('')
    fetchDir(parent).then((r) => { setRootPath(r.path); rerender() })
  }

  const renderLevel = (path: string, depth: number): any[] => {
    const entries = cacheRef.current[path]
    if (!entries) return []
    const nodes: any[] = []
    for (const e of entries) {
      const isOpen = expandedRef.current.has(e.path)
      nodes.push(
        <div key={e.path}>
          <button
            type="button"
            className="dsh-wt_treeRow"
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => {
              if (e.isDir) { toggle(e.path); return }
              if (/\.html?$/i.test(e.name)) {
                // 目录级静态托管：相对引用（./assets/...）在所在目录下解析，页面可完整渲染
                const dir = parentPathOf(e.path)
                splitStore.openTab(props.row, props.index, {
                  kind: 'iframe',
                  url: '/api/worktable/site/' + encodeURIComponent(dir) + '/' + encodeURIComponent(e.name),
                  title: e.name,
                })
              } else if (/\.(md|markdown|mdown|txt|log|tsx|ts|jsx|js|css|json|pdf|png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(e.name)) {
                splitStore.openTab(props.row, props.index, { kind: 'file', path: e.path })
              } else {
                setError(T('pane.openLater'))
              }
            }}
          >
            <span className={'dsh-wt_treeArrow' + (e.isDir && isOpen ? ' dsh-wt_treeArrowOpen' : '')} aria-hidden>{e.isDir ? '▸' : ''}</span>
            {e.isDir ? <FolderIcon /> : <FileIcon />}
            <span className="dsh-wt_treeName">{e.name}</span>
          </button>
          {e.isDir && isOpen && renderLevel(e.path, depth + 1)}
        </div>,
      )
    }
    return nodes
  }

  return (
    <>
      <div className="dsh-wt_subBar">
        <button type="button" className="dsh-wt_subBtn" title="上一级" onClick={goUp}>⬆</button>
        <button type="button" className="dsh-wt_subBtn" title="刷新" onClick={refresh}>↻</button>
        <span className="dsh-wt_subPath">{rootPath || '…'}</span>
      </div>
      <div className="dsh-wt_subList">
        {error && <div className="dsh-wt_subEmpty">{error}</div>}
        {!error && cacheRef.current[rootPath]?.length === 0 && <div className="dsh-wt_subEmpty">—</div>}
        {renderLevel(rootPath, 0)}
      </div>
    </>
  )
}

/** 源代码管理窗（服务端 /api/worktable/git） */
function GitPane() {
  const [snap, setSnap] = useState<{ isRepo: boolean; branch?: string; entries: any[] } | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    postJson('/api/worktable/git', {
      sessionId: splitEnv?.getScope()?.sessionId ?? '',
      cwd: splitEnv?.getScope()?.cwd ?? '',
    })
      .then(setSnap)
      .catch((e) => setError(String(e)))
  }, [])
  useEffect(() => { load() }, [load])
  return (
    <>
      <div className="dsh-wt_subBar">
        <button type="button" className="dsh-wt_subBtn" title="刷新" onClick={load}>↻</button>
        <span className="dsh-wt_subPath">{snap?.isRepo ? ('⎇ ' + snap.branch) : ''}</span>
      </div>
      <div className="dsh-wt_subList">
        {error && <div className="dsh-wt_subEmpty">{error}</div>}
        {!error && snap && !snap.isRepo && <div className="dsh-wt_subEmpty">{T('pane.gitNotRepo')}</div>}
        {!error && snap?.isRepo && snap.entries.length === 0 && <div className="dsh-wt_subEmpty">{T('pane.gitClean')}</div>}
        {!error && snap?.isRepo && snap.entries.map((e, i) => (
          <div key={i} className="dsh-wt_subRow dsh-wt_subRowStatic">
            <span className={'dsh-wt_gitXY dsh-wt_gitXY' + (e.xy.includes('A') || e.xy.includes('M') ? 'Mod' : 'New')}>{e.xy.trim()}</span>
            <span className="dsh-wt_subName">{e.path}</span>
          </div>
        ))}
      </div>
    </>
  )
}

/** 任务管理窗：后台任务 + 子代理（Agent 情况；2s 刷新） */
function JobsPane() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 2000)
    return () => window.clearInterval(timer)
  }, [])
  const jobs = splitEnv?.getJobs?.() ?? []
  const subagents = splitEnv?.getSubagents?.() ?? []
  return (
    <div className="dsh-wt_subList">
      <div className="dsh-wt_subSection">{T('pane.jobsTitle')}</div>
      {jobs.length === 0 && <div className="dsh-wt_subEmpty">{T('pane.jobsEmpty')}</div>}
      {jobs.map((j) => (
        <div key={j.id} className="dsh-wt_subRow dsh-wt_subRowStatic">
          <span className={'dsh-wt_jobDot dsh-wt_jobDot-' + j.status} aria-hidden>●</span>
          <span className="dsh-wt_subName">{j.label}</span>
          <span className="dsh-wt_subTag">{j.kind}</span>
        </div>
      ))}
      <div className="dsh-wt_subSection">{T('pane.subagents')}</div>
      {subagents.length === 0 && <div className="dsh-wt_subEmpty">{T('pane.subagentsEmpty')}</div>}
      {subagents.map((s: any, i: number) => (
        <div key={s?.id ?? i} className="dsh-wt_subRow dsh-wt_subRowStatic" style={{ paddingLeft: 8 + (s?.depth ?? 0) * 12 }}>
          <span className={'dsh-wt_jobDot dsh-wt_jobDot-' + (s?.status ?? 'stopping')} aria-hidden>●</span>
          <span className="dsh-wt_subName">{s?.label ?? s?.title ?? s?.name ?? '—'}</span>
          {s?.status && <span className="dsh-wt_subTag">{s.status}</span>}
        </div>
      ))}
    </div>
  )
}

/** 终端窗（WS /api/worktable/term + node-pty） */
function TerminalPane() {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [failed, setFailed] = useState('')
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    let term: any = null
    let ws: WebSocket | null = null
    let disposed = false
    try {
      term = new Terminal({
        cursorBlink: true,
        fontFamily: 'Cascadia Code, Cascadia Mono, Consolas, Menlo, monospace',
        fontSize: 12,
        convertEol: true,
        theme: { background: '#010409' },
      })
    } catch {
      setFailed(T('pane.termFail'))
      return
    }
    term.open(el)
    // 强制自动换行（DECAWM on）：超长行在窗口宽度处换行，不被截断
    try { term.write('\x1b[?7h') } catch {}
    const focusTerm = () => { try { term.focus() } catch {} }
    focusTerm()
    el.addEventListener('pointerdown', focusTerm)
    const scope = splitEnv?.getScope?.()
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = proto + '//' + location.host + '/api/worktable/term?sessionId=' + encodeURIComponent(scope?.sessionId ?? '') + '&cwd=' + encodeURIComponent(scope?.cwd ?? '') + '&cols=80&rows=24'
    try {
      ws = new WebSocket(url)
    } catch {
      term.dispose()
      setFailed(T('pane.termFail'))
      return
    }
    ws.onopen = () => { focusTerm(); try { term.write('\x1b[?7h') } catch {} }
    ws.onmessage = (ev) => { try { term.write(String(ev.data)) } catch {} }
    ws.onclose = () => { if (!disposed) { try { term.write('\r\n[连接已关闭]') } catch {} } }
    ws.onerror = () => { if (!disposed) setFailed(T('pane.termFail')) }
    term.onData((d: string) => { if (ws && ws.readyState === 1) ws.send(d) })
    const ro = new ResizeObserver(() => {
      if (typeof term.fit === 'function') {
        try { term.fit() } catch {}
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }))
      }
    })
    ro.observe(el)
    return () => {
      disposed = true
      ro.disconnect()
      try { ws?.close() } catch {}
      try { term.dispose() } catch {}
    }
  }, [])
  if (failed) {
    return <div className="dsh-wt_paneWip"><span className="dsh-wt_paneWipText">{failed}</span></div>
  }
  return <div ref={hostRef} className="dsh-wt_termHost" />
}

const mdRenderer = new MarkdownIt({ linkify: true })

const IMAGE_EXTS = /[.](png|jpe?g|gif|webp|svg|bmp|ico)$/i
const MD_EXTS = /[.](md|markdown|mdown)$/i

/** 本地文件预览：PDF 走原生 iframe（Chrome 内置阅读器）、图片居中、MD 渲染、其余纯文本 */
function FileViewer(props: { path: string }) {
  const ext = (props.path.split('.').pop() || '').toLowerCase()
  const fileUrl = '/api/worktable/file?path=' + encodeURIComponent(props.path)
  if (ext === 'pdf') {
    return <iframe className="dsh-wt_paneFrame" src={fileUrl} title={basenameOf(props.path)} />
  }
  if (IMAGE_EXTS.test('.' + ext)) {
    return (
      <div className="dsh-wt_imgView">
        <img src={fileUrl} alt={basenameOf(props.path)} />
      </div>
    )
  }
  return <TextViewer path={props.path} fileUrl={fileUrl} isMd={MD_EXTS.test('.' + ext)} />
}

/** 代码文件语言映射（预览语法着色） */
const CODE_LANGS: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', css: 'css', json: 'json' }
const CODE_EXTS = /[.](tsx|ts|jsx|js|css|json)$/i

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function codeHtml(text: string, ext: string): string {
  const lang = CODE_LANGS[ext] ?? ''
  if (lang) {
    try { return hljs.highlight(text, { language: lang }).value } catch { return escapeHtml(text) }
  }
  return escapeHtml(text)
}

/** 文本预览（fetch 原文 → MD 渲染 / 代码高亮 / <pre> 等宽展示）；全部文本类型支持编辑/预览切换并可保存回磁盘 */
function TextViewer(props: { path: string; fileUrl: string; isMd: boolean }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveFail, setSaveFail] = useState(false)
  useEffect(() => {
    let dead = false
    setText(null)
    setError('')
    fetch(props.fileUrl)
      .then((r) => {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.text()
      })
      .then((t) => { if (!dead) setText(t) })
      .catch((e) => { if (!dead) setError(String(e)) })
    return () => { dead = true }
  }, [props.fileUrl])
  const enterEdit = () => { setDraft(text ?? ''); setSaveFail(false); setMode('edit') }
  const save = async () => {
    setSaving(true)
    setSaveFail(false)
    try {
      const r = await fetch('/api/worktable/write', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: props.path, content: draft }),
      })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      setText(draft)
      setMode('preview')
    } catch {
      setSaveFail(true)
    } finally {
      setSaving(false)
    }
  }
  if (error) {
    return <div className="dsh-wt_paneWip"><span className="dsh-wt_paneWipText">{T('file.fail')}：{error}</span></div>
  }
  if (text == null) {
    return <div className="dsh-wt_paneWip"><span className="dsh-wt_paneWipText">{T('file.loading')}</span></div>
  }
  const ext = (props.path.split('.').pop() || '').toLowerCase()
  const isCode = CODE_EXTS.test('.' + ext)
  return (
    <>
      <div className="dsh-wt_mdBar">
        <button type="button" className={'dsh-wt_mdBtn' + (mode === 'preview' ? ' dsh-wt_mdBtnOn' : '')} onClick={() => setMode('preview')}>{T('file.preview')}</button>
        <button type="button" className={'dsh-wt_mdBtn' + (mode === 'edit' ? ' dsh-wt_mdBtnOn' : '')} onClick={enterEdit}>{T('file.edit')}</button>
        {mode === 'edit' && (
          <button type="button" className="dsh-wt_mdSave" disabled={saving} onClick={save}>{saving ? '…' : T('file.save')}</button>
        )}
        {saveFail && <span className="dsh-wt_mdMsg">{T('file.saveFail')}</span>}
      </div>
      {mode === 'edit'
        ? <textarea className="dsh-wt_mdEdit" value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} />
        : props.isMd
          ? (
            <div className="dsh-wt_fileView">
              <div
                className="dsh-wt_md"
                dangerouslySetInnerHTML={{ __html: mdRenderer.render(text) }}
                onClick={(e: any) => {
                  const a = e.target && e.target.closest ? (e.target.closest('a') as HTMLAnchorElement | null) : null
                  if (!a) return
                  e.preventDefault()
                  const href = a.getAttribute('href') || ''
                  if (/^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener')
                }}
              />
            </div>
          )
          : isCode
            ? (
              <div className="dsh-wt_fileView">
                <pre className="dsh-wt_code"><code dangerouslySetInnerHTML={{ __html: codeHtml(text, ext) }} /></pre>
              </div>
            )
            : <div className="dsh-wt_fileView"><pre className="dsh-wt_txt">{text}</pre></div>}
    </>
  )
}

/** 自制下拉列表（原生 select 无法美化）：文件夹分组标题 + 1px 细分隔线 + 选项列表 */
function SelectPop(props: {
  value: string | null
  groups: { title: string; items: { id: string; label: string; isCurrent?: boolean }[] }[]
  placeholder?: string
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const flat = props.groups.flatMap((g) => g.items)
  const selected = flat.find((i) => i.id === props.value)
  return (
    <div className="dsh-wt_select">
      <button type="button" className="dsh-wt_selectBtn" onClick={() => setOpen((v) => !v)}>
        <span className={'dsh-wt_selectVal' + (selected ? '' : ' dsh-wt_selectPh')}>{selected?.label ?? props.placeholder ?? ''}</span>
        <span className="dsh-wt_selectCaret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="dsh-wt_selectList">
          {props.groups.map((g, gi) => (
            <Fragment key={g.title || 'g' + gi}>
              {g.title && (
                <>
                  <div className="dsh-wt_selectDivider" />
                  <div className="dsh-wt_selectGroup">📁 {g.title}</div>
                </>
              )}
              {g.items.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  className={'dsh-wt_selectItem' + (it.id === props.value ? ' dsh-wt_selectItemOn' : '')}
                  onClick={() => { props.onChange(it.id); setOpen(false) }}
                >
                  <span className="dsh-wt_selectItemTitle">{it.label}</span>
                  {it.isCurrent && <span className="dsh-wt_selectCurrent">{T('custom.sessionCurrent')}</span>}
                </button>
              ))}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

/** 自定义窗口：居中对话框。两种模式：新建专属会话 / 发送到已有会话（默认当前会话）。 */
function CustomPane(props: { paneTitle?: string }) {
  const paneTitle = props.paneTitle ?? ''
  try { (window as any).__dshLastCustomPaneTitle = paneTitle } catch {}
  const custom = splitEnv?.custom
  const [requirement, setRequirement] = useState('')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [projects, setProjects] = useState<{ id: string; name: string }[]>(() => custom?.getProjects?.() ?? [])
  const [mode, setMode] = useState<'new' | 'existing'>('existing')
  const [sessionGroups, setSessionGroups] = useState<{ title: string; sessions: { id: string; title: string; isCurrent: boolean }[] }[]>([])
  const [sessionId, setSessionId] = useState<string | null>(null)
  // 分组（宿主工作区）三态：未分组 / 现有组 / 新建组
  const [wsGroups, setWsGroups] = useState<{ id: string; title: string; path: string }[]>([])
  const [groupMode, setGroupMode] = useState<'none' | 'existing' | 'new'>('none')
  const [groupId, setGroupId] = useState<string | null>(null)
  const [newGroupParent, setNewGroupParent] = useState('')
  const [newGroupName, setNewGroupName] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [fail, setFail] = useState('')
  const [bindNote, setBindNote] = useState<'auto' | 'kept' | 'none'>('none')
  // 默认项目 = 当前工作区所属项目；默认会话 = 当前会话；默认分组 = 当前会话所在工作区
  useEffect(() => {
    const list = custom?.getProjects?.() ?? []
    setProjects(list)
    const cur = custom?.currentProjectId?.() ?? null
    setProjectId(cur && list.some((p) => p.id === cur) ? cur : (list[0]?.id ?? null))
    // 内建项目（股票检测 / 待办清单…）：需求框预填任务起始文案（仅首次进入，不覆盖用户已输入内容）
    if (cur) {
      const starter = custom?.getProjectStarter?.(cur) ?? ''
      if (starter) setRequirement((r) => (r && r !== starter ? r : starter))
    }
    setWsGroups((custom?.getWorkspaces?.() ?? []).map((w) => ({ id: w.id, title: w.title, path: w.path })))
    custom?.getSessions?.().then((res) => {
      setSessionGroups(res.groups)
      const flat = res.groups.flatMap((g) => g.sessions)
      setSessionId(flat.find((s) => s.isCurrent)?.id ?? flat[0]?.id ?? null)
      const curId = flat.find((s) => s.isCurrent)?.id
      const home = curId ? (custom?.getWorkspaces?.() ?? []).find((w) => (w.sessionIds ?? []).includes(curId)) : null
      if (home) { setGroupMode('existing'); setGroupId(home.id) }
    }).catch(() => { setSessionGroups([]) })
  }, [custom])
  const submit = async () => {
    const text = requirement.trim()
    if (!text || !projectId || !custom) return
    setBusy(true)
    setFail('')
    try {
      const proj = projects.find((p) => p.id === projectId)
      const pname = proj?.name ?? projectId
      if (mode === 'new') {
        let group: any = { kind: 'none' }
        if (groupMode === 'existing' && groupId) group = { kind: 'existing', workspaceId: groupId }
        else if (groupMode === 'new') {
          if (!newGroupParent.trim() || !newGroupName.trim()) { setFail(T('custom.groupNeedPath')); return }
          group = { kind: 'new', parent: newGroupParent.trim(), name: newGroupName.trim() }
        }
        const sid = await custom.submit(projectId, pname, text, group, paneTitle)
        setBindNote((custom.autoBind?.(sid) ?? 'none') as any)
      } else {
        if (!sessionId) return
        await custom.sendToSession(sessionId, projectId, pname, text, paneTitle)
        setBindNote((custom.autoBind?.(sessionId) ?? 'none') as any)
      }
      setDone(true)
    } catch (e) {
      setFail(String(e))
    } finally {
      setBusy(false)
    }
  }
  if (!custom) {
    return <div className="dsh-wt_paneWip"><span className="dsh-wt_paneWipText">{T('pane.wip')}</span></div>
  }
  if (done) {
    return (
      <div className="dsh-wt_customBox">
        <span className="dsh-wt_customDone" aria-hidden>✅</span>
        <p className="dsh-wt_customDoneText">{mode === 'new' ? T('custom.done') : T('custom.sent')}</p>
        <p className="dsh-wt_customDoneHint">{T('custom.doneHint')}</p>
        {bindNote !== 'none' && (
          <p className="dsh-wt_customDoneBind">{bindNote === 'auto' ? T('custom.autoBound') : T('custom.keptBinding')}</p>
        )}
      </div>
    )
  }
  return (
    <div className="dsh-wt_customBox">
      <div className="dsh-wt_customCard">
        <span className="dsh-wt_customTitle">✨ {T('custom.title')}</span>
        <div className="dsh-wt_customModes">
          <button type="button" className={'dsh-wt_customModeBtn' + (mode === 'existing' ? ' dsh-wt_customModeBtnOn' : '')} onClick={() => setMode('existing')}>{T('custom.modeSend')}</button>
          <button type="button" className={'dsh-wt_customModeBtn' + (mode === 'new' ? ' dsh-wt_customModeBtnOn' : '')} onClick={() => setMode('new')}>{T('custom.modeNew')}</button>
        </div>
        <p className="dsh-wt_customHint">{mode === 'new' ? T('custom.hint') : T('custom.hintSend')}</p>
        <textarea
          className="dsh-wt_customInput"
          autoFocus
          placeholder={T('custom.placeholder')}
          value={requirement}
          onChange={(e) => setRequirement(e.target.value)}
        />
        {mode === 'existing' && (
          <div className="dsh-wt_customRow">
            <span className="dsh-wt_customLabel">{T('custom.session')}</span>
            <SelectPop
              value={sessionId}
              groups={sessionGroups.map((g) => ({
                title: g.title,
                items: g.sessions.map((s) => ({ id: s.id, label: s.title, isCurrent: s.isCurrent })),
              }))}
              placeholder={T('custom.session')}
              onChange={setSessionId}
            />
          </div>
        )}
        <div className="dsh-wt_customRow">
          <span className="dsh-wt_customLabel">{T('custom.project')}</span>
          <SelectPop
            value={projectId}
            groups={[{ title: '', items: projects.map((p) => ({ id: p.id, label: p.name })) }]}
            placeholder={T('custom.project')}
            onChange={setProjectId}
          />
        </div>
        {mode === 'new' && (
          <div className="dsh-wt_customRow">
            <span className="dsh-wt_customLabel">{T('custom.group')}</span>
            <SelectPop
              value={groupMode === 'none' ? '__none' : groupMode === 'new' ? '__new' : groupId}
              groups={[{
                title: '',
                items: [
                  { id: '__none', label: T('custom.groupNone') },
                  ...wsGroups.map((w) => ({ id: w.id, label: w.title })),
                  { id: '__new', label: T('custom.groupNew') },
                ],
              }]}
              placeholder={T('custom.group')}
              onChange={(id) => {
                if (id === '__none') setGroupMode('none')
                else if (id === '__new') setGroupMode('new')
                else { setGroupMode('existing'); setGroupId(id) }
              }}
            />
          </div>
        )}
        {mode === 'new' && groupMode === 'new' && (
          <>
            <div className="dsh-wt_customRow">
              <span className="dsh-wt_customLabel">{T('custom.groupNewParent')}</span>
              <input
                className="dsh-wt_customPathInput"
                placeholder={T('custom.groupNewParentPh')}
                value={newGroupParent}
                onChange={(e) => setNewGroupParent(e.target.value)}
              />
            </div>
            <div className="dsh-wt_customRow">
              <span className="dsh-wt_customLabel">{T('custom.groupNewName')}</span>
              <input
                className="dsh-wt_customPathInput"
                placeholder={T('custom.groupNewNamePh')}
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
              />
            </div>
          </>
        )}
        <button
          type="button"
          className="dsh-wt_customSend"
          disabled={busy || !requirement.trim() || !projectId || (mode === 'existing' && !sessionId) || (mode === 'new' && groupMode === 'new' && (!newGroupParent.trim() || !newGroupName.trim()))}
          onClick={submit}
        >{busy ? '…' : (mode === 'new' ? T('custom.send') : T('custom.sendToSession'))}</button>
        {fail && <p className="dsh-wt_customFail">{T('custom.fail')}：{fail}</p>}
      </div>
    </div>
  )
}

/** 单个标签页的内容渲染 */
function PaneTabBody(props: { tab: PaneTab; row: PaneRow; index: number; paneTitle?: string; reloadKey: number }) {
  const content = props.tab.content
  if (content.kind === 'iframe') {
    return <IframePane url={content.url} title={content.title ?? props.tab.title} reloadKey={props.reloadKey} />
  }
  if (content.kind === 'file') {
    return <FileViewer path={content.path} />
  }
  if (content.type === 'browser') return <BrowserPane row={props.row} index={props.index} tabId={props.tab.id} content={content} reloadKey={props.reloadKey} />
  if (content.type === 'anim') return <AnimPane row={props.row} index={props.index} tabId={props.tab.id} content={content} reloadKey={props.reloadKey} />
  if (content.type === 'console') return <ConsolePane />
  if (content.type === 'explorer') return <ExplorerPane row={props.row} index={props.index} />
  if (content.type === 'scm') return <GitPane />
  if (content.type === 'tasks') return <JobsPane />
  if (content.type === 'terminal') return <TerminalPane />
  if (content.type === 'custom') return <CustomPane paneTitle={props.paneTitle ?? ''} />
  if (content.type === 'globe') return <GlobePane />
  if (content.type === 'gamedev') return <GameDevPane />
  if (content.type === 'digitalhuman') return <DigitalHumanPane env={dhEnvOf} sessionId={dhScopeOf} t={T} />
  return (
    <div className="dsh-wt_paneWip">
      <span className="dsh-wt_paneWipIcon" aria-hidden>{BUILTIN_ICONS[content.type]}</span>
      <span className="dsh-wt_paneWipText">{T('pane.wip')}</span>
    </div>
  )
}

/** 需要标签栏刷新按钮的内容类型：网页类（iframe / 浏览器 / 动画）统一在标签最左放 ↻ */
function refreshableTab(t: PaneTab): boolean {
  const c = t.content
  return c.kind === 'iframe' || (c.kind === 'builtin' && (c.type === 'browser' || c.type === 'anim'))
}

/** 窗内容：标签页模型（无标签 = 6 选 1 选择器；标签可切换/关闭，关完回到选择器）
 *  网页类标签最左侧固定一个 ↻ 刷新按钮（标签名之前），点击重挂载该标签内容。 */
function PaneBody(props: { pane: SplitPane; row: PaneRow; index: number }) {
  const { pane, row, index } = props
  const tabs = pane.tabs ?? []
  const active = Math.min(pane.active ?? 0, Math.max(0, tabs.length - 1))
  const [reloadKeys, setReloadKeys] = useState<Record<string, number>>({})
  if (tabs.length === 0) {
    return <PanePicker row={row} index={index} />
  }
  const refreshTab = (t: PaneTab) => {
    setReloadKeys((m) => ({ ...m, [t.id]: (m[t.id] ?? 0) + 1 }))
    splitStore.setActiveTab(row, index, t.id)
  }
  // 唯一标签是控制室 → 整个标签栏不渲染（不可关、不可换，标签栏无信息价值；去掉顶部多余标题）
  const singleConsole = tabs.length === 1 && tabs[0].content?.kind === 'builtin' && tabs[0].content.type === 'console'
  return (
    <>
      {!singleConsole && !pane.collapsed && (
      <div className="dsh-wt_tabBar">
        {tabs.map((t, i) => {
          // 控制室标签不可关闭：关掉后窗格变选择器，用户回不到控制室（不可逆操作）
          const locked = t.content?.kind === 'builtin' && t.content.type === 'console'
          return (
          <span
            key={t.id}
            className={'dsh-wt_tab' + (i === active ? ' dsh-wt_tabOn' : '')}
            title={t.title}
            draggable={!locked}
            onDragStart={(e: any) => { dragTab = { row, index, tabId: t.id }; try { e.dataTransfer.effectAllowed = 'move' } catch {} }}
            onDragEnd={() => { dragTab = null; setDropTarget(null) }}
            onClick={() => splitStore.setActiveTab(row, index, t.id)}
          >
            {refreshableTab(t) && (
              <button
                type="button"
                className="dsh-wt_tabRefresh"
                title={T('pane.refresh')}
                aria-label={T('pane.refresh')}
                onClick={(e) => { e.stopPropagation(); refreshTab(t) }}
              >↻</button>
            )}
            <span className="dsh-wt_tabTitle">{t.title}</span>
            {!locked && (
              <button
                type="button"
                className="dsh-wt_tabClose"
                title={T('pane.closeTab')}
                onClick={(e) => { e.stopPropagation(); splitStore.closeTab(row, index, t.id) }}
              >✕</button>
            )}
          </span>
          )
        })}
      </div>
      )}
      <PaneTabBody tab={tabs[active]} row={row} index={index} paneTitle={pane.title} reloadKey={reloadKeys[tabs[active].id] ?? 0} />
    </>
  )
}

/** 未指派内容：4 选 1 选择器。按钮固定大小、整体居中；
 * 按窗位宽高比自适应排列：宽窗横排 4 连 / 方窗 2×2 / 竖窗竖排。 */
function PanePicker(props: { row: PaneRow; index: number }) {
  const [mode, setMode] = useState<'row' | 'grid' | 'col'>('grid')
  const hostRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const update = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      const aspect = h > 0 ? w / h : 1
      setMode(aspect > 1.4 ? 'row' : aspect > 0.72 ? 'grid' : 'col')
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const pick = (content: SplitContent) => splitStore.openTab(props.row, props.index, content)
  return (
    <div ref={hostRef} className={'dsh-wt_panePicker dsh-wt_panePicker-' + mode}>
      <button type="button" className="dsh-wt_panePick" onClick={() => pick({ kind: 'builtin', type: 'browser' })}>
        <span aria-hidden>🌐</span>{T('pane.browser')}
      </button>
      <button type="button" className="dsh-wt_panePick" onClick={() => pick({ kind: 'builtin', type: 'anim' })}>
        <span aria-hidden>🎬</span>{T('pane.anim')}
      </button>
      <button type="button" className="dsh-wt_panePick" onClick={() => pick({ kind: 'builtin', type: 'explorer' })}>
        <span aria-hidden>📁</span>{T('pane.explorer')}
      </button>
      <button type="button" className="dsh-wt_panePick" onClick={() => pick({ kind: 'builtin', type: 'terminal' })}>
        <span aria-hidden>▸_</span>{T('pane.terminal')}
      </button>
      <button type="button" className="dsh-wt_panePick" onClick={() => pick({ kind: 'builtin', type: 'custom' })}>
        <span aria-hidden>✨</span>{T('pane.custom')}
      </button>
      <button type="button" className="dsh-wt_panePick" onClick={() => pick({ kind: 'builtin', type: 'globe' })}>
        <span aria-hidden>🌍</span>{T('pane.globe')}
      </button>
      <button type="button" className="dsh-wt_panePick" onClick={() => pick({ kind: 'builtin', type: 'digitalhuman' })}>
        <span aria-hidden>💃</span>{T('pane.digitalhuman')}
      </button>
      <button type="button" className="dsh-wt_panePick" onClick={() => pick({ kind: 'builtin', type: 'gamedev' })}>
        <span aria-hidden>🎮</span>{T('pane.gamedev')}
      </button>
    </div>
  )
}

type PoolItem = { spec: LayoutSpec; chatW: number; topH: number; leftW: number; paneWs: number[]; topWs: number[] }

/** 单个工作区渲染层（geom 为 null 时用 0 几何渲染，外层 display:none 保活，保留网页/MD 滚动/激活标签等状态） */
function WorkspaceLayer(props: { spec: LayoutSpec; geom: Geom | null; chatW: number; topH: number; leftW: number; paneWs: number[]; topWs: number[] }) {
  const g = props.geom ?? { left: 0, top: 0, right: 0, bottom: 0 }
  const spec = props.spec
  const top = spec.top ?? []
  const main = spec.main ?? []
  const hasLeft = !!spec.left
  const hasTop = top.length > 0
  const chatLeft = !hasLeft && spec.chatSide === 'left'
  const colW = g.right - g.left
  const rowH = g.bottom - g.top
  const chatW = clamp(props.chatW, spec.chatWidth.min, Math.max(spec.chatWidth.min, colW - 60))
  const topH = hasTop
    ? clamp(props.topH, spec.topHeight?.min ?? 80, Math.max(spec.topHeight?.min ?? 80, rowH - BAR_H - 80))
    : 0
  const leftW = hasLeft
    ? clamp(props.leftW, spec.leftWidth?.min ?? 160, Math.max(spec.leftWidth?.min ?? 160, colW - 260))
    : 0
  const chatFull = spec.chatFullHeight === true
  const contentW = Math.max(0, colW - chatW)
  const contentX = hasLeft ? g.left + leftW : (chatLeft ? g.left + chatW : g.left)
  const topRowX = hasLeft ? g.left + leftW : contentX
  const topRowW = hasLeft ? Math.max(0, colW - leftW) : (chatFull ? contentW : colW)

  const topItems = allocate(top, props.topWs, topRowW)
  const mainItems = allocate(main, props.paneWs, contentW)
  const leftItem = spec.left ? { pane: spec.left, left: 0, width: leftW } : null

  const barTop = g.top
  const bodyTop = barTop + BAR_H + topH
  const paneBottom = g.bottom
  const mainH = paneBottom - bodyTop
  const topY = barTop + BAR_H

  const renderPane = (it: { pane: SplitPane; left: number; width: number }, row: PaneRow, index: number, x: number, y: number, h: number) => {
    const singleConsole = (it.pane.tabs ?? []).length === 1 && it.pane.tabs![0].content?.kind === 'builtin' && it.pane.tabs![0].content.type === 'console'
    return (
    <div
      key={it.pane.id}
      className="dsh-wt_pane"
      data-drop-hover={dropTarget && dropTarget.row === row && dropTarget.index === index ? 'true' : undefined}
      style={{ position: 'fixed', left: x + it.left, top: y, width: it.width, height: h, zIndex: 68 }}
      onDragOver={(e: any) => {
        if (!dragTab) return
        e.preventDefault()
        setDropTarget({ row, index })
      }}
      onDragLeave={(e: any) => {
        if (e.currentTarget && !e.currentTarget.contains(e.relatedTarget)) setDropTarget(null)
      }}
      onDrop={(e: any) => {
        e.preventDefault()
        const s = dragTab
        dragTab = null
        setDropTarget(null)
        if (s && (s.row !== row || s.index !== index)) {
          splitStore.moveTab(s.row, s.index, s.tabId, row, index)
        }
      }}
    >
      {!it.pane.collapsed && (
      <div
        className="dsh-wt_paneBar"
        title={T('split.dragSwap')}
        draggable
        onDragStart={(e: any) => { dragPane = { row, index }; try { e.dataTransfer.effectAllowed = 'move' } catch {} }}
        onDragOver={(e: any) => e.preventDefault()}
        onDrop={(e: any) => {
          e.preventDefault()
          const s = dragPane
          if (s && (s.row !== row || s.index !== index)) splitStore.swapPanes(s.row, s.index, row, index)
          dragPane = null
        }}
        onDragEnd={() => { dragPane = null }}
      >
        <span className="dsh-wt_paneTitle">{it.pane.title}</span>
      </div>
      )}
      <PaneBody pane={it.pane} row={row} index={index} />
      {!singleConsole && (
        <>
        <button
          type="button"
          className="dsh-wt_annotBtn"
          title={T('annot.label')}
          aria-label={T('annot.label')}
          onClick={() => startAnnot(windowLabelOf(row, index))}
        >
          <svg viewBox="0 0 16 16" aria-hidden><path d="M2 5.6c0-1.2 1-2.2 2.2-2.2h7.6c1.2 0 2.2 1 2.2 2.2v3.6c0 1.2-1 2.2-2.2 2.2H7.5L5 13.6l.3-2.4H4.2c-1.2 0-2.2-1-2.2-2.2z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
        </button>
        <button
          type="button"
          className={'dsh-wt_collapseBtn' + (it.pane.collapsed ? ' dsh-wt_collapseBtnCollapsed' : '')}
          title={it.pane.collapsed ? T('pane.expand') : T('pane.collapse')}
          aria-label={it.pane.collapsed ? T('pane.expand') : T('pane.collapse')}
          onClick={() => splitStore.toggleCollapsed(row, index)}
        >
          {it.pane.collapsed ? (
            <svg viewBox="0 0 16 16" aria-hidden><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          )}
        </button>
        </>
      )}
    </div>
    )
  }

  return (
    <>
      {/* 标题栏 */}
      <div className="dsh-wt_splitBar" style={{ position: 'fixed', left: g.left, top: barTop, width: hasLeft || chatFull ? contentW : (hasTop ? colW : contentW), zIndex: 70 }}>
        {spec.id !== 'wt-console' && <span className="dsh-wt_splitTitle">{spec.title}</span>}
        {!hasLeft && (
          <button
            type="button"
            className="dsh-wt_splitFlip"
            title={T('split.flip')}
            onClick={() => splitStore.setChatSide(chatLeft ? 'right' : 'left')}
          >⇄</button>
        )}
        <button type="button" className="dsh-wt_splitClose" aria-label="退出分栏（Esc）" onClick={() => splitStore.close()}>✕</button>
      </div>
      {/* 左列整高内容窗 */}
      {leftItem && renderPane(leftItem, 'left', 0, g.left, barTop + BAR_H, g.bottom - barTop - BAR_H)}
      {/* 顶部通栏行（左列布局时为右侧列顶行） */}
      {hasTop && topItems.map((it, i) => renderPane(it, 'top', i, topRowX, topY, topH))}
      {/* 主行内容窗 */}
      {mainItems.map((it, i) => renderPane(it, 'main', i, contentX, bodyTop, mainH))}
      {/* 顶部/主行水平分隔线 */}
      {hasTop && (
        <div
          className="dsh-wt_splitDivider dsh-wt_splitDividerH"
          role="separator"
          title="拖动调整上下分区"
          style={{ position: 'fixed', left: topRowX, top: bodyTop - DIVIDER / 2, width: topRowW, height: DIVIDER, zIndex: 72 }}
          onPointerDown={makeDividerHandler('top')}
        />
      )}
      {/* 顶部行内垂直分隔线 */}
      {hasTop && topItems.slice(0, -1).map((it, i) => (
        <div
          key={'tv' + it.pane.id}
          className="dsh-wt_splitDivider"
          role="separator"
          title="拖动调整宽度"
          style={{ position: 'fixed', left: topRowX + it.left + it.width - DIVIDER / 2, top: topY, width: DIVIDER, height: topH, zIndex: 72 }}
          onPointerDown={makeDividerHandler('topPane', i)}
        />
      ))}
      {/* 主行内容窗垂直分隔线 */}
      {mainItems.slice(0, -1).map((it, i) => (
        <div
          key={'v' + it.pane.id}
          className="dsh-wt_splitDivider"
          role="separator"
          title="拖动调整宽度"
          style={{ position: 'fixed', left: contentX + it.left + it.width - DIVIDER / 2, top: bodyTop, width: DIVIDER, height: mainH, zIndex: 72 }}
          onPointerDown={makeDividerHandler('pane', i)}
        />
      ))}
      {/* 聊天分隔线（左列布局 = 左/右列边界；其余 = 内容与聊天之间） */}
      <div
        className="dsh-wt_splitDivider"
        role="separator"
        title={hasLeft ? '拖动调整左右列宽' : '拖动调整聊天宽度'}
        style={{
          position: 'fixed',
          left: (hasLeft ? g.left + leftW : (chatLeft ? g.left + chatW : g.right - chatW)) - DIVIDER / 2,
          top: hasLeft || chatFull ? barTop + BAR_H : bodyTop,
          width: DIVIDER,
          height: hasLeft || chatFull ? g.bottom - barTop - BAR_H : mainH,
          zIndex: 72,
        }}
        onPointerDown={makeDividerHandler(hasLeft ? 'left' : 'chat')}
      />
      <AnnotationOverlay />
    </>
  )
}

/** 分栏工作区浮层（shell.overlay 座位；订阅 splitStore 快照渲染）。
 * 切换项目时旧工作区不销毁：全部挂载在池中、仅当前可见（display:none 保活），
 * 网页子页面/滚动位置、MD 滚动位置、激活标签等在切回时原样保留。 */
function SplitWorkspace() {
  const [snap, setSnap] = useState({
    active: splitStore.active,
    spec: splitStore.spec,
    geom: splitStore.geom,
    chatW: splitStore.chatW,
    topH: splitStore.topH,
    leftW: splitStore.leftW,
    paneWs: [...splitStore.paneWs],
    topWs: [...splitStore.topWs],
  })
  const poolRef = useRef<Map<string, PoolItem>>(new Map())
  const [, setPoolTick] = useState(0)

  useEffect(() => splitStore.subscribe(() => {
    const spec = splitStore.spec
    if (splitStore.active && spec) {
      poolRef.current.set(spec.id, {
        spec,
        chatW: splitStore.chatW,
        topH: splitStore.topH,
        leftW: splitStore.leftW,
        paneWs: [...splitStore.paneWs],
        topWs: [...splitStore.topWs],
      })
      // 保活池上限 6 个（LRU：删最老的），避免长时间使用内存膨胀
      while (poolRef.current.size > 6) {
        const first = poolRef.current.keys().next().value
        if (first != null) poolRef.current.delete(first)
      }
    }
    setSnap({
      active: splitStore.active,
      spec: splitStore.spec,
      geom: splitStore.geom,
      chatW: splitStore.chatW,
      topH: splitStore.topH,
      leftW: splitStore.leftW,
      paneWs: [...splitStore.paneWs],
      topWs: [...splitStore.topWs],
    })
    setPoolTick((t) => t + 1)
  }), [])

  useEffect(() => {
    if (!snap.active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') splitStore.close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [snap.active])

  // 标签拖放高亮 → 重渲染
  const [, setDropTick] = useState(0)
  useEffect(() => {
    const fn = () => setDropTick((t) => t + 1)
    dropTargetListeners.add(fn)
    return () => { dropTargetListeners.delete(fn) }
  }, [])

  const activeId = snap.active && snap.spec ? snap.spec.id : null
  const entries = Array.from(poolRef.current.entries())
  if (entries.length === 0) return null
  return (
    <>
      {entries.map(([id, item]) => {
        const isActive = id === activeId
        return (
          <div key={id} style={isActive ? undefined : { visibility: 'hidden' as const }}>
            <WorkspaceLayer
              spec={item.spec}
              geom={isActive ? snap.geom : null}
              chatW={isActive ? snap.chatW : item.chatW}
              topH={isActive ? snap.topH : item.topH}
              leftW={isActive ? snap.leftW : item.leftW}
              paneWs={isActive ? snap.paneWs : item.paneWs}
              topWs={isActive ? snap.topWs : item.topWs}
            />
          </div>
        )
      })}
    </>
  )
}

/** 调试出口（自动化验证用；必须在 store 定义之后） */
try { (window as any).__dshWorktable = { splitStore } } catch {}

export { SplitWorkspace }
