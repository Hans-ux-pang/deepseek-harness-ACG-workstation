import { Context } from '@deepseek-ai/cordis'
import { execFile, spawn } from 'node:child_process'
import { createReadStream, readdirSync, realpathSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve as pathResolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { homedir, tmpdir as osTmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 基础数据目录解析：不加载任何官方包（loadPkg 的兜底只能用它，禁止反向调用包加载函数——否则成环）。
 * 规则与官方 @deepseek-ai/dsh-home-paths 的 resolveDshHome 一致：
 *   DSH_HOME 环境变量优先（空/纯空白视为未设置），否则 ~/.dsh；
 *   支持 ~、~/、~\ 前缀展开；相对路径按进程 cwd 解析；结果归一为绝对路径。
 * 禁止任何业务代码直接拼 homedir()/.dsh —— 自定义 DSH_HOME（Desktop/隔离测试）会读错数据。
 */
function baseDshHome(): string {
  const env = process.env.DSH_HOME
  // 与官方一致：trim 只用于判断是否全空白，实际路径保留原字符串（两端空格有含义）
  const value = env !== undefined && env.trim().length > 0 ? env : pathResolve(homedir(), '.dsh')
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return pathResolve(homedir(), value.slice(2))
  return pathResolve(value)
}

/** 解析 DSH 数据根目录：优先官方 @deepseek-ai/dsh-home-paths（显式配置/DSH_HOME/默认），
 *  不可用或返回非法值时回退 baseDshHome()（同官方规则）。带缓存。 */
let cachedDshHome: string | null = null
/** 本次解析实际走了哪条路径（供测试断言官方包是否真的被使用） */
let dshHomeSource: 'official' | 'fallback' = 'fallback'
function resolveDshHomeSafe(): string {
  if (cachedDshHome) return cachedDshHome
  try {
    const pkg = loadPkg('@deepseek-ai/dsh-home-paths') as any
    if (pkg && typeof pkg.resolveDshHome === 'function') {
      const home = pkg.resolveDshHome(undefined, process.env)
      if (typeof home === 'string' && home.trim() !== '') {
        dshHomeSource = 'official'
        cachedDshHome = home
        return cachedDshHome
      }
    }
  } catch {}
  dshHomeSource = 'fallback'
  cachedDshHome = baseDshHome()
  return cachedDshHome
}

/**
 * dsh-worktable 服务端：健康路由 + 工作区内容窗的数据路由。
 * 参考 dsh-better-sidebar 的架构——内容窗能力由本插件自己的服务端路由提供：
 *   - POST /api/worktable/fs     目录列表（资源管理器窗）
 *   - POST /api/worktable/git    git 状态（源代码管理窗）
 *   - WS   /api/worktable/term   node-pty 终端流（终端窗；依赖宿主 node_modules 中的
 *                                node-pty 与 ws，缺失时该路由不注册、终端窗降级提示）
 */

declare const __WT_VERSION__: string
const PLUGIN_VERSION = typeof __WT_VERSION__ === 'undefined' ? 'dev' : __WT_VERSION__

export const name = 'dsh-worktable'
export const inject = ['webServer', 'sessions']

export const HEALTH_PATH = '/api/worktable/health'

const MAX_ENTRIES = 500

/** 本地文件/站点静态资源的 MIME 映射（file 与 site 两条路由共用） */
const FILE_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', map: 'application/json; charset=utf-8',
  md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
  pdf: 'application/pdf', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  wasm: 'application/wasm', mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm',
}

const SITE_PREFIX = '/api/worktable/site'

// 原生皮肤模板（esbuild text loader 嵌入；/api/worktable/template 路由直接下发）
// @ts-ignore
import dshellCss from '../template/dshell.css'
// @ts-ignore
import dshellHtml from '../template/dshell.html'
const TEMPLATE_PREFIX = '/api/worktable/template'

// 地球旅行窗格的静态数据（esbuild 内联进服务端 bundle；详见 data/globe/SOURCE.md）
// @ts-ignore
import globeLandTopo from '../data/globe/land-110m.topo'
// @ts-ignore
import globePlacesTrim from '../data/globe/places-trim.json'

/** 壁纸媒体目录：<DSH_HOME>/worktable-media（插件自有；文件不随发布包分发，也不进 git）。
 *  仅按「单个文件名」取用 —— 白名单扩展名 + 拒绝任何路径分隔符 → 无法目录穿越。 */
const WALL_MEDIA_PREFIX = '/api/worktable/media'
const WALL_MEDIA_EXT: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml',
}
function wallMediaDir(): string { return pathResolve(resolveDshHomeSafe(), 'worktable-media') }

/** 数字人自诊断信标最后一次上报（内存，不持久化） */
let dhReportCache: Record<string, unknown> | null = null

/**
 * 本机语音合成（Windows SAPI）：把一段文字合成 WAV 落到 worktable-media，返回可播放 URL。
 * 为什么走宿主而不是浏览器 speechSynthesis：源项目本身就是「本机 TTS」路线（桥接里的 Qwen3-TTS），
 * 而且浏览器语音在部分环境下会被静默拦掉；本机 SAPI 是 Windows 自带能力，零下载。
 *
 * 关键实现点（踩过的坑）：
 *  - powershell.exe（5.1）按 ANSI 读 .ps1，中文会烂 → 脚本全 ASCII，正文用 **UTF-8 文件**传；
 *  - 脚本用 -EncodedCommand（UTF-16LE base64）下发，彻底避开引号/编码转义；
 *  - 子进程 stdio 用 'ignore'（受限沙箱下管道 stdio 会 EPERM），成败以产物文件为准。
 */
