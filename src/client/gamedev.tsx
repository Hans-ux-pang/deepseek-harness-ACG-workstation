/**
 * dsh-worktable 内置窗格：游戏开发师（gamedev）。
 *
 * 干什么：把**正在爆火的小游戏**拆成可复制的做法，并当场生成一段可以直接粘给 AI 的提示词。
 *
 * 数据口径：静态快照，抓取日见 SNAPSHOT_DATE；每条榜单都标注了平台与月份，来源见 SOURCES。
 * 榜单不会自己更新 —— 过期了就改 GAMEDEV-DATA 区里的 RANKINGS / RECIPES。
 *
 * 标记区说明：GAMEDEV-DATA 与 PROMPT 两块是**纯 JS**（无 TS 语法、无 export），
 * 便于离线断言直接把这两块抽出来求值（见 globe-plugin/check-gamedev.mjs）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'

/* GAMEDEV-DATA-BEGIN */
var SNAPSHOT_DATE = '2026-09-21'

/** 数据来源（榜单抓取时逐条核对过标题与月份） */
var SOURCES = [
  { label: '微信小游戏畅销榜 Top100（2026年8月）', url: 'http://www.gamelook.com.cn/2026/09/601375/', note: '《向僵尸开炮》登顶；换血率 25%' },
  { label: '微信小游戏畅销榜 Top100（2026年7月）', url: 'http://www.gamelook.com.cn/2026/08/599222/', note: '《我的花园世界》登顶；换血率 31%' },
  { label: '抖音小游戏畅销榜 Top100（2026年6月）', url: 'http://www.gamelook.com.cn/2026/07/596757/', note: '《赵云与阿斗》登顶；休闲 47 款首次超过角色 42 款' },
  { label: '抖音 IAA 小游戏内容创意玩法风向标（2026 第 1 期）', url: 'https://developer.open-douyin.com/forum/bulletin/post/698d9852a9441abeb0d4c8e0', note: '官方口径的 IAA 玩法方向' },
  { label: 'Block Blast! 拿下 2026 Q1 全球下载量第一', url: 'https://www.tmcnet.com/usubmit/2026/04/23/10370375.htm', note: '解压方块类的天花板' },
  { label: '8 月百强小游戏（腾讯新闻）', url: 'https://news.qq.com/rain/a/20260901A085WU00', note: '指出「一热门 IAA 玩法出现迭代」' },
]

/** 两个平台的畅销榜前十：名次 / 游戏 / 品类与一句话机制 */
var RANKINGS = [
  {
    platform: '微信小游戏',
    month: '2026 年 8 月',
    rows: [
      [1, '向僵尸开炮', '塔防 · 自动射击，站桩清屏'],
      [2, '疯狂水世界', '模拟经营，一个月升 10 位'],
      [3, '三国：冰河时代', 'SLG，头部常青'],
      [4, '无尽冬日', 'SLG · 冰雪生存'],
      [5, '浪漫餐厅', '合并消除 + 经营'],
      [6, '灵画师', 'RPG，微信/抖音双平台前十'],
      [7, '永远的蔚蓝星球', '塔防'],
      [8, '跃动小子', 'RPG · 跑酷动作'],
      [9, '向末日开炮', 'SLG 新品，空降前十'],
      [10, '梦幻消除战', '合并消除'],
    ],
  },
  {
    platform: '抖音小游戏',
    month: '2026 年 6 月',
    rows: [
      [1, '赵云与阿斗', '字谜 + 塔防，空降冠军'],
      [2, '我的花园世界', '模拟经营，上月微信榜第一'],
      [3, '三国：冰河时代', 'SLG'],
      [4, '灵画师', 'RPG'],
      [5, '向僵尸开炮', '塔防 · 自动射击'],
      [6, '无尽冬日', 'SLG'],
      [7, '向往的生活', '模拟经营，升 11 位'],
      [8, '浪漫餐厅', '合并消除'],
      [9, '跃动小子', 'RPG'],
      [10, '时尚百货城', '养成 · 经营'],
    ],
  },
]

/** 结构性观察（比单个名次更耐用） */
var TRENDS = [
  '抖音 6 月：休闲 47 款**首次超过**角色 42 款，其中塔防从 12 款涨到 16 款，成为子类第一',
  '微信 8 月：RPG 入榜 40 款最多，但前十只占 2 席 —— 数量多 ≠ 头部强',
  'SLG 是「量少质高」：微信 8 月仅 6 款入榜，却拿下前十里的 3 席',
  '模拟经营波动极大：微信 7 月《我的花园世界》登顶，抖音同月从 12 款缩到 8 款',
  '换血率 25%~31%：每月四分之一到三分之一的榜单换人，腰部产品寿命很短',
  '纯 IAA（只看广告）也能进前 40：抖音 6 月《消的有点菜》靠极少量内购拿到 37 名',
  '全球维度：Block Blast! 是 2026 Q1 全球下载量第一 —— 解压类不靠题材靠手感',
]

/**
 * 玩法配方：每条都是一个「可以今天就动手做」的做法。
 * stars = 个人开发者实现难度（1 最容易 5 最难）；fit = 适不适合个人/小团队上手。
 */
