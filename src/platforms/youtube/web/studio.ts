import { CatbusError } from '../../../core/errors.js'
import { type HeaderPairs, parseJson } from '../../../core/http.js'
import * as rand from '../../../core/rand.js'
import { authError } from '../../../core/toolkit.js'
import { STUDIO_ORIGIN, type YtClient } from './client.js'

/**
 * YouTube Studio（studio.youtube.com）的接口。
 * Studio 页面用的是 WEB_CREATOR 客户端（clientName 62），版本号、API key、频道 ID 与 delegation context 都从 Studio 首页的 ytcfg 取；
 * 签名与 www 相同，只是 SAPISIDHASH 里的 origin 换成 Studio 的域名。
 * 写操作（建视频、删视频）还要在 context.request 里带 BotGuard 校验与 sessionInfo，见 publish.ts。
 */

const UPLOAD_URL = 'https://upload.youtube.com/upload/studio'
/** 分段上传每段的大小，取 upload 接口返回的粒度（chunk granularity）的整数倍。 */
const CHUNK_BYTES = 16 * 1024 * 1024

export interface StudioConfig {
  clientVersion: string
  apiKey: string
  channelId: string
  /** 首页 ytcfg 里的 INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT：Studio 请求要带上它，才是以频道身份操作。 */
  delegation: string | null
}

/** Studio 首页的 ytcfg。没登录时首页会跳到 Google 登录页，取不到配置。 */
export async function studioConfig(c: YtClient): Promise<StudioConfig> {
  const res = await c.http.request({ url: `${STUDIO_ORIGIN}/`, headers: c.pageHeaders() })
  await c.check(res, 'studio')
  const html = await res.text()
  const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1]
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1]
  const channelId = html.match(/"CHANNEL_ID":"(UC[^"]+)"/)?.[1]
  const delegation = html.match(/"INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT":"([^"]+)"/)?.[1] ?? null
  if (!clientVersion || !apiKey) {
    if (/accounts\.google\.com/.test(res.url) || /ServiceLogin/.test(html)) throw authError(c.ctx, 'YouTube Studio 要求登录：登录态已失效，请重新导出 cookie 登录')
    throw new CatbusError('UPSTREAM', 'YouTube Studio 首页里没有找到 ytcfg', { hint: '页面结构可能已变更', detail: { status: res.status, url: res.url } })
  }
  if (!channelId) throw new CatbusError('UPSTREAM', '这个账号还没有 YouTube 频道', { hint: '在 youtube.com 上先创建频道，才能上传视频' })
  return { clientVersion, apiKey, channelId, delegation }
}

/**
 * Studio 的 InnerTube 请求：`POST studio.youtube.com/youtubei/v1/<path>`，带频道的 delegationContext。
 * requestExtra 合并进 context.request（如 `{sessionInfo: {token}}`、`{attestationResponseData: {...}}`）。
 * 不自动重试：写操作可能已经生效。
 */
export async function studio<T = any>(c: YtClient, cfg: StudioConfig, path: string, body: Record<string, unknown>, requestExtra: Record<string, unknown> = {}): Promise<T> {
  const auth = c.authorization(STUDIO_ORIGIN)
  if (!auth) throw authError(c.ctx, '这个命令需要登录')
  const headers: HeaderPairs = [
    ['User-Agent', c.ua],
    ['Accept', '*/*'],
    ['Content-Type', 'application/json'],
    ['Authorization', auth],
    ['X-Goog-AuthUser', '0'],
    ['X-Origin', STUDIO_ORIGIN],
    ['X-Youtube-Client-Name', '62'],
    ['X-Youtube-Client-Version', cfg.clientVersion],
    ...(cfg.delegation ? [['X-Youtube-Delegation-Context', cfg.delegation] as [string, string]] : []),
    ['Origin', STUDIO_ORIGIN],
    ['Referer', `${STUDIO_ORIGIN}/`],
  ]
  const delegationContext = { externalChannelId: cfg.channelId, roleType: { channelRoleType: 'CREATOR_CHANNEL_ROLE_TYPE_OWNER' } }
  const context = {
    client: { clientName: 62, clientVersion: cfg.clientVersion, hl: 'en', gl: 'US' },
    request: { returnLogEntry: true, internalExperimentFlags: [], ...requestExtra },
    user: { delegationContext, ...(cfg.delegation ? { serializedDelegationContext: cfg.delegation } : {}) },
  }
  const res = await c.http.request({
    method: 'POST',
    url: `${STUDIO_ORIGIN}/youtubei/v1/${path}`,
    query: { alt: 'json', key: cfg.apiKey },
    headers,
    json: { ...body, context },
  })
  await c.check(res, `studio:${path}`)
  return parseJson<T>(res)
}