async function synthesizeWav(text: string, rate: number, pitch: number, voice: string): Promise<{ url: string } | { error: string }> {
  const body = String(text ?? '').trim().slice(0, 600)
  if (!body) return { error: 'empty text' }
  const dir = wallMediaDir()
  const name = `tts-${createHash('sha1').update(body + '|' + rate + '|' + pitch + '|' + voice).digest('hex').slice(0, 16)}.wav`
  const outFile = pathResolve(dir, name)
  const { stat } = await import('node:fs/promises')
  const exists = await stat(outFile).catch(() => null)
  if (exists && exists.size > 1024) return { url: `${WALL_MEDIA_PREFIX}/${encodeURIComponent(name)}` }

  const ps = pathResolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const textFile = pathResolve(osTmpdir(), `dsh-worktable-tts-${Date.now()}.txt`)
  const { writeFile: writeFileAsync, rm } = await import('node:fs/promises')
  try {
    await writeFileAsync(textFile, body, 'utf8')
    // 单引号路径里的单引号要翻倍；正文从文件读，不进脚本
    const q = (s: string): string => "'" + s.replace(/'/g, "''") + "'"
    const script = [
      'Add-Type -AssemblyName System.Speech',
      `$t = [System.IO.File]::ReadAllText(${q(textFile)}, [System.Text.Encoding]::UTF8)`,
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      `$want = ${q(voice)}`,
      'if ($want -ne "") { try { $s.SelectVoice($want) } catch {} }',
      '$zh = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like "zh*" } | Select-Object -First 1',
      'if ($want -eq "" -and $zh) { try { $s.SelectVoice($zh.VoiceInfo.Name) } catch {} }',
      `$s.Rate = ${Math.max(-10, Math.min(10, Math.round(rate)))}`,
      `$out = ${q(outFile)}`,
      '$ok = $false',
      // 先试 SSML（可带音高，声线差异更明显）；失败或无产物再退回纯 Speak
      'try {',
      `  $esc = [System.Security.SecurityElement]::Escape($t)`,
      `  $ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-CN"><prosody rate="${Math.max(-10, Math.min(10, Math.round(rate)))}" pitch="${Math.max(-50, Math.min(50, Math.round(pitch)))}%">' + $esc + '</prosody></speak>'`,
      '  $s.SetOutputToWaveFile($out)',
      '  $s.SpeakSsml($ssml)',
      '  if ((Test-Path $out) -and ((Get-Item $out).Length -gt 1024)) { $ok = $true }',
      '} catch { $ok = $false }',
      'if (-not $ok) {',
      '  try {',
      '    $s.SetOutputToWaveFile($out)',
      '    $s.Speak($t)',
      '    if ((Test-Path $out) -and ((Get-Item $out).Length -gt 1024)) { $ok = $true }',
      '  } catch { $ok = $false }',
      '}',
      '$s.Dispose()',
      'if ($ok) { Write-Output "OK" } else { Write-Output "FAIL" }',
    ].join('\n')
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    await new Promise<void>((resolve) => {
      const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        stdio: 'ignore', // 管道 stdio 在受限沙箱下会 EPERM；成败看产物
        windowsHide: true,
      })
      const timer = setTimeout(() => { try { child.kill() } catch { /* 已退出 */ } resolve() }, 25000)
      child.on('error', () => { clearTimeout(timer); resolve() })
      child.on('close', () => { clearTimeout(timer); resolve() })
    })
    const made = await stat(outFile).catch(() => null)
    if (!made || made.size <= 1024) return { error: 'synthesis failed' }
    // 只留最近 40 个合成产物，避免目录无限膨胀
    try {
      const names = (await import('node:fs/promises').then((m) => m.readdir(dir))).filter((n) => /^tts-.*\.wav$/i.test(n))
      if (names.length > 40) {
        const withTime = await Promise.all(names.map(async (n) => ({ n, t: (await stat(pathResolve(dir, n)).catch(() => null))?.mtimeMs ?? 0 })))
        withTime.sort((a, b) => a.t - b.t)
        for (const it of withTime.slice(0, withTime.length - 40)) await rm(pathResolve(dir, it.n), { force: true }).catch(() => {})
      }
    } catch { /* 清理失败不影响本次合成 */ }
    return { url: `${WALL_MEDIA_PREFIX}/${encodeURIComponent(name)}` }
  } catch (err) {
    return { error: String(err) }
  } finally {
    await rm(textFile, { force: true }).catch(() => {})
  }
}

/**
 * 从本插件模块位置向祖先方向查找并加载 node_modules 包（如 ws / node-pty）。
 * 本包经 junction 链接进 profile，普通 import 可能解析不到 profile 级依赖；
 * 同时尝试 junction 路径与 realpath 两条祖先链。
 */
/** 依赖探测尝试计数（供测试断言「有界探测、无循环重入」） */
let loadProbeAttempts = 0
function loadPkg(pkg: string): any | null {
  const starts = new Set<string>()
  try { starts.add(dirname(fileURLToPath(import.meta.url))) } catch {}
  try { starts.add(realpathSync(dirname(fileURLToPath(import.meta.url)))) } catch {}
  for (const start of starts) {
    let dir: string | null = start
    while (dir && dir !== pathResolve(dir, '..')) {
      loadProbeAttempts++
      try {
        const req = createRequire(pathToFileURL(pathResolve(dir, '__wt_probe__.js')).href)
        return req(pkg)
      } catch {}
      dir = pathResolve(dir, '..')
    }
  }
  // 兜底：DSH profiles/*/node_modules（按 baseDshHome 解析根目录——不能用 resolveDshHomeSafe，否则与本函数成环）
  try {
    const profilesDir = pathResolve(baseDshHome(), 'profiles')
    for (const profile of readdirSync(profilesDir, { withFileTypes: true })) {
      if (!profile.isDirectory() && !profile.isSymbolicLink()) continue
      const nm = pathResolve(profilesDir, profile.name, 'node_modules')
      loadProbeAttempts++
      try {
        const req = createRequire(pathToFileURL(pathResolve(nm, '__wt_probe__.js')).href)
        return req(pkg)
      } catch {}
    }
  } catch {}
  return null
}

/** 测试钩子：依赖探测尝试次数 + 数据目录解析路径（循环回归与官方路径断言用） */
export function __wtLoadProbeStats(): { attempts: number; homeSource: 'official' | 'fallback' } {
  return { attempts: loadProbeAttempts, homeSource: dshHomeSource }
}

/** 解析会话工作目录：服务端 header.cwd 优先，其次客户端传入 cwd，最后进程 cwd */
function serverCwd(ctx: any, sessionId?: string, clientCwd?: string): string {
  if (sessionId) {
    try {
      const headerCwd = ctx.sessions?.get?.(sessionId)?.header?.cwd
      if (typeof headerCwd === 'string' && headerCwd) return headerCwd
    } catch {}
  }
  if (typeof clientCwd === 'string' && clientCwd) return clientCwd
  return process.cwd()
}

