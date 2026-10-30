import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { CatbusError } from '../../../core/errors.js'
import type { Cookie } from '../../../core/schemas.js'
import * as rand from '../../../core/rand.js'
import { type BgChallenge, runBotGuard } from './botguard.js'

/**
 * 无头 Chromium，只用来在 Studio 页面里计算 BotGuard（见 botguard.ts）。
 * 只用 Node 内置模块：Chromium 自己不随 catbus 安装，用户指定或 Playwright 装好的（AGENTS 5.7）。
 */

// ================================================================ 找浏览器

/** Playwright 装好的 Chromium 在缓存目录里的相对路径（Chrome for Testing 与旧的 Chromium 两种）。 */
const BINARIES: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ['chrome-mac-arm64', 'chrome-mac-x64', 'chrome-mac'].flatMap((d) => [
    `${d}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${d}/Chromium.app/Contents/MacOS/Chromium`,
  ]),
  linux: ['chrome-linux64/chrome', 'chrome-linux/chrome'],
  win32: ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe'],
}

export interface ChromeLookup {
  /** `catbus config set youtube.browser <路径>` 的值。 */
  configured?: string | null
  platform?: NodeJS.Platform
  home?: string
  env?: NodeJS.ProcessEnv
}

/**
 * 浏览器路径的发现顺序：config.toml 的 youtube.browser → 环境变量 CATBUS_YOUTUBE_BROWSER → Playwright 缓存里最新的 chromium-<版本>。
 * 不扫描系统里的 Google Chrome：它是用户日常在用的浏览器，catbus 不占用它。
 */
export function findChrome(opts: ChromeLookup = {}): string {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  const explicit = opts.configured || env.CATBUS_YOUTUBE_BROWSER
  if (explicit) {
    if (!isFile(explicit)) {
      throw new CatbusError('ERROR', `找不到配置的浏览器：${explicit}`, { hint: '检查 catbus config get youtube.browser，或重新设置' })
    }
    return explicit
  }
  for (const root of playwrightRoots(platform, home, env)) {
    for (const dir of chromiumDirs(root)) {
      for (const rel of BINARIES[platform] ?? []) {
        const p = join(root, dir, rel)
        if (isFile(p)) return p
      }
    }
  }
  throw new CatbusError('ERROR', '找不到 Chromium：YouTube 的 item publish / delete 需要它计算 Studio 的 BotGuard 校验', {
    hint: '安装：npx playwright install chromium；或指定已有的 Chromium：catbus config set youtube.browser <路径>',
  })
}

function playwrightRoots(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = []
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0') roots.push(env.PLAYWRIGHT_BROWSERS_PATH)
  if (platform === 'darwin') roots.push(join(home, 'Library', 'Caches', 'ms-playwright'))
  else if (platform === 'win32') roots.push(join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'ms-playwright'))
  else roots.push(join(home, '.cache', 'ms-playwright'))
  return roots
}

/** 缓存里的 chromium-<版本> 目录，新版本在前（不含 chromium_headless_shell-*：它过不了 Studio 的浏览器检查）。 */
function chromiumDirs(root: string): string[] {
  try {
    return readdirSync(root)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.slice('chromium-'.length)) - Number(a.slice('chromium-'.length)))
  } catch {
    return []
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

// ================================================================ 会话

export interface BrowserCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number | null
}

export interface OpenOptions {
  executable: string
  /** 打开后先访问的地址（Studio 页面）。 */
  url: string
  proxy: string | null
  /** 浏览器的 User-Agent：与 Node 侧请求一致，不带 HeadlessChrome。 */
  ua: string
  cookies: Cookie[]
}

export interface AttestRequest {
  bg: BgChallenge
  binding: unknown
  /** interpreter 的 JS 源码，已由 Node 取回；页面里还没有时求值一次。 */
  interpreter: string
  fallbackGlobal: string
}

export interface BrowserSession {
  /** 打开 Studio 后的地址；跳到 accounts.google.com 说明登录态已失效。 */
  readonly url: string
  attest(req: AttestRequest): Promise<string>
  /** 浏览器里 youtube.com 的 cookie（包括 Google 轮换后的值）。 */
  cookies(): Promise<BrowserCookie[]>
  close(): Promise<void>
}

/** 测试时替换这个对象的 open。 */
export const browser = {
  open: openBrowser,
}

