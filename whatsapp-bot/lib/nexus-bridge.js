/*
 * DARKNOTE ⇄ NEXUS BRIDGE
 *
 * The bot and the website stay separate processes with separate credentials.
 * The only thing they share is this bridge: the bot reports what it owns and
 * the website tells it what to do. Neither one can drive the other's socket.
 *
 * What it does, in one cycle (default every 15s):
 *   1. pairs itself to the panel once, using a code from the dashboard;
 *   2. reports every WhatsApp session it currently holds (authoritative sync);
 *   3. asks for pairing work the owner requested in the panel and issues the
 *      real WhatsApp pairing code through the bot's own pairing code path;
 *   4. collects RESTART / LOGOUT commands and acks them;
 *   5. ships log lines so the panel shows the same events as the console.
 *
 * Design rules:
 *   - never throws into the bot: a panel outage must not take WhatsApp down;
 *   - never logs the bot token;
 *   - writes the token to .nexus-token.json (gitignored) so a restart keeps
 *     its identity without a new pairing code.
 *
 * Environment:
 *   NEXUS_URL          https://your-panel.vercel.app
 *   NEXUS_TOKEN        dnx_… (optional if NEXUS_PAIR_CODE is set once)
 *   NEXUS_PAIR_CODE    8-character code from Panel → Bots → Pair (single use)
 *   NEXUS_SYNC_SECONDS reporting interval, default 15, minimum 5
 *   NEXUS_ENABLED      set to "false" to disable the bridge entirely
 */
'use strict'

const fs = require('fs')
const path = require('path')

const TOKEN_FILE = path.join(__dirname, '..', '.nexus-token.json')
const MAX_EVENTS_PER_FLUSH = 40