var RECIPES = [
  {
    id: 'autoshooter',
    name: '塔防割草 · 站桩清屏',
    aka: 'auto-shooter / survivor-like',
    stars: 2,
    fit: '强烈推荐',
    hot: '微信 8 月第一《向僵尸开炮》、第七《永远的蔚蓝星球》；抖音 6 月第五《向僵尸开炮》',
    why: '玩家只做一件事（走位），剩下全自动。屏幕越脏越爽，30 秒就能感到变强 —— 上手门槛和爽感回报的比例最划算。',
    loop: '走位躲怪 → 自动开火 → 升级三选一 → 波次变强 → 死了重开（永久成长）',
    mvp: ['自动锁定并开火', '敌人成群涌来', '升级三选一', '死亡结算 + 重开', '同屏 300 敌人不掉帧'],
    money: '激励视频：复活、双倍结算、免费重抽一次升级',
    genre: '俯视角自动射击 + 波次塔防',
    theme: '末日僵尸围城',
    art: '低多边形 + 霓虹描边，暗底高对比',
    core: [
      '角色跟随鼠标/手指移动，自动锁定最近敌人并持续开火，玩家不需要点射击键',
      '敌人按波次成群涌入，每波数量与血量递增，Boss 每 5 波一次',
      '升级三选一：从随机 3 个词条里选 1 个（攻速/弹道数/穿透/暴击/吸血/护盾/召唤物）',
      '词条之间要能叠出「质变」：例如弹道数 × 穿透 × 弹射，从单发变成满屏乱弹',
      '死亡后回到开局，但保留永久成长点（用局内金币兑换，让失败也有收益）',
    ],
    juice: [
      '命中顿帧 40~80ms，击杀时敌人缩放爆开 + 粒子四散',
      '连杀计数与屏幕边缘红晕（受击）/金晕（连杀）',
      '升级三选一弹出时全场慢放 0.3 秒，卡牌要有重量感',
      'WebAudio 现场合成枪声与升级音，音调随连杀数升高',
    ],
    nums: [
      '前 10 秒必须完成第一次击杀与第一次升级，否则重做开局节奏',
      '每 30 秒一个难度台阶，敌人血量按 1.18 倍递增',
      '三选一里至少保证 1 个「这局能立刻感受到」的输出词条',
    ],
  },
  {
    id: 'extraction',
    name: '搜打撤 · 带得走才算赢',
    aka: 'extraction / 撤离玩法',
    stars: 4,
    fit: '推荐（有经验者）',
    hot: '《镇邪人》《生存 33 天》《病毒大逃杀》—— 硬核搜打撤被公认是这一年的小游戏爆点',
    why: '把「贪」变成玩法：多搜一件就要多冒一次险。死亡掉落制造强烈情绪，玩家会反复回来找回场子。',
    loop: '进图 → 搜刮资源 → 打怪/躲怪 → 决定何时撤离 → 带出的东西变成永久成长',
    mvp: ['单局 3~5 分钟的随机地图', '可拾取的战利品与背包容量', '撤离点 + 读秒', '死亡掉落全部战利品', '基地里的永久成长'],
    money: '激励视频：保险箱（死了保一件）、额外撤离机会、开局补给',
    genre: '俯视角搜刮 + 撤离（PvE）',
    theme: '中式微恐地宫',
    art: '暗调手绘 + 雾气与视野遮蔽',
    core: [
      '随机生成的房间地图，玩家视野有迷雾，未探索区域不可见',
      '地图里散布可搜刮的容器，开箱需要 1~2 秒停留（制造风险窗口）',
      '背包有格数与重量上限：拿更多 = 走更慢 / 打不过时跑不掉',
      '撤离点定时开放，读秒期间必须原地坚守，被打断就要重来',
      '死亡掉落本局全部战利品；成功撤离后战利品进仓库并可用于永久升级',
    ],
    juice: [
      '开箱前的悬念音效与 0.2 秒的箱盖动画',
      '稀有度光柱（白/蓝/紫/金）+ 拾取时飘字',
      '撤离读秒时的心跳音与画面轻微呼吸感',
      '阵亡瞬间画面去色 + 掉落物洒一地',
    ],
    nums: [
      '单局目标时长 3~5 分钟，撤离点在第 90 秒后开放',
      '稀有物品掉率控制在 8%~12%，让「这一把有戏」成为常态',
      '永久成长的单次提升不超过战力的 5%，避免滚雪球',
    ],
  },
  {
    id: 'backpack',
    name: '背包整理 · 形状拼装',
    aka: 'backpack / 俄罗斯方块式配装',
    stars: 3,
    fit: '推荐',
    hot: '抖音 6 月第 15《指尖幻影》：塔防布阵与战斗分离，靠背包摆放定强弱',
    why: '把「配装」做成核心玩法：限制空间 + 形状不一 = 天然的取舍。战斗全自动，门槛极低但决策有深度。',
    loop: '整理背包 → 合成升级 → 全屏自动战斗 → 只选增益 buff → 用奖励扩背包',
    mvp: ['形状各异的武器与道具', '有限格子的背包', '同类同级可合成', '全屏自动战斗', '战后只选 buff'],
    money: '激励视频：多一次合成、扩一格背包、战斗失败后重来',
    genre: '背包配装 + 自动战斗（塔防布阵与战斗分离）',
    theme: '科幻废土',
    art: '硬边科幻 UI + 发光道具图标',
    core: [
      '背包是网格，每件武器/道具占不同形状（1x2、2x2、L 形），必须完整放下',
      '格子数很紧张，低级道具要及时丢掉或合成，逼玩家做取舍',
      '两个同种同级道具可合成高一级（体积可能变化，要重新规划）',
      '战斗阶段玩家不再操作布阵，只按波次选增益 buff，看自动战斗演出',
      '通关奖励用于扩背包格子与解锁新道具，形成长期追求',
    ],
    juice: [
      '道具放进格子时吸附 + 轻微回弹，放不下时红色抖动',
      '合成时的光效与数值跳字',
      '战斗全屏演出：屏幕震动、伤害数字层叠、暴击特写',
    ],
    nums: [
      '初始背包必须「刚好放不下三件」—— 例如 12 格，而三件武器合计要占 14 格',
      '每 3 关扩 1~2 格，扩格是最强的正反馈',
      '每关保证 60% 概率出现与当前配装协同的 buff（已堆暴击就给暴击伤害）',
    ],
  },
  {
    id: 'merge',
    name: '合并消除 · 二合一升级',
    aka: 'merge / 合并玩法',
    stars: 2,
    fit: '强烈推荐',
    hot: '微信 8 月第五《浪漫餐厅》、第十《梦幻消除战》；抖音 6 月第八《浪漫餐厅》',
    why: '规则一句话说清、决策无限深。棋盘空间本身就是资源，天然产出「差一步」的不甘。',
    loop: '生成低级物 → 二合一 → 解锁新品类 → 用产出交付订单 → 扩棋盘',
    mvp: ['拖拽二合一', '生成器与冷却', '订单系统', '棋盘空间限制', '图鉴解锁'],
    money: '激励视频：立刻回满生成器、额外一格棋盘、跳过订单等待',
    genre: '合并消除 + 轻经营',
    theme: '餐厅后厨',
    art: '暖色扁平插画，食物质感要足',
    core: [
      '点生成器产出 1 级物品，拖到相同物品上合并成 2 级，逐级到最高级',
      '棋盘格子有限，高级物品占地更大，必须规划动线',
      '订单要求交付某等级的若干物品，交付给金币与经验',
      '生成器有次数/体力，用完只能等或看广告 —— 这是节奏阀门',
      '清理棋盘上的障碍物（藤蔓/冰）需要消耗特定物品，制造短期目标',
    ],
    juice: [
      '合并瞬间的吸附 + 光爆 + 音阶上行',
      '新品类解锁时的图鉴翻开动画',
      '订单完成时的金币雨与连击音效',
    ],
    nums: [
      '生成器免费次数按 6 次/轮设计，让玩家 60 秒内必须做一次决定',
      '订单难度曲线：前 5 单只用 1~3 级物品，第 6 单起才要求 4 级',
      '棋盘留 20% 空位是舒适区，低于 10% 空位玩家会焦虑（这是设计出来的）',
    ],
  },
  {
    id: 'idle-farm',
    name: '模拟经营 · 放置生产链',
    aka: 'idle / 经营养成',
    stars: 3,
    fit: '推荐',
    hot: '微信 7 月第一《我的花园世界》、8 月第二《疯狂水世界》；抖音 6 月第七《向往的生活》',
    why: '离线也在涨的错觉最抓人。经营类天生适合「每天上来收一次」的留存结构，冲突少、情绪稳定。',
    loop: '种植/建造 → 等待或操作加速 → 收获 → 交订单 → 用收益扩建 → 解锁新品类',
    mvp: ['一条能自洽的生产链', '离线收益结算', '订单与交付', '扩建与解锁', '每日任务'],
    money: '激励视频：离线收益翻倍、加速一次、订单刷新',
    genre: '模拟经营 + 放置',
    theme: '果园 / 花园',
    art: '明快手绘，植物生长有 3~4 个阶段可看',
    core: [
      '至少三层生产链：原料 → 加工 → 成品，每层都有等待时间',
      '玩家可用「浇水/加速」类操作缩短等待，但次数有限',
      '居民订单驱动产出，交付后给金币与经验，订单难度逐步提高',
      '扩建解锁新地块与新品类，形成「想看到下一块地」的驱动',
      '离线收益按时间累积，上限 8 小时（引导回访但不惩罚）',
    ],
    juice: [
      '收获时的咔哒音效与飘字，连续收获音调递增',
      '作物成熟的轻微摇摆与光点',
      '扩建完成时镜头拉远，展示变大后的全景',
    ],
    nums: [
      '首次种植到收获不超过 20 秒，让玩家立刻看到闭环',
      '第 3 次收获时必须解锁一个新东西，避免节奏塌陷',
      '订单收益要能覆盖下一次扩建的 60%，让目标始终可及',
    ],
  },
  {
    id: 'stack3d',
    name: '3D 堆叠三消 · 超休闲',
    aka: 'tile match / 三消堆叠',
    stars: 3,
    fit: '推荐（纯广告变现）',
    hot: '抖音 6 月第 37《消的有点菜》：极少量内购、主要靠广告就进前 40，同类罕见',
    why: '零学习成本 + 视觉治愈。看三秒就会玩，特别适合吃短视频买量的流量。',
    loop: '点选同名物件入槽 → 满三个消除 → 槽位快满时紧张 → 通关或失败',
    mvp: ['3D 堆叠的物件', '点击入槽（7 格）', '三个同名消除', '层叠遮挡关系', '关卡递进'],
    money: '纯 IAA：复活、撤回一步、槽位加一',
    genre: '3D 堆叠三消（点击即玩）',
    theme: '蔬菜水果 / 软萌杂物',
    art: '低多边形 3D + 软光 + 糖果色',
    core: [
      '物件以 3D 堆叠摆放，上层挡住下层，只有可点击的物件才能选',
      '点击物件进入底部槽位，槽内有 3 个同名物件时自动消除',
      '槽位上限 7 个，放满且无法消除即失败（这是唯一的失败条件）',
      '关卡用不同堆叠结构与物件种类制造难度，不是靠加时间压力',
      '每关 3 个道具：撤回、洗牌、加一个槽位',
    ],
    juice: [
      '物件飞入槽位的弧线动画与落槽弹性',
      '消除时的粉碎粒子 + 轻微屏幕回弹',
      '槽位剩 2 格时空位变红并有心跳音',
    ],
    nums: [
      '前 3 关必须让人一次过，第 4 关起才允许失败',
      '每关物件种类控制在 6~9 种，超过 9 种就难以规划',
      '难度靠减少可用堆叠排序（每关减 10% 可选项），不要靠缩短时间',
    ],
  },
  {
    id: 'idle-click',
    name: '挂机点击 · 数值轰炸',
    aka: 'clicker / 挂机成长',
    stars: 2,
    fit: '推荐',
    hot: '《寻道大千》的砍树、《斗罗大陆：传承》的消耗香肠攻击，都是这条路的变体',
    why: '暴涨的数字本身就是奖励。单次点击的产出几秒就翻十倍，玩家会在「再看一眼」里停不下来。',
    loop: '点击/自动产出 → 掉落装备 → 战力暴涨 → 打更强的怪 → 重生换永久加成',
    mvp: ['点击产出主资源', '自动产出（挂机）', '装备掉落与替换', '战力数值', '重生（转生）机制'],
    money: '激励视频：离线收益倍增、装备掉落翻倍、免费重生一次',
    genre: '挂机点击 + 装备养成',
    theme: '修仙砍树 / 玄幻',
    art: '国风扁平 + 大号发光数字',
    core: [
      '点击主按钮产出资源，资源自动转化为每秒产出（购买产线）',
      '打怪掉装备，装备直接替换更强的（不要做复杂对比界面）',
      '战力是一个巨大数字，界面必须用 万/亿/兆 分级显示，避免溢出与眼花',
      '重生：清空资源换永久倍率，让玩家有明显「重新起飞」的加速感',
      '离线收益：回来时弹一次结算面板，附「看视频翻倍」',
    ],
    juice: [
      '点击时的数字炸开 + 音效随连击升高',
      '装备掉落的光柱按稀有度分色',
      '数值跨越 万/亿 档时的全屏特效',
    ],
    nums: [
      '第 1 次翻倍要在 10 秒内发生，之后每次翻倍间隔 ≤ 2 倍上一次',
      '数字用 1.23 亿 这种两位有效数字，超过就换单位',
      '重生门槛设为「再攒 15 分钟就能到达」，太长会劝退',
    ],
  },
  {
    id: 'wordplay',
    name: '字谜融合 · 知识即战力',
    aka: 'word + tower defense',
    stars: 3,
    fit: '推荐（差异化最强）',
    hot: '抖音 6 月第一《赵云与阿斗》：汉字 + 塔防，蜜獾工坊出品，两个平台同时进榜',
    why: '在全是数值和美术的赛道里，认知型玩法自带传播点：玩家会截图、会让朋友猜，天然有分享理由。',
    loop: '出题 → 玩家选字/拼词 → 答对变强、答错扣血 → 关卡推进',
    mvp: ['题库或可拼字表', '答题与计时', '答对获得战力/防御', '答错惩罚', '关卡推进'],
    money: '激励视频：提示一个字、重答一次、跳过一题',
    genre: '字谜/知识问答 + 塔防战斗',
    theme: '三国 / 汉字',
    art: '水墨 + 烫金描边，字体本身就是美术',
    core: [
      '战斗前答题：答对给增益（攻击/护盾/召唤），答错扣血或减少防御位',
      '题目与题材强绑定（三国题就出三国人名、成语、兵器字）',
      '字谜做成可点选的字块，正确答案由字块拼出，不用输入法',
      '难度递增：从「一眼答」到「需要想一想」，但不要出现生僻到没人会的题',
      '连答正确触发「字阵」特效：场上所有单位同时强化',
    ],
    juice: [
      '答对时字形放大并镀金，答错时纸张撕碎 + 墨迹扩散',
      '连答计数与逐渐加快的鼓点',
      'Boss 战前给出关键题，答对直接削掉一段血',
    ],
    nums: [
      '每题思考时间 8~12 秒，超过就按错处理',
      '题库至少 200 条，且按难度分 3 档随机抽',
      '前 5 题必须是「几乎不会错」的题，先给成功体验',
    ],
  },
  {
    id: 'physics-puzzle',
    name: '解压方块 · 无压力消除',
    aka: 'block puzzle / 8x8',
    stars: 1,
    fit: '强烈推荐（最容易做完）',
    hot: 'Block Blast! 拿下 2026 Q1 全球下载量第一 —— 全球最大的休闲品类之一',
    why: '没有时间压力、没有失败羞辱，随时能停。放得下就消、放不下就结束，规则 3 秒讲完。',
    loop: '拿 3 个方块 → 拖到 8x8 网格 → 满行/满列消除 → 连消加分 → 放不下即结束',
    mvp: ['8x8 网格', '三选一的方块', '拖拽放置与合法性判断', '满行满列消除', '分数与最高分'],
    money: '激励视频：换一组方块、局内复活一次',
    genre: '解压方块（puzzle）',
    theme: '纯抽象几何 / 糖果色',
    art: '高饱和色块 + 圆角 + 柔和投影，消除时炸成碎片',
    core: [
      '每次给出 3 个随机形状（类似俄罗斯方块块型），必须全部放下才给下一组',
      '拖拽到网格，位置合法才高亮；放下后检测整行/整列填满并消除',
      '连消（一次放下同时消多行）给额外倍率与特效',
      '放不下任何一块即结束，结算展示最高分',
      '网格初始不是空的：预置一些障碍块制造不均',
    ],
    juice: [
      '拖拽时被占格变红、可放格发亮',
      '消除时方块炸成粒子 + 屏幕轻震 + 连消音阶',
      '接近满格时的呼吸感与倒计时感（但不要真的计时）',
    ],
    nums: [
      '第一局必须能玩到 3 分钟以上，否则说明方块生成太苛刻',
      '消除一行给 10 分，连消按 1.5 倍递增',
      '生成方块时保证「至少有一种放法」，同时给出不超过 3 个块型',
    ],
  },
  {
    id: 'one-tap',
    name: '一命跑酷 · 单指操作',
    aka: 'runner / one-tap',
    stars: 2,
    fit: '推荐',
    hot: '《跃动小子》微信 8 月第八、抖音 6 月第九 —— RPG 外壳 + 跑酷内核',
    why: '十秒上手、三十秒一局，最容易被短视频展示。失败成本低，重开几乎是本能。',
    loop: '单指跳跃/转向 → 躲避障碍 → 收集资源 → 距离越远越快 → 撞到即结束',
    mvp: ['单指操作', '障碍生成', '难度随距离上升', '收集物', '距离/分数结算'],
    money: '激励视频：复活续跑、开局加速道具、双倍金币',
    genre: '单指跑酷（超休闲）',
    theme: '霓虹都市 / 赛博',
    art: '霓虹配色 + 动态模糊 + 长阴影',
    core: [
      '只有一个操作（点击/按住），但操作手感要做到「差一点就死」的精确',
      '障碍按可预测的节奏生成，让熟练玩家能背板，这是长线动力',
      '速度随距离提升，每 500 米一个台阶，并给出明显的速度感变化',
      '沿途收集货币，用于解锁皮肤/角色（外观是主要的长期追求）',
      '复活只能一次（看广告），保住「一命」的价值',
    ],
    juice: [
      '起跳/落地的挤压拉伸，落地扬尘',
      '擦身而过时的慢放 0.1 秒 + 白闪',
      '速度台阶切换时的镜头拉远与音效切换',
    ],
    nums: [
      '前 15 秒不能有必死障碍，先让玩家建立节奏感',
      '每 500 米提速 8%，上限 2.2 倍',
      '复活点必须落在安全区（距最近障碍至少 2 秒路程），否则复活即死会激怒玩家',
    ],
  },
  {
    id: 'slg',
    name: '轻 SLG · 4X 城建',
    aka: 'SLG / 4X',
    stars: 5,
    fit: '不建议个人做',
    hot: '微信 8 月第 3《三国：冰河时代》、第 4《无尽冬日》、第 9《向末日开炮》—— 6 款入榜拿下 3 个前十',
    why: '吸金能力最强、但门槛也最高：真正决定成败的是买量预算与长线运营，不是玩法。',
    loop: '城建 → 造兵 → 打野/结盟 → 跨服战争 → 用资源反哺城建',
    mvp: ['主城与建筑升级队列', '资源产出与消耗', '部队训练与行军', '地图与目标点', '联盟基础功能'],
    money: '内购为主（加速、资源、礼包），激励视频只做补充',
    genre: 'SLG / 4X 策略',
    theme: '三国 / 冰雪末日',
    art: '写实厚涂 + 大地图俯视',
    core: [
      '主城建筑有升级队列与等待时间，资源产出与队列深度挂钩',
      '部队训练 → 行军 → 战斗，战斗是可回放的结算而非实时操作',
      '世界地图上有可争夺的资源点与要塞',
      '联盟是核心留存结构：援助、集结、领地共享',
      '跨服/赛季制提供长期目标与重置动力',
    ],
    juice: [
      '城建升级时镜头推近并展示升完级的新外观',
      '出兵后地图上画出会流动的行军线，抵达时落点爆开一圈尘环',
      '集结倒计时用大号数字压在屏幕中央，战报弹出时逐行滚动',
    ],
    nums: [
      '单机简化版：第 1 座建筑升级 30 秒，之后每级时长 ×1.35，前 10 分钟要有 6 次等级提升',
      '资源产出比设为「消耗 1 分钟产能换 1 级建筑」，让等待永远有明确去处',
      '章节节奏：每 5 关一次 Boss、每 20 关解锁一类新兵种，避免长草期超过 3 分钟',
    ],
  },
]