/** Google 的 HttpOnly cookie 名单：凭证里不记录这个标记，注入时按名字还原。 */
const HTTP_ONLY = new Set([
  'SID', 'HSID', 'SSID', 'LOGIN_INFO', 'YSC',
  '__Secure-1PSID', '__Secure-3PSID', '__Secure-1PSIDTS', '__Secure-3PSIDTS', '__Secure-YNID',
  '__Secure-ROLLOUT_TOKEN', '__Secure-1PSIDCC', '__Secure-3PSIDCC',
])

const PAGE_WAIT_MS = 30_000
const LAUNCH_WAIT_MS = 20_000

async function openBrowser(o: OpenOptions): Promise<BrowserSession> {
  const dir = await mkdtemp(join(tmpdir(), 'catbus-chromium-'))
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${dir}`,
    `--user-agent=${o.ua}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,900',
  ]
  if (o.proxy) args.push(`--proxy-server=${chromeProxy(o.proxy)}`)
  // 以 root 运行（如 Docker）时 Chromium 必须关掉沙箱
  if (process.platform === 'linux' && process.getuid?.() === 0) args.push('--no-sandbox')
  args.push('about:blank')

  const proc = spawn(o.executable, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let exited = false
  let stderr = ''
  proc.on('exit', () => {
    exited = true
  })
  proc.stderr?.on('data', (d) => {
    if (stderr.length < 2000) stderr += String(d)
  })

  let cdp: Cdp | null = null
  const close = async () => {
    cdp?.close()
    if (!exited) proc.kill()
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {})
  }
  try {
    const port = await waitForPort(dir, () => exited, LAUNCH_WAIT_MS, stderr)
    cdp = await Cdp.connect(await pageWebSocket(port))
    await cdp.send('Page.enable')
    await cdp.send('Network.enable')
    for (const c of o.cookies) await cdp.send('Network.setCookie', cookieParams(c)).catch(() => {})
    // 打开页面是只读的，经代理偶发 TLS 断开时可以再试
    let nav: { errorText?: string } = {}
    for (let attempt = 1; ; attempt++) {
      nav = await cdp.send('Page.navigate', { url: o.url })
      if (!nav.errorText || attempt >= 3) break
      await rand.sleep(1000 * attempt)
    }
    if (nav.errorText) throw new CatbusError('NETWORK', `浏览器打开 YouTube Studio 失败：${nav.errorText}`, { hint: '检查代理：catbus config get proxy' })
    const url = await waitForLoad(cdp)
    return {
      url,
      attest: (req) => attest(cdp!, req),
      cookies: async () => {
        const { cookies } = await cdp!.send('Network.getAllCookies')
        return cookies
          .filter((c: any) => String(c.domain).endsWith('youtube.com'))
          .map((c: any) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires > 0 ? c.expires : null }))
      },
      close,
    }
  } catch (err) {
    await close()
    throw err
  }
}

async function attest(cdp: Cdp, req: AttestRequest): Promise<string> {
  const name = req.bg.globalName || req.fallbackGlobal
  const loaded = `!!(globalThis[${JSON.stringify(name)}] && typeof globalThis[${JSON.stringify(name)}].a === 'function')`
  if (!(await cdp.evaluate(loaded))) {
    // Studio 页面开了 Trusted Types，<script src> 注入不了，所以用 Runtime.evaluate 在页面全局求值
    const res = await cdp.send('Runtime.evaluate', { expression: req.interpreter, returnByValue: true }, 120_000)
    if (res.exceptionDetails) {
      throw new CatbusError('UPSTREAM', `BotGuard interpreter 求值失败：${String(res.exceptionDetails.exception?.description ?? '').split('\n')[0]}`)
    }
    if (!(await cdp.evaluate(loaded))) throw new CatbusError('UPSTREAM', `BotGuard interpreter 没有定义全局对象 ${name}`)
  }
  const expression = `(${runBotGuard.toString()})(${JSON.stringify(req.bg)}, ${JSON.stringify(req.binding)}, ${PAGE_WAIT_MS}, ${JSON.stringify(req.fallbackGlobal)})`
  let web: unknown
  try {
    web = await cdp.evaluate(expression, PAGE_WAIT_MS + 30_000)
  } catch (err) {
    throw new CatbusError('UPSTREAM', `BotGuard 在浏览器里失败：${(err as Error).message}`, { hint: '稍后重试；反复失败时换一个代理出口' })
  }
  if (typeof web !== 'string' || !web) throw new CatbusError('UPSTREAM', 'BotGuard 没有返回校验结果')
  return web
}

/**
 * 等页面有了 body 且地址已经是 https（跳转完成）。不等 readyState 为 complete：Studio 一直在加载资源，
 * 原型实测时 readyState 长时间停在 loading，但页面的 ytcfg 与 bundle 已经可用。
 */