function json(res: any, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/* ---------- 地球旅行窗格（globe）：内置数据 + 三道图片源 ---------- */

/**
 * 海岸线与城市目录**随包内置**，不走网络。
 *
 * 为什么内置：这两份数据是静态的（110m 海岸线 55KB、裁剪后的城市目录 61KB），
 * 而 cdn.jsdelivr.net 在部分网络环境下不可达 —— 实测宿主里 fetch 直接
 * `TypeError: fetch failed`，于是真实海岸线退化成手绘轮廓、1251 个城市点整批消失。
 * 内联进 bundle 后完全离线可用，也省掉一次上游往返。
 * 数据来源与再生成方式见 data/globe/SOURCE.md。
 */
const GLOBE_LAND_TOPO: string = String(globeLandTopo)
const GLOBE_PLACES: any[] = Array.isArray(globePlacesTrim) ? (globePlacesTrim as any[]) : []

/**
 * 图片搜索必须用**浏览器 UA**。
 * 用 Node 默认 UA / 产品 UA 打百度图搜，会被「百度安全验证」拦下：返回一张 1438 字符的
 * 存根页（HTTP 200），抠不出任何缩略图 —— 表现就是每个地点都没有实景图。
 * 换成浏览器 UA + 先访问首页拿 Cookie 后，同一批查询从 0 张变成 30～120 张。
 */
const GLOBE_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const GLOBE_ACCEPT_LANG = 'zh-CN,zh;q=0.9,en;q=0.8'
const GLOBE_MAX_PHOTOS = 18
/** 三道图片源，按可靠性排序：百度 JSON 接口 → 百度 HTML → 必应 HTML。 */
const BAIDU_HOME_URL = 'https://image.baidu.com/'
const BAIDU_ACJSON_URL = 'https://image.baidu.com/search/acjson?'
const BAIDU_IMG_URL = 'https://image.baidu.com/search/index?tn=baiduimage&word='
const BING_IMG_URL = 'https://cn.bing.com/images/search?q='
/** 百度安全验证存根页的标题；比长度判断更明确。 */
const GLOBE_BLOCKED_MARK = '百度安全验证'
/** 空结果只短时记忆：一次拦截不该把某个地点永久钉成「没有图」。 */
const GLOBE_PHOTO_NEG_TTL = 120000
/** 一次请求里所有图片源加起来的时间预算。 */
const GLOBE_PHOTO_BUDGET = 14000

/**
 * ISO 3166-1 alpha-2 → 中文国名。
 * Natural Earth 只提供英文 adm0name，这里补中文标签；缺项自动回退英文，不会出错。
 */
const CN_COUNTRY: Record<string, string> = {
  CN: '中国', TW: '中国台湾', HK: '中国香港', MO: '中国澳门', JP: '日本', KR: '韩国', KP: '朝鲜', MN: '蒙古',
  IN: '印度', PK: '巴基斯坦', BD: '孟加拉国', LK: '斯里兰卡', NP: '尼泊尔', BT: '不丹', MV: '马尔代夫', AF: '阿富汗',
  TH: '泰国', VN: '越南', LA: '老挝', KH: '柬埔寨', MM: '缅甸', MY: '马来西亚', SG: '新加坡', ID: '印度尼西亚',
  PH: '菲律宾', BN: '文莱', TL: '东帝汶',
  KZ: '哈萨克斯坦', UZ: '乌兹别克斯坦', KG: '吉尔吉斯斯坦', TJ: '塔吉克斯坦', TM: '土库曼斯坦',
  IR: '伊朗', IQ: '伊拉克', SY: '叙利亚', LB: '黎巴嫩', JO: '约旦', IL: '以色列', PS: '巴勒斯坦',
  SA: '沙特阿拉伯', AE: '阿联酋', QA: '卡塔尔', KW: '科威特', BH: '巴林', OM: '阿曼', YE: '也门',
  TR: '土耳其', GE: '格鲁吉亚', AM: '亚美尼亚', AZ: '阿塞拜疆', CY: '塞浦路斯',
  EG: '埃及', LY: '利比亚', TN: '突尼斯', DZ: '阿尔及利亚', MA: '摩洛哥', SD: '苏丹', SS: '南苏丹',
  ET: '埃塞俄比亚', ER: '厄立特里亚', DJ: '吉布提', SO: '索马里', KE: '肯尼亚', UG: '乌干达',
  TZ: '坦桑尼亚', RW: '卢旺达', BI: '布隆迪', CD: '刚果（金）', CG: '刚果（布）', CF: '中非',
  CM: '喀麦隆', TD: '乍得', NE: '尼日尔', NG: '尼日利亚', BJ: '贝宁', TG: '多哥', GH: '加纳',
  CI: '科特迪瓦', LR: '利比里亚', SL: '塞拉利昂', GN: '几内亚', GW: '几内亚比绍', SN: '塞内加尔',
  GM: '冈比亚', MR: '毛里塔尼亚', ML: '马里', BF: '布基纳法索', AO: '安哥拉', ZM: '赞比亚',
  ZW: '津巴布韦', MW: '马拉维', MZ: '莫桑比克', MG: '马达加斯加', MU: '毛里求斯', SC: '塞舌尔',
  NA: '纳米比亚', BW: '博茨瓦纳', ZA: '南非', LS: '莱索托', SZ: '斯威士兰', GA: '加蓬',
  GQ: '赤道几内亚', ST: '圣多美和普林西比', CV: '佛得角',
  RU: '俄罗斯', UA: '乌克兰', BY: '白俄罗斯', MD: '摩尔多瓦', PL: '波兰', CZ: '捷克', SK: '斯洛伐克',
  HU: '匈牙利', RO: '罗马尼亚', BG: '保加利亚', GR: '希腊', AL: '阿尔巴尼亚', MK: '北马其顿',
  RS: '塞尔维亚', BA: '波黑', HR: '克罗地亚', SI: '斯洛文尼亚', ME: '黑山', XK: '科索沃',
  IT: '意大利', MT: '马耳他', ES: '西班牙', PT: '葡萄牙', FR: '法国', MC: '摩纳哥', AD: '安道尔',
  DE: '德国', AT: '奥地利', CH: '瑞士', LI: '列支敦士登', BE: '比利时', NL: '荷兰', LU: '卢森堡',
  GB: '英国', IE: '爱尔兰', IS: '冰岛', NO: '挪威', SE: '瑞典', FI: '芬兰', DK: '丹麦',
  EE: '爱沙尼亚', LV: '拉脱维亚', LT: '立陶宛',
  US: '美国', CA: '加拿大', MX: '墨西哥', GT: '危地马拉', BZ: '伯利兹', SV: '萨尔瓦多',
  HN: '洪都拉斯', NI: '尼加拉瓜', CR: '哥斯达黎加', PA: '巴拿马', CU: '古巴', JM: '牙买加',
  HT: '海地', DO: '多米尼加', PR: '波多黎各', BS: '巴哈马', BB: '巴巴多斯', TT: '特立尼达和多巴哥',
  GD: '格林纳达', LC: '圣卢西亚', VC: '圣文森特和格林纳丁斯', AG: '安提瓜和巴布达', DM: '多米尼克',
  KN: '圣基茨和尼维斯', BM: '百慕大', GL: '格陵兰',
  CO: '哥伦比亚', VE: '委内瑞拉', GY: '圭亚那', SR: '苏里南', GF: '法属圭亚那', EC: '厄瓜多尔',
  PE: '秘鲁', BR: '巴西', BO: '玻利维亚', PY: '巴拉圭', UY: '乌拉圭', AR: '阿根廷', CL: '智利',
  AU: '澳大利亚', NZ: '新西兰', PG: '巴布亚新几内亚', FJ: '斐济', SB: '所罗门群岛', VU: '瓦努阿图',
  NC: '新喀里多尼亚', PF: '法属波利尼西亚', WS: '萨摩亚', TO: '汤加', KI: '基里巴斯',
  TV: '图瓦卢', NR: '瑙鲁', PW: '帕劳', FM: '密克罗尼西亚', MH: '马绍尔群岛', GU: '关岛',
  AQ: '南极洲',
}

/** ISO2 → 国旗 emoji（区域指示符）；非两字母代码回退为 📍。 */
function flagOfIso(iso: string): string {
  const s = String(iso || '').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(s)) return '📍'
  return String.fromCodePoint(0x1f1e6 + s.charCodeAt(0) - 65, 0x1f1e6 + s.charCodeAt(1) - 65)
}