/**
 * 画风预设：每条都是一套可直接落地的「美术 DNA」。
 *
 * 配色不是形容词而是十六进制 —— 提示词里写「赛博朋克风」AI 只会给你一坨蓝紫渐变，
 * 写清 hex、形状语言、禁忌，出来的东西才可控。
 * palette[0] 固定是底色（对比度检查会拿它当基准）。
 */
var ART_STYLES = [
  {
    id: 'neon-cyber',
    name: '霓虹赛博',
    aka: 'neon cyberpunk',
    fit: '塔防割草 / 跑酷 / 射击 / 任何需要「爽」的快节奏玩法',
    palette: [
      { hex: '#05060F', use: '底色（近黑，不要纯黑）' },
      { hex: '#0B1026', use: '面板与地面' },
      { hex: '#22D3EE', use: '主光：玩家、UI 主色、描边' },
      { hex: '#FF2D95', use: '敌方与危险提示' },
      { hex: '#F7FF00', use: '爆点强调（只用于奖励与暴击）' },
      { hex: '#E8F6FF', use: '文字' },
    ],
    shapes: '硬边直线 + 45° 切角，不要圆角；所有元素带 1~2px 发光描边',
    light: '自发光为主：黑底 + 加色混合（globalCompositeOperation="lighter"）+ 高斯式外发光（用 shadowBlur 模拟）',
    motion: '残影拖尾、扫描线、故障位移（每 3~5 秒抖 2 帧）、快速起停（ease-out 极短）',
    ui: '等宽字体、大写字距、细青色边框 + 切角；数值用荧光色',
    taboo: '柔和渐变、低饱和大地色、圆润卡通风、大面积纯白',
    dna: '整体像一台在雨夜运行的终端：黑底、青色主光、洋红警示，元素自发光并带扫描线。',
  },
  {
    id: 'cozy-lowpoly',
    name: '治愈低多边形',
    aka: 'cozy low-poly',
    fit: '模拟经营 / 合并消除 / 放置养成',
    palette: [
      { hex: '#F7E7CE', use: '底色（暖米）' },
      { hex: '#A8D5BA', use: '草地与植物' },
      { hex: '#7FB3D5', use: '水与天空' },
      { hex: '#F2A65A', use: '高光与暖光' },
      { hex: '#4A3F35', use: '文字与轮廓（暖褐，不用纯黑）' },
    ],
    shapes: '圆角多边形、无锐角；物体之间留 8%~12% 呼吸间距',
    light: '单一暖光源从左上来，柔和长投影；同一物体只用 2~3 个明度层',
    motion: '缓慢摆动（正弦 1.5~3 秒周期）、放置时轻微下沉回弹、无激烈特效',
    ui: '圆角卡片、柔和阴影、低对比背景；圆体或手写感字体',
    taboo: '纯黑描边、荧光色、高频闪烁、尖锐三角',
    dna: '像下午四点的阳光照在木桌上：暖米底色、柔和长投影、圆润造型，一切都慢半拍。',
  },
  {
    id: 'ink-wash',
    name: '水墨国风',
    aka: 'ink wash / 国风',
    fit: '字谜融合 / 放置修仙 / 卡牌 / 剧情向',
    palette: [
      { hex: '#F4EFE6', use: '宣纸底' },
      { hex: '#1B1B1F', use: '重墨（主体轮廓）' },
      { hex: '#3A3A42', use: '淡墨（次要形体）' },
      { hex: '#B03A2E', use: '朱砂（印章、伤害、重点）' },
      { hex: '#2E6F8E', use: '石青（点缀，克制使用）' },
    ],
    shapes: '笔触化：轮廓粗细不等、末端收笔渐细；刻意留白，画面不铺满',
    light: '无明确光源，靠墨色浓淡分层；禁止使用外发光与高光点',
    motion: '墨迹扩散（半径缓动 + 透明度渐隐）、笔锋扫过、页片翻动',
    ui: '竖排可选、书法感标题、朱砂印章做确认按钮',
    taboo: '荧光色、塑料高光、渐变彩虹、卡通粗描边',
    dna: '像一幅会动的水墨立轴：宣纸底、浓淡墨分层、朱砂点睛，大面积留白。',
  },
  {
    id: 'pixel-16',
    name: '像素复古 16bit',
    aka: 'pixel art / 复古',
    fit: '解压方块 / 平台跳跃 / Roguelike / 任何格子玩法',
    palette: [
      { hex: '#1A1C2C', use: '最暗（底色）' },
      { hex: '#333C57', use: '暗部' },
      { hex: '#566C86', use: '中间调' },
      { hex: '#94B0C2', use: '亮部' },
      { hex: '#F4F4F4', use: '高光与文字' },
      { hex: '#EF7D57', use: '暖强调' },
      { hex: '#FFCD75', use: '金币与奖励' },
      { hex: '#38B764', use: '生命与正向' },
    ],
    shapes: '严格对齐整数像素网格；只用 1px 硬边，禁止抗锯齿与半透明',
    light: '每个物体 3 个明度层（暗/中/亮），不做真实光照',
    motion: '逐帧动画 8~12fps（不要 60fps 平滑补间）、色板循环（palette cycling）、抖动（dithering）',
    ui: '像素字体（字号必须是 8 或 16 的整数倍）、九宫格边框、无圆角',
    taboo: '平滑渐变、模糊、旋转非 90° 倍数、任意缩放导致的半像素',
    dna: '像一台老主机上的卡带游戏：8~16 色硬边像素、逐帧动画、抖动渐变，绝不抗锯齿。',
  },
  {
    id: 'vaporwave',
    name: '蒸汽波',
    aka: 'vaporwave / synthwave',
    fit: '跑酷 / 音乐节奏 / 解压 / 需要强记忆点的休闲玩法',
    palette: [
      { hex: '#1A0B2E', use: '深紫底' },
      { hex: '#FF71CE', use: '粉（主视觉）' },
      { hex: '#01CDFE', use: '青（次视觉）' },
      { hex: '#05FFA1', use: '薄荷（奖励）' },
      { hex: '#B967FF', use: '紫（氛围）' },
      { hex: '#FFFB96', use: '奶油黄（文字与高光）' },
    ],
    shapes: '透视网格地平线、太阳圆形 + 横向切割线、几何体（球/锥/柱）',
    light: '强渐变背景（粉→青→紫）+ 霓虹外发光；元素像贴纸上贴着发光边',
    motion: '网格向观众滚动、色相缓慢循环、轻微 VHS 抖动与色差（RGB split）',
    ui: '粗体无衬线、全大写、带发光投影；边框用粉青双色描边',
    taboo: '大地色、写实材质、暗部死黑（要紫而不是黑）',
    dna: '像一盘 80 年代录像带：粉紫青渐变、透视网格、发光几何体，带轻微 VHS 抖动。',
  },
  {
    id: 'glass-future',
    name: '玻璃拟态 · 未来极简',
    aka: 'glassmorphism',
    fit: '背包整理 / 解压方块 / 数据感强的益智玩法',
    palette: [
      { hex: '#0F172A', use: '底色（深蓝灰）' },
      { hex: '#1E293B', use: '玻璃面板底' },
      { hex: '#60A5FA', use: '主色（可交互）' },
      { hex: '#34D399', use: '成功与正向反馈' },
      { hex: '#FBBF24', use: '警告与计时' },
      { hex: '#E2E8F0', use: '文字' },
    ],
    shapes: '大圆角（12~20px）、层叠卡片、每层 1px 半透明白描边',
    light: '静态柔和背光 + 玻璃层 8%~14% 白色叠加；投影用大范围低透明度',
    motion: '面板浮入 200ms、按压缩放 0.97、数值滚动；动效克制不弹跳',
    ui: '无衬线中等字重、大量留白、图标线性一致（同 2px 线宽）',
    taboo: '强噪点纹理、深暗角、荧光描边、拟物阴影',
    dna: '像一块未来的玻璃仪表盘：深蓝灰底、半透明圆角面板、细白描边、克制柔光。',
  },
  {
    id: 'grimdark',
    name: '暗黑厚涂 · 硬核',
    aka: 'grimdark',
    fit: '搜打撤 / 生存 / 塔防（末日题材）',
    palette: [
      { hex: '#0D0B0A', use: '虚空底' },
      { hex: '#1C1917', use: '石与地面' },
      { hex: '#57534E', use: '铁与次要形体' },
      { hex: '#7F1D1D', use: '血与危险' },
      { hex: '#F59E0B', use: '火与唯一光源' },
      { hex: '#E7E5E4', use: '骨白（文字与锋刃）' },
    ],
    shapes: '不规则轮廓 + 破损边角；剪影要能在纯黑下认出来',
    light: '单一强光源（火把/爆炸）+ 强轮廓光；大面积压暗，只留一处亮部',
    motion: '重落地扬尘、镜头短促震动、慢速漂移的雾与灰烬',
    ui: '做旧质感、粗糙边缘、字母间距紧；按钮像金属铭牌',
    taboo: '高饱和鲜艳色、干净圆角、可爱元素、均匀打光',
    dna: '像一片烧过的战场：近黑底、铁与血、唯一光源是火，轮廓光勾边，其余全压暗。',
  },
  {
    id: 'candy-casual',
    name: '糖果软萌',
    aka: 'candy casual',
    fit: '3D 堆叠三消 / 超休闲 / 任何面向泛用户的点击玩法',
    palette: [
      { hex: '#FFF1F6', use: '奶油粉底' },
      { hex: '#FFB3C1', use: '主粉' },
      { hex: '#FFD6A5', use: '蜜桃橙' },
      { hex: '#CAFFBF', use: '薄荷绿' },
      { hex: '#9BF6FF', use: '天空蓝' },
      { hex: '#BDB2FF', use: '薰衣草紫' },
      { hex: '#4A3B52', use: '文字（深紫灰，不用黑）' },
    ],
    shapes: '一切皆圆：圆形、超椭圆、圆角方块；物件要有厚度（顶部亮、侧面暗）',
    light: '顶部柔光 + 接触阴影；每个物件都像果冻一样有高光点',
    motion: '弹性动画（过冲 10%~15%）、挤压拉伸、粒子是星星和圆点',
    ui: '粗体圆体字、药丸按钮、描边用深紫灰而非黑',
    taboo: '纯黑、锐角、低饱和、恐怖或写实元素',
    dna: '像一罐糖果：奶油粉底、马卡龙色、圆润带厚度、弹性动画和星星粒子。',
  },
  {
    id: 'papercraft',
    name: '纸艺剪纸',
    aka: 'papercraft',
    fit: '解压方块 / 拼图 / 叙事向休闲玩法',
    palette: [
      { hex: '#F5F1E8', use: '纸白底' },
      { hex: '#D9C7A7', use: '牛皮纸层' },
      { hex: '#2E2A25', use: '墨线' },
      { hex: '#D9534F', use: '番茄红（重点）' },
      { hex: '#3E8E8E', use: '灰绿（次重点）' },
    ],
    shapes: '硬边剪影 + 层叠纸张；每层带 1~2px 偏移投影形成立体感',
    light: '无真实光照，靠层与层的投影表达深度；纸张有极淡的纤维噪点',
    motion: '翻页、撕开、滑入（带轻微旋转 1°~2°）、投影随层级加深',
    ui: '手写体标题、胶带与图钉元素、圆角裁切',
    taboo: '发光、金属质感、霓虹色、过度平滑渐变',
    dna: '像一叠手工剪纸：纸白底、硬边剪影、每层错位投影，只有番茄红和灰绿两个重点色。',
  },
  {
    id: 'minimal-mono',
    name: '极简几何 · 单色 + 一色',
    aka: 'minimal mono',
    fit: '解压方块 / 益智 / 数字类玩法（最不容易做丑）',
    palette: [
      { hex: '#F5F5F4', use: '底（冷白）' },
      { hex: '#171717', use: '前景与文字' },
      { hex: '#A3A3A3', use: '次要信息' },
      { hex: '#2563EB', use: '唯一强调色（只给「可交互」用）' },
    ],
    shapes: '只用圆、方、三角三种基本形；所有圆角/线宽用同一个数值（如 4px / 2px）',
    light: '完全不用光照与阴影，靠形状大小与留白分层',
    motion: '位置与透明度两件事：位移 150~200ms、缓动统一 ease-out',
    ui: '一套字号（如 12/16/24/40）、左对齐、大量留白、无边框只用分隔线',
    taboo: '超过一个强调色、渐变、阴影、纹理、装饰性图标',
    dna: '像一张瑞士平面设计海报：冷白底、纯黑前景、一个蓝色只给可交互元素，其余全靠留白分层。',
  },
]

