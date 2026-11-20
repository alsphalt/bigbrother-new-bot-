'use strict'

const axios = require('axios')
const qs = require('querystring')
const crypto = require('crypto')
const https = require('https')
const fs = require('fs')
const path = require('path')

let distubeYtdl = null
let classicYtdl = null
try { distubeYtdl = require('@distube/ytdl-core') } catch {}
try { classicYtdl = require('ytdl-core') } catch {}

const agent = new https.Agent({ rejectUnauthorized: true })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/*
 * HOW LONG THE PROVIDER POLLING COSTS, AND WHY IT WAS CUT DOWN
 *
 * SaveNow does not hand back a file: it starts a conversion job and you POLL until it is
 * ready. The old loop slept 2500ms between attempts, up to 40 attempts - so it could burn
 * 100 SECONDS of pure waiting, and in practice it spent ~15s (about 6 polls) before the job
 * was ready. That wait was the single largest fixed cost in .song / .shazam audio.
 *
 * The job is usually ready well before the next 2.5s tick, so a shorter tick detects
 * readiness sooner instead of overshooting. The attempt COUNT is raised in step so the
 * overall time budget stays about the same (~96s) - this makes it FASTER TO NOTICE a ready
 * job, not quicker to give up on a slow one.
 */
const POLL_INTERVAL_MS = 800
const POLL_ATTEMPTS = 120

const SaveNow = {
  _api: 'https://p.savenow.to',
  _key: 'dfcb6d76f2f6a9894gjkege8a4ab232222',
  poll: async (url, limit = POLL_ATTEMPTS) => {
    for (let i = 0; i < limit; i++) {
      try {
        const { data } = await axios.get(url, { httpsAgent: agent, timeout: 60000 })
        if (data?.success === 1 && data.download_url) return data
        if (data?.success === -1) break
      } catch {}
      await sleep(POLL_INTERVAL_MS)
    }
    return null
  },
  // The provider's accepted audio bitrates, best first. Exported for the probe/tests so the
  // chosen value can be re-verified instead of being taken on faith.
  audioQualities: ['128']
}

const savetube = {
  base: 'https://media.savetube.me/api',
  headers: { accept: '*/*', 'content-type': 'application/json', origin: 'https://yt.savetube.me', referer: 'https://yt.savetube.me/', 'user-agent': 'DARKNOTE/5.1.0' },
  audioFormats: new Set(['mp3', 'm4a', 'webm', 'aac', 'flac', 'opus', 'ogg', 'wav']),
  videoFormats: new Set(['144', '240', '360', '480', '720', '1080', '1440', '2k', '3k', '4k', '5k', '8k']),
  youtubeId(url) {
    try {
      const u = new URL(url)
      if (u.hostname === 'youtu.be') return u.pathname.slice(1).match(/^[A-Za-z0-9_-]{11}$/)?.[0] || null
      if (u.hostname.includes('youtube.com')) return u.searchParams.get('v') || u.pathname.match(/\/(?:embed|v|shorts)\/([A-Za-z0-9_-]{11})/)?.[1] || null
    } catch {}
    return null
  },
  async request(url, data = {}, method = 'post') {
    try {
      const response = await axios({ method, url, data: method === 'post' ? data : undefined, params: method === 'get' ? data : undefined, headers: this.headers, timeout: 60000 })
      return { status: true, data: response.data }
    } catch (error) { return { status: false, code: error.response?.status || 500, error: error.message } }
  },
  async decrypt(enc) {
    const secretKey = 'C5D58EF67A7584E4A29F6C35BBC4EB12'
    const data = Buffer.from(enc, 'base64')
    const iv = data.subarray(0, 16), content = data.subarray(16), key = Buffer.from(secretKey, 'hex')
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv)
    return JSON.parse(Buffer.concat([decipher.update(content), decipher.final()]).toString())
  },
  async download(url, format = 'mp3') {
    const id = this.youtubeId(url)
    if (!id || (!this.audioFormats.has(format) && !this.videoFormats.has(format))) return { status: false }
    try {
      const cdnRes = await this.request(`${this.base}/random-cdn`, {}, 'get')
      const cdn = cdnRes.data?.cdn
      if (!cdn) return { status: false }
      const info = await this.request(`https://${cdn}/v2/info`, { url: `https://www.youtube.com/watch?v=${id}` })
      if (!info.status || !info.data?.data) return { status: false }
      const meta = await this.decrypt(info.data.data)
      const audio = this.audioFormats.has(format)
      const dl = await this.request(`https://${cdn}/download`, { id, downloadType: audio ? 'audio' : 'video', quality: audio ? '128' : format, key: meta.key })
      const downloadUrl = dl.data?.data?.downloadUrl
      return downloadUrl ? { status: true, title: meta.title || 'YouTube Media', download_url: downloadUrl } : { status: false }
    } catch { return { status: false } }
  }
}