/** 人口 → 可读文本（只用于一句话简介）。 */
function popText(n: number): string {
  if (!n || n <= 0) return ''
  if (n >= 100000000) return (n / 100000000).toFixed(1) + ' 亿'
  if (n >= 10000) return Math.round(n / 10000) + ' 万'
  return String(n)
}

/**
 * 把 851KB 的 GeoJSON 裁成客户端要的最小行：
 *   [名称, 中文国名, 国旗, 纬度, 经度, 人口文本, 分级]
 * 分级用于客户端按缩放做标记 LOD：0 = 首都/世界城市/≥200 万，1 = ≥30 万，2 = 其余。
 */
function trimPlaces(geo: any): any[] {
  const out: any[] = []
  const feats = geo && Array.isArray(geo.features) ? geo.features : []
  for (const f of feats) {
    const p = f && f.properties
    if (!p) continue
    const lat = Number(p.latitude)
    const lon = Number(p.longitude)
    if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) continue
    const name = String(p.name || '').trim()
    if (!name) continue
    const iso = String(p.iso_a2 || '').toUpperCase()
    const country = CN_COUNTRY[iso] || String(p.adm0name || '')
    const pop = Number(p.pop_max) || 0
    const rank = Number(p.adm0cap) === 1 || Number(p.worldcity) === 1 || pop >= 2000000
      ? 0
      : pop >= 300000 ? 1 : 2
    out.push([name, country, flagOfIso(iso), Number(lat.toFixed(3)), Number(lon.toFixed(3)), popText(pop), rank])
  }
  return out
}

/**
 * 规整并校验一条图链。
 *
 * 百度图链的 `&` 在 HTML 里被 JSON 转义成 `\u0026`，**必须还原**（不还原的裸链实测直接 400）；
 * 而且百度、必应的图链都不带文件扩展名，所以判定不能只看 `.jpg`。
 */
function cleanImgUrl(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return ''
  const u = raw
    .replace(/\\u0026/g, '&')
    .split('\\u002F').join('/')
    .split('\\u002f').join('/')
    .split('\\/').join('/')
  if (!/^https?:\/\//.test(u)) return ''
  if (u.includes('"') || u.includes("'") || /\s/.test(u) || u.includes('\\')) return ''
  /* 百度图床 / 必应缩略图床：都无扩展名，但都是可以直连的图 */
  if (/^https?:\/\/img\d*\.baidu\.com\/it\/u=/.test(u)) return u
  if (/^https?:\/\/(?:ts|tse)\d*\.mm\.bing\.net\/th/.test(u)) return u
  if (/^https?:\/\/th\.bing\.com\/th/.test(u)) return u
  if (/\.(jpe?g|png|webp|gif)(\?|$)/i.test(u)) return u
  return ''
}

/** 把候选图链按顺序收进结果（去重）。 */
function pushPhotos(out: string[], ...raws: unknown[]): void {
  for (const raw of raws) {
    const u = cleanImgUrl(raw)
    if (u && !out.includes(u)) out.push(u)
  }
}

/**
 * 从百度图搜 HTML 里抠出缩略图候选 URL。
 *
 * 页面字段形如 `"thumburl":"https://imgN.baidu.com/it/u=...,...\u0026fm=253&app=138..."`。
 */
function harvestBaiduPhotos(text: string): string[] {
  const out: string[] = []
  if (!text) return out
  const re = /"(?:thumburl|thumbURL|hoverurl|hoverURL|middleurl|middleURL)"\s*:\s*"(https?:[^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) pushPhotos(out, m[1])
  return out
}

/**
 * 百度图搜的 JSON 接口（`/search/acjson`，页面自己调的那个）。
 * 纯 JSON、字段即 `thumbURL`，比抠 HTML 稳，优先用它。
 */
function harvestBaiduJson(text: string): string[] {
  const out: string[] = []
  if (!text || text.charAt(0) !== '{') return out
  let j: any = null
  try { j = JSON.parse(text) } catch { return out }
  const rows = j && Array.isArray(j.data) ? j.data : []
  for (const d of rows) {
    if (!d || typeof d !== 'object') continue
    pushPhotos(out, d.thumbURL, d.middleURL, d.hoverURL)
  }
  return out
}

/**
 * 必应图搜 HTML：结果项形如 `m="{&quot;murl&quot;:&quot;...&quot;,&quot;turl&quot;:&quot;...&quot;}"`。
 * 优先取 `turl`（`*.mm.bing.net` / `th.bing.com` 的缩略图，国内可直连、无防盗链），没有才退回 `murl`。
 */
function harvestBingPhotos(text: string): string[] {
  const out: string[] = []
  if (!text) return out
  const re = /m="\{&quot;([\s\S]{0,1500}?)\}"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const attrs = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    const turl = attrs.match(/"turl":"(https?:[^"]+)"/)
    const murl = attrs.match(/"murl":"(https?:[^"]+)"/)
    /* 只信任必应自己的缩略图床；murl 是任意第三方站点，可能被墙或防盗链 */
    pushPhotos(out, turl ? turl[1] : '', murl && /mm\.bing\.net|th\.bing\.com/.test(murl[1]) ? murl[1] : '')
  }
  return out
}

/** 被「百度安全验证」拦下的存根页（HTTP 200，但正文只有一千多字符）。 */
function isBlockedPage(text: string): boolean {
  return !text || text.length < 3000 || text.includes(GLOBE_BLOCKED_MARK)
}

/** 浏览器式请求头（UA 必须像浏览器，否则百度直接给安全验证页）。 */
function globeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'user-agent': GLOBE_BROWSER_UA, 'accept-language': GLOBE_ACCEPT_LANG, ...extra }
}

/** 百度会话 Cookie：先访问一次首页拿 BAIDUID，再带着它搜索。30 分钟过期。 */
let globeBaiduCookie = ''
let globeBaiduCookieAt = 0
const GLOBE_COOKIE_TTL = 1800000