/** 提示词模板（工坊里可切换） */
var TEMPLATES = [
  { id: 'proto', name: '单文件原型', hint: '一个 index.html，双击即玩 —— 最快看到东西' },
  { id: 'wechat', name: '微信小游戏上架', hint: '含平台适配、分包、开放数据域、广告位' },
  { id: 'fusion', name: '玩法缝合创新', hint: '把两套玩法缝在一起，并给出差异化方向' },
  { id: 'polish', name: '手感打磨', hint: '已有原型，只要手感、反馈与数值优化' },
]
/* GAMEDEV-DATA-END */

/* PROMPT-BEGIN */
/**
 * 把一套画风预设压成可直接塞进提示词的「美术 DNA」。
 * 配色一定带 hex —— 只说「赛博朋克风」AI 会给你一坨蓝紫渐变，说清 hex 才可控。
 */
function styleDna(s) {
  if (!s) return ''
  var L = []
  L.push('画风：' + s.name + '（' + s.aka + '）')
  L.push('- 配色板（照用，不要自己另发明颜色）：' + s.palette.map(function (p) { return p.use + ' ' + p.hex }).join('；'))
  L.push('- 形状语言：' + s.shapes)
  L.push('- 光照与材质：' + s.light)
  L.push('- 动效与反馈：' + s.motion)
  L.push('- UI 与字体：' + s.ui)
  L.push('- 这个风格里**不能出现**：' + s.taboo)
  return L.join('\n')
}