async function ytdlv1(url, type = 'audio') {
  try {
    const endpoint = type === 'audio' || type === 'mp3' ? `https://ytdlpyton.nvlgroup.my.id/download/audio?url=${encodeURIComponent(url)}&mode=url` : `https://ytdlpyton.nvlgroup.my.id/download/?url=${encodeURIComponent(url)}&resolution=${encodeURIComponent(type)}&mode=url`
    const { data } = await axios.get(endpoint, { timeout: 60000 })
    return data?.download_url ? { status: true, title: data.title || 'YouTube Media', download_url: data.download_url } : { status: false }
  } catch { return { status: false } }
}

async function ytdlv2(url, type = 'audio') {
  try {
    const { data } = await axios.post('https://app.ytdown.to/proxy.php', qs.stringify({ url }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: '*/*', 'X-Requested-With': 'XMLHttpRequest', 'User-Agent': 'Mozilla/5.0', Referer: 'https://app.ytdown.to/id12/' }, timeout: 60000 })
    const api = data?.api
    if (!api?.mediaItems) return { status: false }
    const audio = type === 'audio' || type === 'mp3'
    const target = audio ? api.mediaItems.find(v => v.type === 'Audio' && v.mediaQuality === '128K') || api.mediaItems.find(v => v.type === 'Audio') : api.mediaItems.find(v => v.type === 'Video' && v.mediaQuality === 'HD') || api.mediaItems.find(v => v.type === 'Video')
    if (!target?.mediaUrl) return { status: false }
    for (let i = 0; i < 20; i++) {
      try {
        const { data: check } = await axios.get(target.mediaUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 60000 })
        if (check?.status === 'completed' && check.fileUrl) return { status: true, title: api.title || 'YouTube Media', download_url: check.fileUrl }
      } catch {}
      await sleep(3000)
    }
    return { status: false }
  } catch { return { status: false } }
}

async function ytdlv3(url, type = 'audio') {
  try {
    const format = type === 'audio' ? 'mp3' : type
    const { data: init } = await axios.get(`${SaveNow._api}/ajax/download.php`, { params: { copyright: 0, format, url, api: SaveNow._key }, httpsAgent: agent, timeout: 60000 })
    if (!init?.success || !init.progress_url) return { status: false }
    const result = await SaveNow.poll(init.progress_url)
    return result?.download_url ? { status: true, title: init.info?.title || 'YouTube Media', download_url: result.download_url } : { status: false }
  } catch { return { status: false } }
}

async function ytdlv4(url, type = 'audio') {
  return savetube.download(url, type === 'audio' || type === 'mp3' ? 'mp3' : type)
}

async function ytdlAuto(url, type = 'audio') {
  for (const fn of [ytdlv1, ytdlv3, ytdlv4, ytdlv2]) {
    try { const result = await fn(url, type); if (result?.status && result.download_url) return result } catch {}
  }
  return { status: false, error: 'All YouTube download providers failed' }
}

