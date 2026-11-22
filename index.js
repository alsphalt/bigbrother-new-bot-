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
     * Anti-promote / anti-demote enforcement.
     *
     * Registered here (not in bigbro.js) because the listener needs the live socket, while
     * bigbro.js only ever receives (conn, m) per message. The toggles themselves are stored
     * per group in database/antiactions.json and set via .antipromote / .antidemote.
     */
    conn.ev.on('group-participants.update', async (update) => {
        try {
            const { id, participants, action, author } = update
            if (!['promote', 'demote'].includes(action)) return

            const file = path.join(__dirname, 'database', 'antiactions.json')
            let db = {}
            try { db = JSON.parse(fs.readFileSync(file)) || {} } catch {}
            if (Array.isArray(db)) db = {}

            const cfg = db[id]
            if (!cfg) return

            const key = action === 'promote' ? 'antipromote' : 'antidemote'
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
                    if (action === 'promote') {
                        await conn.groupParticipantsUpdate(id, [jid], 'demote')
                    } else {
                        await conn.groupParticipantsUpdate(id, [jid], 'promote')
                    }
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