/**
 * 生成「画风优化」提示词：给已有游戏做一次视觉改造，玩法与数值一律不动。
 * @param s 画风预设（ART_STYLES 里的一条）
 * @param o { current, target, keepCode, extra, budget, maxChars }
 */
function buildArtPrompt(s, o) {
  o = o || {}
  var name = String(o.title || '').trim()
  var current = String(o.current || '').trim()
  var extra = String(o.extra || '').trim()
  var budget = String(o.budget || '粒子同屏不超过 400，单个特效不超过 3 层叠加').trim()
  var cap = o.maxChars || 6000
  var L = []

  L.push('你是游戏美术总监兼技术美术（TA），擅长在**不改玩法、不改数值**的前提下把画面质感提升一个档次。')
  L.push('你的判断标准只有一条：玩家第一眼看到的画面，是否比之前更想截图分享。')
  L.push('')

  L.push('【任务】')
  L.push('把我下面给出的游戏从现在的样子改成「' + s.name + '」风格' + (name ? '（游戏名：' + name + '）' : '') + '。')
  L.push('玩法、操作、数值、关卡结构一律不动 —— 只允许改渲染、资源、动画与 UI 层。')
  L.push('')

  L.push('【目标画风】')
  L.push(styleDna(s))
  L.push('')
  L.push('这套风格的适用场景（供你判断取舍）：' + s.fit)
  L.push('')

  if (current) {
    var shown = current.length > cap ? current.slice(0, cap) + '\n…（内容过长已截断，请按已给出部分推断整体风格）' : current
    L.push('【现状（我现在的代码 / 画面描述）】')
    L.push(shown)
    L.push('')
  } else {
    L.push('【现状】')
    L.push('（我这次没提供代码，请你先按「一个用 Canvas 2D 画的、配色随便、没有光影层次的朴素版本」来假设现状。）')
    L.push('')
  }

  L.push('【硬约束】')
  L.push('- 不改玩法逻辑、不改数值参数、不改操作方式；改动只允许出现在渲染与 UI 层')
  L.push('- 所有视觉必须由代码画出来（几何图形 + 渐变 + 发光 + 阴影），不引入任何图片、字体、CDN')
  L.push('- 性能预算：' + budget + '；目标 60fps，特效必须能一键降级（CONFIG 里留一个 quality 开关）')
  L.push('- 颜色不许散落在代码里：全部收进文件顶部的 CONFIG.PALETTE，键名用语义（如 BG / PLAYER / DANGER / REWARD）')
  L.push('- 无障碍：关键元素之间明度差 ≥ 25%，不要只靠颜色区分敌我（形状或描边也要不同）')
  L.push('')

  L.push('【交付顺序（请严格按这个顺序，不要跳步）】')
  L.push('1. **现状诊断**：列出当前画面最影响质感的 5 个问题，每条一句话并指出具体位置（哪个元素/哪一段）')
  L.push('2. **配色表**：用表格给「用途 / 旧颜色 / 新颜色（hex） / 为什么」，逐条对齐目标画风的配色板')
  L.push('3. **完整代码**：一次给全、可直接运行的新版本（不要分段贴、不要省略、不要 TODO）')
  L.push('4. **改动清单**：每项写成「改了什么 → 视觉上的效果 → 性能代价」，性能代价要具体到数量级')
  L.push('')

  L.push('【这个风格最容易做砸的地方（请主动规避）】')
  L.push('- 把风格做成「滤镜」：只在原图上叠一层颜色，形状语言和描边完全没变')
  L.push('- 一次性把所有元素都加发光/粒子，导致画面糊成一团、反而看不清主体')
  L.push('- 配色用满：主色、次色、强调色各超过一个就失控了')
  L.push('- 忘记 UI：游戏画面换了风格，按钮和数字还是旧皮肤，看起来像两个游戏')
  L.push('')

  if (extra) {
    L.push('【补充要求】')
    L.push(extra)
    L.push('')
  }

  L.push('【做完自查】')
  L.push('- [ ] 玩法与数值零改动（改动清单里没有任何一条落在逻辑层）')
  L.push('- [ ] 硬编码颜色清零，全部来自 CONFIG.PALETTE')
  L.push('- [ ] 连续玩 5 分钟不掉帧（说明你测的方式与最低帧率）')
  L.push('- [ ] 画面缩到 30% 大小仍能一眼分清玩家、敌人、奖励')
  L.push('- [ ] 截图给没玩过的人看，能说出这是什么风格')
  L.push('')

  L.push('不要解释基础概念，先给诊断和配色表，再给完整代码。')
  return L.join('\n')
}

/** 交付形态（按模板切换） */
function deliverySpec(tpl) {
  if (tpl === 'wechat') {
    return [
      '用微信小游戏原生工程结构（game.js + game.json + js/ 目录），可在微信开发者工具里直接打开运行',
      '逻辑层与渲染层分离：主域负责玩法，开放数据域只负责排行榜绘制',
      '所有资源走本地相对路径，不依赖任何 CDN；首包控制在 4MB 以内，超出的放分包',
      '适配微信小游戏生命周期：onShow/onHide 暂停与恢复、分享、录屏',
    ]
  }
  if (tpl === 'fusion') {
    return [
      '单个 index.html，内联 CSS 与 JS，不引用任何外部库/CDN，双击即可运行',
      '先把两套玩法各自的「最小循环」都跑通，再做缝合，不要一上来就做大杂烩',
    ]
  }
  if (tpl === 'polish') {
    return [
      '在我给出的现有代码上改，不要重写结构；每一项改动都要能说清「改前 → 改后」的差别',
      '如果缺少可改的代码，就先按单文件形态产出一版再改',
    ]
  }
  return [
    '单个 index.html 文件（第 1 行为 <!DOCTYPE html>），内联 CSS 与 JS',
    '不引用任何外部库、CDN、字体或图片文件；双击即可在浏览器打开运行',
    '代码必须是完整可运行的，不允许出现「此处省略」「同上」「TODO 自行补充」',
  ]
}

/**
 * 生成可直接粘给 AI 的提示词。
 * @param r 配方对象（RECIPES 里的一条）
 * @param o 工坊选项 { template, title, theme, art, stack, money, extra, fusionWith }
 */
