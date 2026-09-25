/**
 * 数字人窗格（工作台内建内容 type: 'digitalhuman'）。
 *
 * 最小版形态：形象优先用**内置形象**（<DSH_HOME>/worktable-media/dh-*.mp4，取自上游数字人项目
 * beiyege-01/dsh-voice-ai-girlfriend 的 assets/bg-images 美女循环片，宿主路由 /api/worktable/dh 下发清单），
 * 其次用工作台媒体库（IndexedDB `photoRecords`）；待机时循环播放，助手回复期间切「思考中」、
 * 回复落地后切「说话」（形象轻推近 + 声波条 + 柔光描边）；朗读开着时用浏览器内置语音念出来。
 *
 * 语音聊天：底部 🎙 点一下连续聆听（宿主内置识别，零安装零模型），每句识别完直接送进当前会话；
 * 你一说话就打断正在念的回复（对应源项目的 barge-in / interruptReply）；回复落地再朗读回来。
 *
 * 刻意砍掉：Python 桥接（:8765）、DUIX 口型视频生成、OmniVoice 声音克隆、silero VAD 打断。
 * 工作台侧只保留「形象 + 状态 + 朗读 + 语音输入」，不引入任何本地模型与外部进程。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { photoStore, type PhotoRecord } from './photoStore'

/** 工作台注入的数字人环境（index.tsx 组装；splitEnv 在挂载后才注入，故用取值函数） */
export type DhEnv = {
  /** 会话快照变化订阅（返回退订函数） */
  subscribe: (fn: () => void) => () => void
  /** 读某会话的最新助手回复文本与运行态（纯读内存镜像，零 Token） */
  read: (sessionId: string) => { text: string; running: boolean }
  /** 第二条取文通道：宿主 history 异步只读（内存镜像取不到时兜底） */
  readAsync?: (sessionId: string) => Promise<string>
  /** 把一句话送进当前会话（语音识别结果走这条；宿主侧按 queue 投递） */
  send?: (text: string) => Promise<void>
}

export type DhPaneProps = {
  env: () => DhEnv | null
  /** 当前会话 id（跟随宿主当前会话） */
  sessionId: () => string
  t: (key: string, params?: Record<string, string>) => string
}

const PREF_KEY = 'dsh.worktable.dh.v1'
/** 朗读上限：整段回复动辄上千字，念完要几分钟——截到 400 字并在句末收尾 */
const SPEAK_MAX = 400
/** 朗读关闭时「说话」口型态的展示时长（纯视觉，不出声） */
const MUTE_TALK_MS = 2500
/** 兜底轮询：会话快照订阅偶有漏通知，1.2s 的慢轮询保证状态不卡死 */
const TICK_MS = 1200

type Prefs = { avatar?: string; speak?: boolean; voice?: string; floatOn?: boolean; floatX?: number; floatY?: number; floatW?: number }

function readPrefs(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as Prefs | null
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

function writePrefs(p: Prefs): void {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)) } catch { /* 持久化不可用：本次会话内仍然生效 */ }
}

/** 悬浮小窗开关的读写（index.tsx 用它记住"小窗是否打开"） */
export const dhPrefs = { read: readPrefs, write: writePrefs }

function synthOf(): SpeechSynthesis | null {
  try { return typeof window !== 'undefined' && window.speechSynthesis ? window.speechSynthesis : null } catch { return null }
}

/** 中文音色挑选（音色表异步就绪，取不到就交给宿主默认音色） */
function pickZhVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
  try {
    const vs = synth.getVoices() ?? []
    return vs.find((v) => /^zh/i.test(v.lang)) ?? vs.find((v) => /chinese|中文|普通话|huihui|yaoyao|xiaoxiao/i.test(v.name)) ?? null
  } catch {
    return null
  }
}

/**
 * 声线预设：浏览器语音没有音色克隆，用「系统音色 + 音高 + 语速」组合出可辨识的不同声线
 * （源项目靠 Qwen3-TTS 声音克隆，这里是不装模型前提下能做到的等价体验）。
 */
export const VOICE_PRESETS: { id: string; key: string; pitch: number; rate: number }[] = [
  { id: 'default', key: 'dh.voiceDefault', pitch: 1, rate: 1.04 },
  { id: 'sweet', key: 'dh.voiceSweet', pitch: 1.26, rate: 1.1 },
  { id: 'loli', key: 'dh.voiceLoli', pitch: 1.5, rate: 1.12 },
  { id: 'queen', key: 'dh.voiceQueen', pitch: 0.86, rate: 0.98 },
  { id: 'gentle', key: 'dh.voiceGentle', pitch: 0.95, rate: 0.9 },
  { id: 'broadcast', key: 'dh.voiceBroadcast', pitch: 0.92, rate: 1.0 },
  { id: 'deep', key: 'dh.voiceDeep', pitch: 0.68, rate: 0.94 },
]

