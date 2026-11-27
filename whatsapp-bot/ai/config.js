'use strict'

/*
 * Central settings store.
 *
 * `ai/*`, `lib/*` and the tests all read and write configuration through this
 * module: `config.prefix = '.'`, `config.writeAiSetting(...)`,
 * `config.getAiSettings()`, `config.sessionSettings`, and so on. The file was
 * missing from the repository, so the bot crashed on boot
 * (`Cannot find module './config'`).
 *
 * Behaviour:
 *   - reads config.json once, then serves it from memory;
 *   - assignments (`config.prefix = ...`) persist atomically to config.json;
 *   - `writeAiSetting` merges into the `ai` section and persists;
 *   - every read merges sane defaults so a partial config.json cannot crash a
 *     feature that expects a key.
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const CONFIG_FILE = path.join(ROOT, 'config.json')

const DEFAULTS = {
    botName: 'DARKNOTE',
    mode: 'public',
    prefix: '.',
    anticall: false,
    antilink: false,
    autoread: false,
    autotyping: false,
    autorecoding: false,
    antideleteSkipOwner: true,
    maxTelegramAccounts: 100,
    maxSessionsPerAccount: 20,
    cmdAliases: {},
    stickerCommands: {},
    sessionSettings: {},
    statusAutomation: {},
    ai: {
        provider: '',
        apiKey: '',
        baseUrl: '',
        model: '',
        chatbotEnabled: false,
        disabledProviders: [],
        modules: {},
        onlineCycleEnabled: false,
        onlineCycleMs: 0,
        temperature: 0.7,
        maxTokens: 700,
        // Reply pacing: the owner asked for a 5 second answer, so every window
        // collapses to 5000ms (see tests/timing.test.js).
        replyDelayShortMinMs: 5000,
        replyDelayShortMaxMs: 5000,
        replyDelayLongMinMs: 5000,
        replyDelayLongMaxMs: 5000,
        groupDelayMinMs: 5000,
        groupDelayMaxMs: 5000,
        ownerNormalDelayMinMs: 5000,
        ownerNormalDelayMaxMs: 5000,
        ownerLongDelayMinMs: 5000,
        ownerLongDelayMaxMs: 5000,
        ownerShortDelayMs: 5000,
        autohumanAnalyseMs: 1500,
        autohumanGenerateMs: 2000,
        autohumanPreSendMs: 1500,
    },
}

let cache = null
let saveTimer = null
let envLoaded = false

function clone(value) {
    try {
        return structuredClone(value)
    } catch {
        return JSON.parse(JSON.stringify(value))
    }
}

function merge(base, override) {
    if (!override || typeof override !== 'object' || Array.isArray(override)) return override === undefined ? base : override
    const out = Array.isArray(base) ? [] : { ...base }
    for (const [key, value] of Object.entries(override)) {
        if (value && typeof value === 'object' && !Array.isArray(value) && base && typeof base[key] === 'object') {
            out[key] = merge(base[key] || {}, value)
        } else {
            out[key] = value
        }
    }
    return out
}

function load() {
    if (cache) return cache
    let file = {}
    try {
        file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
    } catch {
        file = {}
    }
    cache = merge(clone(DEFAULTS), file)
    return cache
}

function persistNow() {
    if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
    }
    try {
        const tmp = `${CONFIG_FILE}.tmp`
        fs.writeFileSync(tmp, JSON.stringify(load(), null, 2))
        fs.renameSync(tmp, CONFIG_FILE)
    } catch (err) {
        console.error('[config] could not persist settings:', err?.message || err)
    }
}

function persistSoon() {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
        saveTimer = null
        persistNow()
    }, 15)
    if (typeof saveTimer.unref === 'function') saveTimer.unref()
}

/** Loads `.env` without overriding values that are already in the environment. */
function loadEnvOnce() {
    if (envLoaded) return
    envLoaded = true
    try {
        const file = path.join(ROOT, '.env')
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
        /* ignore malformed .env */
    }
}

function getAiSettings() {
    const data = load()
    return { ...clone(DEFAULTS.ai), ...(data.ai && typeof data.ai === 'object' ? data.ai : {}) }
}

function writeAiSetting(key, value) {
    const data = load()
    data.ai = { ...(data.ai || {}), [key]: value }
    persistSoon()
    return value
}

function readConfigFile() {
    return clone(load())
}

function invalidateConfigCache() {
    cache = null
}

function setSessionSetting(session, key, value) {
    const data = load()
    if (!data.sessionSettings || typeof data.sessionSettings !== 'object') data.sessionSettings = {}
    data.sessionSettings[session] = { ...(data.sessionSettings[session] || {}), [key]: value }
    persistSoon()
    return data.sessionSettings[session]
}

function getSessionSettings(session) {
    const data = load()
    const all = data.sessionSettings && typeof data.sessionSettings === 'object' ? data.sessionSettings : {}
    return { ...(all[session] || {}) }
}

const api = {
    ROOT,
    CONFIG_FILE,
    DEFAULTS,
    loadEnvOnce,
    getAiSettings,
    writeAiSetting,
    readConfigFile,
    invalidateConfigCache,
    setSessionSetting,
    getSessionSettings,
    save: persistNow,
}

module.exports = new Proxy(api, {
    get(target, prop, receiver) {
        if (prop in target) return Reflect.get(target, prop, receiver)
        return load()[prop]
    },
    set(target, prop, value) {
        if (typeof prop === 'symbol') return Reflect.set(target, prop, value)
        if (Object.prototype.hasOwnProperty.call(target, prop) && typeof target[prop] === 'function') {
            target[prop] = value
            return true
        }
        load()[prop] = value
        persistSoon()
        return true
    },
    has(target, prop) {
        return prop in target || prop in load()
    },
    ownKeys(target) {
        return [...new Set([...Reflect.ownKeys(target), ...Object.keys(load())])]
    },
    getOwnPropertyDescriptor(target, prop) {
        if (prop in target) return Reflect.getOwnPropertyDescriptor(target, prop)
        if (prop in load()) {
            return { configurable: true, enumerable: true, value: load()[prop], writable: true }
        }
        return undefined
    },
})
