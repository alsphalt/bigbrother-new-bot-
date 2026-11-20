'use strict'

/*
 * YouTube search without an API key or an extra npm package.
 *
 * Uses YouTube's own InnerTube endpoint (the one the web player calls) with the
 * public WEB client key. No login, no cookies, no yt-search / ytdl-core needed,
 * so `.song` works on a bare `npm install` of this project.
 *
 * The response is a deeply nested renderer tree. collectVideoRenderers() walks it
 * instead of regex-matching titles, because title text also appears inside
 * shelves, continuations and lockup view models - a regex happily mixes a
 * playlist title with a video id.
 */

const SEARCH_URL = 'https://www.youtube.com/youtubei/v1/search'
const INNERTUBE_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'
const CLIENT_VERSION = '2.20241126.01.00'
const REQUEST_TIMEOUT_MS = 20000
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Flatten any of YouTube's text shapes (simpleText / runs / string) to a string. */
function textOf (node) {
    if (!node) return ''
    if (typeof node === 'string') return node
    if (typeof node.simpleText === 'string') return node.simpleText
    if (Array.isArray(node.runs)) return node.runs.map(run => run?.text || '').join('')
    return ''
}

/** Recursively collect every videoRenderer object, stopping at each one. */
function collectVideoRenderers (node, out, depth = 0) {
    if (!node || depth > 40) return
    if (Array.isArray(node)) {
        for (const item of node) collectVideoRenderers(item, out, depth + 1)
        return
    }
    if (typeof node !== 'object') return
    if (node.videoRenderer?.videoId) {
        out.push(node.videoRenderer)
        return
    }
    for (const key of Object.keys(node)) collectVideoRenderers(node[key], out, depth + 1)
}

function normalize (renderer) {
    const videoId = renderer.videoId
    const thumbs = renderer.thumbnail?.thumbnails || []
    const best = thumbs[thumbs.length - 1] || {}
    const length = textOf(renderer.lengthText)
    return {
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        title: textOf(renderer.title) || 'YouTube song',
        author: textOf(renderer.ownerText) || textOf(renderer.longBylineText) || 'YouTube',
        duration: length || 'LIVE',
        seconds: parseDuration(length),
        views: textOf(renderer.viewCountText),
        thumbnail: best.url ? (best.url.startsWith('//') ? `https:${best.url}` : best.url) : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        isLive: !length
    }
}

/** "4:07" / "1:02:33" -> seconds, 0 when unknown. */
function parseDuration (text) {
    if (!text) return 0
    const parts = String(text).split(':').map(part => Number(part.replace(/\D/g, '')))
    if (parts.some(part => !Number.isFinite(part))) return 0
    return parts.reduce((total, part) => total * 60 + part, 0)
}

/** Pull a video id out of a watch / youtu.be / shorts / embed URL. */
function extractVideoId (input) {
    try {
        const url = new URL(String(input))
        const host = url.hostname.toLowerCase().replace(/^www\./, '')
        if (host === 'youtu.be') return url.pathname.slice(1).match(/^[A-Za-z0-9_-]{11}$/)?.[0] || null
        if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
            return url.searchParams.get('v')?.match(/^[A-Za-z0-9_-]{11}$/)?.[0] ||
                url.pathname.match(/\/(?:embed|v|shorts|live)\/([A-Za-z0-9_-]{11})/)?.[1] || null
        }
    } catch {}
    return null
}

function isYouTubeUrl (input) {
    return /^https?:\/\//i.test(String(input || '')) && Boolean(extractVideoId(input))
}

/**
 * Search YouTube and return up to `limit` videos.
 * Throws on network/parse failure so the caller can tell the user why.
 */
async function searchYouTube (query, limit = 5) {
    const text = String(query || '').trim()
    if (!text) throw new Error('Search query is empty')

    const response = await fetch(`${SEARCH_URL}?key=${INNERTUBE_KEY}&prettyPrint=false`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': USER_AGENT,
            'Accept-Language': 'en-US,en;q=0.9',
            Origin: 'https://www.youtube.com',
            Referer: 'https://www.youtube.com/'
        },
        body: JSON.stringify({
            context: { client: { clientName: 'WEB', clientVersion: CLIENT_VERSION, hl: 'en', gl: 'US' } },
            query: text
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

    if (!response.ok) throw new Error(`YouTube search failed (HTTP ${response.status})`)

    const data = await response.json()
    const renderers = []
    collectVideoRenderers(data, renderers)

    const seen = new Set()
    const results = []
    for (const renderer of renderers) {
        if (seen.has(renderer.videoId)) continue
        seen.add(renderer.videoId)
        results.push(normalize(renderer))
        if (results.length >= limit) break
    }
    return results
}

/** Resolve whatever the user typed into one video (URL wins, otherwise top search hit). */
async function resolveSong (input) {
    const text = String(input || '').trim()
    if (!text) throw new Error('No song name or link given')

    if (isYouTubeUrl(text)) {
        const videoId = extractVideoId(text)
        return {
            videoId,
            url: `https://www.youtube.com/watch?v=${videoId}`,
            title: 'YouTube song',
            author: 'YouTube',
            duration: '',
            seconds: 0,
            views: '',
            thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            isLive: false,
            fromUrl: true
        }
    }

    const results = await searchYouTube(text, 5)
    if (!results.length) throw new Error('No YouTube songs found')
    const playable = results.find(result => !result.isLive) || results[0]
    return playable
}

module.exports = {
    searchYouTube,
    resolveSong,
    extractVideoId,
    isYouTubeUrl,
    parseDuration
}