/** 朗读文本清洗：去代码块与链接语法、压空白，超长按句末截断 */
export function speechTextOf(raw: string): string {
  let s = String(raw ?? '')
  s = s.replace(/```[\s\S]*?```/g, ' ')
  s = s.replace(/`([^`\n]{1,200})`/g, '$1')
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/[ \t]+/g, ' ')
  s = s.replace(/\n{2,}/g, '\n')
  s = s.trim()
  if (s.length <= SPEAK_MAX) return s
  const head = s.slice(0, SPEAK_MAX)
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('\n'))
  return (cut > SPEAK_MAX * 0.4 ? head.slice(0, cut + 1) : head) + '……'
}

/**
 * 语音识别：源项目走「麦克风 → Python 桥接 STT（:8765）→ 会话」，这里换成宿主内置识别
 * （SpeechRecognition / webkitSpeechRecognition，零安装零模型）。交互语义照搬源项目：
 * 点一下连续聆听、说话即打断朗读、每句识别完直接送进当前会话。
 */
type RecognitionLike = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((event: any) => void) | null
  onerror: ((event: any) => void) | null
  onend: (() => void) | null
  onspeechstart: (() => void) | null
}

/** 取宿主识别构造器；不支持则 null（Firefox 等 → 如实提示，不假装在听） */
function recognitionCtor(): (new () => RecognitionLike) | null {
  try {
    const w = window as any
    return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
  } catch {
    return null
  }
}

/** 构建期注入的客户端标记（esbuild define；诊断信标据此判断浏览器里是哪一次构建） */
declare const __WT_BUILD__: string | undefined
const DH_BUILD = typeof __WT_BUILD__ === 'string' ? __WT_BUILD__ : 'dev'

/**
 * 自诊断信标：把浏览器侧的真实状态 POST 给宿主（GET /api/worktable/dh/report 可读）。
 * 「数字人没声音」这类问题不靠用户描述——宿主那边直接看构建标记、音色数、朗读是否真起来、取到几字。
 * 只读诊断，不含任何会话内容。
 */
function dhReport(payload: Record<string, unknown>): void {
  try {
    void fetch('/api/worktable/dh/report', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ build: DH_BUILD, at: Date.now(), ...payload }),
    }).catch(() => { /* 宿主不可达就算了，诊断不是主链路 */ })
  } catch { /* 忽略 */ }
}

/**
 * 宿主本机语音（Windows SAPI）合成：POST /api/worktable/tts → 返回可播放的 WAV URL。
 * 这是朗读的**主路径**（源项目也是本机 TTS 路线），失败才退回浏览器 speechSynthesis。
 */
async function hostTts(text: string, rate: number, pitch: number, voice: string): Promise<string | null> {
  try {
    const r = await fetch('/api/worktable/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, rate, pitch, voice }),
    })
    if (!r.ok) return null
    const j = await r.json()
    return j?.ok === true && typeof j.url === 'string' ? j.url : null
  } catch {
    return null
  }
}

/** 声线预设 → SAPI 参数（rate: -10..10 整数；pitch: ±50% 百分比） */
function sapiParams(p: { pitch: number; rate: number }): { rate: number; pitch: number } {
  return {
    rate: Math.max(-10, Math.min(10, Math.round((p.rate - 1) * 10))),
    pitch: Math.max(-50, Math.min(50, Math.round((p.pitch - 1) * 100))),
  }
}

/** 选素材用的缩略图：自建/自撤对象 URL（视频取首帧静帧、不自动播放，避免一屏同时解码） */function DhThumb(props: { record: PhotoRecord }) {
  const url = useMemo(() => {
    try { return URL.createObjectURL(props.record.blob) } catch { return '' }
  }, [props.record])
  useEffect(() => () => { if (url) { try { URL.revokeObjectURL(url) } catch { /* 已释放 */ } } }, [url])
  if (!url) return <span aria-hidden>{props.record.kind === 'video' ? '🎬' : '🖼'}</span>
  return props.record.kind === 'video'
    ? <video src={url} muted playsInline preload="metadata" />
    : <img src={url} alt="" draggable={false} />
}

export function DigitalHumanPane(props: DhPaneProps) {  const { env, sessionId, t } = props

  const [records, setRecords] = useState<PhotoRecord[]>([])
  const [builtins, setBuiltins] = useState<{ name: string; url: string }[]>([])
  const [avatarId, setAvatarId] = useState<string>(() => readPrefs().avatar ?? '')
  const [speakOn, setSpeakOn] = useState<boolean>(() => readPrefs().speak !== false)
  const [talking, setTalking] = useState(false)
  const [thinking, setThinking] = useState(false)
  const [pickOpen, setPickOpen] = useState(false)
  const [voiceSel, setVoiceSel] = useState<string>(() => readPrefs().voice ?? 'default')
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [sysVoices, setSysVoices] = useState<SpeechSynthesisVoice[]>([])
  const [note, setNote] = useState('')
  /** 最近一次朗读/口型态的回复字数（0 = 取不到文本，徽标上直接能看出来） */
  const [heardLen, setHeardLen] = useState<number | null>(null)
  const [libUrl, setLibUrl] = useState('')

  const speakOnRef = useRef(speakOn)
  speakOnRef.current = speakOn

  // ── 形象：内置形象（<DSH_HOME>/worktable-media/dh-*.mp4，取自上游数字人项目的美女循环片）
  //    优先，其次工作台媒体库；显式选择被删（文件/记录没了）时自动回落，不留空窗 ──────────
  const avatar = useMemo<{ key: string; builtinUrl: string | null; record: PhotoRecord | null } | null>(() => {
    const pickedB = avatarId.startsWith('b:') ? builtins.find((b) => 'b:' + b.name === avatarId) : undefined
    const pickedL = avatarId.startsWith('l:') ? records.find((r) => 'l:' + r.id === avatarId) : undefined
    if (pickedB) return { key: 'b:' + pickedB.name, builtinUrl: pickedB.url, record: null }
    if (pickedL) return { key: 'l:' + pickedL.id, builtinUrl: null, record: pickedL }
    // 没选过 / 选中的没了 → 内置首条（默认形象）→ 媒体库首条
    if (builtins[0]) return { key: 'b:' + builtins[0].name, builtinUrl: builtins[0].url, record: null }
    if (records[0]) return { key: 'l:' + records[0].id, builtinUrl: null, record: records[0] }
    return null
  }, [avatarId, builtins, records])

  useEffect(() => {
    const rec = avatar?.record ?? null
    if (!rec) { setLibUrl(''); return }
    const url = URL.createObjectURL(rec.blob)
    setLibUrl(url)
    return () => { try { URL.revokeObjectURL(url) } catch { /* 已释放 */ } }
  }, [avatar])

  const mediaUrl = avatar ? (avatar.builtinUrl ?? libUrl) : ''

  const reload = useCallback(async () => {
    const list = await photoStore.list().catch(() => [] as PhotoRecord[])
    setRecords(list)
  }, [])

  /** 内置形象清单（宿主扫描 worktable-media/dh-*）；路由不可用就只列媒体库 */
  const reloadBuiltins = useCallback(async () => {
    try {
      const r = await fetch('/api/worktable/dh', { cache: 'no-store' })
      if (!r.ok) return
      const j = await r.json()
      const list = Array.isArray(j?.avatars)
        ? j.avatars.filter((a: any) => a && typeof a.name === 'string' && typeof a.url === 'string')
        : []
      setBuiltins(list)
    } catch { /* 忽略：内置清单不是必需品 */ }
  }, [])

  useEffect(() => { void reload(); void reloadBuiltins() }, [reload, reloadBuiltins])

  useEffect(() => {
    const next = { ...readPrefs(), avatar: avatarId || undefined }
    writePrefs(next)
  }, [avatarId])

  useEffect(() => {
    const next = { ...readPrefs(), speak: speakOn }
    writePrefs(next)
  }, [speakOn])

  useEffect(() => {
    const next = { ...readPrefs(), voice: voiceSel }
    writePrefs(next)
  }, [voiceSel])

  // 系统音色表异步就绪（voiceschanged），拿不到就只列声线预设
  useEffect(() => {
    const synth = synthOf()
    if (!synth) return
    const load = (): void => {
      try { setSysVoices((synth.getVoices() ?? []).filter((v) => /^zh/i.test(v.lang))) } catch { /* 忽略 */ }
    }
    load()
    try { synth.addEventListener?.('voiceschanged', load) } catch { /* 老浏览器无事件 */ }
    return () => { try { synth.removeEventListener?.('voiceschanged', load) } catch { /* 忽略 */ } }
  }, [])

  // ── 朗读（浏览器内置语音；无桥接、无本地模型） ────────────────────────────
  const utterRef = useRef<SpeechSynthesisUtterance | null>(null)
  const startGuardRef = useRef<number | null>(null)
  const muteTimerRef = useRef<number | null>(null)
  const noteTimerRef = useRef<number | null>(null)
  /** 正在朗读的正文：用来识别「麦克风自听回声」（识别的字都在正文里 = 它听到的是自己） */
  const speakingTextRef = useRef('')
  /** 最近一次朗读尝试的结果（信标上报用） */
  const lastSpeakRef = useRef<{ at: number; len: number; started: boolean; err: string; via?: string } | null>(null)
  /** 宿主合成 WAV 的播放器（本机语音主路径） */
  const audioRef = useRef<HTMLAudioElement | null>(null)
  /** 浏览器语音兜底句柄（speak 在 browserSpeak 之前定义，经 ref 取，避免顺序依赖） */
  const browserSpeakRef = useRef<((body: string, preset: { pitch: number; rate: number }) => void) | null>(null)
  /** 信标节流时间戳 */
  const reportAtRef = useRef(0)

  const showNote = useCallback((text: string) => {
    setNote(text)
    if (noteTimerRef.current != null) window.clearTimeout(noteTimerRef.current)
    noteTimerRef.current = window.setTimeout(() => { noteTimerRef.current = null; setNote('') }, 6000)
  }, [])

  const stopSpeech = useCallback(() => {
    try { synthOf()?.cancel() } catch { /* 忽略 */ }
    const a = audioRef.current
    if (a) { try { a.pause(); a.removeAttribute('src') } catch { /* 忽略 */ } }
    utterRef.current = null
    speakingTextRef.current = ''
    setTalking(false)
  }, [])

  /** 播宿主合成出来的 WAV（本机语音主路径） */
  const playWav = useCallback((url: string, body: string) => {
    try {
      const a = audioRef.current ?? new Audio()
      audioRef.current = a
      speakingTextRef.current = body
      a.src = url
      a.onplay = () => { setTalking(true); setNote('') }
      a.onended = () => { if (audioRef.current === a) { speakingTextRef.current = ''; setTalking(false) } }
      a.onerror = () => { if (audioRef.current === a) { speakingTextRef.current = ''; setTalking(false) } }
      void a.play().then(() => { setTalking(true); setNote('') }).catch(() => {
        // 自动播放被拦（无用户手势）：试听按钮/语音输入都带手势，正常不会走到这
        setNote(t('dh.blocked'))
      })
    } catch { /* 播放器不可用：交由浏览器语音兜底 */ }
  }, [t])

  const speak = useCallback((raw: string) => {
    const body = speechTextOf(raw)
    if (!body) return
    const preset = VOICE_PRESETS.find((p) => p.id === voiceSel) ?? VOICE_PRESETS[0]
    stopSpeech()
    lastSpeakRef.current = { at: Date.now(), len: body.length, started: false, err: '' }
    // 主路径：宿主本机语音（Windows SAPI）合成 WAV 再播；成功就不碰浏览器语音
    const sapi = sapiParams(preset)
    const voiceName = voiceSel.startsWith('sys:') ? voiceSel.slice(4) : ''
    void hostTts(body, sapi.rate, sapi.pitch, voiceName).then((url) => {
      if (url) {
        if (lastSpeakRef.current) { lastSpeakRef.current.via = 'host'; lastSpeakRef.current.started = true }
        playWav(url, body)
        return
      }
      if (lastSpeakRef.current) lastSpeakRef.current.via = 'browser'
      browserSpeakRef.current?.(body, preset)
    }).catch(() => { browserSpeakRef.current?.(body, preset) })
  }, [playWav, stopSpeech, voiceSel])

  /** 兜底：浏览器内置语音（宿主 TTS 不可用时） */
  const browserSpeak = useCallback((body: string, preset: { pitch: number; rate: number }) => {
    const synth = synthOf()
    if (!synth) { showNote(t('dh.unsupported')); return }
    const utter = new SpeechSynthesisUtterance(body)
    utter.lang = 'zh-CN'
    utter.pitch = preset.pitch
    utter.rate = preset.rate
    // 声线 = 预设音高语速 + 音色（'sys:<名字>' 指定系统音色；否则自动挑中文音色）
    const voice = voiceSel.startsWith('sys:')
      ? (synth.getVoices() ?? []).find((v) => v.name === voiceSel.slice(4)) ?? null
      : pickZhVoice(synth)
    if (voice) utter.voice = voice
    let started = false
    utter.onstart = () => { started = true; speakingTextRef.current = body; setTalking(true); setNote(''); if (lastSpeakRef.current) lastSpeakRef.current.started = true }
    utter.onend = () => { if (utterRef.current === utter) { utterRef.current = null; speakingTextRef.current = ''; setTalking(false) } }
    utter.onerror = (ev: any) => {
      if (lastSpeakRef.current) lastSpeakRef.current.err = String(ev?.error ?? 'error')
      if (utterRef.current === utter) { utterRef.current = null; speakingTextRef.current = ''; setTalking(false) }
    }
    utterRef.current = utter
    // Chrome 的已知坑：cancel() 之后**同步** speak() 会被静默丢弃（表现就是「完全没声」）。
    // 隔一帧再发，并先 resume()（引擎卡在 paused 时也不会出声）。
    const fire = (): void => {
      if (utterRef.current !== utter) return
      try { synth.resume() } catch { /* 忽略 */ }
      try { synth.speak(utter) } catch { utterRef.current = null; showNote(t('dh.unsupported')); return }
      // 语音引擎没起来就如实提示，不假装在说
      if (startGuardRef.current != null) window.clearTimeout(startGuardRef.current)
      startGuardRef.current = window.setTimeout(() => {
        startGuardRef.current = null
        if (!started && utterRef.current === utter) {
          utterRef.current = null
          speakingTextRef.current = ''
          setTalking(false)
          if (lastSpeakRef.current) lastSpeakRef.current.err = 'not-started'
          showNote(t('dh.blocked'))
        }
      }, 1200)
    }
    window.setTimeout(fire, 60)
  }, [showNote, t, voiceSel])
  browserSpeakRef.current = browserSpeak

  // ── 语音聊天（内置识别）：点一下连续聆听 → 每句送进当前会话 → 回复朗读回你 ──────
  const [listening, setListening] = useState(false)
  const [heard, setHeard] = useState('')
  const recRef = useRef<RecognitionLike | null>(null)
  const wantListenRef = useRef(false)
  /** 最近一次送出的话（重复识别去重） */
  const lastSentRef = useRef<{ text: string; at: number } | null>(null)
  /** 单句聆听的 60s 兜底计时器 */
  const listenGuardRef = useRef<number | null>(null)

  const sendHeard = useCallback(async (text: string) => {
    const send = env()?.send
    if (!send) { showNote(t('dh.sendFailed')); return }
    // 同一句被重复识别（识别器抖动）→ 4s 内吞掉，避免重复发问
    const prev = lastSentRef.current
    if (prev && prev.text === text && Date.now() - prev.at < 4000) return
    lastSentRef.current = { text, at: Date.now() }
    try { await send(text) } catch { showNote(t('dh.sendFailed')) }
  }, [env, showNote, t])

  /** 开始/续听（onend 会自动调回来续上；用户点停止才会真正结束） */
  function startListening(): void {
    const Ctor = recognitionCtor()
    if (!Ctor) { showNote(t('dh.sttUnsupported')); return }
    if (recRef.current) return
    stopSpeech() // barge-in：开始聆听即打断正在念的回复
    if (muteTimerRef.current != null) { window.clearTimeout(muteTimerRef.current); muteTimerRef.current = null }
    setTalking(false)
    const rec = new Ctor()
    rec.lang = 'zh-CN'
    rec.continuous = true
    rec.interimResults = true
    // 自听回声判定：识别的字都出现在「正在念的正文」里，就是它听见了自己（防自问自答死循环）
    const isEcho = (t: string): boolean => {
      const spoken = speakingTextRef.current
      return spoken.length > 0 && t.length >= 2 && spoken.includes(t)
    }
    rec.onresult = (event: any) => {
      const results = event?.results ?? []
      let interim = ''
      for (let i = event?.resultIndex ?? 0; i < results.length; i++) {
        const item = results[i]
        const raw = String(item?.[0]?.transcript ?? '')
        if (item?.isFinal) {
          const text = raw.trim()
          if (!text || isEcho(text)) continue
          setHeard('')
          // 单句模式：收到一句就收工（避免把旁边的闲聊一直送进来）；要接着说再点一下 🎙
          wantListenRef.current = false
          void sendHeard(text)
        } else {
          interim += raw
        }
      }
      const live = interim.trim()
      if (!live || isEcho(live)) return
      // 真的在插话（不是回声）→ 打断朗读，对应源项目的 barge-in
      if (talkingRef.current) stopSpeech()
      setHeard(live)
    }
    rec.onerror = (event: any) => {
      const code = String(event?.error ?? '')
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        wantListenRef.current = false
        recRef.current = null
        setListening(false)
        setHeard('')
        showNote(t('dh.micDenied'))
        return
      }
      if (code === 'no-speech' || code === 'aborted' || code === 'network') return // 正常抖动：等 onend 续听
      showNote(t('dh.sttFailed'))
    }
    rec.onend = () => {
      recRef.current = null
      if (!wantListenRef.current) { setListening(false); setHeard(''); return }
      // Chrome 静音一阵会自行结束会话：连续聆听就续上（稍等再起，避免 InvalidStateError）
      window.setTimeout(() => { if (wantListenRef.current && !recRef.current) { try { startListening() } catch { /* 下一轮 onend 再试 */ } } }, 350)
    }
    recRef.current = rec
    wantListenRef.current = true
    setListening(true)
    // 兜底：点了却没说话（或环境太吵一直识别不出成句）→ 60s 自动收工，不无限占麦
    if (listenGuardRef.current != null) window.clearTimeout(listenGuardRef.current)
    listenGuardRef.current = window.setTimeout(() => {
      listenGuardRef.current = null
      if (wantListenRef.current) stopListening()
    }, 60000)
    try { rec.start() } catch { recRef.current = null; setListening(false); showNote(t('dh.sttFailed')) }
  }

  const stopListening = (): void => {
    wantListenRef.current = false
    if (listenGuardRef.current != null) { window.clearTimeout(listenGuardRef.current); listenGuardRef.current = null }
    const rec = recRef.current
    recRef.current = null
    try { rec?.stop() } catch { /* 忽略 */ }
    setListening(false)
    setHeard('')
  }

  /** 朗读开关本身是用户手势：借它解锁宿主语音（Chrome 要求手势后才允许出声） */
  const unlockSpeech = useCallback(() => {
    const synth = synthOf()
    if (!synth) return
    try {
      synth.resume()
      const warm = new SpeechSynthesisUtterance(' ')
      warm.volume = 0
      synth.speak(warm)
    } catch { /* 忽略 */ }
  }, [])

  // ── 会话跟随：回复开始 → 思考中；回复落地 → 说话 ─────────────────────────
  const sidRef = useRef('')
  const spokenRef = useRef('')
  const pendingRef = useRef<{ text: string; at: number } | null>(null)
  /** history 兜底通道的节流时间戳 */
  const asyncReadRef = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const talkingRef = useRef(false)
  talkingRef.current = talking

  const tick = useCallback(() => {
    const e = env()
    const sid = sessionId()
    if (!e || !sid) return
    // 非活跃的布局层是 display:none 保活的（WorkspaceLayer 池化）：隐藏时不朗读也不换状态，
    // 否则另一个项目里的数字人会突然出声。用「有没有盒子/尺寸」判定，比 offsetParent 稳
    // （offsetParent 在某些包装下恒为 null，会把整个状态机静默关掉）。
    const root = rootRef.current
    if (root !== null && (root.getClientRects().length === 0 || root.offsetWidth === 0 || root.offsetHeight === 0)) {
      if (talkingRef.current) stopSpeech()
      return
    }
    let text = ''
    let running = false
    try {
      const r = e.read(sid)
      text = r.text
      running = r.running
    } catch { return }
    if (sidRef.current !== sid) {
      // 换会话：只记基线，不追读历史消息
      sidRef.current = sid
      spokenRef.current = text
      pendingRef.current = null
      setThinking(running)
      stopSpeech()
      return
    }
    setThinking(running)
    if (!text) {
      // 内存镜像读不到文本 → 走宿主 history 兜底（4s 一次，避免频繁拉取）
      pendingRef.current = null
      if (Date.now() - asyncReadRef.current > 4000 && typeof e.readAsync === 'function') {
        asyncReadRef.current = Date.now()
        const sid2 = sid
        void e.readAsync(sid2).then((raw) => {
          const t = String(raw ?? '').trim()
          if (!t || sidRef.current !== sid2 || t === spokenRef.current) return
          spokenRef.current = t
          setHeardLen(t.length)
          if (speakOnRef.current) speak(t)
        }).catch(() => { /* 兜底失败不影响主链路 */ })
      }
      return
    }
    if (text === spokenRef.current) { pendingRef.current = null; return }
    // 不把自己刚发出去的话念回来（识别到用户消息时漏进兜底分支的保险）
    const sent = lastSentRef.current
    if (sent && sent.text === text) { spokenRef.current = text; pendingRef.current = null; return }
    const pending = pendingRef.current
    if (!pending || pending.text !== text) {
      pendingRef.current = { text, at: Date.now() }
      return
    }
    // 落地判定：running=false 时稳住 0.9s（多步回合 running 会在步骤间瞬时转假）；
    // running 一直为真时给 2.5s 兜底——文本这么久没再变，说明这一轮已经说完（长工具调用/卡住的 running
    // 不该让数字人永远闭嘴）。
    const dwell = running ? 2500 : 900
    if (Date.now() - pending.at < dwell) return
    pendingRef.current = null
    spokenRef.current = text
    setHeardLen(text.length)
    if (speakOnRef.current) {
      speak(text)
      return
    }
    // 朗读关着：只闪一次「说话」口型态（纯视觉）
    setTalking(true)
    if (muteTimerRef.current != null) window.clearTimeout(muteTimerRef.current)
    muteTimerRef.current = window.setTimeout(() => { muteTimerRef.current = null; setTalking(false) }, MUTE_TALK_MS)
  }, [env, sessionId, speak, stopSpeech])

  const tickRef = useRef(tick)
  useEffect(() => { tickRef.current = tick }, [tick])

  /** speak 的 ref（挂载问候在 speak 定义前后都要能取到） */
  const speakRef = useRef<((raw: string) => void) | null>(null)
  speakRef.current = speak

  // 打开窗格就打个招呼（朗读关着则只闪一次口型态；每次挂载只打一次）
  useEffect(() => {
    if (readPrefs().speak === false) return
    const timer = window.setTimeout(() => {
      speakRef.current?.(t('dh.greet'))
    }, 900)
    return () => window.clearTimeout(timer)
  }, [t])

  // 诊断信标：挂载时上报一次静态事实，之后最多每 5s 上报一次实时状态（构建标记/音色数/朗读结果/取文字数）
  useEffect(() => {
    const dump = (extra: Record<string, unknown> = {}): void => {
      let voices: SpeechSynthesisVoice[] = []
      try { voices = synthOf()?.getVoices() ?? [] } catch { /* 忽略 */ }
      dhReport({
        ua: (() => { try { return navigator.userAgent } catch { return '' } })(),
        voices: voices.length,
        zhVoices: voices.filter((v) => /^zh/i.test(v.lang)).map((v) => v.name),
        speakPref: readPrefs().speak !== false,
        voiceSel: readPrefs().voice ?? 'default',
        ...extra,
      })
    }
    dump({ phase: 'mount' })
    const timer = window.setInterval(() => {
      const e = env()
      const sid = sessionId()
      let syncLen = -1
      let running = false
      try {
        if (e && sid) { const r = e.read(sid); syncLen = r.text.length; running = r.running }
      } catch { /* 忽略 */ }
      dump({ phase: 'tick', syncLen, running, listening: wantListenRef.current, lastSpeak: lastSpeakRef.current, lastHeardLen: heardLen })
    }, 5000)
    return () => window.clearInterval(timer)
  }, [env, sessionId, heardLen])

  useEffect(() => {
    let unsub: (() => void) | null = null
    const fire = (): void => { try { tickRef.current() } catch { /* 单次失败不影响后续 */ } }
    fire()
    const timer = window.setInterval(() => {
      if (unsub === null) {
        const e = env()
        if (e) unsub = e.subscribe(fire)
      }
      fire()
    }, TICK_MS)
    return () => {
      window.clearInterval(timer)
      if (unsub) unsub()
    }
  }, [env])

  // 卸载：停朗读、停聆听、清定时器（每个副作用都要能收回）
  useEffect(() => () => {
    try { synthOf()?.cancel() } catch { /* 忽略 */ }
    wantListenRef.current = false
    try { recRef.current?.abort() } catch { /* 忽略 */ }
    recRef.current = null
    for (const r of [startGuardRef, muteTimerRef, noteTimerRef]) {
      if (r.current != null) window.clearTimeout(r.current)
      r.current = null
    }
  }, [])

  const phase = talking ? 'talking' : thinking ? 'thinking' : 'idle'
  const isVideo = avatar ? (avatar.builtinUrl !== null || avatar.record?.kind === 'video') : false

  const toggleSpeak = (): void => {
    setSpeakOn((prev) => {
      const next = !prev
      if (next) { unlockSpeech(); showNote(t('dh.speakReady')) }
      else { stopSpeech(); if (muteTimerRef.current != null) { window.clearTimeout(muteTimerRef.current); muteTimerRef.current = null } }
      return next
    })
  }

  const openPick = (): void => {
    setPickOpen((v) => {
      if (!v) { void reload(); void reloadBuiltins() }
      return !v
    })
  }

  return (
    <div ref={rootRef} className="dsh-wt_dh" data-talk={talking ? '1' : '0'} data-think={thinking ? '1' : '0'}>
      {mediaUrl ? (
        isVideo ? (
          <video className="dsh-wt_dhMedia" src={mediaUrl} autoPlay loop muted playsInline preload="auto" />
        ) : (
          <img className="dsh-wt_dhMedia" src={mediaUrl} alt="" draggable={false} />
        )
      ) : (
        <div className="dsh-wt_dhEmpty">
          <span className="dsh-wt_dhEmptyIcon" aria-hidden>💃</span>
          <span className="dsh-wt_dhEmptyTitle">{t('dh.empty')}</span>
          <span className="dsh-wt_dhEmptyHint">{t('dh.emptyHint')}</span>
        </div>
      )}

      <div className="dsh-wt_dhBadge">
        <span className="dsh-wt_dhDot" aria-hidden />
        <span className="dsh-wt_dhStatus">{t('dh.' + phase)}{heardLen != null ? ' · ' + heardLen + t('dh.chars') : ''}</span>
        {talking && (
          <span className="dsh-wt_dhWave" aria-hidden>
            <i /><i /><i /><i /><i />
          </span>
        )}
      </div>

      {note && <div className="dsh-wt_dhNote">{note}</div>}

      {/* 聆听中的实时字幕（识别中/待命中都给反馈，不装死） */}
      {listening && (
        <div className={'dsh-wt_dhHeard' + (heard ? '' : ' dsh-wt_dhHeardIdle')}>
          <span className="dsh-wt_dhHeardDot" aria-hidden />
          {heard || t('dh.micOn') + '…'}
        </div>
      )}

      <div className="dsh-wt_dhBar">
        <button
          type="button"
          className="dsh-wt_dhBtn"
          title={t('dh.pickTitle')}
          aria-label={t('dh.pickTitle')}
          aria-expanded={pickOpen}
          onClick={openPick}
        >🖼 {t('dh.pick')}</button>
        <button
          type="button"
          className={'dsh-wt_dhBtn' + (speakOn ? ' dsh-wt_dhBtnOn' : '')}
          title={t('dh.speakTitle')}
          aria-label={t('dh.speakTitle')}
          aria-pressed={speakOn}
          onClick={toggleSpeak}
        >{speakOn ? '🔊 ' + t('dh.speakOn') : '🔇 ' + t('dh.speakOff')}</button>
        <button
          type="button"
          className={'dsh-wt_dhBtn' + (voiceOpen ? ' dsh-wt_dhBtnOn' : '')}
          title={t('dh.voiceTitle')}
          aria-label={t('dh.voiceTitle')}
          aria-expanded={voiceOpen}
          onClick={() => { setVoiceOpen((v) => !v); setPickOpen(false) }}
        >🗣 {t('dh.voice')}</button>
        <button
          type="button"
          className={'dsh-wt_dhBtn' + (listening ? ' dsh-wt_dhBtnRec' : '')}
          title={t('dh.micTitle')}
          aria-label={t('dh.micTitle')}
          aria-pressed={listening}
          onClick={() => { if (listening) stopListening(); else startListening() }}
        >🎙 {listening ? t('dh.micOn') : t('dh.mic')}</button>
      </div>

      {voiceOpen && (
        <div className="dsh-wt_dhVoice">
          {/* 试听：点一下立刻出声（用户手势，绕开浏览器自动播放拦截），用来分辨「TTS 有没有声」 */}
          <button
            type="button"
            className="dsh-wt_dhVoiceRow dsh-wt_dhVoiceTry"
            onClick={() => { unlockSpeech(); speak(t('dh.voiceSample')) }}
          >🔈 {t('dh.voicePreview')}</button>
          <div className="dsh-wt_dhPickGroup">{t('dh.voiceGroup')}</div>
          {VOICE_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={'dsh-wt_dhVoiceRow' + (voiceSel === p.id ? ' dsh-wt_dhVoiceRowOn' : '')}
              onClick={() => { setVoiceSel(p.id); setVoiceOpen(false) }}
            >
              <span className="dsh-wt_dhVoiceName">{t(p.key)}</span>
              {voiceSel === p.id && <span aria-hidden>✓</span>}
            </button>
          ))}
          {sysVoices.length > 0 ? (
            <>
              <div className="dsh-wt_dhPickGroup">{t('dh.voiceSysGroup')} · {sysVoices.length}</div>
              {sysVoices.map((v) => (
                <button
                  key={v.name}
                  type="button"
                  className={'dsh-wt_dhVoiceRow' + (voiceSel === 'sys:' + v.name ? ' dsh-wt_dhVoiceRowOn' : '')}
                  title={v.name + ' · ' + v.lang}
                  onClick={() => { setVoiceSel('sys:' + v.name); setVoiceOpen(false) }}
                >
                  <span className="dsh-wt_dhVoiceName">{v.name}</span>
                  {voiceSel === 'sys:' + v.name && <span aria-hidden>✓</span>}
                </button>
              ))}
            </>
          ) : (
            <div className="dsh-wt_dhPickEmpty">{t('dh.voiceNoSys')}</div>
          )}
        </div>
      )}

      {pickOpen && (
        <div className="dsh-wt_dhPick">
          {builtins.length === 0 && records.length === 0 && (
            <div className="dsh-wt_dhPickEmpty">{t('dh.emptyHint')}</div>
          )}
          {builtins.length > 0 && (
            <>
              <div className="dsh-wt_dhPickGroup">{t('dh.builtinGroup')}</div>
              <div className="dsh-wt_dhPickGrid">
                {builtins.map((b, i) => (
                  <button
                    key={b.name}
                    type="button"
                    className={'dsh-wt_dhPickItem' + (avatar?.key === 'b:' + b.name ? ' dsh-wt_dhPickItemOn' : '')}
                    title={b.name}
                    aria-label={t('dh.builtinGroup') + ' ' + (i + 1)}
                    onClick={() => { setAvatarId('b:' + b.name); setPickOpen(false) }}
                  >
                    <video src={b.url} muted playsInline preload="metadata" />
                    {avatar?.key === 'b:' + b.name && <span className="dsh-wt_dhPickOn" aria-hidden>✓</span>}
                  </button>
                ))}
              </div>
            </>
          )}
          {records.length > 0 && (
            <>
              <div className="dsh-wt_dhPickGroup">{t('dh.libraryGroup')}</div>
              <div className="dsh-wt_dhPickGrid">
                {records.map((r, i) => (
                  <button
                    key={r.id}
                    type="button"
                    className={'dsh-wt_dhPickItem' + (avatar?.key === 'l:' + r.id ? ' dsh-wt_dhPickItemOn' : '')}
                    title={r.kind === 'video' ? t('dh.video') : t('dh.photo')}
                    aria-label={(r.kind === 'video' ? t('dh.video') : t('dh.photo')) + ' ' + (i + 1)}
                    onClick={() => { setAvatarId('l:' + r.id); setPickOpen(false) }}
                  >
                    <DhThumb record={r} />
                    {avatar?.key === 'l:' + r.id && <span className="dsh-wt_dhPickOn" aria-hidden>✓</span>}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 悬浮小窗：数字人做成可拖动、可缩放的独立小卡片（对齐源项目 CompanionWindow 的形态），
 * 不占窗格、能一边聊天一边看她。位置/宽度存进同一份 prefs，双击标题条复位。
 */
export function DhFloat(props: DhPaneProps & { onClose: () => void }) {
  const init = readPrefs()
  const [w, setW] = useState<number>(() => {
    const v = init.floatW ?? 0
    return v >= 180 && v <= 480 ? v : 260
  })
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() =>
    typeof init.floatX === 'number' && typeof init.floatY === 'number' ? { x: init.floatX, y: init.floatY } : null)
  const boxRef = useRef<HTMLDivElement | null>(null)

  const height = (): number => Math.round(Math.min(Math.max(w * 1.5, 260), Math.min(620, window.innerHeight * 0.72)))
  const defPos = (): { x: number; y: number } => ({
    x: Math.max(12, window.innerWidth - w - 16),
    y: Math.max(12, Math.round((window.innerHeight - height()) / 2)),
  })
  const cur = pos ?? defPos()

  /** 拖顶部标题条移动（不动卡片内部控件，避免和按钮抢事件） */
  const startMove = (e: React.PointerEvent): void => {
    e.preventDefault()
    const base = pos ?? defPos()
    const sx = e.clientX
    const sy = e.clientY
    const onMove = (m: PointerEvent): void => {
      const nx = Math.max(4, Math.min(window.innerWidth - w - 4, base.x + (m.clientX - sx)))
      const ny = Math.max(4, Math.min(window.innerHeight - 40, base.y + (m.clientY - sy)))
      setPos({ x: nx, y: ny })
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setPos((p) => { if (p) writePrefs({ ...readPrefs(), floatX: p.x, floatY: p.y }); return p })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /** 右下角抓手调宽（高度按比例跟着变） */
  const startResize = (e: React.PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const sx = e.clientX
    const sx0 = e.clientX
    void sx
    const startW = w
    const onMove = (m: PointerEvent): void => {
      const next = Math.max(180, Math.min(480, startW + (m.clientX - sx0)))
      setW(next)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setW((v) => { writePrefs({ ...readPrefs(), floatW: v }); return v })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      ref={boxRef}
      className="dsh-wt_dhFloat"
      style={{ left: cur.x, top: cur.y, width: w, height: height() }}
    >
      <div
        className="dsh-wt_dhFloatBar"
        title={props.t('dh.floatHint')}
        onPointerDown={startMove}
        onDoubleClick={() => { setPos(null); writePrefs({ ...readPrefs(), floatX: undefined, floatY: undefined }) }}
      >
        <span className="dsh-wt_dhFloatDot" aria-hidden />
        <span className="dsh-wt_dhFloatName">{props.t('dh.projectTitle')}</span>
        <button
          type="button"
          className="dsh-wt_dhFloatClose"
          title={props.t('dh.close')}
          aria-label={props.t('dh.close')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={props.onClose}
        >✕</button>
      </div>
      <div className="dsh-wt_dhFloatBody">
        <DigitalHumanPane {...props} />
      </div>
      <span className="dsh-wt_dhFloatGrip" title={props.t('dh.floatResize')} onPointerDown={startResize} aria-hidden />
    </div>
  )
}
