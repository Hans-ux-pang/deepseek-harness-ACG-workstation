/**
 * dsh-worktable 构建：
 *   - lib/index.js    服务端 ESM（cordis 插件，健康路由）
 *   - lib/client.js   客户端单文件 CJS（window.__ModuleLoader__.load 握手；
 *                     react / @deepseek-ai/* 由宿主模块系统提供，保持 external）
 * esbuild 走 JS API；pdf.js worker 源码以字符串注入客户端 banner，
 * 运行时用 Blob URL 起 module worker（不依赖服务端路由，F5 即生效）。
 */
import { build } from 'esbuild'
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
mkdirSync(join(here, 'lib'), { recursive: true })
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'))
const pluginManifest = JSON.parse(readFileSync(join(here, 'dsh.plugin.json'), 'utf8'))
if (pluginManifest.version !== pkg.version) {
  throw new Error('dsh-worktable build: package.json version (' + pkg.version + ') != dsh.plugin.json version (' + pluginManifest.version + ') — 发版前先统一两处版本号')
}

const clientBanner = {
  js: "window.__ModuleLoader__.load({ id: 'dsh-worktable', factory: (require) => { var module = { exports: {} }; var exports = module.exports;",
}
const clientFooter = { js: 'return module.exports; } });' }

await build({
  entryPoints: [join(here, 'src/index.ts')],
  outfile: 'lib/index.js',
  bundle: true,
  sourcemap: 'external',
  logLevel: 'info',
  platform: 'node',
  define: { __WT_VERSION__: JSON.stringify(pkg.version) },
  format: 'esm',
  target: ['node22'],
  external: ['@deepseek-ai/*', 'node:*', 'ws', 'node-pty'],
  // 原生皮肤模板与地球海岸线数据都以文本嵌入服务端 bundle
  // （.topo 用 text loader 而不是 json：客户端拿到的是原样文本，JSON.stringify 会改动数字写法）
  loader: { '.css': 'text', '.html': 'text', '.topo': 'text' },
})

await build({
  entryPoints: [join(here, 'src/client/index.tsx')],
  outfile: 'lib/client.js',
  bundle: true,
  sourcemap: 'external',
  logLevel: 'info',
  platform: 'browser',
  format: 'cjs',
  target: ['es2022'],
  jsx: 'automatic',
  external: ['@deepseek-ai/*', 'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'scheduler'],
  loader: { '.css': 'text' }, // xterm.css 以文本内联进样式串（宿主不加载独立 css 文件）
  banner: clientBanner,
  footer: clientFooter,
  // 客户端自报版本（随 package.json version 走，发版即自动一致）+ 构建标记
  // （诊断信标据此判断浏览器里跑的是哪一次构建：分辨「改了没生效」与「真的坏了」）
  define: { __WT_VERSION__: JSON.stringify(pkg.version), __WT_BUILD__: JSON.stringify(new Date().toISOString()) },
})

console.log('[dsh-worktable build] done: lib/index.js, lib/client.js')
