import { getConfig } from '../../../core/config.js'
import type { CookieJar } from '../../../core/cookies.js'
import { CatbusError } from '../../../core/errors.js'
import { readMedia } from '../../../core/files.js'
import { HttpClient } from '../../../core/http.js'
import * as n from '../../../core/normalize.js'
import * as rand from '../../../core/rand.js'
import type { HandlerContext } from '../../../core/registry.js'
import { authError } from '../../../core/toolkit.js'
import { type BgChallenge } from './botguard.js'
import { type BrowserCookie, type BrowserSession, browser, findChrome } from './browser.js'
import { STUDIO_ORIGIN, type YtClient, yt } from './client.js'
import * as norm from './normalize.js'
import { videoId } from './resolve.js'
import { dataUri, type StudioConfig, studio, studioConfig, uploadVideo } from './studio.js'

/**
 * YouTube Studio 的写操作：建视频（item publish）与删视频（item delete）。
 *
 * Studio 的写请求要在 context.request 里带两样东西（AGENTS 5.7）：
 * - sessionInfo.token：att/get → BotGuard → att/esr 换来的会话令牌（必要时再走 reauth）；
 * - attestationResponseData：建视频时，上传完成后对 UNBOUND 挑战再算一次 BotGuard。
 * BotGuard 只在无头 Chromium 的 Studio 页面里算（browser.ts）；其余请求全部由 Node 发出。
 * 重试规则：会话请求（att/get、att/esr、reauth、ars/grst）和 metadata_update 在网络出错时再试一次；
 * 建视频、上传、删除不重试，因为请求可能已经生效。
 */

type Ctx = HandlerContext

/** 可见范围：Studio 的 privacy 取值。 */
const PRIVACY = { public: 'PUBLIC', private: 'PRIVATE' } as const

/** 定时发布：先建成私享，到点由 YouTube 转公开。返回 Unix 秒。 */
function scheduleSec(iso: string): number {
  const sec = Math.floor(Date.parse(iso) / 1000)
  if (!(sec * 1000 > rand.now())) throw new CatbusError('USAGE', `定时发布的时间已经过去：${iso}`, { hint: '给一个将来的时间，例如 2026-11-01T20:00:00+08:00' })
  return sec
}

/** 找浏览器：config.toml 的 youtube.browser、环境变量、Playwright 缓存。 */
async function locateChrome(): Promise<string> {
  const configured = await getConfig(['youtube', 'browser'])
  return findChrome({ configured: typeof configured === 'string' ? configured : null })
}

/**
 * 一次写操作：打开 Studio 页面（带上当前账号的 cookie），交给 fn 使用，结束时把浏览器里轮换过的 cookie 写回凭证。
 * 浏览器只负责 BotGuard；fn 里的请求由 Node 发出。
 */
async function withBrowser<T>(c: YtClient, cfg: StudioConfig, executable: string, fn: (a: Attestor) => Promise<T>): Promise<T> {
  const jar = c.jar
  const injected = new Map(jar.cookies.map((k) => [cookieKey(k), k.value]))
  const bw = await browser.open({
    executable,
    url: `${STUDIO_ORIGIN}/channel/${cfg.channelId}/videos/upload?d=ud`,
    proxy: c.ctx.config.proxy,
    ua: c.ua,
    cookies: jar.cookies,
  })
  try {
    if (/accounts\.google\./.test(bw.url)) throw authError(c.ctx, 'YouTube Studio 要求登录：登录态已失效')
    return await fn(new Attestor(c, cfg, bw))
  } finally {
    const fresh = await bw.cookies().catch(() => [] as BrowserCookie[])
    const synced = syncCookies(jar, injected, fresh)
    if (synced) c.ctx.log.info(`已把浏览器轮换的 ${synced} 个 cookie 写回凭证`)
    await bw.close()
  }
}

export function cookieKey(c: { name: string; domain: string; path: string }): string {
  return `${c.name}|${c.domain}|${c.path}`
}

/**
 * 只写回浏览器自己改过的 cookie（值与注入时不同）。Node 侧请求已经通过 Set-Cookie 更新过的值不能被旧值覆盖。
 * 返回写回的个数。
 */
export function syncCookies(jar: CookieJar, injected: Map<string, string>, fresh: BrowserCookie[]): number {
  let n = 0
  const byKey = new Map(fresh.map((f) => [cookieKey(f), f.value]))
  for (const c of jar.cookies) {
    const key = cookieKey(c)
    const value = byKey.get(key)
    if (value != null && value !== injected.get(key) && value !== c.value) {
      c.value = value
      n++
    }
  }
  return n
}

/** 一个写操作内的 BotGuard 与会话。 */
class Attestor {
  private readonly interpreters = new Map<string, Promise<string>>()

  constructor(
    private readonly c: YtClient,
    private readonly cfg: StudioConfig,
    private readonly bw: BrowserSession,
  ) {}

