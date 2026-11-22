/*

*/
const fs = require('fs')
const path = require('path')
const config = require('./fig.json')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require("mzazibaileys")
const pino = require('pino')
const { Boom } = require('@hapi/boom')
const readline = require('readline')
const { smsg, makeWASocket: makeWASocketSimple, bind } = require('./lib/msg.js')

let handleMessage = require('./bigbro.js')

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
})

const question = (text) => new Promise((resolve) => rl.question(text, resolve))

/* Keyed JSON stores (antiactions / adminSnapshot). readJSON() in bigbro.js
 * seeds [] which would drop the group keys on the next stringify. */
const readJSONObject = (file) => {
    try {
        if (!fs.existsSync(file)) fs.writeFileSync(file, '{}')
        const value = JSON.parse(fs.readFileSync(file, 'utf8'))
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    } catch {
        return {}
    }
}

const saveJSONObject = (file, data) => {
    fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

let reconnectTimeout = null
let isReconnecting = false
let pairCodeRequested = false
let pairAttempts = 0

function reload(file) {
    const filePath = path.resolve(file)

    fs.watchFile(filePath, () => {
        fs.unwatchFile(filePath)
        console.log(`Reloaded: ${file}`)

        delete require.cache[require.resolve(file)]

        try {
            if (file.includes('bigbro.js')) {
                handleMessage = require('./bigbro.js')
            } else if (file.includes('msg.js')) {
                delete require.cache[require.resolve('./lib/msg.js')]
                const msg = require('./lib/msg.js')
                global.smsg = msg.smsg
                global.bind = msg.bind
            }

            reload(file)
        } catch (err) {
            console.log(`❌ Error reload ${file}:`, err)
        }
    })
}

reload('./bigbro.js')
reload('./lib/msg.js')

async function connectToWhatsApp() {
    if (isReconnecting) return
    isReconnecting = true

    const { state, saveCreds } = await useMultiFileAuthState('auth')

    const conn = makeWASocketSimple({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Safari'),
        auth: state
    })

    bind(conn)

    if (!conn.authState.creds.registered && !pairCodeRequested && pairAttempts < 3) {
        pairCodeRequested = true
        pairAttempts += 1
        const digits = (value) => String(value || '').replace(/[^0-9]/g, '')

        // Non-interactive pairing: PAIR_NUMBER=<digits> npm start
        let phoneNumber = digits(process.env.PAIR_NUMBER)
        if (!phoneNumber) {
            console.log('This bot needs a WhatsApp number to pair (example: 628xxxxxx):')
            phoneNumber = digits(await question('NUMBER: '))
        }

        try {
            // The registration node can only be sent once the WebSocket is open.
            // Requesting earlier throws Boom 428 "Connection Closed".
            await conn.waitForSocketOpen()
            await new Promise((r) => setTimeout(r, 1500))

            const code = await conn.requestPairingCode(phoneNumber, 'DARKNOTE')
            console.log(`PAIR 🧑‍💻 CODE: ${code}`)
            console.log(`PAIR_NUMBER_USED: ${phoneNumber}`)
            console.log('Enter this 8-character code in WhatsApp > Linked devices > Link with phone number')
        } catch (err) {
            console.error('PAIRING FAILED:', err?.message || err)
            pairCodeRequested = false
        }
    }

    conn.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            let m = chatUpdate.messages[0]
            console.log('[INBOUND]', JSON.stringify({
                type: chatUpdate.type,
                count: chatUpdate.messages?.length || 0,
                jid: m?.key?.remoteJid || null,
                fromMe: !!m?.key?.fromMe,
                hasMessage: !!m?.message,
                keys: m?.message ? Object.keys(m.message).join(',') : null
            }))
            if (!m.message) return
            if (m.key?.remoteJid === 'status@broadcast') return
            

            let processedMsg
            try {
                processedMsg = await smsg(conn, m)
            } catch (err) {
                console.error('❌ smsg error:', err.message)
                return
            }

            if (!processedMsg) return

            // LID-addressed DM chats are not reliably routable for outbound sends on
            // this fork; the PN form of the same peer is. Groups (@g.us) are untouched.
            if (String(processedMsg.chat || '').endsWith('@lid') &&
                /@s\.whatsapp\.net$/.test(String(processedMsg.sender || ''))) {
                console.log('[JID] mapping lid chat ->', processedMsg.sender)
                processedMsg.chat = processedMsg.sender
            }

            console.log('[PARSED]', JSON.stringify({
                sender: processedMsg.sender || null,
                chat: processedMsg.chat || null,
                fromMe: !!processedMsg.fromMe,
                text: String(processedMsg.text || '').slice(0, 60)
            }))

            await handleMessage(conn, processedMsg)
            console.log('[HANDLED]')
        } catch (err) {
            console.error('❌ messages.upsert error:', err)
        }
    })

    /*
     * Anti-demote enforcement.
     *
     * Registered here (not in bigbro.js) because the listener needs the live socket, while
     * bigbro.js only ever receives (conn, m) per message. The toggle is stored per group
     * in database/antiactions.json and set via .antidemote. Anti-promote has its own
     * snapshot-based listener below.
     */
    conn.ev.on('group-participants.update', async (update) => {
        try {
            const { id, participants, action, author } = update
            if (action !== 'demote') return

            const file = path.join(__dirname, 'database', 'antiactions.json')
            const db = readJSONObject(file)

            const cfg = db[id]
            if (!cfg) return

            const key = 'antidemote'
            if (!cfg[key]) return

            // Skip actions by the bot itself (would loop) and by the configured owner.
            const authorNum = String(author || '').split('@')[0].split(':')[0]
            const creatorNum = String(config.ownerNumber || '').replace(/\D/g, '')
            if (creatorNum && authorNum === creatorNum) return
            const botNum = String(conn.user?.id || '').split('@')[0].split(':')[0]
            if (authorNum === botNum) return

            const reverted = []
            for (const jid of participants || []) {
                try {
                    await conn.groupParticipantsUpdate(id, [jid], 'promote')
                    reverted.push(jid)
                } catch (error) {
                    console.error('[antiaction] revert failed for', jid, error?.message || error)
                }
            }
            if (!reverted.length) return

            await conn.sendMessage(id, {
                text: `🛡️ *Anti-${key}* aktif.\n` +
                      `Aksi ${action} oleh @${authorNum} telah dibatalkan.`,
                mentions: author ? [author] : []
            })
        } catch (error) {
            console.error('[antiaction]', error)
        }
    })

    /*
     * ANTI-PROMOTE — snapshot based.
     *
     * WhatsApp gives no reliable "who promoted whom" for a rogue promotion, so the
     * only trustworthy signal is the admin list itself: keep a per-group snapshot
     * (database/adminSnapshot.json) and treat any JID that became admin without
     * being in that snapshot as a rogue promotion. The promoter (event author) and
     * the promoted user are both demoted, unless the promoter is the creator or the
     * bot itself. The snapshot is seeded when the feature is switched on and kept
     * fresh on every participant event, so enabling the feature never mass-demotes
     * the admins that were already there.
     */
    conn.ev.on('group-participants.update', async (update) => {
        try {
            const { id, participants, action, author } = update
            if (!['promote', 'demote', 'add', 'remove'].includes(action)) return

            const file = path.join(__dirname, 'database', 'antiactions.json')
            const snapFile = path.join(__dirname, 'database', 'adminSnapshot.json')
            const db = readJSONObject(file)
            const snap = readJSONObject(snapFile)

            const adminsOf = (meta) => (meta?.participants || [])
                .filter(p => p.admin === 'admin' || p.admin === 'superadmin')
                .map(p => p.id)

            if (!db[id]?.antipromote) {
                // Keep the snapshot fresh even when the feature is off.
                try {
                    const meta = await conn.groupMetadata(id)
                    snap[id] = adminsOf(meta)
                    saveJSONObject(snapFile, snap)
                } catch { }
                return
            }

            // ── resolve protected identities ────────────────────────────────
            const norm = (j) => String(j || '').split('@')[0].split(':')[0].replace(/\D/g, '')
            const creatorNum = String(config.ownerNumber || '').replace(/\D/g, '')
            const botNum = norm(conn.user?.id)
            const authorNum = norm(author)

            const isProtected = (jid) => {
                const n = norm(jid)
                if (!n) return false // missing author must not read as "protected"
                return (!!creatorNum && n === creatorNum) || (!!botNum && n === botNum)
            }

            // ── fetch current admins & diff against the snapshot ────────────
            const meta = await conn.groupMetadata(id)
            const currentAdmins = adminsOf(meta)
            const previousAdmins = Array.isArray(snap[id]) ? snap[id] : []

            const newAdmins = currentAdmins.filter(j => !previousAdmins.includes(j))

            // Update the snapshot regardless of what happens next.
            snap[id] = currentAdmins
            saveJSONObject(snapFile, snap)

            if (!newAdmins.length) return // nothing newly promoted

            // ── decide who to demote ───────────────────────────────────────
            const targets = []

            for (const newAdmin of newAdmins) {
                if (isProtected(newAdmin)) continue // creator / bot promoted → allowed
                if (isProtected(author)) continue   // promoter is creator or bot → allow
                // real rogue promote → demote BOTH promoter and promoted
                targets.push(newAdmin)
                if (author && !isProtected(author)) targets.push(author)
            }

            const uniqueTargets = [...new Set(targets)]
            if (!uniqueTargets.length) return

            // ── FAST ACTION: single batched demote call ─────────────────────
            try {
                await conn.groupParticipantsUpdate(id, uniqueTargets, 'demote')
            } catch (error) {
                console.error('[antipromote] batch demote failed:', error?.message || error)
                // Fallback: one by one so one bad JID does not block the rest.
                for (const target of uniqueTargets) {
                    try {
                        await conn.groupParticipantsUpdate(id, [target], 'demote')
                    } catch (err) {
                        console.error('[antipromote]', target, err?.message || err)
                    }
                }
            }

            // ── notify ─────────────────────────────────────────────────────
            await conn.sendMessage(id, {
                text:
                    `🛡️ *ANTI-PROMOTE TRIGGERED*\n\n` +
                    `Promoted by : @${authorNum || 'unknown'}\n` +
                    `New admin   : ${newAdmins.map(j => '@' + norm(j)).join(', ')}\n` +
                    `Action      : demoted ${uniqueTargets.length} user(s)`,
                mentions: [...uniqueTargets, ...newAdmins, author].filter(Boolean)
            }).catch(() => { })
        } catch (error) {
            console.error('[antipromote]', error)
        }
    })

    /*
     * ANTICALL — incoming call offers.
     *
     * Baileys emits `call` with an array of call events. The handler lives in
     * bigbro.js and re-reads database/anticall.json on every event, so
     * `.anticall off` takes effect immediately without a restart.
     */
    conn.ev.on('call', async (calls) => {
        const list = Array.isArray(calls) ? calls : [calls]
        for (const call of list) {
            try {
                const handler = handleMessage.handleIncomingCall
                if (typeof handler !== 'function') continue
                const result = await handler(conn, call)
                if (result?.action && result.action !== 'ignored') {
                    console.log('[anticall]', result.action, call?.from || '', result.reason || '')
                }
            } catch (error) {
                console.error('[anticall] handler failed:', error?.stack || error)
            }
        }
    })

    conn.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update

        if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut

            console.log('Connection closed, reconnecting:', shouldReconnect)

            if (shouldReconnect) {
                if (reconnectTimeout) clearTimeout(reconnectTimeout)

                reconnectTimeout = setTimeout(() => {
                    isReconnecting = false
                    connectToWhatsApp()
                }, 5000)
            } else {
                console.log('🔒 Logged out, auto-reconnect disabled')
                isReconnecting = false
            }
        } else if (connection === 'open') {
            console.log('✅ Connected to WhatsApp')
            isReconnecting = false

            if (process.env.DEBUG_SEND_ON_OPEN === '1') {
                try {
                    const target = conn.user.id
                    const sent = await conn.sendMessage(target, { text: '[BOT SELFTEST] outbound text path OK' })
                    console.log('[SELFTEST] text sent to', target, 'id=', sent?.key?.id || 'none')
                } catch (err) {
                    console.error('[SELFTEST] text failed:', err?.message || err)
                }
                if (process.env.DEBUG_SEND_LID) {
                    try {
                        const sent = await conn.sendMessage(process.env.DEBUG_SEND_LID, { text: '[BOT SELFTEST] LID chat path OK' })
                        console.log('[SELFTEST] lid sent to', process.env.DEBUG_SEND_LID, 'id=', sent?.key?.id || 'none')
                    } catch (err) {
                        console.error('[SELFTEST] lid failed:', err?.message || err)
                    }
                }
            }

            if (reconnectTimeout) clearTimeout(reconnectTimeout)
        }
    })

    conn.ev.on('creds.update', saveCreds)
}

connectToWhatsApp()