/*
 * OPTIONAL YOUTUBE COOKIES
 *
 * YouTube answers many VPS / datacenter IPs with "Sign in to confirm you're not a
 * bot" instead of a player response. That is an IP reputation check, not a code
 * bug, and the only client-side fix is to present an account's cookies:
 *
 *   YTDL_COOKIE="SID=...; HSID=...; SSID=..."     (cookie header string)
 *   YTDL_COOKIE='[{"name":"SID","value":"..."}]'  (JSON array, as exported)
 *   ./cookies.json                                (same JSON array, on disk)
 *
 * Never committed: .gitignore already ignores cookies.json and .env.
 */
let cookieAgent
function ytdlAgent() {
  if (cookieAgent !== undefined) return cookieAgent
  cookieAgent = null
  try {
    let raw = process.env.YTDL_COOKIE
    if (!raw) {
      const file = path.join(__dirname, '..', '..', 'cookies.json')
      if (fs.existsSync(file)) raw = fs.readFileSync(file, 'utf8')
    }
    if (!raw || !distubeYtdl?.createAgent) return cookieAgent
    let cookies = []
    if (raw.trim().startsWith('[')) {
      cookies = JSON.parse(raw)
    } else {
      cookies = raw.split(';').map(part => part.trim()).filter(Boolean).map(part => {
        const at = part.indexOf('=')
        return at > 0 ? { name: part.slice(0, at), value: part.slice(at + 1), domain: '.youtube.com' } : null
      }).filter(Boolean)
    }
    if (!cookies.length) return cookieAgent
    cookieAgent = distubeYtdl.createAgent(cookies)
    console.log(`[SONG] Using YouTube cookies (${cookies.length} cookies)`)
  } catch (error) {
    console.error('[SONG] YouTube cookies could not be loaded:', error?.message || error)
  }
  return cookieAgent
}

async function ytdlDirectBuffer(url) {
  if (!distubeYtdl || !distubeYtdl.validateURL(url)) return { status: false }
  try {
    const agent = ytdlAgent()
    const info = await distubeYtdl.getInfo(url, agent ? { agent } : {})
    const format = distubeYtdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' })
    if (!format?.url) return { status: false }
    const stream = distubeYtdl.downloadFromInfo(info, agent ? { format, agent, highWaterMark: 1 << 20 } : { format, highWaterMark: 1 << 20 })
    const chunks = []; let total = 0
    for await (const chunk of stream) { chunks.push(chunk); total += chunk.length; if (total > 50 * 1024 * 1024) { try { stream.destroy() } catch {}; throw new Error('Audio file is too large') } }
    const buffer = Buffer.concat(chunks)
    if (buffer.length < 4096) throw new Error('Downloaded audio is empty')
    return { status: true, title: info.videoDetails?.title || 'YouTube song', buffer, mimetype: format.mimeType?.split(';')[0] || 'audio/mp4' }
  } catch (error) { return { status: false, error: error?.message || 'Direct YouTube audio failed' } }
}

