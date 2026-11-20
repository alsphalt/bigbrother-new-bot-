'use strict'

/*
 * ACRCloud song identification for `.shazam`.
 *
 * Why this does not use the `acrcloud` npm package: the identify call is one
 * signed multipart POST. Doing it with node's built-in crypto + fetch removes a
 * dependency, and keeps the signing rule in the open where it can be checked:
 *
 *   stringToSign = "POST\n/v1/identify\n<access_key>\naudio\n1\n<timestamp>"
 *   signature    = base64(HMAC-SHA1(access_secret, stringToSign))
 *
 * Credentials are read from the environment first, then fig.json, then the
 * values already bundled in lib/heromodes/whatsapp.js - so an existing deploy
 * keeps working, while a new one can move the keys out of source with:
 *
 *   ACRCLOUD_HOST / ACRCLOUD_ACCESS_KEY / ACRCLOUD_ACCESS_SECRET
 */

const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

const IDENTIFY_TIMEOUT_MS = 45000
const MAX_SAMPLE_BYTES = 12 * 1024 * 1024

/* ------------------------------- credentials ------------------------------ */

function bundledCredentials () {
    // Single source of truth for the keys this project already ships with.
    try {
        const { ACR_CONFIG } = require('./heromodes/whatsapp.js')
        if (ACR_CONFIG?.host && ACR_CONFIG?.accessKey && ACR_CONFIG?.accessSecret) return ACR_CONFIG
    } catch {}
    return {}
}

function figCredentials () {
    try {
        const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fig.json'), 'utf8'))
        const acr = config?.acrcloud || {}
        if (acr.host && acr.accessKey && acr.accessSecret) {
            return { host: acr.host, accessKey: acr.accessKey, accessSecret: acr.accessSecret }
        }
    } catch {}
    return {}
}

function credentials () {
    const env = {
        host: process.env.ACRCLOUD_HOST,
        accessKey: process.env.ACRCLOUD_ACCESS_KEY,
        accessSecret: process.env.ACRCLOUD_ACCESS_SECRET
    }
    if (env.host && env.accessKey && env.accessSecret) return { ...env, source: 'env' }

    const fig = figCredentials()
    if (fig.host) return { ...fig, source: 'fig.json' }

    const bundled = bundledCredentials()
    if (bundled.host) return { ...bundled, source: 'lib/heromodes/whatsapp.js' }

    return { host: '', accessKey: '', accessSecret: '', source: 'none' }
}

/* --------------------------------- audio --------------------------------- */

let ffmpegPathCache

function ffmpegPath () {
    if (ffmpegPathCache !== undefined) return ffmpegPathCache
    try {
        ffmpegPathCache = require('ffmpeg-static') || 'ffmpeg'
    } catch {
        ffmpegPathCache = 'ffmpeg'
    }
    return ffmpegPathCache
}

/**
 * Normalise any replied audio/video to 16 kHz mono PCM WAV.
 *
 * ACRCloud fingerprints best on speech/music-rate mono audio, and WhatsApp
 * replies arrive as opus/ogg (voice notes) or mp4/aac (audio & video). Falls
 * back to the original bytes when ffmpeg is unavailable, because ACRCloud also
 * accepts mp3/ogg/mp4 directly.
 */
async function toWav (buffer) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('Nothing to analyse')
    if (buffer.length > MAX_SAMPLE_BYTES) throw new Error('Media is too large to analyse')

    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const input = path.join(os.tmpdir(), `shazam-in-${stamp}`)
    const output = path.join(os.tmpdir(), `shazam-out-${stamp}.wav`)

    try {
        await fs.promises.writeFile(input, buffer)
        await new Promise((resolve, reject) => {
            execFile(
                ffmpegPath(),
                ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', output],
                { timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
                error => error ? reject(error) : resolve()
            )
        })
        const wav = await fs.promises.readFile(output)
        if (wav.length < 1024) throw new Error('Converted audio is empty')
        return wav
    } catch {
        // ffmpeg missing or refused the container: hand ACRCloud the raw bytes.
        return buffer
    } finally {
        await fs.promises.unlink(input).catch(() => {})
        await fs.promises.unlink(output).catch(() => {})
    }
}