  /**
   * 会话相关的 Studio 请求（att/get、att/esr、reauth、ars/grst）只换取校验与令牌，不改动账号数据，
   * 网络出错（代理偶发断开）时再试一次。建视频、删除、metadata_update 不走这里。
   */
  private call<T = any>(path: string, body: Record<string, unknown>, requestExtra: Record<string, unknown> = {}): Promise<T> {
    const once = () => studio<T>(this.c, this.cfg, path, body, requestExtra)
    return once().catch(async (err) => {
      if (!(err instanceof CatbusError && err.code === 'NETWORK')) throw err
      this.c.ctx.log.warn(`网络出错，重试一次：${err.message}`)
      await rand.sleep(1000)
      return once()
    })
  }

  /** att/get：返回 challenge 与 bgChallenge。 */
  private async challenge(engagement: Record<string, unknown>): Promise<{ challenge: string; bg: BgChallenge }> {
    const j = await this.call<any>('att/get', engagement)
    const bg = j.bgChallenge ?? j.botguardData
    if (!j.challenge || !bg) {
      throw new CatbusError('UPSTREAM', 'YouTube Studio 没有返回 BotGuard 挑战（att/get）', { hint: '页面结构可能已变更', detail: { keys: Object.keys(j ?? {}) } })
    }
    return { challenge: j.challenge, bg }
  }

  /** 在浏览器里算一次 BotGuard，返回 webResponse。interpreter 由 Node 取回，每个 URL 只取一次。 */
  private async run(bg: BgChallenge, binding: unknown): Promise<string> {
    const interpreter = await this.interpreter(bg)
    return this.bw.attest({ bg, binding, interpreter, fallbackGlobal: 'trayride' })
  }

  private interpreter(bg: BgChallenge): Promise<string> {
    const url = unwrap(bg.interpreterUrl, 'privateDoNotAccessOrElseTrustedResourceUrlWrappedValue') ?? unwrap(bg.interpreterSafeUrl, 'privateDoNotAccessOrElseTrustedResourceUrlWrappedValue')
    if (url) {
      const full = url.startsWith('//') ? `https:${url}` : url
      let p = this.interpreters.get(full)
      if (!p) {
        p = this.fetchText(full)
        this.interpreters.set(full, p)
      }
      return p
    }
    const inline = unwrap(bg.interpreterSafeScript, 'privateDoNotAccessOrElseSafeScriptWrappedValue') ?? (typeof bg.interpreterScript === 'string' ? bg.interpreterScript : null)
    if (inline) return Promise.resolve(inline)
    return Promise.reject(new CatbusError('UPSTREAM', 'BotGuard 挑战里没有 interpreter', { hint: '页面结构可能已变更' }))
  }

  /** interpreter 是 Google 的静态脚本，不带 cookie，走没有 cookie 罐的客户端。 */
  private async fetchText(url: string): Promise<string> {
    const http = new HttpClient({ browser: 'chrome_149', os: 'windows', proxy: this.c.ctx.config.proxy, timeout: this.c.ctx.config.timeout, log: this.c.ctx.log })
    const req = { url, headers: [['User-Agent', this.c.ua], ['Accept', '*/*']] as [string, string][] }
    const res = await http.request(req).catch(async (err) => {
      if (!(err instanceof CatbusError && err.code === 'NETWORK')) throw err
      await rand.sleep(1000)
      return http.request(req)
    })
    await this.c.check(res, 'botguard')
    return res.text()
  }

  /** 会话令牌：att/get（CREATOR_STUDIO_ACTION）→ BotGuard → att/esr；esr 要求 reauth 时再走 reauth 与 ars/grst。 */
  async sessionToken(): Promise<string> {
    const { challenge, bg } = await this.challenge({ engagementType: 'ENGAGEMENT_TYPE_CREATOR_STUDIO_ACTION', ids: [{ externalChannelId: this.cfg.channelId }] })
    const web = await this.run(bg, { atr_challenge: challenge })
    const esr = await this.call<any>('att/esr', { challenge, botguardResponse: web, xguardClientStatus: 0 })
    let token: string | undefined = esr.sessionToken ?? undefined
    if (esr.shouldFetchReauthSessionToken) {
      const rr = await this.call<any>('security/get_web_reauth_url', {
        continueUrl: `${STUDIO_ORIGIN}/reauth`,
        flow: 'REAUTH_FLOW_YT_STUDIO_COLD_LOAD',
        ivctx: esr.ctx,
        challenge,
        botguardResponse: web,
      })
      if (!rr.encodedReauthProofToken) {
        throw new CatbusError('RISK_CONTROL', 'YouTube 没有接受这次 BotGuard 校验（reauth 被拒绝）', {
          hint: '稍后重试，或换一个代理出口；仍然失败时到 https://studio.youtube.com 上传',
          detail: { kind: 'blocked', keys: Object.keys(rr ?? {}) },
        })
      }
      const granted = await this.call<any>('ars/grst', { ctx: rr.sessionRiskCtx }, { reauthRequestInfo: { encodedReauthProofToken: rr.encodedReauthProofToken } })
      token = granted.sessionToken
    }
    if (!token) {
      throw new CatbusError('RISK_CONTROL', 'YouTube Studio 没有发放会话令牌（sessionToken）', {
        hint: '稍后重试，或换一个代理出口',
        detail: { kind: 'blocked', keys: Object.keys(esr ?? {}) },
      })
    }
    return token
  }