/**
 * 上传视频文件，返回 Studio 建视频要用的 frontendUploadId 与 scottyResourceId。
 * 先 start 拿到上传地址，再按段 upload，最后一段带 finalize；与 Studio 页面的上传对话框一致。
 */
export async function uploadVideo(c: YtClient, file: { data: Uint8Array; filename: string }): Promise<{ frontendUploadId: string; scottyResourceId: string }> {
  const data = file.data
  const frontendUploadId = `innertube_studio:${rand.uuid4().toUpperCase()}:0`
  const common: HeaderPairs = [
    ['User-Agent', c.ua],
    ['Accept', '*/*'],
    ['Content-Type', 'application/x-www-form-urlencoded;charset=utf-8'],
    ['Origin', STUDIO_ORIGIN],
    ['Referer', `${STUDIO_ORIGIN}/`],
  ]
  const start = await c.http.request({
    method: 'POST',
    url: UPLOAD_URL,
    query: { authuser: '0' },
    headers: [
      ...common,
      ['X-Goog-Upload-Command', 'start'],
      ['X-Goog-Upload-File-Name', file.filename],
      ['X-Goog-Upload-Protocol', 'resumable'],
      ['X-Goog-Upload-Header-Content-Length', String(data.length)],
    ],
    body: JSON.stringify({ frontendUploadId }),
  })
  const uploadUrl = start.headers.get('x-goog-upload-url')
  if (!start.ok || !uploadUrl) {
    if (start.status === 401) throw authError(c.ctx, '上传视频需要登录：登录态已失效')
    throw new CatbusError('UPSTREAM', `开始上传失败：HTTP ${start.status}`, { detail: { status: start.status, upload_status: start.headers.get('x-goog-upload-status') } })
  }
  const granularity = Number(start.headers.get('x-goog-upload-chunk-granularity')) || 262144
  const chunk = Math.max(granularity, Math.floor(CHUNK_BYTES / granularity) * granularity)
  let offset = 0
  for (;;) {
    const end = Math.min(offset + chunk, data.length)
    const last = end === data.length
    const res = await c.http.request({
      method: 'POST',
      url: uploadUrl,
      headers: [...common, ['X-Goog-Upload-Command', last ? 'upload, finalize' : 'upload'], ['X-Goog-Upload-Offset', String(offset)]],
      body: data.subarray(offset, end),
      timeout: 600,
    })
    if (!res.ok) throw new CatbusError('UPSTREAM', `上传视频失败：HTTP ${res.status}（已上传 ${offset} / ${data.length} 字节）`, { detail: { status: res.status, offset } })
    if (last) {
      const done = await parseJson<any>(res)
      const scottyResourceId = done?.scottyResourceId
      if (!scottyResourceId) throw new CatbusError('UPSTREAM', '上传完成，但返回里没有 scottyResourceId', { detail: { keys: Object.keys(done ?? {}) } })
      return { frontendUploadId, scottyResourceId }
    }
    c.ctx.log.info(`已上传 ${Math.round((end / data.length) * 100)}%`)
    offset = end
  }
}

/** 上传缩略图用的 data URL（Studio 的 videoStill 只收 data URL）。 */
export function dataUri(data: Uint8Array, contentType: string): string {
  return `data:${contentType};base64,${Buffer.from(data).toString('base64')}`
}
