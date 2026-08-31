import { logger } from '../core/logger'
import { truncate } from '../core/util'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36 Akansha/1.0'
const TIMEOUT = 15_000
const MAX_PAGE = 120_000

const PRIVATE =
  /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i

function assertPublicUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`"${raw}" is not a valid URL.`)
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http and https URLs can be fetched.')
  }
  if (PRIVATE.test(url.hostname)) {
    throw new Error(
      `${url.hostname} is a local or private address. Akansha only fetches public web pages; use the file or terminal tools for local services.`
    )
  }
  return url
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')

const toText = (html: string) =>
  decode(
    html
      .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()

async function get(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT)
  })
  if (!res.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${res.status}.`)
  const type = res.headers.get('content-type') ?? ''
  if (!/text\/|xml|json/.test(type)) {
    throw new Error(`${new URL(url).hostname} returned ${type || 'binary content'}, which Akansha cannot read as a page.`)
  }
  return res.text()
}

export const web = {
  /**
   * ponytail: results come from DuckDuckGo's no-JavaScript HTML endpoint and are
   * parsed with regexes -- no API key, no account, no cost. It is inherently
   * fragile to markup changes and is not a licensed search API; swap in Brave or
   * Tavily (both key-based JSON APIs) if search reliability starts to matter.
   */
  async search(query: string, limit = 6): Promise<{ title: string; url: string; snippet: string }[]> {
    const q = String(query ?? '').trim()
    if (!q) throw new Error('A search query is required.')
    const cap = Math.min(Math.max(Number(limit) || 6, 1), 20)
    const html = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`)

    const blocks = html.split(/class="result(?:s_links)?[^"]*"/).slice(1)
    const out: { title: string; url: string; snippet: string }[] = []
    for (const block of blocks) {
      const link = block.match(/<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
      if (!link) continue
      let href = decode(link[1] ?? '')
      // DDG wraps outbound links: /l/?uddg=<encoded target>
      const wrapped = href.match(/[?&]uddg=([^&]+)/)
      if (wrapped) href = decodeURIComponent(wrapped[1] ?? '')
      if (!href.startsWith('http')) continue
      const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/)
      out.push({
        title: toText(link[2] ?? '').slice(0, 200),
        url: href,
        snippet: toText(snippet?.[1] ?? '').slice(0, 400)
      })
      if (out.length >= cap) break
    }
    if (!out.length) {
      logger.warn('web.searchEmpty', { query: q.slice(0, 80) })
      throw new Error(
        'The search returned no parseable results. DuckDuckGo may have changed its HTML or rate-limited this machine; try again or open the page yourself.'
      )
    }
    return out
  },

  async fetchPage(url: string): Promise<{ url: string; title: string; text: string }> {
    const target = assertPublicUrl(url)
    const html = await get(target.toString())
    const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? target.hostname)
    return { url: target.toString(), title: title.slice(0, 300), text: truncate(toText(html), MAX_PAGE) }
  }
}