async function ensureBaiduCookie(force = false): Promise<string> {
  if (!force && globeBaiduCookie && Date.now() - globeBaiduCookieAt < GLOBE_COOKIE_TTL) return globeBaiduCookie
  try {
    const r: any = await fetch(BAIDU_HOME_URL, {
      headers: globeHeaders({ accept: 'text/html,application/xhtml+xml' }),
      signal: AbortSignal.timeout(10000),
    })
    await r.text()
    /* getSetCookie() 才能拿到完整的多个 Set-Cookie；退化路径只取单个 header */
    const jar: string[] = typeof r.headers?.getSetCookie === 'function' ? r.headers.getSetCookie() : []
    const single = jar.length || typeof r.headers?.get !== 'function' ? '' : (r.headers.get('set-cookie') || '')
    const parts = (jar.length ? jar : [single])
      .map((c: string) => String(c).split(';')[0].trim())
      .filter(Boolean)
    if (parts.length) { globeBaiduCookie = parts.join('; '); globeBaiduCookieAt = Date.now() }
  } catch { /* 拿不到 Cookie 也照样试一次 */ }
  return globeBaiduCookie
}

/** 一次图片源尝试的结果。 */
type GlobeShot = { photos: string[]; status: number; blocked: boolean }

/** 源 1：百度图搜 JSON 接口（页面自己调的 acjson）。 */
async function shotBaiduJson(q: string, cookie: string): Promise<GlobeShot> {
  const p = new URLSearchParams({
    tn: 'resultjson_com', logid: '1', ipn: 'rj', ct: '201326592', is: '', fp: 'result',
    queryWord: q, cl: '2', lm: '-1', ie: 'utf-8', oe: 'utf-8', adpicid: '', st: '-1', z: '',
    ic: '0', hd: '', latest: '', copyright: '', word: q, s: '', se: '', tab: '', width: '',
    height: '', face: '0', istype: '2', qc: '', nc: '1', expermode: '', nojc: '', isAsync: '',
    pn: '0', rn: '30', gsm: '1e',
  })
  const r = await fetch(BAIDU_ACJSON_URL + p.toString(), {
    headers: globeHeaders({ accept: 'application/json, text/plain, */*', referer: BAIDU_IMG_URL + encodeURIComponent(q), cookie }),
    signal: AbortSignal.timeout(9000),
  })
  const text = r.ok ? await r.text() : ''
  return { photos: harvestBaiduJson(text), status: r.status, blocked: r.ok && isBlockedPage(text) }
}

/** 源 2：百度图搜 HTML 页（候选更多，但更容易被拦）。 */
async function shotBaiduHtml(q: string, cookie: string): Promise<GlobeShot> {
  const r = await fetch(BAIDU_IMG_URL + encodeURIComponent(q), {
    headers: globeHeaders({ accept: 'text/html,application/xhtml+xml', referer: BAIDU_HOME_URL, cookie }),
    signal: AbortSignal.timeout(9000),
  })
  const text = r.ok ? await r.text() : ''
  return { photos: harvestBaiduPhotos(text), status: r.status, blocked: r.ok && isBlockedPage(text) }
}

/** 源 3：必应图搜（缩略图走 mm.bing.net，国内可直连）。 */
async function shotBing(q: string): Promise<GlobeShot> {
  const r = await fetch(BING_IMG_URL + encodeURIComponent(q) + '&form=HDRSC2&first=1', {
    headers: globeHeaders({ accept: 'text/html,application/xhtml+xml' }),
    signal: AbortSignal.timeout(9000),
  })
  const text = r.ok ? await r.text() : ''
  return { photos: harvestBingPhotos(text), status: r.status, blocked: false }
}

/**
 * 依次问三道图片源，谁先给出候选就用谁。
 * 第一道被拦（安全验证）时先刷新一次 Cookie 再重试同一源 —— 多数情况下这一次就过了。
 * 全部源都直接抛错（断网/DNS）时把错误抛出去，由路由如实回 502。
 */
async function collectGlobePhotos(q: string): Promise<{ photos: string[]; source: string; reason: string }> {
  const started = Date.now()
  let lastStatus = 0
  let sawBlocked = false
  let gotAnyStatus = false
  let lastErr: any = null
  let refreshed = false
  let source = ''

  await ensureBaiduCookie()
  const sources: Array<{ name: string; run: () => Promise<GlobeShot> }> = [
    { name: 'baidu-json', run: () => shotBaiduJson(q, globeBaiduCookie) },
    { name: 'baidu-html', run: () => shotBaiduHtml(q, globeBaiduCookie) },
    { name: 'bing', run: () => shotBing(q) },
  ]

  outer:
  for (const s of sources) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() - started > GLOBE_PHOTO_BUDGET) break outer
      try {
        const r = await s.run()
        if (r.status) { gotAnyStatus = true; lastStatus = r.status }
        if (r.blocked) sawBlocked = true
        if (r.photos.length) {
          return { photos: r.photos.slice(0, GLOBE_MAX_PHOTOS), source: s.name, reason: '' }
        }
        /* 被拦 + 还没刷过 Cookie → 刷新后重试同一源 */
        if (r.blocked && !refreshed && s.name.indexOf('baidu') === 0) {
          refreshed = true
          await ensureBaiduCookie(true)
          continue
        }
      } catch (err) { lastErr = err }
      break
    }
  }

  if (!gotAnyStatus && lastErr) throw lastErr
  const reason = lastStatus >= 400 ? 'upstream ' + lastStatus
    : sawBlocked ? '图片源要求人机验证'
      : '没有找到可用的实景图'
  return { photos: [], source, reason }
}

/** 构建期生成 data/globe/places-trim.json 用：保证内置数据与裁剪逻辑出自同一份代码。 */
export function __wtTrimPlaces(geo: any): any[] { return trimPlaces(geo) }

async function readJsonBody(req: any): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try { return JSON.parse(text) } catch { return {} }
}

/** 列出一个目录层级（目录在前、大小写不敏感排序、上限 500、隐藏项标注） */
async function listDirectory(path: string) {
  const abs = pathResolve(path)
  const dirents = await readdir(abs, { withFileTypes: true })
  const entries = dirents
    .map((d) => ({ name: d.name, path: abs + sep + d.name, isDir: d.isDirectory(), hidden: d.name.startsWith('.') }))
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
  const truncated = entries.length > MAX_ENTRIES
  return { path: abs, entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries, truncated }
}

function gitExec(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolvePromise(stdout)
    })
  })
}

/** git 状态快照（porcelain v1 -z；非仓库返回 isRepo:false） */
async function gitStatus(cwd: string) {
  try {
    const branchRaw = await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
    const porcelain = await gitExec(['status', '--porcelain=v1', '-z'], cwd)
    const entries = porcelain
      .split('\0')
      .filter((s) => s.length > 2)
      .map((s) => ({ xy: s.slice(0, 2), path: s.slice(3) }))
    return { isRepo: true, branch: branchRaw.trim() || 'HEAD', entries }
  } catch {
    return { isRepo: false, branch: undefined, entries: [] }
  }
}

