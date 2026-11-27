'use strict'

/*
 * Shared provider settings.
 *
 * `lib/lyrics.js` and `lib/image-edit.js` require this module for the API base
 * URL and the provider keys. It was missing from the repository, which crashed
 * the process at startup (MODULE_NOT_FOUND) before WhatsApp was ever reached.
 *
 * Values are read lazily through getters so a `.env` that is loaded after this
 * module is required (the bot loads it during boot) is still picked up.
 */

const fs = require('fs')
const path = require('path')

let envLoaded = false

/** Minimal .env reader; no dependency needed and never overrides real env vars. */
function loadEnvOnce() {
    if (envLoaded) return
    envLoaded = true
    try {
        const file = path.join(__dirname, '.env')
        if (!fs.existsSync(file)) return
        for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            const line = rawLine.trim()
            if (!line || line.startsWith('#')) continue
            const eq = line.indexOf('=')
            if (eq <= 0) continue
            const key = line.slice(0, eq).trim()
            if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue
            let value = line.slice(eq + 1).trim()
            if (
                (value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'"))
            ) {
                value = value.slice(1, -1)
            }
            process.env[key] = value
        }
    } catch {
        /* a broken .env must not stop the bot */
    }
}

function read(...names) {
    // The bot loads .env during boot; libraries and tests see the real process
    // environment (so a test run is not polluted by local secrets).
    for (const name of names) {
        const value = process.env[name]
        if (value !== undefined && String(value).trim() !== '') return String(value).trim()
    }
    return ''
}

const settings = {
    get BASE_URL() {
        return read('GENIUS_BASE_URL', 'API_BASE_URL', 'MZAZI_BASE_URL') || 'https://www.mzazi.shop'
    },
    get GENIUS_LYRICS_API_KEY() {
        return read('GENIUS_LYRICS_API_KEY')
    },
    get MZAZI_API_KEY() {
        return read('MZAZI_API_KEY')
    },
    get MZAZI_API_KEY_IMAGE() {
        return read('MZAZI_API_KEY_IMAGE')
    },
    loadEnvOnce,
}

module.exports = settings