/* -------------------------------- identify ------------------------------- */

function signature (accessKey, accessSecret, timestamp) {
    const stringToSign = `POST\n/v1/identify\n${accessKey}\naudio\n1\n${timestamp}`
    return crypto.createHmac('sha1', accessSecret).update(Buffer.from(stringToSign, 'utf8')).digest('base64')
}

function pickMatch (metadata) {
    const bucket = metadata?.music || metadata?.humming || []
    return Array.isArray(bucket) && bucket.length ? bucket[0] : null
}

/** Identify a media buffer with ACRCloud. Never throws for a "no match" answer. */
async function identify (buffer) {
    const { host, accessKey, accessSecret, source } = credentials()
    if (!host) {
        return {
            ok: false,
            code: 'NO_CREDENTIALS',
            message: 'Shazam is not configured. Set ACRCLOUD_HOST, ACRCLOUD_ACCESS_KEY and ACRCLOUD_ACCESS_SECRET (or fill acrcloud in fig.json).'
        }
    }

    const sample = await toWav(buffer)
    const timestamp = String(Math.floor(Date.now() / 1000))
    const form = new FormData()
    form.append('sample', new Blob([sample], { type: 'application/octet-stream' }), 'sample.wav')
    form.append('access_key', accessKey)
    form.append('data_type', 'audio')
    form.append('signature_version', '1')
    form.append('signature', signature(accessKey, accessSecret, timestamp))
    form.append('sample_bytes', String(sample.length))
    form.append('timestamp', timestamp)

    let response
    try {
        response = await fetch(`https://${host}/v1/identify`, {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(IDENTIFY_TIMEOUT_MS)
        })
    } catch (error) {
        return { ok: false, code: 'NETWORK', message: `Shazam request failed: ${error?.message || error}` }
    }

    let data
    try {
        data = await response.json()
    } catch {
        return { ok: false, code: 'BAD_RESPONSE', message: `Shazam returned an unreadable reply (HTTP ${response.status})` }
    }

    const status = data?.status || {}
    if (status.code !== 0) {
        const hint = status.code === 1001 ? 'No match found. Try a longer, clearer clip.'
            : status.code === 3001 ? `Invalid ACRCloud access key (source: ${source}).`
                : status.code === 3003 ? 'ACRCloud access key has expired.'
                    : status.msg || 'Identification failed.'
        return { ok: false, code: status.code, message: hint, raw: data }
    }

    const match = pickMatch(data.metadata)
    if (!match) return { ok: false, code: 1001, message: 'No match found. Try a longer, clearer clip.' }

    return {
        ok: true,
        score: Number(match.score || 0),
        title: match.title || 'Unknown title',
        artists: (match.artists || []).map(artist => artist?.name).filter(Boolean),
        album: match.album?.name || '',
        genres: (match.genres || []).map(genre => genre?.name).filter(Boolean),
        releaseDate: match.release_date || '',
        label: match.label || '',
        query: [match.title, (match.artists || []).map(a => a?.name).filter(Boolean).join(' ')].filter(Boolean).join(' ')
    }
}

/** WhatsApp-ready summary of a successful identification. */
function formatMatch (match) {
    const lines = [`🎧 *${match.title}*`]
    if (match.artists?.length) lines.push(`👤 Artist : ${match.artists.join(', ')}`)
    if (match.album) lines.push(`💿 Album : ${match.album}`)
    if (match.genres?.length) lines.push(`🎼 Genre : ${match.genres.join(', ')}`)
    if (match.releaseDate) lines.push(`📅 Release : ${match.releaseDate}`)
    if (match.label) lines.push(`🏷️ Label : ${match.label}`)
    lines.push(`✅ Match : ${Math.round((match.score || 0) * 100)}%`)
    return lines.join('\n')
}

module.exports = {
    identify,
    formatMatch,
    credentials,
    toWav,
    signature
}