function buildPrompt(r, o) {
  o = o || {}
  var tpl = o.template || 'proto'
  /* 名字留空就干脆不写书名号 —— 硬塞一个「未命名小游戏」只会让提示词显得廉价 */
  var title = String(o.title || '').trim()
  var theme = String(o.theme || r.theme || '').trim()
  var art = String(o.art || r.art || '').trim()
  var money = String(o.money || r.money || '').trim()
  var extra = String(o.extra || '').trim()
  var fusionWith = String(o.fusionWith || '').trim()
  var L = []

  /* ---- 角色与目标 ---- */
  L.push('你是一位做过十款以上月流水百万级小游戏的独立游戏开发者，擅长把玩法原型在一天内做到「能玩、手感好、有留存钩子」。')
  L.push('')
  L.push('【一句话需求】')
  L.push('做一个「' + theme + '」题材的小游戏' + (title ? '《' + title + '》' : '') + '，核心玩法是「' + r.name + '」（' + r.aka + '）。')
  if (tpl === 'fusion') {
    L.push('在它的基础上再缝进「' + (fusionWith || '另一套玩法') + '」，两套玩法必须共用同一套资源与操作，不能各玩各的。')
  }
  L.push('目标：让玩家在 10 秒内明白怎么玩、30 秒内获得第一次明显爽感、3 分钟内产生「再来一局」的冲动。')
  L.push('')

  /* ---- 美术与题材 ---- */
  var style = null
  if (o.artStyleId) {
    for (var si = 0; si < ART_STYLES.length; si++) if (ART_STYLES[si].id === o.artStyleId) style = ART_STYLES[si]
  }
  L.push('【美术与题材】')
  L.push('- 题材：' + theme)
  if (style) {
    /* 选了画风预设就把整套 DNA（含 hex 配色板）写进去，比「XX 风格」这种形容词可控得多 */
    L.push(styleDna(style))
    L.push('- 美术尽量用纯代码画出来（几何图形 + 渐变 + 发光 + 阴影），不要依赖任何图片素材')
  } else {
    L.push('- 风格：' + art)
    L.push('- 美术尽量用纯代码画出来（几何图形 + 渐变 + 发光 + 阴影），不要依赖任何图片素材')
    L.push('- 配色给出 4~6 个十六进制主色并集中在 CONFIG 里，全局统一，不要中途混搭风格')
  }
  L.push('')

  /* ---- 交付形态 ---- */
  L.push('【交付形态】')
  var ds = deliverySpec(tpl)
  for (var i = 0; i < ds.length; i++) L.push('- ' + ds[i])
  L.push('')

  /* ---- 技术约束 ---- */
  L.push('【技术约束】')
  L.push('- 渲染用 Canvas 2D（不要 WebGL / WebGL2，不要引入 three.js 之类的引擎）')
  L.push('- 目标 60fps：同屏对象上限 ' + (r.id === 'autoshooter' ? '300' : '100') + ' 个，必须用对象池，禁止每帧 new 对象')
  L.push('- 输入同时支持鼠标与触摸，移动端按竖屏 9:16 优先，桌面端居中显示并留出安全边距')
  L.push('- 分辨率随 devicePixelRatio 缩放，窗口 resize 不丢游戏状态')
  L.push('- 状态机：菜单 → 游戏中 → 暂停 → 结算 → （可复活）→ 菜单')
  L.push('- 存档用 localStorage：最高分、最高纪录、已解锁内容；版本号写进键名以便日后迁移')
  L.push('- 音效用 WebAudio 现场合成（振荡器 + 包络），不引入任何音频文件，并提供静音开关')
  L.push('')

  /* ---- 核心玩法 ---- */
  L.push('【核心玩法（逐条实现，不要漏项）】')
  for (var c = 0; c < r.core.length; c++) L.push((c + 1) + '. ' + r.core[c])
  L.push('')
  L.push('单局循环：' + r.loop)
  L.push('')

  /* ---- 手感 ---- */
  L.push('【手感与表现（"juice"，这部分决定留存）】')
  for (var j = 0; j < r.juice.length; j++) L.push('- ' + r.juice[j])
  L.push('- 所有反馈都要在 100ms 内出现：不然后面做得再好也像「塑料感」')
  L.push('')

  /* ---- 数值 ---- */
  L.push('【数值与节奏】')
  for (var n = 0; n < r.nums.length; n++) L.push('- ' + r.nums[n])
  L.push('')

  /* ---- 变现 ---- */
  L.push('【变现与增长钩子】')
  L.push('- ' + money)
  L.push('- 分享：结算页给出可直接复制的成绩文案（含分数与一句挑衅式话术）')
  if (tpl === 'wechat') {
    L.push('')
    L.push('【平台适配（微信小游戏）】')
    L.push('- 用 wx.createCanvas / wx.onTouchStart 等官方 API，不要用 DOM 事件')
    L.push('- 分包加载：主包只放首关资源，其余放分包并按需 wx.loadSubpackage')
    L.push('- 开放数据域用于好友排行榜：只画 canvas，不参与主域逻辑')
    L.push('- 广告接入点写成一个可替换的函数，用注释标出「此处调用激励视频」')
    L.push('- 审核注意：不要出现赌博、血腥、诱导分享的文案')
  }
  if (tpl === 'fusion') {
    L.push('')
    L.push('【创新要求】')
    L.push('- 先各自实现两套玩法的最小循环，再设计它们的连接点（资源互通 / 操作互斥 / 节奏互补）')
    L.push('- 给出 3 个差异化的缝合方向，每个方向一句话说明「新意在哪、风险在哪」，并标明你推荐哪个')
    L.push('- 明确说出哪一处最容易做成「两张皮」，以及你的规避办法')
  }
  if (tpl === 'polish') {
    L.push('')
    L.push('【本次只要改这些】')
    L.push('- 输入到画面的延迟感：补上预输入缓冲与 40~80ms 顿帧')
    L.push('- 数值曲线：给出修改前后的具体数字对比表')
    L.push('- 反馈层级：区分「小反馈 / 中反馈 / 大反馈」，避免所有事件都是一个特效')
  }
  if (extra) {
    L.push('')
    L.push('【补充要求】')
    L.push(extra)
  }
  L.push('')

  /* ---- 验收 ---- */
  L.push('【做完自查（逐条确认后再交付）】')
  L.push('- [ ] 打开就能玩，控制台没有任何报错或警告')
  L.push('- [ ] 10 秒内不需要说明书就能上手')
  L.push('- [ ] 手机竖屏与桌面浏览器都不破版、不超出屏幕')
  L.push('- [ ] 连续玩 5 分钟不卡顿、内存不持续上涨（对象池生效）')
  L.push('- [ ] 失败后 1 秒内能重开，重开不需要读条')
  L.push('- [ ] 关掉声音后游戏逻辑完全不受影响')
  L.push('')

  /* ---- 交付要求 ---- */
  L.push('【交付要求】')
  L.push('1. 先给**完整可运行**的代码（不要分段贴、不要省略），一次给全')
  L.push('2. 再给一段 100 字以内的玩法说明（怎么玩、赢的条件、失败的条件）')
  L.push('3. 然后给 3 个后续迭代方向，每个一句话，按「性价比」排序')
  L.push('4. 最后说明你在哪里留了可调参数（数值变量集中放在文件顶部的 CONFIG 对象里）')
  L.push('')
  L.push('不要解释基础概念（什么是 canvas、什么是游戏循环都不用讲），直接给代码。')
  return L.join('\n')
}
/* PROMPT-END */

/** 复制到剪贴板：优先 Clipboard API，失败退回 textarea + execCommand */
function copyToClipboard(text: string): Promise<boolean> {
  const nav: any = typeof navigator !== 'undefined' ? navigator : null
  const legacy = () => {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', 'readonly')
      ta.style.position = 'fixed'
      ta.style.top = '-2000px'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch { return false }
  }
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
    return nav.clipboard.writeText(text).then(() => true).catch(() => legacy())
  }
  return Promise.resolve(legacy())
}

const CSS = [
  '.wt-gd{position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden;',
  'background:radial-gradient(ellipse at 30% 0%,#141033 0%,#08060f 55%,#04030a 100%);color:#ece7ff;',
  'font:12.5px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}',
  '.wt-gd *{box-sizing:border-box}',
  '.wt-gd-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',

  /* 顶栏 */
  '.wt-gd-top{flex:0 0 auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 12px;',
  'border-bottom:1px solid rgba(168,140,255,.22);background:linear-gradient(90deg,rgba(70,40,140,.42),rgba(10,8,26,.3))}',
  '.wt-gd-brand{display:flex;align-items:center;gap:7px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;letter-spacing:1.8px;color:#c3a6ff}',
  '.wt-gd-dot{width:6px;height:6px;border-radius:50%;background:#b48cff;box-shadow:0 0 8px #b48cff}',
  '.wt-gd-tabs{display:flex;gap:4px;margin-left:auto}',
  '.wt-gd-tab{font:inherit;font-size:11.5px;padding:5px 11px;cursor:pointer;color:#cbbdf0;background:rgba(60,40,120,.3);',
  'border:1px solid rgba(168,140,255,.26);border-radius:3px}',
  '.wt-gd-tab:hover{background:rgba(90,60,170,.42);color:#fff}',
  '.wt-gd-tabOn{background:linear-gradient(180deg,rgba(140,100,255,.5),rgba(70,40,150,.5));color:#fff;border-color:rgba(196,170,255,.7)}',

  /* 内容区 */
  '.wt-gd-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:12px}',
  '.wt-gd-body::-webkit-scrollbar{width:8px}',
  '.wt-gd-body::-webkit-scrollbar-thumb{background:rgba(168,140,255,.3);border-radius:8px}',
  '.wt-gd-sec{display:flex;align-items:center;gap:8px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;',
  'letter-spacing:1.6px;color:#b49cf0;text-transform:uppercase;margin:14px 0 8px}',
  '.wt-gd-sec:first-child{margin-top:0}',
  '.wt-gd-sec::before{content:"▚"}',
  '.wt-gd-sec::after{content:"";flex:1 1 auto;height:1px;background:linear-gradient(90deg,rgba(168,140,255,.4),transparent)}',
  '.wt-gd-hint{font-size:11px;color:#9d92c4;line-height:1.7}',

  /* 榜单表 */
  '.wt-gd-table{width:100%;border-collapse:collapse;font-size:11.5px;margin-bottom:6px}',
  '.wt-gd-table th{text-align:left;font-weight:400;font-size:10px;letter-spacing:1px;color:#a595d8;',
  'border-bottom:1px solid rgba(168,140,255,.24);padding:4px 6px}',
  '.wt-gd-table td{padding:4px 6px;border-bottom:1px solid rgba(168,140,255,.1);color:#ded6f5}',
  '.wt-gd-table tr:hover td{background:rgba(120,90,220,.16)}',
  '.wt-gd-rank{font-family:ui-monospace,Menlo,Consolas,monospace;color:#b48cff;width:34px}',
  '.wt-gd-rankTop{color:#ffd479;font-weight:700}',
  '.wt-gd-trend{display:flex;gap:7px;padding:5px 8px;border-left:2px solid rgba(168,140,255,.5);',
  'background:rgba(70,50,130,.18);margin-bottom:5px;font-size:11.5px;line-height:1.6;color:#d8cff2}',
  '.wt-gd-src{display:flex;gap:7px;align-items:baseline;font-size:11px;padding:3px 0;color:#a99dd0}',
  '.wt-gd-src a{color:#c9b3ff;text-decoration:none;border-bottom:1px dotted rgba(201,179,255,.5)}',
  '.wt-gd-src a:hover{color:#fff}',

  /* 配方卡 */
  '.wt-gd-tools{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px}',
  '.wt-gd-input,.wt-gd-select,.wt-gd-area{font:inherit;font-size:11.5px;color:#efe9ff;background:rgba(14,10,30,.85);',
  'border:1px solid rgba(168,140,255,.3);border-radius:3px;padding:6px 9px;outline:none}',
  '.wt-gd-input:focus,.wt-gd-select:focus,.wt-gd-area:focus{border-color:rgba(196,170,255,.75)}',
  '.wt-gd-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:10px}',
  '.wt-gd-card{position:relative;border:1px solid rgba(168,140,255,.26);border-radius:4px;padding:11px 12px;',
  'background:linear-gradient(160deg,rgba(50,34,104,.5),rgba(12,9,26,.5))}',
  '.wt-gd-card::before{content:"";position:absolute;top:-1px;left:-1px;width:14px;height:14px;',
  'border-top:2px solid rgba(196,170,255,.8);border-left:2px solid rgba(196,170,255,.8)}',
  '.wt-gd-cardHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
  '.wt-gd-cardName{font-size:14px;font-weight:650;color:#fff}',
  '.wt-gd-cardAka{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:9.5px;color:#a595d8;letter-spacing:.6px}',
  '.wt-gd-star{margin-left:auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;color:#ffd479;white-space:nowrap}',
  '.wt-gd-fit{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:9px;letter-spacing:.8px;padding:1.5px 6px;border-radius:2px;',
  'border:1px solid rgba(140,240,180,.4);color:#a7f0c4}',
  '.wt-gd-fit-warn{border-color:rgba(255,150,140,.45);color:#ffb3ab}',
  '.wt-gd-k{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:9px;letter-spacing:1.2px;color:#a595d8;margin-top:8px}',
  '.wt-gd-v{font-size:11.5px;line-height:1.7;color:#ddd5f4}',
  '.wt-gd-chip{display:inline-block;font-size:10.5px;padding:2px 7px;margin:3px 4px 0 0;border-radius:2px;',
  'background:rgba(80,60,150,.35);border:1px solid rgba(168,140,255,.24);color:#cfc2f2}',
  '.wt-gd-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}',
  '.wt-gd-btn{font:inherit;font-size:11.5px;padding:6px 12px;cursor:pointer;color:#efe9ff;border-radius:3px;',
  'background:linear-gradient(180deg,rgba(120,84,230,.55),rgba(58,34,124,.55));border:1px solid rgba(196,170,255,.5);',
  'transition:background .15s,box-shadow .15s,transform .1s}',
  '.wt-gd-btn:hover{background:linear-gradient(180deg,rgba(146,106,255,.75),rgba(78,48,164,.7));box-shadow:0 0 14px rgba(160,120,255,.35)}',
  '.wt-gd-btn:active{transform:translateY(1px)}',
  '.wt-gd-btn:focus-visible{outline:none;box-shadow:0 0 0 2px rgba(196,170,255,.6)}',
  '.wt-gd-btn-ghost{background:rgba(30,20,60,.5);border-color:rgba(168,140,255,.3);color:#c8bcf0}',
  '.wt-gd-btn-ok{background:linear-gradient(180deg,rgba(60,190,130,.6),rgba(20,90,60,.6));border-color:rgba(150,245,190,.6);color:#eafff4}',

  /* 工坊 */
  '.wt-gd-studio{display:grid;grid-template-columns:minmax(280px,340px) minmax(320px,1fr);gap:12px;align-items:start}',
  '@media (max-width:820px){.wt-gd-studio{grid-template-columns:1fr}}',
  '.wt-gd-field{display:flex;flex-direction:column;gap:3px;margin-bottom:8px}',
  '.wt-gd-label{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:9px;letter-spacing:1.2px;color:#a595d8}',
  '.wt-gd-out{width:100%;min-height:420px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:1.65;',
  'white-space:pre-wrap;resize:vertical}',
  '.wt-gd-outBar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}',
  '.wt-gd-count{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10px;color:#a595d8}',

  /* 画风预设卡 */
  '.wt-gd-style{position:relative;border:1px solid rgba(168,140,255,.22);border-radius:4px;padding:9px 10px;cursor:pointer;',
  'background:linear-gradient(160deg,rgba(40,28,84,.45),rgba(10,8,22,.45));transition:border-color .15s,box-shadow .15s}',
  '.wt-gd-style:hover{border-color:rgba(196,170,255,.55)}',
  '.wt-gd-styleOn{border-color:rgba(196,170,255,.9);box-shadow:0 0 0 1px rgba(196,170,255,.35),0 0 18px rgba(140,100,255,.25)}',
  '.wt-gd-palette{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}',
  '.wt-gd-swatch{display:flex;flex-direction:column;gap:2px;width:54px}',
  '.wt-gd-swatch i{display:block;height:17px;border-radius:2px;border:1px solid rgba(255,255,255,.18)}',
  '.wt-gd-swatch b{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:8px;font-weight:400;color:#a595d8;letter-spacing:.2px}',

  /* 复制提示 */
  '.wt-gd-toast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:9;pointer-events:none;',
  'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.6px;padding:7px 14px;border-radius:3px;',
  'background:rgba(20,12,40,.94);border:1px solid rgba(196,170,255,.6);color:#e9e2ff;box-shadow:0 8px 26px rgba(0,0,0,.5)}',
].join('')