async function waitForLoad(cdp: Cdp): Promise<string> {
  const deadline = rand.now() + PAGE_WAIT_MS
  while (rand.now() < deadline) {
    try {
      const st = await cdp.evaluate(`({ href: location.href, hasBody: !!document.body })`)
      if (st.hasBody && /^https:\/\//.test(st.href)) return st.href
    } catch {
      // 页面还在跳转时执行上下文会被销毁，继续等
    }
    await rand.sleep(300)
  }
  throw new CatbusError('UPSTREAM', 'YouTube Studio 页面加载超时', { hint: '检查代理，或稍后重试' })
}

async function waitForPort(dir: string, exited: () => boolean, ms: number, stderr: string): Promise<number> {
  const deadline = rand.now() + ms
  const file = join(dir, 'DevToolsActivePort')
  while (rand.now() < deadline) {
    if (exited()) break
    try {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0])
      if (port > 0) return port
    } catch {
      // 文件还没写出来
    }
    await rand.sleep(100)
  }
  throw new CatbusError('ERROR', `浏览器没有启动（CDP 端口未就绪）：${stderr.slice(0, 300).trim() || '无输出'}`, {
    hint: '确认 youtube.browser 指向的是可以运行的 Chromium',
  })
}

async function pageWebSocket(port: number): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[]
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      // 端口还没接受连接
    }
    await rand.sleep(200)
  }
  throw new CatbusError('ERROR', '浏览器没有可用的页面')
}

/** Chromium 的 --proxy-server 不认 socks5h，按 socks5 处理（DNS 在本机解析）。 */
function chromeProxy(proxy: string): string {
  const u = new URL(proxy)
  const scheme = u.protocol === 'socks5h:' ? 'socks5' : u.protocol.slice(0, -1)
  return `${scheme}://${u.host}`
}

function cookieParams(c: Cookie): Record<string, unknown> {
  const p: Record<string, unknown> = {
    name: c.name,
    value: c.value,
    path: c.path || '/',
    secure: true,
    sameSite: 'None',
    httpOnly: HTTP_ONLY.has(c.name),
  }
  // __Host- 前缀的 cookie 不能带 domain，只能用 url
  if (c.name.startsWith('__Host-')) p.url = 'https://www.youtube.com/'
  else p.domain = c.domain
  if (c.expires) p.expires = c.expires
  return p
}

// ================================================================ CDP

type WsLike = {
  send(data: string): void
  close(): void
  addEventListener(type: string, fn: (ev: any) => void, opts?: { once?: boolean }): void
}

/** Node 22 自带的 WebSocket（全局对象；类型定义里没有，这里手动声明）。 */
const WebSocketCtor = (globalThis as unknown as { WebSocket: new (url: string) => WsLike }).WebSocket

/** 与一个页面的 CDP 连接：一次只发一个命令也没问题，这里每个请求用 id 对应回包。 */
class Cdp {
  private nextId = 0
  private readonly pending = new Map<number, { method: string; res: (v: any) => void; rej: (e: Error) => void; timer: NodeJS.Timeout }>()

  private constructor(private readonly ws: WsLike) {}

  static connect(url: string): Promise<Cdp> {
    const ws = new WebSocketCtor(url)
    const cdp = new Cdp(ws)
    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(cdp), { once: true })
      ws.addEventListener('error', () => reject(new CatbusError('ERROR', '连接浏览器的调试端口失败')), { once: true })
      ws.addEventListener('message', (ev) => cdp.onMessage(String(ev.data)))
    })
  }

  private onMessage(data: string): void {
    const m = JSON.parse(data)
    const p = m.id != null ? this.pending.get(m.id) : undefined
    if (!p) return
    this.pending.delete(m.id)
    clearTimeout(p.timer)
    if (m.error) p.rej(new Error(`${p.method}: ${m.error.message}`))
    else p.res(m.result)
  }

  send(method: string, params: Record<string, unknown> = {}, timeout = 60_000): Promise<any> {
    const id = ++this.nextId
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        rej(new Error(`${method} timed out`))
      }, timeout)
      this.pending.set(id, { method, res, rej, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** 在页面里求值，返回值按 JSON 取回；页面抛出的异常转成 Error。 */
  async evaluate(expression: string, timeout = 60_000): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout)
    if (r.exceptionDetails) {
      throw new Error(String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'page exception').split('\n')[0])
    }
    return r.result.value
  }

  close(): void {
    this.ws.close()
  }
}