  /** 建视频前的校验：上传完成后，对 UNBOUND 挑战加上 scottyResourceId 再算一次 BotGuard。 */
  async uploadAttestation(scottyResourceId: string): Promise<{ challenge: string; webResponse: string }> {
    const { challenge, bg } = await this.challenge({ engagementType: 'ENGAGEMENT_TYPE_UNBOUND' })
    const webResponse = await this.run(bg, { c: challenge, e: 'ENGAGEMENT_TYPE_VIDEO_UPLOAD', scottyResourceId })
    return { challenge, webResponse }
  }
}

/** 从 trusted-types 包装对象里取出原始值。 */
function unwrap(v: unknown, key: string): string | null {
  const inner = (v as Record<string, unknown> | null | undefined)?.[key]
  return typeof inner === 'string' && inner ? inner : null
}

/** 发布视频：读取文件 → 上传 → 建视频（标题、简介、可见范围、校验）→ 有标签、封面或定时发布时再 metadata_update。 */
export async function publishVideo(ctx: Ctx) {
  const c = yt(ctx)
  if (!c.loggedIn) throw authError(ctx, '发布视频需要登录')
  const o = ctx.options as Record<string, any>
  if (!o.video) throw new CatbusError('USAGE', 'YouTube 发布需要 --video', { hint: 'catbus youtube item publish --video <文件> --title <标题>' })
  if (!o.title) throw new CatbusError('USAGE', 'YouTube 发布需要 --title')
  const schedule: number | null = o.schedule ? scheduleSec(o.schedule) : null
  // 先确认能找到浏览器，再上传，避免上传完了才发现没法建视频
  const executable = await locateChrome()
  const cfg = await studioConfig(c)
  const video = await readMedia(c.http, o.video)
  const cover = o.cover ? await readMedia(c.http, o.cover) : null
  const privacy = schedule != null ? 'PRIVATE' : PRIVACY[o.visibility as keyof typeof PRIVACY]
  const uploaded = await uploadVideo(c, video)

  const id = await withBrowser(c, cfg, executable, async (a) => {
    const token = await a.sessionToken()
    const att = await a.uploadAttestation(uploaded.scottyResourceId)
    const created = await studio<any>(
      c,
      cfg,
      'upload/createvideo',
      {
        channelId: cfg.channelId,
        resourceId: { scottyResourceId: { id: uploaded.scottyResourceId } },
        frontendUploadId: uploaded.frontendUploadId,
        initialMetadata: {
          title: { newTitle: o.title },
          privacy: { newPrivacy: privacy },
          draftState: { isDraft: false },
          ...(o.text ? { description: { newDescription: o.text, shouldSegment: true } } : {}),
        },
        contentLevelProtection: { enableRequiresContentLevelProtection: false },
        presumedShort: false,
      },
      { attestationResponseData: { challenge: att.challenge, webResponse: att.webResponse }, sessionInfo: { token } },
    )
    const videoIdNew: string | undefined = created?.videoId
    // 没有建成时不重试：这次请求可能已经建了视频，重试会得到重复的草稿
    if (!videoIdNew) throw createRejected(created, uploaded.scottyResourceId)

    const update: Record<string, unknown> = {}
    if (o.tag?.length) update.tags = { newTags: o.tag }
    if (cover) update.videoStill = { operation: 'UPLOAD_CUSTOM_THUMBNAIL', image: { dataUri: dataUri(cover.data, cover.contentType) } }
    if (schedule != null) update.scheduledPublishing = { set: { privacy: 'PUBLIC', timeSec: String(schedule) } }
    if (Object.keys(update).length) await setMetadata(c, cfg, token, videoIdNew, update)
    return videoIdNew
  })

  return n.item({
    id,
    kind: 'video',
    url: norm.videoUrl(id),
    title: o.title,
    text: o.text ?? null,
    author: norm.channelUser(cfg.channelId, null),
    status: privacy === 'PUBLIC' ? 'reviewing' : 'private',
  })
}

/**
 * 视频已经建好之后设置标签、封面、定时发布（metadata_update）。同样的元数据设置两次结果不变，网络出错时再试一次。
 * 任何失败都带上视频 ID：此时视频已经存在，用户需要知道去哪里补设置或清理。
 */