/** 终端 WebSocket 升级路由（同步注册 + ctx.effect，同 better-sidebar；node-pty 缺失时不注册） */
function setupTerminal(webServer: any, ctx: any) {
  if (typeof webServer.registerUpgrade !== 'function') return
  const wsMod = loadPkg('ws')
  const ptyMod = loadPkg('node-pty')
  ctx.logger?.info?.('[dsh-worktable] term deps: ws=' + (wsMod ? 'ok' : 'MISSING') + ' node-pty=' + (ptyMod ? 'ok' : 'MISSING'))
  if (!wsMod || !ptyMod) {
    ctx.logger?.warn('[dsh-worktable] 终端路由未注册：ws/node-pty 不可用')
    return
  }
  const WebSocketServer = wsMod.WebSocketServer ?? wsMod.default?.WebSocketServer
  if (!WebSocketServer) return
  const pty = ptyMod.default ?? ptyMod
  const wss = new WebSocketServer({ noServer: true })
  const spawnShell = (): { cmd: string; args: string[] } =>
    process.platform === 'win32'
      ? { cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] } // -NoProfile：跳过用户配置（oh-my-posh 花哨提示符在 xterm 里是乱码，PSReadLine 长输入行不换行被截断）
      : { cmd: process.env.SHELL || '/bin/bash', args: [] }
  const clampDim = (v: number, fallback: number) => Math.min(1024, Math.max(2, Number.isFinite(v) ? v : fallback))

  ctx.effect(() => webServer.registerUpgrade({
    path: '/api/worktable/term',
    handler: (req: any, socket: any, head: any) => {
      wss.handleUpgrade(req, socket, head, (ws: any) => {
        const u = new URL(req.url ?? '/', 'http://dsh.internal')
        const cwd = serverCwd(ctx, u.searchParams.get('sessionId') || undefined, u.searchParams.get('cwd') || undefined)
        const cols = clampDim(Number(u.searchParams.get('cols')), 80)
        const rows = clampDim(Number(u.searchParams.get('rows')), 24)
        let term: any = null
        try {
          const shell = spawnShell()
          term = pty.spawn(shell.cmd, shell.args, { name: 'xterm-256color', cols, rows, cwd, env: process.env })
        } catch (err) {
          try { ws.send('\r\n[worktable] 终端启动失败：' + String(err)) } catch {}
          try { ws.close() } catch {}
          return
        }
        term.onData((d: string) => { try { ws.send(d) } catch {} })
        term.onExit(() => { try { ws.close() } catch {} })
        ws.on('message', (raw: any) => {
          const text = String(raw)
          try {
            const msg = JSON.parse(text)
            if (msg && msg.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
              term.resize(clampDim(msg.cols, cols), clampDim(msg.rows, rows))
              return
            }
          } catch {}
          try { term.write(text) } catch {}
        })
        ws.on('close', () => { try { term.kill() } catch {} })
      })
    },
  }), 'dsh-worktable: terminal upgrade')
}