function boolEnv(value, fallback = true) {
    if (value === undefined || value === '') return fallback
    return !/^(0|false|off|no)$/i.test(String(value).trim())
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function baseUrl() {
    return String(process.env.NEXUS_URL || '').trim().replace(/\/+$/, '')
}

function intervalSeconds() {
    const raw = Number(process.env.NEXUS_SYNC_SECONDS || 15)
    if (!Number.isFinite(raw)) return 15
    return Math.max(5, Math.min(300, Math.round(raw)))
}

function botVersion() {
    if (process.env.NEXUS_BOT_VERSION) return String(process.env.NEXUS_BOT_VERSION).slice(0, 40)
    // Reading the package version means a redeploy of the bot is visible in the
    // panel without anyone editing a constant.
    const pkg = readJson(path.join(__dirname, '..', 'package.json'))
    return pkg && pkg.version ? String(pkg.version).slice(0, 40) : '1.0.0'
}

/* Panel status names ← this bot's registry states. */
function mapState(state) {
    const value = String(state || '').toUpperCase()
    if (value === 'CONNECTED') return 'CONNECTED'
    if (value === 'PAIRING') return 'PAIRING_CODE'
    if (value === 'LOGGED_OUT') return 'LOGGED_OUT'
    if (value === 'ERROR') return 'ERROR'
    if (value === 'CONNECTING') return 'CONNECTING'
    return 'DISCONNECTED'
}

function createBridge(deps) {
    const pair = typeof deps.pair === 'function' ? deps.pair : null
    const restart = typeof deps.restart === 'function' ? deps.restart : null
    const logout = typeof deps.logout === 'function' ? deps.logout : null
    const sessions = typeof deps.sessions === 'function' ? deps.sessions : () => []

    const stored = readJson(TOKEN_FILE) || {}
    const state = {
        token: String(process.env.NEXUS_TOKEN || stored.token || ''),
        botId: stored.botId || '',
        botName: stored.name || '',
        startedAt: Date.now(),
        online: false,
        lastError: '',
        lastSyncAt: 0,
        reported: 0,
        commandsRun: 0
    }

    const aliases = new Map()   // bot session id → panel pairing request id
    const handled = new Set()   // panel request ids already claimed
    const events = []
    let timer = null
    let running = false
    let stopped = false
    let stream = null
    let streamTimer = null
    let pokeTimer = null

    function log(...parts) {
        console.log('[NEXUS]', ...parts)
    }

    function enqueue(level, message) {
        if (events.length >= MAX_EVENTS_PER_FLUSH) events.shift()
        events.push({ level, message: String(message).slice(0, 400) })
    }

    async function call(method, route, body) {
        const url = baseUrl()
        if (!url) throw new Error('NEXUS_URL is not set')
        const res = await fetch(url + route, {
            method,
            headers: {
                'content-type': 'application/json',
                ...(state.token ? { authorization: `Bearer ${state.token}` } : {})
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(15000)
        })
        const text = await res.text()
        let parsed = null
        try { parsed = text ? JSON.parse(text) : null } catch { parsed = null }
        if (!res.ok) {
            const message = parsed?.error?.message || `${res.status} ${res.statusText}`
            const error = new Error(message)
            error.status = res.status
            throw error
        }
        return parsed || {}
    }

    function saveToken(token, botId, name) {
        state.token = token
        state.botId = botId || state.botId
        state.botName = name || state.botName
        try {
            fs.writeFileSync(TOKEN_FILE, JSON.stringify({
                token, botId: state.botId, name: state.botName, at: new Date().toISOString()
            }, null, 2))
            fs.chmodSync(TOKEN_FILE, 0o600)
        } catch (error) {
            log('could not persist the token:', error?.message || error)
        }
    }

    /* Zero-touch registration: the bot enrols itself with the website using a
       shared secret, so a fresh install needs no code copied by hand. */
    async function enrol() {
        const secret = String(process.env.NEXUS_ENROLL_SECRET || '').trim()
        const owner = String(process.env.NEXUS_OWNER_EMAIL || '').trim()
        if (!secret || !owner || state.token) return Boolean(state.token)
        try {
            const res = await fetch(baseUrl() + '/api/bot/v1/enroll', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-enroll-secret': secret },
                body: JSON.stringify({
                    ownerEmail: owner,
                    name: String(process.env.NEXUS_BOT_NAME || 'bigbrother-bot')
                }),
                signal: AbortSignal.timeout(15000)
            })
            const out = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error(out?.error?.message || `HTTP ${res.status}`)
            saveToken(out.token, out.botId, out.name)
            log(`enrolled with the panel as "${out.name}"`)
            enqueue('INFO', 'Agent enrolled automatically')
            return true
        } catch (error) {
            log('self-enrolment failed:', error?.message || error)
            state.lastError = error?.message || String(error)
            return false
        }
    }

    async function claimPairingCode() {
        const code = String(process.env.NEXUS_PAIR_CODE || '').trim()
        if (!code || state.token) return Boolean(state.token)
        try {
            const out = await call('POST', '/api/bots/pair', { code, version: botVersion() })
            saveToken(out.token, out.botId, out.name)
            log(`paired with the panel as "${out.name || out.botId}"`)
            enqueue('INFO', 'Bot linked to the Darknote panel')
            return true
        } catch (error) {
            log('pairing code rejected:', error.message)
            state.lastError = error.message
            return false
        }
    }

    function snapshot() {
        let list = []
        try { list = sessions() || [] } catch (error) {
            log('session snapshot failed:', error?.message || error)
            return []
        }
        return list.map(record => {
            const externalId = String(record.externalId || record.id || '').slice(0, 120)
            const phone = String(record.phone || '').replace(/\D/g, '')
            const status = mapState(record.state)
            return {
                externalId,
                ...(aliases.has(externalId) ? { requestId: aliases.get(externalId) } : {}),
                label: String(record.label || `+${phone}`).slice(0, 60),
                phone,
                status,
                statusDetail: String(record.lastError || '').slice(0, 300),
                ...(record.lastConnectedAt && status === 'CONNECTED'
                    ? { connectedAt: new Date(record.lastConnectedAt).toISOString() }
                    : {}),
                platform: 'DARKNOTE'
            }
        }).filter(item => item.externalId)
    }

    async function reportPairingResult(requestId, phone, outcome) {
        const body = outcome.ok
            ? { code: String(outcome.code), phone, expiresAt: new Date(Date.now() + 55000).toISOString() }
            : { error: String(outcome.reason || outcome.detail || 'pairing failed').slice(0, 300), phone }
        await call('POST', `/api/bot/v1/pairing/${encodeURIComponent(requestId)}`, body)
        if (outcome.ok) {
            if (outcome.sessionId) aliases.set(String(outcome.sessionId), requestId)
            log(`pairing code issued for +${phone}`)
            enqueue('INFO', `Pairing code issued for +${phone}`)
        } else {
            log(`pairing failed for +${phone}: ${body.error}`)
            enqueue('ERROR', `Pairing failed for +${phone}: ${body.error}`)
        }
    }

    async function servePairingRequests(requests) {
        if (!Array.isArray(requests) || !requests.length) return
        if (!pair) {
            log('the panel asked for a pairing code but this bot has no pairing hook')
            return
        }
        for (const request of requests) {
            const id = String(request?.id || '')
            const phone = String(request?.phone || '').replace(/\D/g, '')
            if (!id || handled.has(id)) continue
            if (!/^\d{8,15}$/.test(phone)) {
                handled.add(id)
                await reportPairingResult(id, phone, { ok: false, reason: 'invalid-number' }).catch(() => {})
                continue
            }
            handled.add(id)
            try {
                const outcome = await pair(phone)
                await reportPairingResult(id, phone, outcome || { ok: false, reason: 'no-outcome' })
            } catch (error) {
                await reportPairingResult(id, phone, { ok: false, reason: error?.message || String(error) }).catch(() => {})
            }
        }
    }

    async function flushEvents() {
        if (!events.length) return
        const batch = events.splice(0, MAX_EVENTS_PER_FLUSH)
        try {
            await call('POST', '/api/bot/v1/events', { events: batch })
        } catch {
            // Drop the batch: a permanently failing log must not grow forever.
        }
    }

    async function executeCommands() {
        let out
        try { out = await call('GET', '/api/bot/v1/commands') } catch { return }
        const commands = Array.isArray(out.commands) ? out.commands : []
        for (const command of commands) {
            const panelSessionId = command?.session?.id || null
            const externalId = command?.session?.externalId || ''
            let status = 'DONE'
            let result = ''
            try {
                if (command.type === 'RESTART' && restart) {
                    const done = await restart(externalId || 'main')
                    if (done && done.ok === false) { status = 'ERROR'; result = done.error || 'restart failed' }
                    else result = `restarted ${externalId || 'main'}`
                } else if (command.type === 'LOGOUT' && logout) {
                    const done = await logout(externalId)
                    if (done && done.ok === false) { status = 'ERROR'; result = done.error || 'logout failed' }
                    else result = `unlinked ${externalId}`
                } else {
                    status = 'ERROR'
                    result = `this bot cannot handle ${command.type}`
                }
            } catch (error) {
                status = 'ERROR'
                result = error?.message || String(error)
            }
            state.commandsRun += 1
            log(`${command.type} ${status.toLowerCase()}${result ? `: ${result}` : ''}`)
            enqueue(status === 'DONE' ? 'INFO' : 'ERROR', `${command.type} ${status.toLowerCase()}: ${result}`)
            await call('POST', `/api/bot/v1/commands/${encodeURIComponent(command.id)}`, {
                status, result: result.slice(0, 300)
            }).catch(() => {})
        }
    }

    async function cycle() {
        if (stopped) return
        if (!state.token && !(await claimPairingCode())) {
            schedule()
            return
        }
        try {
            const sessionsPayload = snapshot()
            const out = await call('POST', '/api/bot/v1/sync', {
                status: 'ONLINE',
                version: botVersion(),
                message: sessionsPayload.length
                    ? `bridge: ${sessionsPayload.length} session(s)`
                    : 'bridge: no WhatsApp sessions yet',
                sessions: sessionsPayload
            })
            state.online = true
            state.lastError = ''
            state.lastSyncAt = Date.now()
            state.reported = sessionsPayload.length
            if (!state.botId && out?.bot?.id) state.botId = out.bot.id

            await servePairingRequests(out?.pairingRequests || [])
            await executeCommands()
            await flushEvents()
        } catch (error) {
            state.online = false
            state.lastError = error?.message || String(error)
            if (error?.status === 401) {
                // Revoked or rotated: drop it. If enrolment is configured the bot
                // registers again by itself instead of needing a new code.
                log('the panel rejected this bot token — forgetting it')
                state.token = ''
                try { fs.unlinkSync(TOKEN_FILE) } catch { /* already gone */ }
                if (await enrol()) { schedule(); return }
                log('no enrolment secret configured: link a new code to continue')
                stopped = true
                return
            }
            log('panel unreachable:', state.lastError)
        }
        schedule()
    }

    /* Push channel: the website holds this stream open and wakes the bot the
       moment the owner asks for a pairing code, instead of waiting for the
       next poll tick. The poll stays as a fallback. */
    function poke() {
        if (stopped) return
        if (timer) { clearTimeout(timer); timer = null }
        if (pokeTimer) return
        pokeTimer = setTimeout(() => { pokeTimer = null; cycle() }, 120)
        pokeTimer.unref?.()
    }

    async function openStream() {
        if (stopped || !state.token) return
        const url = baseUrl()
        if (!url) return
        const controller = new AbortController()
        stream = controller
        try {
            const res = await fetch(url + '/api/bot/v1/stream', {
                headers: {
                    authorization: `Bearer ${state.token}`,
                    accept: 'text/event-stream'
                },
                signal: controller.signal
            })
            if (!res.ok || !res.body) throw new Error(`stream ${res.status}`)
            log('event stream connected — pairing requests are pushed instantly')
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            while (true) {
                const { value, done } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
                let index
                while ((index = buffer.indexOf('\n\n')) >= 0) {
                    const frame = buffer.slice(0, index)
                    buffer = buffer.slice(index + 2)
                    const line = frame.split('\n').find(part => part.startsWith('data:'))
                    if (!line) continue
                    try {
                        const event = JSON.parse(line.slice(5).trim())
                        if (event.type === 'pairing' || event.type === 'command' || event.type === 'sync') poke()
                    } catch { /* ignore malformed frame */ }
                }
            }
        } catch (error) {
            if (!stopped && error?.name !== 'AbortError') state.lastError = error?.message || String(error)
        }
        stream = null
        if (!stopped) {
            streamTimer = setTimeout(openStream, 2500)
            streamTimer.unref?.()
        }
    }

    function schedule() {
        if (stopped) return
        timer = setTimeout(cycle, intervalSeconds() * 1000)
        timer.unref?.()
    }

    async function start() {
        if (!state.token) await enrol()
        if (!boolEnv(process.env.NEXUS_ENABLED)) {
            log('disabled (NEXUS_ENABLED=false)')
            return false
        }
        const url = baseUrl()
        if (!url) {
            log('not configured — set NEXUS_URL and NEXUS_PAIR_CODE/NEXUS_TOKEN to link this bot to the panel')
            return false
        }
        if (running) return true
        running = true
        log(`linking to ${url} every ${intervalSeconds()}s${state.botName ? ` as ${state.botName}` : ''}`)
        // Do not await the first cycle: the bot must finish booting.
        timer = setTimeout(cycle, 2000)
        timer.unref?.()
        openStream()
        return true
    }

    function stop() {
        stopped = true
        if (timer) clearTimeout(timer)
        if (pokeTimer) clearTimeout(pokeTimer)
        if (streamTimer) clearTimeout(streamTimer)
        try { stream?.abort() } catch { /* already closed */ }
        timer = null
        running = false
    }

    function status() {
        return {
            enabled: Boolean(baseUrl()),
            online: state.online,
            botId: state.botId,
            botName: state.botName,
            sessions: state.reported,
            commandsRun: state.commandsRun,
            lastSyncAt: state.lastSyncAt ? new Date(state.lastSyncAt).toISOString() : null,
            lastError: state.lastError
        }
    }

    return { start, stop, status, _cycle: cycle }
}

module.exports = { createBridge, mapState }
