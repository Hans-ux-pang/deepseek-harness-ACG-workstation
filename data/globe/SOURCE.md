# 地球旅行窗格的内置数据

这两个文件在构建期被 esbuild 内联进 `lib/index.js`，运行时不联网。

| 文件 | 内容 | 来源 |
|---|---|---|
| `land-110m.topo` | Natural Earth 110m 陆地边界（TopoJSON，55,207 字符） | `world-atlas@2/land-110m.json`（npm 包 world-atlas，数据为 Natural Earth，公有领域） |
| `places-trim.json` | 1251 个真实城市点，每行 `[名称, 中文国名, 国旗, 纬度, 经度, 人口文本, 分级]`（61,459 字符） | `ne_50m_populated_places_simple.geojson`（Natural Earth，公有领域），由 `trimPlaces()` 裁剪 |

## 为什么内置

这两份数据是静态的，而 CDN 不一定可达 —— 实测在部分网络环境下，
宿主进程里 `fetch('https://cdn.jsdelivr.net/...')` 直接 `TypeError: fetch failed`，
后果是真实海岸线退化成手绘轮廓、1251 个城市点整批消失（只剩内置 347 个精选点位）。
内联进 bundle 后完全离线可用，也省掉一次上游往返。

## 如何再生成

```bash
# 1) 先用当前代码构建一次（需要 lib/index.js 里的 __wtTrimPlaces）
cd 01_content && node build.mjs
# 2) 复制海岸线 + 用构建产物里的 trimPlaces 重算城市目录
node ../旅行工作台/globe-plugin/gen-globe-data.mjs   # 路径按实际存放位置调整
# 3) 再构建一次，让新数据进入 bundle
cd 01_content && node build.mjs
```

`places-trim.json` 必须由构建产物里的 `trimPlaces` 生成，而不是另抄一份逻辑：
`check-worktable-host.mjs` 会断言「内置数据 == trimPlaces(真实数据集)」，
两边一旦漂移就会失败。