async function setMetadata(c: YtClient, cfg: StudioConfig, token: string, id: string, update: Record<string, unknown>): Promise<void> {
  const send = () => studio<any>(c, cfg, 'video_manager/metadata_update', { encryptedVideoId: id, ...update }, { sessionInfo: { token } })
  const hint = `到 https://studio.youtube.com/video/${id}/edit 手动设置`
  let res: any
  try {
    res = await send().catch(async (err) => {
      if (!(err instanceof CatbusError && err.code === 'NETWORK')) throw err
      c.ctx.log.warn(`网络出错，重试一次：${err.message}`)
      await rand.sleep(1000)
      return send()
    })
  } catch (err) {
    const code = err instanceof CatbusError ? err.code : 'UPSTREAM'
    throw new CatbusError(code, `视频 ${id} 已建好，但标签 / 封面 / 定时发布没有设置成功：${(err as Error).message}`, { hint, detail: { id } })
  }
  const result: string | undefined = res?.overallResult?.resultCode
  if (result && result !== 'UPDATE_SUCCESS') {
    // 每个字段单独返回 success（实测：tags、videoStill、scheduledPublishing 各一个），失败的字段列出来
    const failed = Object.entries(FIELD_NAMES).filter(([k]) => res?.[k]?.success === false).map(([, v]) => v)
    const what = failed.length ? failed.join('、') : '标签 / 封面 / 定时发布'
    throw new CatbusError('UPSTREAM', `视频 ${id} 已建好，但${what}没有设置成功（YouTube 返回 ${result}）`, {
      hint: failed.includes('封面') ? `${hint}。未通过验证的账号可能不能上传自定义封面` : hint,
      detail: { id, failed, result: res.overallResult },
    })
  }
}

/** metadata_update 返回里的字段名 → 中文。 */
const FIELD_NAMES: Record<string, string> = { tags: '标签', videoStill: '封面', scheduledPublishing: '定时发布' }

/** 文本的 runs 拼成一串字。 */
const runsText = (t: any): string => (Array.isArray(t?.runs) ? t.runs.map((r: any) => r?.text ?? '').join('') : '')

/**
 * Studio 没有建成视频时的原因。上传被拒时（如当天上传数超限），返回里有 contents.uploadFeedbackItemRenderer，
 * 其中 uploadStatus 为 REJECTED；这种情况不是页面结构变了，要把 YouTube 给的原因报出来。
 */
function createRejected(created: any, scottyResourceId: string): CatbusError {
  for (const item of created?.contents?.uploadFeedbackItemRenderer?.contents ?? []) {
    const st = item?.uploadStatus
    if (st?.uploadStatus !== 'REJECTED') continue
    const reason = typeof st.uploadStatusReason === 'string' ? st.uploadStatusReason : null
    const text = [runsText(st.message), runsText(st.detailedMessage)].filter(Boolean).join('：')
    if (reason === 'UPLOAD_STATUS_REASON_RATE_LIMIT_EXCEEDED') {
      return new CatbusError('RISK_CONTROL', `YouTube 拒绝了这次上传：${text || reason}`, {
        hint: '这个账号的每日上传数已用完（未验证的账号限制更多）。到 YouTube 完成手机验证，或明天再试',
        detail: { kind: 'rate_limit', reason, scottyResourceId },
      })
    }
    return new CatbusError('UPSTREAM', `YouTube 拒绝了这次上传：${text || reason || '原因未知'}`, {
      hint: '到 https://studio.youtube.com 手动上传，看页面上的提示',
      detail: { reason, scottyResourceId },
    })
  }
  return new CatbusError('UPSTREAM', '视频文件已上传，但 YouTube Studio 没有建成视频', {
    hint: '到 https://studio.youtube.com 检查有没有新草稿，确认后再决定是否重新发布',
    detail: { keys: Object.keys(created ?? {}), scottyResourceId },
  })
}

/** 删除自己的视频。 */
export async function deleteVideo(ctx: Ctx) {
  const c = yt(ctx)
  if (!c.loggedIn) throw authError(ctx, '删除视频需要登录')
  const id = videoId(ctx.args.item!)
  const executable = await locateChrome()
  const cfg = await studioConfig(c)
  await withBrowser(c, cfg, executable, async (a) => {
    const token = await a.sessionToken()
    const res = await studio<any>(c, cfg, 'video/delete', { videoId: id }, { sessionInfo: { token } })
    if (res?.success !== true) {
      throw new CatbusError('UPSTREAM', `删除视频 ${id} 没有成功`, {
        hint: `到 https://studio.youtube.com/video/${id}/edit 确认是否还在`,
        detail: { keys: Object.keys(res ?? {}), message: res?.error?.message ?? null },
      })
    }
  })
  return { id }
}