async function ytdlClassicBuffer(url) {
  if (!classicYtdl) return { status: false, error: 'Classic YouTube downloader is not installed' }
  try {
    if (!classicYtdl.validateURL(url)) return { status: false, error: 'Invalid YouTube URL' }
    const info = await classicYtdl.getInfo(url)
    const format = classicYtdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' })
    if (!format?.url) return { status: false, error: 'No audio-only YouTube format was available' }
    const stream = classicYtdl.downloadFromInfo(info, { format, highWaterMark: 1 << 20 })
    const chunks = []; let total = 0
    for await (const chunk of stream) { chunks.push(chunk); total += chunk.length; if (total > 50 * 1024 * 1024) { try { stream.destroy() } catch {}; throw new Error('Audio file is too large') } }
    const buffer = Buffer.concat(chunks)
    if (buffer.length < 4096) throw new Error('Downloaded audio is empty')
    return { status: true, title: info.videoDetails?.title || 'YouTube song', buffer, mimetype: format.mimeType?.split(';')[0] || 'audio/mp4' }
  } catch (error) { return { status: false, error: error?.message || 'YouTube audio download failed' } }
}

  /*
   * AUDIO / VIDEO BUFFER CACHE
   *
   * Measured on this deployment: resolving a download costs ~14.5s of the provider's
   * SERVER-SIDE conversion (polled), and the transfer itself runs at only 0.24-0.73 MB/s.
   * Neither number can be improved from the client, so the one reliable way to make a
   * request fast is to not repeat it.
   *
   * This matters more than it first appears: tapping AUDIO and then VIDEO on the same
   * song downloaded the identical file TWICE (the log shows two "Downloading ..." lines
   * for one track), and any re-play paid the full cost again. A cached hit returns in
   * milliseconds instead of ~26s.
   *
   * Bounded by TOTAL BYTES rather than entry count, because one long track can be tens of
   * MB - a count-only limit could pin hundreds of MB of RSS. Oldest-first eviction, and
   * an entry larger than the whole budget is simply not cached.
   */
  const bufferCache = new Map()
  const BUFFER_CACHE_MAX_BYTES = 96 * 1024 * 1024
  const BUFFER_CACHE_TTL_MS = 30 * 60 * 1000
  let bufferCacheBytes = 0

  function bufferCacheKey(url, type) {
    const id = extractYouTubeId(url)
    return `${type || 'audio'}:${id || String(url)}`
  }

  function bufferCacheGet(key) {
    const hit = bufferCache.get(key)
    if (!hit) return null
    if (Date.now() - hit.at > BUFFER_CACHE_TTL_MS) {
      bufferCache.delete(key)
      bufferCacheBytes -= hit.bytes
      return null
    }
    // Re-insert to mark it most-recently-used.
    bufferCache.delete(key)
    bufferCache.set(key, hit)
    return hit.value
  }

  function bufferCacheSet(key, value) {
    const bytes = value?.buffer?.length || 0
    // Nothing to cache, or a single item larger than the entire budget.
    if (!bytes || bytes > BUFFER_CACHE_MAX_BYTES) return
    const prev = bufferCache.get(key)
    if (prev) { bufferCacheBytes -= prev.bytes; bufferCache.delete(key) }
    bufferCache.set(key, { at: Date.now(), bytes, value })
    bufferCacheBytes += bytes
    while (bufferCacheBytes > BUFFER_CACHE_MAX_BYTES && bufferCache.size > 1) {
      const oldest = bufferCache.keys().next().value
      const gone = bufferCache.get(oldest)
      bufferCache.delete(oldest)
      bufferCacheBytes -= gone?.bytes || 0
    }
  }

  async function ytdlAutoBuffer(url, type = 'audio') {
    const cacheKey = bufferCacheKey(url, type)
    const cached = bufferCacheGet(cacheKey)
    if (cached) return cached

    /* Cache a successful result on the way out, so every return path below is covered
     * without duplicating the call. */
    const remember = value => { if (value?.status && Buffer.isBuffer(value.buffer)) bufferCacheSet(cacheKey, value); return value }

    const attempts = []
    try { const direct = await ytdlDirectBuffer(url); if (direct?.status && Buffer.isBuffer(direct.buffer)) return remember(direct); if (direct?.error) attempts.push(direct.error) } catch (e) { attempts.push(e?.message || 'Direct YouTube download failed') }
    try { const classic = await ytdlClassicBuffer(url); if (classic?.status && Buffer.isBuffer(classic.buffer)) return remember(classic); if (classic?.error) attempts.push(classic.error) } catch (e) { attempts.push(e?.message || 'Fallback YouTube download failed') }
  let lastError = attempts[attempts.length - 1] || 'All YouTube audio providers failed'
  for (const fn of [ytdlv1, ytdlv3, ytdlv4, ytdlv2]) {
    try {
      const result = await fn(url, type); if (!result?.status || !result.download_url) continue
      const response = await axios.get(result.download_url, { responseType: 'arraybuffer', timeout: 120000, maxContentLength: 50 * 1024 * 1024, maxBodyLength: 50 * 1024 * 1024, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36', Accept: 'audio/mpeg,audio/*;q=0.9,application/octet-stream;q=0.8,*/*;q=0.5' }, validateStatus: status => status >= 200 && status < 400 })
      const buffer = Buffer.from(response.data); const contentType = String(response.headers?.['content-type'] || '').toLowerCase()
      if (buffer.length < 4096) throw new Error('Downloaded audio is empty or too small')
        if (contentType.includes('text/html') || contentType.includes('application/json')) throw new Error('Provider returned a webpage instead of audio')
        return remember({ status: true, title: result.title || 'YouTube song', buffer, mimetype: contentType.startsWith('audio/') ? contentType.split(';')[0] : 'audio/mpeg' })
    } catch (error) { lastError = error?.message || lastError }
  }
    /*
     * Report EVERY reason, not just the last one.
     *
     * The providers are tried in order and each fails for its own reason. Keeping only
     * the final message meant a YouTube bot-check on the direct path was reported as
     * "Classic YouTube downloader is not installed" - true, but it says nothing about
     * why the download actually failed.
     */
    const details = [...new Set([...attempts, lastError].filter(Boolean))].join(' | ')
  return { status: false, error: details || 'All YouTube audio providers failed' }
}


function extractYouTubeId(url) {
  try {
    const u = new URL(String(url))
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    if (host === 'youtu.be') return u.pathname.slice(1).match(/^[A-Za-z0-9_-]{11}$/)?.[0] || null
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      return u.searchParams.get('v')?.match(/^[A-Za-z0-9_-]{11}$/)?.[0] || u.pathname.match(/\/(?:embed|v|shorts|live)\/([A-Za-z0-9_-]{11})/)?.[1] || null
    }
  } catch {}
  return null
}

async function getYouTubeMetadata(url) {
  const videoId = extractYouTubeId(url)
  if (!videoId) return { status: false, error: 'Invalid YouTube URL' }
  if (distubeYtdl) {
    try {
      const info = await distubeYtdl.getBasicInfo(`https://www.youtube.com/watch?v=${videoId}`)
      const d = info.videoDetails || {}
      return {
        status: true,
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: d.title || 'YouTube video',
        author: d.author?.name || 'YouTube',
        duration: Number(d.lengthSeconds || 0),
        thumbnail: d.thumbnails?.[d.thumbnails.length - 1]?.url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        views: Number(d.viewCount || 0),
        isLive: Boolean(d.isLiveContent)
      }
    } catch (error) {
      return { status: false, videoId, error: error?.message || 'Unable to read YouTube metadata' }
    }
  }
  return { status: false, videoId, error: 'YouTube metadata reader is unavailable' }
}

async function downloadToFile(downloadUrl, destination, maxBytes = 200 * 1024 * 1024) {
  const temp = `${destination}.part`
  try {
    const response = await axios.get(downloadUrl, {
      responseType: 'stream',
      timeout: 120000,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'video/mp4,video/*;q=0.9,application/octet-stream;q=0.8,*/*;q=0.5' },
      validateStatus: status => status >= 200 && status < 400
    })
    const contentLength = Number(response.headers?.['content-length'] || 0)
    if (contentLength > maxBytes) throw new Error('Video file is too large')
    await fs.promises.mkdir(path.dirname(destination), { recursive: true })
    const writer = fs.createWriteStream(temp)
    let total = 0

    /*
     * ONE error listener for the whole stream, not one per write.
     *
     * The previous version attached `writer.once('error', reject)` INSIDE the
     * per-chunk loop, so every time backpressure was hit another listener was
     * attached and never removed. A large download pushed the count past Node's
     * limit and printed this in the console:
     *
     *   MaxListenersExceededWarning: Possible EventEmitter memory leak detected.
     *   11 error listeners added to [WriteStream]. MaxListeners is 10.
     *
     * The final `end()` wait attached one more that was never detached when its
     * promise resolved, so it leaked for the life of the stream as well.
     * Measured against the old code: a 400-chunk download left 401 error
     * listeners attached to the stream.
     *
     * A single deferred records the first error instead, and every wait below
     * adds only its own short-lived listener and removes it on settle. The
     * persistent listener also stops an error from becoming an unhandled
     * 'error' event, which would take the whole process down.
     */
    let streamError = null
    const recordStreamError = error => {
      streamError = error instanceof Error ? error : new Error(String(error || 'write stream failed'))
    }
    writer.on('error', recordStreamError)

    /** Wait for one stream event, detaching BOTH listeners when it settles. */
    const waitForStream = event => new Promise((resolve, reject) => {
      if (streamError) return reject(streamError)
      const done = value => { writer.removeListener(event, done); writer.removeListener('error', fail); resolve(value) }
      const fail = error => { writer.removeListener(event, done); writer.removeListener('error', fail); reject(error) }
      writer.once(event, done)
      writer.once('error', fail)
    })

    try {
      for await (const chunk of response.data) {
        total += chunk.length
        if (total > maxBytes) throw new Error('Video file is too large')
        if (!writer.write(chunk)) await waitForStream('drain')
        // An error can land between chunks. Stop rather than keep writing into a
        // dead stream until the read loop happens to end.
        if (streamError) throw streamError
      }
      await new Promise((resolve, reject) => {
        const done = () => { writer.removeListener('finish', done); writer.removeListener('error', fail); resolve() }
        const fail = error => { writer.removeListener('finish', done); writer.removeListener('error', fail); reject(error) }
        writer.once('finish', done)
        writer.once('error', fail)
        writer.end()
      })
    } catch (error) {
      writer.destroy()
      throw error
    }
    if (total < 4096) throw new Error('Downloaded video is empty')
    await fs.promises.rename(temp, destination)
    return { status: true, path: destination, size: total }
  } catch (error) {
    try { await fs.promises.rm(temp, { force: true }) } catch {}
    return { status: false, error: error?.message || 'Video download failed' }
  }
}