export function apply(ctx: Context) {
  const webServer = (ctx as any).webServer
  if (!webServer) {
    ctx.logger?.warn('[dsh-worktable] ctx.webServer 不可用（headless profile？），跳过服务端路由')
    return
  }

  webServer.register({
    kind: 'exact',
    path: HEALTH_PATH,
    handler: (_req: any, res: any) => {
      json(res, 200, { plugin: 'dsh-worktable', version: PLUGIN_VERSION, ok: true })
    },
  })

  // 本地文件读取（资源管理器点击 .html 后浏览器标签内打开）
  webServer.register({
    kind: 'exact',
    path: '/api/worktable/file',
    handler: async (req: any, res: any) => {
      try {
        const u = new URL(req.url ?? '/', 'http://dsh.internal')
        const p = u.searchParams.get('path') || ''
        if (!p) { json(res, 400, { error: 'missing path' }); return }
        const abs = pathResolve(p)
        const stat = await import('node:fs/promises').then((m) => m.stat(abs))
        if (stat.size > 20 * 1024 * 1024) { json(res, 413, { error: 'file too large' }); return }
        const data = await readFile(abs)
        const ext = (abs.split('.').pop() || '').toLowerCase()
        const types: Record<string, string> = {
          html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
          css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
          json: 'application/json; charset=utf-8', md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
          pdf: 'application/pdf', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon',
        }
        res.writeHead(200, { 'content-type': FILE_TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' })
        res.end(data)
      } catch (err) {
        json(res, 404, { error: String(err) })
      }
    },
  })

  // 本地站点（目录级静态托管）：点开 index.html 时挂载整个所在目录，
  // 让 ./assets/... 等相对引用正常解析（前缀路由，余下路径 = <rootToken>/<相对路径>）。
  // 原生皮肤模板：HTML 骨架 + 设计系统样式表（随插件分发，主题自动适配）
  webServer.register({
    kind: 'prefix',
    path: TEMPLATE_PREFIX,
    handler: (req: any, res: any) => {
      try {
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const rel = pathname.slice(TEMPLATE_PREFIX.length)
        if (rel === '/dshell.css') {
          res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' })
          res.end(dshellCss)
        } else {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(dshellHtml)
        }
      } catch (err) {
        res.writeHead(404); res.end(String(err))
      }
    },
  })

  // 数字人内置形象清单：<DSH_HOME>/worktable-media/dh-*.mp4（取自上游数字人项目的美女循环片；
  // 素材与壁纸同理不进发布包，随机器安装）。客户端据此列「内置形象」，并把第一条当默认形象。
  webServer.register({
    kind: 'exact',
    path: '/api/worktable/dh',
    handler: async (req: any, res: any) => {
      try {
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
        const names = await import('node:fs/promises')
          .then((m) => m.readdir(wallMediaDir()))
          .catch(() => [] as string[])
        const avatars = names
          .filter((n) => /^dh-[^/\\]+\.(mp4|webm|mov)$/i.test(n))
          .sort()
          .map((name) => ({ name, url: `${WALL_MEDIA_PREFIX}/${encodeURIComponent(name)}` }))
        json(res, 200, { avatars })
      } catch (err) {
        // 清单读取失败不该让窗格报错：回空列表，客户端自然回落媒体库
        json(res, 200, { avatars: [], error: String(err) })
      }
    },
  })

  // 本机语音合成：POST { text, rate, pitch } → { url }
  // 数字人朗读的主路径（Windows SAPI，零下载）；浏览器语音只作兜底。
  webServer.register({
    kind: 'exact',
    path: '/api/worktable/tts',
    handler: async (req: any, res: any) => {
      try {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const body = await readJsonBody(req)
        const text = typeof body?.text === 'string' ? body.text : ''
        const rate = Number.isFinite(Number(body?.rate)) ? Number(body.rate) : 0
        const pitch = Number.isFinite(Number(body?.pitch)) ? Number(body.pitch) : 0
        const voice = typeof body?.voice === 'string' ? body.voice.slice(0, 80) : ''
        const out = await synthesizeWav(text, rate, pitch, voice)
        if ('error' in out) { json(res, 200, { ok: false, error: out.error }); return }
        json(res, 200, { ok: true, url: out.url })
      } catch (err) {
        json(res, 200, { ok: false, error: String(err) })
      }
    },
  })

  // 数字人自诊断信标：客户端 POST 上报浏览器侧真实状态（构建标记/音色数/朗读结果/取文字数），
  // 宿主 GET 读回。排查「数字人没声音」时不靠用户描述，直接看浏览器里发生了什么；只读、无敏感信息。
  webServer.register({
    kind: 'exact',
    path: '/api/worktable/dh/report',
    handler: async (req: any, res: any) => {
      try {
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          dhReportCache = { ...body, receivedAt: Date.now() }
          json(res, 200, { ok: true })
          return
        }
        json(res, 200, { report: dhReportCache })
      } catch (err) {
        json(res, 200, { report: dhReportCache, error: String(err) })
      }
    },
  })

  // 壁纸媒体流：/api/worktable/media/<文件名>（来自 <DSH_HOME>/worktable-media）。
  // 必须支持 Range：<video> 会按字节区间取流，只回 200 全量会导致循环播放/seek 异常。
  webServer.register({
    kind: 'prefix',
    path: WALL_MEDIA_PREFIX,
    handler: async (req: any, res: any) => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        let name = ''
        try { name = decodeURIComponent(pathname.slice(WALL_MEDIA_PREFIX.length).replace(/^\/+/, '')) } catch { name = '' }
        if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) { json(res, 400, { error: 'bad name' }); return }
        const ext = (name.split('.').pop() || '').toLowerCase()
        const type = WALL_MEDIA_EXT[ext]
        if (!type) { json(res, 415, { error: 'unsupported type' }); return }
        const dir = wallMediaDir()
        const abs = pathResolve(dir, name)
        const st = await import('node:fs/promises').then((m) => m.stat(abs)).catch(() => null)
        if (!st || !st.isFile()) { json(res, 404, { error: 'not found', dir }); return }
        const size = st.size
        // 校验器 + 条件请求：素材可换但 URL 不变，所以用 ETag/Last-Modified 让浏览器「每次重新
        // 校验、通常回 304」——既不会拿旧字节（no-cache 语义保持），也不会在暂停/续播/seek 时把
        // 已缓存的区间整段重下。Range 请求带 If-Range 不匹配时必须回整段（不能回 206 拼接旧数据）。
        const etag = `W/"${size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
        const lastMod = st.mtime.toUTCString()
        const validators = { etag, 'last-modified': lastMod, 'cache-control': 'no-cache' }
        const inm = String(req.headers?.['if-none-match'] ?? '').trim()
        const ims = String(req.headers?.['if-modified-since'] ?? '').trim()
        const notModified = inm ? inm.split(',').some((v) => v.trim() === etag || v.trim() === '*')
          : (ims ? Date.parse(ims) >= Math.floor(st.mtimeMs / 1000) * 1000 : false)
        if (notModified) { res.writeHead(304, validators); res.end(); return }
        const rawRange = String(req.headers?.range ?? '').trim()
        const ifRange = String(req.headers?.['if-range'] ?? '').trim()
        const rangeOk = !ifRange || ifRange === etag ||
          (() => { const t = Date.parse(ifRange); return Number.isFinite(t) && t >= Math.floor(st.mtimeMs / 1000) * 1000 })()
        const m = rangeOk ? /^bytes=(\d*)-(\d*)$/.exec(rawRange) : null
        if (m) {
          const hasStart = m[1] !== ''
          const hasEnd = m[2] !== ''
          let start = hasStart ? parseInt(m[1], 10) : 0
          let end = hasEnd ? parseInt(m[2], 10) : size - 1
          // "bytes=-N" 后缀语法 = 最后 N 字节
          if (!hasStart && hasEnd) { start = Math.max(0, size - end); end = size - 1 }
          if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
            res.writeHead(416, { 'content-range': 'bytes */' + size }); res.end(); return
          }
          end = Math.min(end, size - 1)
          res.writeHead(206, {
            'content-type': type,
            'content-length': String(end - start + 1),
            'content-range': 'bytes ' + start + '-' + end + '/' + size,
            'accept-ranges': 'bytes',
            ...validators,
          })
          if (req.method === 'HEAD') { res.end(); return }
          const stream = createReadStream(abs, { start, end })
          stream.on('error', () => { try { res.destroy() } catch {} })
          res.on('close', () => { try { stream.destroy() } catch {} })
          stream.pipe(res)
          return
        }
        res.writeHead(200, { 'content-type': type, 'content-length': String(size), 'accept-ranges': 'bytes', ...validators })
        if (req.method === 'HEAD') { res.end(); return }
        const stream = createReadStream(abs)
        stream.on('error', () => { try { res.destroy() } catch {} })
        res.on('close', () => { try { stream.destroy() } catch {} })
        stream.pipe(res)
      } catch (err) {
        json(res, 500, { error: String(err) })
      }
    },
  })

  webServer.register({
    kind: 'prefix',
    path: SITE_PREFIX,
    handler: async (req: any, res: any) => {
      try {
        if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const segs = pathname.slice(SITE_PREFIX.length).split('/').filter(Boolean)
        const rootToken = decodeURIComponent(segs.shift() ?? '')
        const rel = segs.map((s) => { try { return decodeURIComponent(s) } catch { return s } }).join('/')
        if (!rootToken) { json(res, 400, { error: 'missing root' }); return }
        const root = pathResolve(rootToken)
        let abs = pathResolve(root, rel)
        if (abs !== root && !abs.startsWith(root + sep)) { json(res, 403, { error: 'outside root' }); return }
        const statMod = await import('node:fs/promises')
        let info = await statMod.stat(abs).catch(() => null)
        if (info && info.isDirectory()) {
          abs = pathResolve(abs, 'index.html')
          info = await statMod.stat(abs).catch(() => null)
        }
        if (!info || !info.isFile()) { json(res, 404, { error: 'not found' }); return }
        if (info.size > 40 * 1024 * 1024) { json(res, 413, { error: 'file too large' }); return }
        const data = await readFile(abs)
        const ext = (abs.split('.').pop() || '').toLowerCase()
        res.writeHead(200, { 'content-type': FILE_TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' })
        res.end(data)
      } catch (err) {
        json(res, 404, { error: String(err) })
      }
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/api/worktable/fs',
    handler: async (req: any, res: any) => {
      try {
        const body = await readJsonBody(req)
        const path = typeof body.path === 'string' && body.path
          ? body.path
          : serverCwd(ctx, body.sessionId, body.cwd)
        json(res, 200, await listDirectory(path))
      } catch (err) {
        json(res, 500, { path: '', entries: [], truncated: false, error: String(err) })
      }
    },
  })

  // 工作区列表（自定义窗口会话分组用）：
  // 优先走宿主正式服务 ctx.workspaceRegistry（0.1.1/0.1.2 均有，正确感知 DSH_HOME 与存储后端）；
  // 不可用时回退按 resolveDshHomeSafe() 读 storages/workspace.json（只读）。
  // 返回结构是客户端契约，两种来源都映射成同一 shape。
  webServer.register({
    kind: 'exact',
    path: '/api/worktable/workspaces',
    handler: async (_req: any, res: any) => {
      try {
        // cordis 对未 inject 服务的属性访问会直接 throw（不返回 undefined），必须 try-catch 探测
        let registry: any = null
        try { registry = (ctx as any).workspaceRegistry ?? null } catch {}
        if (!registry) {
          try { registry = ctx.get?.('workspaceRegistry') ?? null } catch {}
        }
        if (registry && typeof registry.list === 'function') {
          const list = registry.list() ?? []
          const workspaceIds: string[] = []
          const tables: Record<string, { title?: string; sessionIds?: string[] }> = {}
          for (const ws of list) {
            const id = String(ws?.id ?? '')
            if (!id) continue
            workspaceIds.push(id)
            tables[id] = {
              title: typeof ws?.title === 'string' ? ws.title : undefined,
              sessionIds: Array.isArray(ws?.sessionIds) ? ws.sessionIds.map(String) : [],
            }
          }
          let archived: string[] = []
          try { archived = (registry.archivedSessionIds ?? []).map(String) } catch {}
          json(res, 200, {
            unit: { name: 'workspace', version: 2 },
            global: { initialized: true, workspaceIds, archivedSessionIds: archived },
            tables: { workspaces: tables },
          })
          return
        }
        const file = pathResolve(resolveDshHomeSafe(), 'storages', 'workspace.json')
        const raw = await readFile(file, 'utf8')
        // 容忍 BOM（外部工具改写可能带 EF BB BF，JSON.parse 会抛错）
        json(res, 200, JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw))
      } catch (err) {
        json(res, 404, { error: String(err) })
      }
    },
  })

  // 本地文件写入（MD 编辑模式保存回磁盘）
  webServer.register({
    kind: 'exact',
    path: '/api/worktable/write',
    handler: async (req: any, res: any) => {
      try {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const body = await readJsonBody(req)
        const p = typeof body.path === 'string' ? body.path : ''
        const content = typeof body.content === 'string' ? body.content : ''
        if (!p) { json(res, 400, { error: 'missing path' }); return }
        if (content.length > 20 * 1024 * 1024) { json(res, 413, { error: 'content too large' }); return }
        const abs = pathResolve(p)
        await import('node:fs/promises').then((m) => m.writeFile(abs, content, 'utf8'))
        json(res, 200, { ok: true })
      } catch (err) {
        json(res, 500, { error: String(err) })
      }
    },
  })

  // 新建分组：创建目录（仅当父目录已存在，避免递归误建深层垃圾目录）
  webServer.register({
    kind: 'exact',
    path: '/api/worktable/mkdir',
    handler: async (req: any, res: any) => {
      try {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
        const body = await readJsonBody(req)
        const p = typeof body.path === 'string' ? body.path.trim() : ''
        if (!p) { json(res, 400, { error: 'missing path' }); return }
        const abs = pathResolve(p)
        const fsx = await import('node:fs/promises')
        const parent = dirname(abs)
        try { await fsx.access(parent) } catch { json(res, 400, { error: 'parent not found' }); return }
        await fsx.mkdir(abs)
        json(res, 200, { ok: true, path: abs })
      } catch (err: any) {
        json(res, err?.code === 'EEXIST' ? 200 : 500, err?.code === 'EEXIST' ? { ok: true, exists: true } : { error: String(err) })
      }
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/api/worktable/git',
    handler: async (req: any, res: any) => {
      const body = await readJsonBody(req)
      const cwd = serverCwd(ctx, body.sessionId, body.cwd)
      json(res, 200, await gitStatus(cwd))
    },
  })

  /* ---------- 地球旅行窗格：内置海岸线/城市目录 + 当地实景图 ---------- */
  // 海岸线与城市目录随包内置（见 GLOBE_LAND_TOPO / GLOBE_PLACES 注释），路由不再依赖上游；
  // 实景图按查询词缓存：命中长期有效，空结果只记 2 分钟（一次被拦不该变成永久没图）。
  const globePhotoCache = new Map<string, { photos: string[]; source: string; reason: string; at: number }>()

  webServer.register({
    kind: 'exact',
    path: '/api/worktable/globe/land',
    handler: async (_req: any, res: any) => {
      if (!GLOBE_LAND_TOPO || GLOBE_LAND_TOPO.charAt(0) !== '{') {
        json(res, 500, { ok: false, reason: 'bundled land data missing' })
        return
      }
      json(res, 200, { ok: true, topo: GLOBE_LAND_TOPO })
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/api/worktable/globe/photos',
    handler: async (req: any, res: any) => {
      try {
        const q = String(new URL(req.url ?? '/', 'http://localhost').searchParams.get('q') ?? '').trim().slice(0, 48)
        if (!q) { json(res, 400, { ok: false, photos: [], reason: 'empty query' }); return }
        const hit = globePhotoCache.get(q)
        if (hit && (hit.photos.length > 0 || Date.now() - hit.at < GLOBE_PHOTO_NEG_TTL)) {
          json(res, 200, { ok: hit.photos.length > 0, photos: hit.photos, source: hit.source, reason: hit.reason })
          return
        }
        const got = await collectGlobePhotos(q)
        if (globePhotoCache.size > 200) globePhotoCache.clear()
        globePhotoCache.set(q, { photos: got.photos, source: got.source, reason: got.reason, at: Date.now() })
        json(res, 200, { ok: got.photos.length > 0, photos: got.photos, source: got.source, reason: got.reason })
      } catch (err) {
        json(res, 502, { ok: false, photos: [], reason: String(err).slice(0, 140) })
      }
    },
  })

  /* 补充城市目录：1251 个真实城市点，构建期裁剪后内联（客户端与内置 347 个手写点位合并去重） */
  webServer.register({
    kind: 'exact',
    path: '/api/worktable/globe/places',
    handler: async (_req: any, res: any) => {
      json(res, 200, { ok: GLOBE_PLACES.length > 0, places: GLOBE_PLACES })
    },
  })

  setupTerminal(webServer, ctx)
}