/** 星级：用 ★/☆ 表示，方便眼睛扫 */
function starText(n: number): string {
  const k = Math.max(1, Math.min(5, n | 0))
  return '★'.repeat(k) + '☆'.repeat(5 - k)
}

/** 配色板：把预设里的 hex 直接铺成色块 —— 读文字不如看颜色快 */
function Palette({ style }: { style: any }) {
  return (
    <div className="wt-gd-palette">
      {style.palette.map((p: any) => (
        <span className="wt-gd-swatch" key={p.hex + p.use} title={p.use + ' ' + p.hex}>
          <i style={{ background: p.hex }} />
          <b>{p.hex}</b>
        </span>
      ))}
    </div>
  )
}

export function GameDevPane() {
  const [tab, setTab] = useState<'board' | 'recipes' | 'studio' | 'art'>('recipes')
  const [q, setQ] = useState('')
  const [onlyEasy, setOnlyEasy] = useState(false)
  const [recipeId, setRecipeId] = useState(RECIPES[0].id)
  const [tpl, setTpl] = useState('proto')
  const [fusionId, setFusionId] = useState(RECIPES[1].id)
  const [title, setTitle] = useState('')
  const [theme, setTheme] = useState('')
  const [art, setArt] = useState('')
  const [money, setMoney] = useState('')
  const [extra, setExtra] = useState('')
  const [copied, setCopied] = useState('')
  const [artId, setArtId] = useState(ART_STYLES[0].id)
  const [artCurrent, setArtCurrent] = useState('')
  const [artExtra, setArtExtra] = useState('')
  const [studioArtId, setStudioArtId] = useState('')
  const timerRef = useRef<number | null>(null)

  useEffect(() => () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current) }, [])

  const recipe = useMemo(() => RECIPES.find((r) => r.id === recipeId) || RECIPES[0], [recipeId])
  const fusionRecipe = useMemo(() => RECIPES.find((r) => r.id === fusionId) || RECIPES[1], [fusionId])
  const artStyle = useMemo(() => ART_STYLES.find((s) => s.id === artId) || ART_STYLES[0], [artId])

  const prompt = useMemo(
    () => buildPrompt(recipe, {
      template: tpl,
      title,
      theme,
      art,
      money,
      extra,
      fusionWith: fusionRecipe ? fusionRecipe.name : '',
      artStyleId: studioArtId,
    }),
    [recipe, tpl, title, theme, art, money, extra, fusionRecipe, studioArtId],
  )

  const artPrompt = useMemo(
    () => buildArtPrompt(artStyle, { current: artCurrent, extra: artExtra }),
    [artStyle, artCurrent, artExtra],
  )

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return RECIPES.filter((r) => {
      if (onlyEasy && r.stars > 3) return false
      if (!kw) return true
      const hay = [r.name, r.aka, r.theme, r.genre, r.hot, r.why].join(' ').toLowerCase()
      return hay.indexOf(kw) >= 0
    })
  }, [q, onlyEasy])

  const doCopy = (text: string, tag: string) => {
    void copyToClipboard(text).then((ok) => {
      setCopied(ok ? '已复制 ' + tag + '，直接粘给 AI 就能开工' : '复制失败：请手动全选复制')
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => setCopied(''), 1900)
    })
  }

  const openInStudio = (id: string) => { setRecipeId(id); setTab('studio') }

  return (
    <div className="wt-gd">
      <style>{CSS}</style>

      <div className="wt-gd-top">
        <span className="wt-gd-brand"><i className="wt-gd-dot" />GAME DEV STUDIO</span>
        <span className="wt-gd-mono" style={{ fontSize: 10, color: '#9d92c4' }}>
          榜单快照 {SNAPSHOT_DATE} · {RECIPES.length} 套配方 · {ART_STYLES.length} 种画风
        </span>
        <div className="wt-gd-tabs">
          <button type="button" className={'wt-gd-tab' + (tab === 'board' ? ' wt-gd-tabOn' : '')} onClick={() => setTab('board')}>爆款榜单</button>
          <button type="button" className={'wt-gd-tab' + (tab === 'recipes' ? ' wt-gd-tabOn' : '')} onClick={() => setTab('recipes')}>玩法配方</button>
          <button type="button" className={'wt-gd-tab' + (tab === 'studio' ? ' wt-gd-tabOn' : '')} onClick={() => setTab('studio')}>提示词工坊</button>
          <button type="button" className={'wt-gd-tab' + (tab === 'art' ? ' wt-gd-tabOn' : '')} onClick={() => setTab('art')}>画风工坊</button>
        </div>
      </div>

      <div className="wt-gd-body">
        {tab === 'board' && (
          <>
            {RANKINGS.map((rk) => (
              <div key={rk.platform + rk.month}>
                <div className="wt-gd-sec">{rk.platform} · 畅销榜前十 · {rk.month}</div>
                <table className="wt-gd-table">
                  <thead><tr><th>#</th><th>游戏</th><th>品类与机制</th></tr></thead>
                  <tbody>
                    {rk.rows.map((row) => (
                      <tr key={rk.platform + row[1]}>
                        <td className={'wt-gd-rank' + (row[0] <= 3 ? ' wt-gd-rankTop' : '')}>{row[0]}</td>
                        <td>{row[1]}</td>
                        <td style={{ color: '#b6a9dd' }}>{row[2]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

            <div className="wt-gd-sec">结构性观察</div>
            {TRENDS.map((t) => (
              <div className="wt-gd-trend" key={t}>
                {/* 数据里用 ** 标重点：这里拆成 <b>，避免出现裸星号 */}
                {t.split('**').map((seg, i) => (
                  i % 2 === 1
                    ? <b key={i} style={{ color: '#e2d6ff' }}>{seg}</b>
                    : <span key={i}>{seg}</span>
                ))}
              </div>
            ))}

            <div className="wt-gd-sec">数据来源（{SNAPSHOT_DATE} 核对）</div>
            <div className="wt-gd-hint" style={{ marginBottom: 6 }}>
              榜单是静态快照，不会自己更新。看到榜单已经换血，就把这里的日期和条目改掉。
            </div>
            {SOURCES.map((s) => (
              <div className="wt-gd-src" key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer">{s.label}</a>
                <span>· {s.note}</span>
              </div>
            ))}
          </>
        )}

        {tab === 'recipes' && (
          <>
            <div className="wt-gd-tools">
              <input className="wt-gd-input" style={{ minWidth: 220 }} placeholder="搜玩法 / 题材 / 代表爆款" value={q} onChange={(e) => setQ(e.target.value)} />
              <label className="wt-gd-hint" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={onlyEasy} onChange={(e) => setOnlyEasy(e.target.checked)} />
                只看个人能做的（难度 ≤ 3★）
              </label>
              <span className="wt-gd-count" style={{ fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 10, color: '#a595d8' }}>
                {filtered.length}/{RECIPES.length} 套
              </span>
            </div>

            <div className="wt-gd-cards">
              {filtered.map((r) => (
                <div className="wt-gd-card" key={r.id}>
                  <div className="wt-gd-cardHead">
                    <span className="wt-gd-cardName">{r.name}</span>
                    <span className={'wt-gd-fit' + (r.stars >= 4 ? ' wt-gd-fit-warn' : '')}>{r.fit}</span>
                    <span className="wt-gd-star" title={'实现难度 ' + r.stars + '/5'}>{starText(r.stars)}</span>
                  </div>
                  <div className="wt-gd-cardAka">{r.aka}</div>

                  <div className="wt-gd-k">代表爆款</div>
                  <div className="wt-gd-v">{r.hot}</div>
                  <div className="wt-gd-k">为什么火</div>
                  <div className="wt-gd-v">{r.why}</div>
                  <div className="wt-gd-k">单局循环</div>
                  <div className="wt-gd-v">{r.loop}</div>
                  <div className="wt-gd-k">最小可玩版本</div>
                  <div>{r.mvp.map((m) => <span className="wt-gd-chip" key={m}>{m}</span>)}</div>
                  <div className="wt-gd-k">变现钩子</div>
                  <div className="wt-gd-v">{r.money}</div>

                  <div className="wt-gd-actions">
                    <button type="button" className="wt-gd-btn" onClick={() => doCopy(buildPrompt(r, { template: 'proto' }), '原型提示词')}>
                      复制 AI 提示词
                    </button>
                    <button type="button" className="wt-gd-btn wt-gd-btn-ghost" onClick={() => openInStudio(r.id)}>在工坊里改</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === 'studio' && (
          <div className="wt-gd-studio">
            <div>
              <div className="wt-gd-sec">选择配方</div>
              <select className="wt-gd-select" style={{ width: '100%' }} value={recipeId} onChange={(e) => setRecipeId(e.target.value)}>
                {RECIPES.map((r) => <option key={r.id} value={r.id}>{r.name}（{starText(r.stars)}）</option>)}
              </select>

              <div className="wt-gd-sec">提示词模板</div>
              <div className="wt-gd-tools">
                {TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={'wt-gd-tab' + (tpl === t.id ? ' wt-gd-tabOn' : '')}
                    title={t.hint}
                    onClick={() => setTpl(t.id)}
                  >{t.name}</button>
                ))}
              </div>
              <div className="wt-gd-hint">{TEMPLATES.find((t) => t.id === tpl)?.hint}</div>

              {tpl === 'fusion' && (
                <>
                  <div className="wt-gd-sec">缝进哪套玩法</div>
                  <select className="wt-gd-select" style={{ width: '100%' }} value={fusionId} onChange={(e) => setFusionId(e.target.value)}>
                    {RECIPES.filter((r) => r.id !== recipeId).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </>
              )}

              <div className="wt-gd-sec">可选填空（留空就用配方的默认值）</div>
              <div className="wt-gd-field">
                <span className="wt-gd-label">游戏名</span>
                <input className="wt-gd-input" placeholder="例如：最后的向日葵" value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="wt-gd-field">
                <span className="wt-gd-label">题材（默认：{recipe.theme}）</span>
                <input className="wt-gd-input" placeholder={recipe.theme} value={theme} onChange={(e) => setTheme(e.target.value)} />
              </div>
              <div className="wt-gd-field">
                <span className="wt-gd-label">美术风格（默认：{recipe.art}）</span>
                <input className="wt-gd-input" placeholder={recipe.art} value={art} onChange={(e) => setArt(e.target.value)} />
              </div>
              <div className="wt-gd-field">
                <span className="wt-gd-label">变现方式（默认：{recipe.money}）</span>
                <input className="wt-gd-input" placeholder="留空用默认" value={money} onChange={(e) => setMoney(e.target.value)} />
              </div>
              <div className="wt-gd-field">
                <span className="wt-gd-label">补充要求</span>
                <textarea className="wt-gd-area" rows={3} placeholder="例如：必须有每日挑战；数值要集中在 CONFIG 里" value={extra} onChange={(e) => setExtra(e.target.value)} />
              </div>

              <div className="wt-gd-sec">画风（可选，选了就把整套 hex 配色写进提示词）</div>
              <select className="wt-gd-select" style={{ width: '100%' }} value={studioArtId} onChange={(e) => setStudioArtId(e.target.value)}>
                <option value="">不指定（用配方默认：{recipe.art}）</option>
                {ART_STYLES.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.aka}</option>)}
              </select>
              {studioArtId && (
                <div style={{ marginTop: 6 }}>
                  {ART_STYLES.filter((s) => s.id === studioArtId).map((s) => (
                    <Palette key={s.id} style={s} />
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="wt-gd-outBar">
                <button type="button" className={'wt-gd-btn' + (copied.indexOf('已复制') === 0 ? ' wt-gd-btn-ok' : '')} onClick={() => doCopy(prompt, '提示词')}>
                  {copied.indexOf('已复制') === 0 ? '✓ 已复制' : '一键复制提示词'}
                </button>
                <button type="button" className="wt-gd-btn wt-gd-btn-ghost" onClick={() => doCopy(buildPrompt(recipe, { template: tpl, title, theme, art, money, extra, fusionWith: fusionRecipe?.name }), '提示词')}>
                  复制并把配方写全
                </button>
                <span className="wt-gd-count">{prompt.length} 字</span>
              </div>
              <textarea className="wt-gd-out" readOnly value={prompt} onFocus={(e) => e.currentTarget.select()} />
              <div className="wt-gd-hint" style={{ marginTop: 6 }}>
                用法：复制 → 粘给 AI 编程助手（DSH / Claude Code / Cursor 都行）→ 先要原型，再按「手感打磨」模板迭代。
              </div>
            </div>
          </div>
        )}
        {tab === 'art' && (
          <div className="wt-gd-studio">
            <div>
              <div className="wt-gd-sec">选目标画风（{ART_STYLES.length} 种）</div>
              <div className="wt-gd-cards" style={{ gridTemplateColumns: '1fr' }}>
                {ART_STYLES.map((s) => (
                  <div
                    key={s.id}
                    className={'wt-gd-style' + (s.id === artId ? ' wt-gd-styleOn' : '')}
                    role="button"
                    tabIndex={0}
                    onClick={() => setArtId(s.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setArtId(s.id) }}
                  >
                    <div className="wt-gd-cardHead">
                      <span className="wt-gd-cardName" style={{ fontSize: 13 }}>{s.name}</span>
                      <span className="wt-gd-cardAka">{s.aka}</span>
                    </div>
                    <Palette style={s} />
                    <div className="wt-gd-k">适合</div>
                    <div className="wt-gd-v" style={{ fontSize: 11 }}>{s.fit}</div>
                    <div className="wt-gd-actions">
                      <button type="button" className="wt-gd-btn" onClick={(e) => { e.stopPropagation(); doCopy(buildArtPrompt(s, { current: artCurrent, extra: artExtra }), s.name + ' 画风提示词') }}>
                        复制画风优化提示词
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div className="wt-gd-outBar">
                <span className="wt-gd-mono" style={{ fontSize: 11, color: '#d9c9ff' }}>{artStyle.name}</span>
                <button type="button" className={'wt-gd-btn' + (copied.indexOf('已复制') === 0 ? ' wt-gd-btn-ok' : '')} onClick={() => doCopy(artPrompt, '画风优化提示词')}>
                  {copied.indexOf('已复制') === 0 ? '✓ 已复制' : '一键复制提示词'}
                </button>
                <span className="wt-gd-count">{artPrompt.length} 字</span>
              </div>

              <div className="wt-gd-field">
                <span className="wt-gd-label">现状：粘贴你现在的代码（或描述当前画面），会原样写进提示词</span>
                <textarea
                  className="wt-gd-area"
                  rows={7}
                  placeholder={'例如：现在是一个黑底白字的方块消除，所有颜色硬编码在 draw() 里，没有任何阴影和动效……\n（也可以直接把整个 index.html 粘进来）'}
                  value={artCurrent}
                  onChange={(e) => setArtCurrent(e.target.value)}
                />
                <span className="wt-gd-count">
                  {artCurrent.length} 字{artCurrent.length > 6000 ? '（超过 6000 字的部分会被截断）' : ''}
                </span>
              </div>

              <div className="wt-gd-field">
                <span className="wt-gd-label">补充要求（可选）</span>
                <input className="wt-gd-input" placeholder="例如：保留现有的像素字体；不要用外发光" value={artExtra} onChange={(e) => setArtExtra(e.target.value)} />
              </div>

              <textarea className="wt-gd-out" readOnly value={artPrompt} onFocus={(e) => e.currentTarget.select()} />
              <div className="wt-gd-hint" style={{ marginTop: 6 }}>
                这份提示词只改视觉、不动玩法：先要「现状诊断 + 配色表」，再要完整代码，最后要一份改动清单。
              </div>
            </div>
          </div>
        )}
      </div>

      {copied && <div className="wt-gd-toast">{copied}</div>}
    </div>
  )
}