async function ytdlAutoVideoFile(url, destination, quality = '720', maxBytes = 200 * 1024 * 1024) {
  const qualities = [String(quality), '480', '360'].filter((v, i, a) => a.indexOf(v) === i)
  let lastError = 'All YouTube video providers failed'
  for (const q of qualities) {
    for (const fn of [ytdlv4, ytdlv3, ytdlv2, ytdlv1]) {
      try {
        const result = await fn(url, q)
        if (!result?.status || !result.download_url) continue
        const saved = await downloadToFile(result.download_url, destination, maxBytes)
        if (saved.status) return { ...saved, title: result.title || 'YouTube video' }
        lastError = saved.error || lastError
      } catch (error) {
        lastError = error?.message || lastError
      }
      try { await fs.promises.rm(destination, { force: true }) } catch {}
      try { await fs.promises.rm(`${destination}.part`, { force: true }) } catch {}
    }
  }
  return { status: false, error: lastError }
}

// `downloadToFile` is exported so its write stream can be regression-tested
// directly: the listener leak it used to have only showed up as a console
// warning during a large download, which no other test could reach.
/*
 * `__bufferCache` is exposed so the eviction and expiry rules can be tested without
 * network access - they are the parts most likely to break silently (a wrong eviction
 * either leaks memory or loses the cache entirely, and neither shows up in behaviour
 * until the process has been up for a while).
 */
module.exports = {
  ytdlv1, ytdlv2, ytdlv3, ytdlv4, ytdlAuto, ytdlAutoBuffer,
  ytdlDirectBuffer, ytdlClassicBuffer, extractYouTubeId, getYouTubeMetadata,
  ytdlAutoVideoFile, downloadToFile,
  __bufferCache: {
    key: bufferCacheKey,
    get: bufferCacheGet,
    set: bufferCacheSet,
    clear: () => { bufferCache.clear(); bufferCacheBytes = 0 },
    stats: () => ({ entries: bufferCache.size, bytes: bufferCacheBytes, maxBytes: BUFFER_CACHE_MAX_BYTES, ttlMs: BUFFER_CACHE_TTL_MS }),
    limit: BUFFER_CACHE_MAX_BYTES,
    ttl: BUFFER_CACHE_TTL_MS
  }
}

