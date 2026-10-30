import { CatbusError } from '../../../core/errors.js'
import { type HeaderPairs, parseJson } from '../../../core/http.js'
import { authError } from '../../../core/toolkit.js'
import { STUDIO_ORIGIN, type YtClient } from './client.js'

/**
 * YouTube Studio（studio.youtube.com）的接口：自己的视频列表。
 * 上传（upload/createvideo）和删除（video/delete）要在 context.request.attestationResponseData 里带网页端 BotGuard 跑出的
 * 校验结果，catbus 还生成不了（2026-10-30 实测：不带时回 200、只有 responseContext），所以没有实现。
 * Studio 页面用的是 WEB_CREATOR 客户端（clientName 62），版本号、API key 与频道 ID 都从 Studio 首页的 ytcfg 取；
 * 签名与 www 相同，只是 SAPISIDHASH 里的 origin 换成 Studio 的域名。
 */

interface StudioConfig {
  clientVersion: string
  apiKey: string
  channelId: string
}

/** Studio 首页的 ytcfg。没登录时首页会跳到 Google 登录页，取不到配置。 */
export async function studioConfig(c: YtClient): Promise<StudioConfig> {
  const res = await c.http.request({ url: `${STUDIO_ORIGIN}/`, headers: c.pageHeaders() })
  await c.check(res, 'studio')
  const html = await res.text()
  const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1]
  const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1]
  const channelId = html.match(/"CHANNEL_ID":"(UC[^"]+)"/)?.[1]
  if (!clientVersion || !apiKey) {
    if (/accounts\.google\.com/.test(res.url) || /ServiceLogin/.test(html)) throw authError(c.ctx, 'YouTube Studio 要求登录：登录态已失效，请重新导出 cookie 登录')
    throw new CatbusError('UPSTREAM', 'YouTube Studio 首页里没有找到 ytcfg', { hint: '页面结构可能已变更', detail: { status: res.status, url: res.url } })
  }
  if (!channelId) throw new CatbusError('UPSTREAM', '这个账号还没有 YouTube 频道', { hint: '在 youtube.com 上先创建频道，才能上传视频' })
  return { clientVersion, apiKey, channelId }
}

/** Studio 的 InnerTube 请求：`POST studio.youtube.com/youtubei/v1/<path>`，带频道的 delegationContext。 */
export async function studio<T = any>(c: YtClient, cfg: StudioConfig, path: string, body: Record<string, unknown>): Promise<T> {
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
    ['Origin', STUDIO_ORIGIN],
    ['Referer', `${STUDIO_ORIGIN}/`],
  ]
  const delegationContext = { externalChannelId: cfg.channelId, roleType: { channelRoleType: 'CREATOR_CHANNEL_ROLE_TYPE_OWNER' } }
  const context = {
    client: { clientName: 62, clientVersion: cfg.clientVersion, hl: 'en', gl: 'US' },
    request: { returnLogEntry: true, internalExperimentFlags: [] },
    user: { delegationContext },
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
