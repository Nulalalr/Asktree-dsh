/**
 * 构建客户端 bundle：把 `src/client.ts` 打成 DSH 要求的模块信封。
 *
 * DSH 的客户端模块必须形如（见 `dsh-client-ui-cordis/lib/client.js`）：
 *
 *   window.__ModuleLoader__.load({
 *     id: "<package name>",
 *     factory: (require) => {
 *       var module = { exports: {} }; var exports = module.exports;
 *       ...bundle...            // 只能 require 平台表里的 external（react 等）
 *       return module.exports;
 *     }
 *   });
 *
 * 该信封由 DSH monorepo 内部的 `clientBundle()` helper 生成，**未随包发布**，
 * 所以这里用 esbuild 自行拼装（`window.__ModuleLoader__` 是宿主页面提供的全局）。
 *
 * 用法：`node scripts/build-client.mjs`（已挂在 `npm run build` 里）
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 平台冻结的外部模块表（见 dsh-web-frontend 的模块解析表） */
const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const outDir = join(root, 'lib')
const tmpFile = join(outDir, '.client.bundle.cjs')

mkdirSync(outDir, { recursive: true })

await build({
  absWorkingDir: root,
  entryPoints: [join(root, 'src', 'client.ts')],
  outfile: tmpFile,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  external: PLATFORM_EXTERNALS,
  legalComments: 'none',
  logLevel: 'warning',
})

const bundle = readFileSync(tmpFile, 'utf8')
const wrapped =
  'window.__ModuleLoader__.load({\n' +
  `\tid: ${JSON.stringify(pkg.name)},\n` +
  '\tfactory: (require) => {\n' +
  '\t\tvar module = { exports: {} };\n' +
  '\t\tvar exports = module.exports;\n' +
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n' +
  bundle.replace(/^/gm, '\t\t') +
  '\t\treturn module.exports;\n' +
  '\t}\n' +
  '});\n'

writeFileSync(join(outDir, 'client.js'), wrapped)
rmSync(tmpFile, { force: true })

const sizeKb = (Buffer.byteLength(wrapped) / 1024).toFixed(1)
console.log(`[asktree] 已生成 lib/client.js（${sizeKb} KB，id=${pkg.name}）`)
