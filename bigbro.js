/*
━━━━━━━━━━━━━━━━━━━━
*/
const baileys = require('mzazibaileys')

const {
    default: makeWASocket,
    proto,
    generateWAMessageFromContent,
    generateWAMessage,
    generateWAMessageContent,
    prepareWAMessageMedia,
    downloadContentFromMessage,
    downloadAndSaveMediaMessage,
    jidNormalizedUser,
    getContentType,
    fetchLatestBaileysVersion,
    useSingleFileAuthState,
    makeInMemoryStore,
    DisconnectReason,
    Browsers
} = baileys

const os = require('os');
const util = require('util');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp')
const { exec } = require('child_process');
const { fileTypeFromBuffer } = require('file-type');
const { writeExif } = require('./lib/StickerMaker.js');

const config = require('./fig.json');
const ownerPath = path.join(__dirname, 'database', 'owner.json');
const premiumPath = path.join(__dirname, 'database', 'premium.json');

/* ---------------- media: .song / .shazam support ---------------- */

const { resolveSong } = require('./lib/ytsearch.js');
const shazam = require('./lib/shazam.js');

// Loaded defensively: if axios (a ytdl.source.js dependency) is missing the bot
// must still boot, with .song reporting a clear message instead of crashing.
let songEngine = null;
try {
    songEngine = require('./lib/heromodes/ytdl.source.js');
} catch (error) {
    console.error('[SONG] audio engine unavailable:', error?.message || error);
}

const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

const safeFileName = (title) => String(title || 'song')
    .replace(/[\\/:*?"<>|\n\r]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'song';

/** Download a YouTube audio buffer, or explain why it failed. */
const downloadSongAudio = async (url) => {
    if (!songEngine?.ytdlAutoBuffer) {
        return { status: false, error: 'Audio engine is unavailable. Run "npm install" then restart the bot.' };
    }
    const result = await songEngine.ytdlAutoBuffer(url, 'audio');
    if (!result?.status || !Buffer.isBuffer(result.buffer)) {
        return { status: false, error: result?.error || 'Semua provider gagal mengunduh audio.' };
    }
    return { ...result, status: true };
};

/** Send a downloaded buffer as WhatsApp audio (document if it is too big). */
const sendSongAudio = async (conn, m, result, fallbackTitle) => {
    const title = safeFileName(result.title || fallbackTitle);
    // yt-dlp returns m4a (audio/mp4); ytdl-core returned mp4/webm too. Labelling a
    // non-mp3 buffer as ".mp3" made WhatsApp show it as an unknown document.
    const mimetype = result.mimetype || 'audio/mpeg';
    const ext = /mp4|m4a/.test(mimetype) ? 'm4a'
        : /ogg|opus/.test(mimetype) ? 'ogg'
        : /webm/.test(mimetype) ? 'webm'
        : /wav/.test(mimetype) ? 'wav'
        : 'mp3';
    const fileName = `${title}.${ext}`;
    if (result.buffer.length > MAX_AUDIO_BYTES) {
        await conn.sendMessage(m.chat, {
            document: result.buffer,
            mimetype,
            fileName
        }, { quoted: m });
        return 'document';
    }
    await conn.sendMessage(m.chat, {
        audio: result.buffer,
        mimetype,
        fileName,
        ptt: false
    }, { quoted: m });
    return 'audio';
};

const readJSON = (file) => {
    try {
        if (!fs.existsSync(file)) fs.writeFileSync(file, '[]');
        return JSON.parse(fs.readFileSync(file));
    } catch {
        return [];
    }
};

const saveJSON = (file, data) => {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
};

// readJSON() seeds a missing file with [], which would silently break the keyed
// antiactions store (an array drops string keys on stringify). This variant keeps {}.
const readJSONObject = (file) => {
    try {
        if (!fs.existsSync(file)) fs.writeFileSync(file, '{}');
        const value = JSON.parse(fs.readFileSync(file));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
        return {};
    }
};

const isGroupAdminOf = (participants, jid) => {
    const me = getNumber(jid);
    if (!me) return false;
    const row = (participants || []).find(p =>
        getNumber(p.id || p.jid || p.lid) === me
    );
    return !!row && (row.admin === 'admin' || row.admin === 'superadmin');
};

const getNumber = (jid = '') => String(jid).split('@')[0].replace(/\D/g, '');

const isCreator = (m) => {
    const sender = getNumber(m.sender);
    const creator = String(config.ownerNumber || '').replace(/\D/g, '');
    return sender === creator;
};

const isOwner = (m) => {
    const sender = getNumber(m.sender);
    const ownerDB = readJSON(ownerPath);
    const creator = String(config.ownerNumber || '').replace(/\D/g, '');
    return sender === creator || ownerDB.includes(sender);
};

const isPremium = (m) => {
    const sender = getNumber(m.sender);
    const premiumDB = readJSON(premiumPath);
    return isOwner(m) || premiumDB.includes(sender);
};

// ─────────────────────────────────────────────────────────────────────
// ANTICALL — helpers
// ─────────────────────────────────────────────────────────────────────
const anticallPath = path.join(__dirname, 'database', 'anticall.json');

const ANTICALL_DEFAULTS = {
    enabled: false,
    action: 'reject',
    warn: true,
    warnText: '📵 Calls are not accepted on this bot. Please send a text message instead.',
    autoBlock: false,
    whitelist: [],
    blocked: []
};

const normPhone = (jid = '') =>
    String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');

const loadAnticall = () => {
    // readJSONObject() keeps {} so spread order and array fields stay sane;
    // readJSON() would seed [] and silently swallow the stored settings.
    const stored = readJSONObject(anticallPath);
    return {
        ...ANTICALL_DEFAULTS,
        ...stored,
        whitelist: Array.isArray(stored.whitelist) ? stored.whitelist.map(normPhone) : [],
        blocked: Array.isArray(stored.blocked) ? stored.blocked.map(normPhone) : []
    };
};

const saveAnticall = (cfg) => saveJSON(anticallPath, cfg);

const isWhitelisted = (cfg, callerJid) =>
    Array.isArray(cfg.whitelist) && cfg.whitelist.includes(normPhone(callerJid));

/**
 * Handle an incoming call.
 * @param {object} conn Baileys socket
 * @param {object} call { id, from, status, isVideo }
 * @returns {Promise<{action: 'ignored'|'rejected'|'blocked'|'error', reason?: string}>}
 */
const handleIncomingCall = async (conn, call) => {
    const cfg = loadAnticall();

    // 1. Master switch
    if (!cfg.enabled) return { action: 'ignored', reason: 'disabled' };

    // 2. Only react to offers (not timeouts, terminates, etc.)
    if (call?.status !== 'offer') return { action: 'ignored', reason: 'not-offer' };

    // 3. Whitelist bypass
    if (isWhitelisted(cfg, call.from)) {
        return { action: 'ignored', reason: 'whitelisted' };
    }

    // 4. Reject the call
    try {
        await conn.rejectCall(call.id, call.from);
    } catch (e) {
        console.error('[anticall] rejectCall failed:', e?.message || e);
        return { action: 'error', reason: 'reject-failed' };
    }

    // 5. Optional warning message
    if (cfg.warn && cfg.warnText) {
        try {
            await conn.sendMessage(call.from, { text: cfg.warnText });
        } catch (e) {
            console.error('[anticall] warn send failed:', e?.message || e);
        }
    }

    // 6. Optional auto-block
    const shouldBlock = cfg.autoBlock || cfg.action === 'block';
    if (shouldBlock) {
        try {
            await conn.updateBlockStatus(call.from, 'block');
            // Track blocked callers for `.anticall unblock <n>`
            if (!cfg.blocked.includes(normPhone(call.from))) {
                cfg.blocked.push(normPhone(call.from));
                saveAnticall(cfg);
            }
            return { action: 'blocked' };
        } catch (e) {
            console.error('[anticall] block failed:', e?.message || e);
            return { action: 'rejected', reason: 'block-failed' };
        }
    }

    return { action: 'rejected' };
};

// System executeEval
const executeEval = async (code, conn, m) => {
    try {
        let result

        if (code.includes('\n') || code.includes(';')) {
            result = await eval(`
                (async (conn, m, require, fs, util) => {
                    ${code}
                })(conn, m, require, fs, util)
            `)
        } else {
            result = await eval(`
                (async (conn, m, require, fs, util) => {
                    return (${code})
                })(conn, m, require, fs, util)
            `)
        }

        if (typeof result !== 'string') {
            result = util.inspect(result, {
                depth: 1
            })
        }

        m.reply(result || 'undefined')
    } catch (e) {
        m.reply(String(e))
    }
}

//System Detect id all Button, id button gapake titik (.)
const extractCommandFromMessage = (m) => {
    let body = '';
    let isButtonResponse = false;
    try {
        if (m.message) {
            if (m.message.conversation) body = m.message.conversation;
            else if (m.message.extendedTextMessage?.text) body = m.message.extendedTextMessage.text;
            else if (m.message.imageMessage?.caption) body = m.message.imageMessage.caption;
            else if (m.message.videoMessage?.caption) body = m.message.videoMessage.caption;
            else if (m.message.documentMessage?.caption) body = m.message.documentMessage.caption;
            else if (m.message.interactiveResponseMessage) {
                const inter = m.message.interactiveResponseMessage;
                if (inter.nativeFlowResponseMessage) {
                    const flow = inter.nativeFlowResponseMessage;
                    if (flow.paramsJson) {
                        try {
                            const params = JSON.parse(flow.paramsJson);
                            body = params.id || params.buttonId || params.rowId || params.index || '';
                        } catch { body = flow.name || ''; }
                    } else body = flow.name || '';
                    isButtonResponse = true;
                } else if (inter.buttonReply) {
                    body = inter.buttonReply.selectedButtonId || '';
                    isButtonResponse = true;
                } else if (inter.singleSelectReply) {
                    body = inter.singleSelectReply.selectedRowId || '';
                    isButtonResponse = true;
                }
            } else if (m.message.templateButtonReplyMessage) {
                body = m.message.templateButtonReplyMessage.selectedId || '';
                isButtonResponse = true;
            } else if (m.message.buttonsResponseMessage) {
                body = m.message.buttonsResponseMessage.selectedButtonId || '';
                isButtonResponse = true;
            }
        }
    } catch (error) {
        console.error('Error parsing message:', error);
    }
    return { body, isButtonResponse };
};




module.exports = async (conn, m) => {
    try {
        const { body, isButtonResponse } = extractCommandFromMessage(m);
        if (!body) return;
        if (body) m.text = body;

        let command = '';
        let args = [];

        if (isButtonResponse) {
            const parts = body.split(/ +/);
            command = parts[0].toLowerCase();
            args = parts.slice(1);
        } else {
            const trimmed = body.trim();
            if (trimmed.startsWith(']>')) {
                if (!isCreator(m)) return m.reply('Eval is creator-only.');
                const evalCode = trimmed.slice(2).trim();
                if (!evalCode) return m.reply('Example:\n]> 1+1');
                return await executeEval(evalCode, conn, m);
            }
            if (trimmed.startsWith('$')) {
                if (!isCreator(m)) return m.reply('❌ Shell is creator-only.');
                const shellCmd = trimmed.slice(1).trim();
                if (!shellCmd) return m.reply('Example: $ ls -la');
                m.reply('⏳ Running shell command...');
                exec(shellCmd, { timeout: 30000, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
                    let output = stdout || stderr || error?.message || '✅ Done (no output)';
                    if (output.length > 2000) output = output.slice(0, 2000) + '\n... (output truncated)';
                    m.reply(`💻 Output:\n${output}`);
                });
                return;
            }
            if (body.startsWith(config.prefix || '.')) {
                const cleanBody = body.slice(1).trim();
                const parts = cleanBody.split(/ +/);
                command = parts[0].toLowerCase();
                args = parts.slice(1);
            } else {
                return;
            }
        }

        const { reply } = m;

        // Guarded: a missing/corrupt menu.jpg must not take down every command.
        let thumb
        try {
            thumb = await sharp('./src/img/menu.jpg')
                .resize(300, 300)
                .jpeg({ quality: 80 })
                .toBuffer()
        } catch (error) {
            console.log('[MENU] thumbnail unavailable:', error?.message || error)
        }

        const allMenuText = () => `*ALL MENU*

*MAIN*
• ${config.prefix || '.'}menu
• ${config.prefix || '.'}ping
• ${config.prefix || '.'}info
• ${config.prefix || '.'}owner
• ${config.prefix || '.'}myjid

*STICKER*
• ${config.prefix || '.'}sticker
• ${config.prefix || '.'}s

*MEDIA*
• ${config.prefix || '.'}song <title/link>
• ${config.prefix || '.'}play <title/link>
• ${config.prefix || '.'}shazam (reply to audio/video)

*GROUP*
• ${config.prefix || '.'}antipromote on/off
• ${config.prefix || '.'}antidemote on/off

*OWNER*
• ${config.prefix || '.'}anticall on/off
• ${config.prefix || '.'}addowner
• ${config.prefix || '.'}delowner
• ${config.prefix || '.'}addprem
• ${config.prefix || '.'}delprem
• ${config.prefix || '.'}eval`

        // Location-header button card. WhatsApp renders the thumbnail as the header and
        // the buttons under it; the caller falls back to plain text if the payload is
        // rejected so the menu is never silent.
        const sendImageCard = async (caption) => {
            if (!thumb) throw new Error('menu image unavailable')
            await conn.sendMessage(m.chat, { image: thumb, caption }, { quoted: m })
        }

        /*
         * MENU DELIVERY — legacy buttonsMessage by default.
         *
         * A plain image + caption carries no buttons, so the menu looked like a
         * dead end. The legacy buttonsMessage (location header + type-1 buttons)
         * is what most clients actually render; the newer interactive card is
         * kept as an opt-in for clients that handle it better.
         *
         *     fig.json -> menu.mode = "legacy" | "interactive"   (default "legacy")
         *
         * If the button message cannot be relayed, the image card and then plain
         * text are used, so `.menu` always produces something visible.
         */
        const MENU_BUTTONS = [
            { id: 'allmenu', text: '📋 ALL MENU' },
            { id: 'ping', text: '⚡ PING' },
            { id: 'owner', text: '👑 OWNER' }
        ]

        const menuMode = () => String(config.menu?.mode || 'legacy').toLowerCase() === 'interactive'
            ? 'interactive'
            : 'legacy'

        const sendLegacyMenu = async (text) => {
            const content = {
                buttonsMessage: {
                    locationMessage: {
                        degreesLatitude: 0,
                        degreesLongitude: 0,
                        name: 'DARKNOTE',
                        address: 'bigbrother Base Bot',
                        jpegThumbnail: thumb
                    },
                    contentText: text,
                    footerText: 'DARKNOTE • bigbrothercode',
                    buttons: MENU_BUTTONS.map(button => ({
                        buttonId: button.id,
                        buttonText: { displayText: button.text },
                        type: 1
                    })),
                    headerType: 6
                }
            }
            const msg = generateWAMessageFromContent(m.chat, content, {
                quoted: m,
                userJid: conn.user?.id
            })
            await conn.relayMessage(m.chat, msg.message, { messageId: msg.key.id })
        }

        const sendMenu = async (text) => {
            if (menuMode() === 'legacy') {
                try {
                    await sendLegacyMenu(text)
                    return
                } catch (error) {
                    console.log('[MENU] legacy button message failed, falling back:', error?.message || error)
                }
            }
            try {
                await sendImageCard(text)
            } catch (error) {
                console.log('[MENU] image card failed, sending text instead:', error?.message || error)
                await reply(text)
            }
        }

       // Self
       if (config.mode === 'self' && !isCreator(m)) return
       //Case
        switch (command) {

        case 'menu': {
    const runtime = process.uptime()

    const days = Math.floor(runtime / 86400)
    const hours = Math.floor((runtime % 86400) / 3600)
    const minutes = Math.floor((runtime % 3600) / 60)
    const seconds = Math.floor(runtime % 60)

    const ping = Date.now() - (Number(m.messageTimestamp) * 1000)
    const mode = config.mode === 'self' ? 'SELF' : 'PUBLIC'

    const infoText = `┏━━━〔 BOT INFO 〕━━━⬣
┃
┃❍ Bot Name : bigbrother Base Bot
┃❍ Developer : bigbrothercode
┃❍ Type : Case
┃❍ Mode : ${mode}
┃❍ Number : ${String(m.sender).replace(/@.+/g, '')}
┃❍ Ping : ${Math.floor(ping)} ms
┃❍ Runtime : ${days}d ${hours}h ${minutes}m ${seconds}s
┃
┗━━━━━━━━━━━━━━⬣`

    const body = `${infoText}\n\n${allMenuText()}`
    await sendMenu(body)
    break
}

        case 'allmenu': {
            await sendMenu(allMenuText())
            break
        }

            case 'owner':
            case 'cekowner': {
                const creator = isCreator(m);
                const owner = isOwner(m);
                const status = creator ? '👑 You are the CREATOR' : owner ? '✅ You are an OWNER' : '❌ You are not an owner';
                const info = `Your JID: ${m.sender}\nCreator: ${config.ownerNumber}@s.whatsapp.net`;
                await reply(`${status}\n\n${info}`);
                break;
            }

            case 'myjid':
                await reply(`Your JID: ${m.sender}`);
                break;

            case 'ping': {
                const start = Date.now();
                const sent = await reply('Measuring ping...');
                const latency = Date.now() - start;
                const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
                const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
                const uptimeHours = (os.uptime() / 3600).toFixed(2);
                const cpuModel = os.cpus()[0]?.model || 'Unknown';
                const cpuCores = os.cpus().length;
                const vpsText = `VPS DATA\n- Hostname: ${os.hostname()}\n- Platform: ${os.platform()} ${os.arch()}\n- Uptime: ${uptimeHours} hours\n- RAM: ${freeMem} GB / ${totalMem} GB (Free/Total)\n- CPU: ${cpuCores} Core, ${cpuModel.substring(0, 30)}`;
                await conn.sendMessage(m.chat, { text: `Pong! ${latency} ms\n\n${vpsText}`, edit: sent.key });
                break;
            }

            case 'info': {  
                await reply(`MESSAGE INFO\n\nSender JID: ${m.sender}\nChat JID: ${m.chat}\nGroup: ${m.isGroup ? 'Yes' : 'No'}\nFrom Bot: ${m.fromMe ? 'Yes' : 'No'}\nMessage ID: ${m.id || '-'}\nText: ${m.text || '-'}`);
                break;
            }

            case 'sticker':
            case 's': {
                if (!m.quoted && !args[0]) return reply('Reply to an image/video or send a URL with .sticker <url>');
                let mediaBuffer;
                if (m.quoted && (m.quoted.mtype === 'imageMessage' || m.quoted.mtype === 'videoMessage')) {
                    mediaBuffer = await m.quoted.download();
                } else if (args[0] && args[0].match(/https?:\/\//)) {
                    const res = await fetch(args[0]);
                    mediaBuffer = Buffer.from(await res.arrayBuffer());
                } else return reply('Unrecognised format. Reply to media or send a URL.');
                if (!mediaBuffer) return reply('Failed to fetch media.');
                const type = await fileTypeFromBuffer(mediaBuffer);
                if (!type || (!/image/.test(type.mime) && !/video/.test(type.mime))) return reply('Only images and videos are supported.');
                await reply('Creating sticker...');
                try {
                    const stickerBuffer = await writeExif(mediaBuffer, { packname: 'Sticker Bot', author: 'bigbrothercode', cropToSquare: false });
                    await conn.sendMessage(m.chat, { sticker: stickerBuffer }, { quoted: m });
                } catch (err) {
                    console.error(err);
                    await reply('Failed to create sticker: ' + err.message);
                }
                break;
            }

            case 'song':
            case 'play': {
                const query = args.join(' ').trim();
                if (!query) {
                    return reply(`🎵 *SONG DOWNLOADER*\n\nExample:\n${config.prefix || '.'}song Burna Boy - Last Last\n${config.prefix || '.'}song https://youtu.be/qrO4YZeyl0I\n\nYou can also send a YouTube link directly.`);
                }
                if (query.length > 150) return reply('Query is too long (150 characters max).');

                await reply('🔎 Searching YouTube...');

                let song;
                try {
                    song = await resolveSong(query);
                } catch (error) {
                    return reply(`❌ ${error?.message || 'YouTube search failed.'}`);
                }

                await reply(`🎵 *${song.title}*\n👤 ${song.author}${song.duration ? `\n⏱️ ${song.duration}` : ''}\n\n⏳ Downloading audio...`);

                const audio = await downloadSongAudio(song.url);
                if (!audio.status) return reply(`❌ Failed to download audio.\n\n${audio.error}`);

                await sendSongAudio(conn, m, audio, song.title);
                break;
            }

            case 'shazam':
            case 'whatsong': {
                const quotedType = String(m.quoted?.mtype || '');
                const ownType = String(m.mtype || '');
                const media = /audio|video/i.test(quotedType) ? m.quoted
                    : /audio|video/i.test(ownType) ? m
                        : null;

                if (!media) {
                    return reply(`🎧 *SHAZAM*\n\nReply to an audio message, voice note, or video with ${config.prefix || '.'}shazam to identify the song.`);
                }

                await reply('🎧 Analysing audio...');

                let mediaBuffer;
                try {
                    mediaBuffer = await media.download();
                } catch (error) {
                    return reply(`❌ Failed to fetch media: ${error?.message || error}`);
                }
                if (!mediaBuffer?.length) return reply('❌ Media is empty or failed to download.');

                const match = await shazam.identify(mediaBuffer);
                if (!match.ok) return reply(`❌ ${match.message}`);

                await reply(shazam.formatMatch(match));
                await reply('⏳ Searching and downloading the song...');

                try {
                    const found = await resolveSong(match.query);
                    const audio = await downloadSongAudio(found.url);
                    if (!audio.status) return reply(`⚠️ Song identified, but the audio download failed.\n\n${audio.error}`);
                    await sendSongAudio(conn, m, audio, found.title);
                } catch (error) {
                    await reply(`⚠️ Song identified, but the audio could not be downloaded automatically.\n${error?.message || error}`);
                }
                break;
            }

            case 'addowner': {
                if (!isCreator(m)) return reply('Creator only');
                let target = args[0];
                if (m.mentionedJid?.[0]) target = m.mentionedJid[0];
                if (!target) return reply('Example: .addowner 628xxx');
                const ownerDB = readJSON(ownerPath);
                const num = getNumber(target);
                if (ownerDB.includes(num)) return reply('Already an owner');
                ownerDB.push(num);
                saveJSON(ownerPath, ownerDB);
                reply(`Owner added\n${num}`);
                break;
            }

            case 'delowner': {
                if (!isCreator(m)) return reply('Creator only');
                let target = args[0];
                if (m.mentionedJid?.[0]) target = m.mentionedJid[0];
                if (!target) return reply('Example: .delowner 628xxx');
                const ownerDB = readJSON(ownerPath);
                const num = getNumber(target);
                const filtered = ownerDB.filter(v => v !== num);
                saveJSON(ownerPath, filtered);
                reply(`Owner removed\n${num}`);
                break;
            }

            case 'addprem': {
                if (!isOwner(m)) return reply('Owner only');
                let target = args[0];
                if (m.mentionedJid?.[0]) target = m.mentionedJid[0];
                if (!target) return reply('Example: .addprem 628xxx');
                const premiumDB = readJSON(premiumPath);
                const num = getNumber(target);
                if (premiumDB.includes(num)) return reply('Already premium');
                premiumDB.push(num);
                saveJSON(premiumPath, premiumDB);
                reply(`Premium added\n${num}`);
                break;
            }

            case 'delprem': {
                if (!isOwner(m)) return reply('Owner only');
                let target = args[0];
                if (m.mentionedJid?.[0]) target = m.mentionedJid[0];
                if (!target) return reply('Example: .delprem 628xxx');
                const premiumDB = readJSON(premiumPath);
                const num = getNumber(target);
                const filtered = premiumDB.filter(v => v !== num);
                saveJSON(premiumPath, filtered);
                reply(`Premium removed\n${num}`);
                break;
            }

            case 'eval': {
                if (!isCreator(m)) return reply('Creator only');
                const code = args.join(' ');
                if (!code) return reply('Example:\n.eval 1+1');
                await executeEval(code, conn, m);
                break;
            }
            
           case 'antipromote': {
    if (!m.isGroup) return m.reply('Only for groups.');

    const meta = await conn.groupMetadata(m.chat);
    const senderIsAdmin = isGroupAdminOf(meta?.participants, m.sender);

    if (!senderIsAdmin && !isOwner(m) && !isCreator(m))
        return m.reply('Group admin / owner only.');

    const file = path.join(__dirname, 'database', 'antiactions.json');
    const snapFile = path.join(__dirname, 'database', 'adminSnapshot.json');

    const db = readJSONObject(file);
    const snap = readJSONObject(snapFile);
    db[m.chat] = db[m.chat] && typeof db[m.chat] === 'object' ? db[m.chat] : {};

    const arg = (args[0] || '').toLowerCase();

    if (arg === 'on' || arg === 'off') {
        db[m.chat].antipromote = arg === 'on';
        // Seed the snapshot with the CURRENT admins so existing admins are not
        // mass-demoted on the first event after enabling.
        snap[m.chat] = (meta?.participants || [])
            .filter(p => p.admin === 'admin' || p.admin === 'superadmin')
            .map(p => p.id);
        saveJSON(file, db);
        saveJSON(snapFile, snap);
        return m.reply(`✅ *antipromote* → *${arg.toUpperCase()}*`);
    }

    return m.reply(
        `*antipromote*: ${db[m.chat].antipromote ? 'ON' : 'OFF'}\n\n` +
        `• ${config.prefix || '.'}antipromote on\n` +
        `• ${config.prefix || '.'}antipromote off`
    );
}

           case 'antidemote': {
    if (!m.isGroup) return m.reply('This command only works in groups.');

    let meta = null;
    try { meta = await conn.groupMetadata(m.chat); } catch {}
    const isAdmin = isGroupAdminOf(meta?.participants, m.sender);
    if (!isAdmin && !isOwner(m)) return m.reply('Group admins only.');

    const file = path.join(__dirname, 'database', 'antiactions.json');
    const db = readJSONObject(file);
    const gid = m.chat;
    db[gid] = db[gid] && typeof db[gid] === 'object' ? db[gid] : {};

    const key = command; // 'antidemote'
    const arg = (args[0] || '').toLowerCase();

    if (arg === 'on' || arg === 'off') {
        db[gid][key] = arg === 'on';
        saveJSON(file, db);

        // The revert needs admin rights, so say it now instead of failing silently later.
        const botIsAdmin = isGroupAdminOf(meta?.participants, conn.user?.id);
        const warning = arg === 'on' && !botIsAdmin
            ? '\n\n⚠️ The bot is not a group admin — changes cannot be reverted until it is.'
            : '';
        return m.reply(`✅ *${key}* is now *${arg.toUpperCase()}* for this group.${warning}`);
    }

    const current = db[gid][key] ? 'ON' : 'OFF';
    return m.reply(
        `*${key}*: ${current}\n\n` +
        `Usage:\n` +
        `• ${config.prefix || '.'}${key} on  → enable\n` +
        `• ${config.prefix || '.'}${key} off → disable`
    );
}

            // ── ANTICALL ────────────────────────────────────────────────────────
            case 'anticall': {
                if (!isOwner(m) && !isCreator(m)) {
                    return m.reply('Owner only.');
                }

                const prefix = config.prefix || '.';
                const cfg = loadAnticall();
                const sub = (args[0] || '').toLowerCase();
                const rest = args.slice(1);

                // no args → show status
                if (!sub) {
                    return m.reply(
                        `*ANTICALL*\n\n` +
                        `Status : ${cfg.enabled ? 'ON' : 'OFF'}\n` +
                        `Action : ${cfg.autoBlock || cfg.action === 'block' ? 'block' : 'reject'}\n` +
                        `Warn caller: ${cfg.warn ? 'yes' : 'no'}\n` +
                        `Whitelist : ${cfg.whitelist.length ? cfg.whitelist.join(', ') : '-'}\n` +
                        `Blocked : ${cfg.blocked.length ? cfg.blocked.join(', ') : '-'}\n\n` +
                        `Commands:\n` +
                        `• ${prefix}anticall on\n` +
                        `• ${prefix}anticall off\n` +
                        `• ${prefix}anticall reject\n` +
                        `• ${prefix}anticall block\n` +
                        `• ${prefix}anticall warn on|off\n` +
                        `• ${prefix}anticall text <message>\n` +
                        `• ${prefix}anticall whitelist add|del <number>\n` +
                        `• ${prefix}anticall unblock <number|all>`
                    );
                }

                // on / off
                if (sub === 'on' || sub === 'off') {
                    cfg.enabled = sub === 'on';
                    saveAnticall(cfg);
                    return m.reply(`✅ Anticall is now *${sub.toUpperCase()}*`);
                }

                // reject / block
                if (sub === 'reject' || sub === 'block') {
                    cfg.action = sub;
                    cfg.autoBlock = sub === 'block';
                    saveAnticall(cfg);
                    return m.reply(`✅ Anticall action → *${sub}*`);
                }

                // warn on|off
                if (sub === 'warn') {
                    const v = (rest[0] || '').toLowerCase();
                    if (!['on', 'off'].includes(v)) return m.reply(`Usage: ${prefix}anticall warn on|off`);
                    cfg.warn = v === 'on';
                    saveAnticall(cfg);
                    return m.reply(`✅ Warn caller → *${v}*`);
                }

                // text <message>
                if (sub === 'text') {
                    const text = rest.join(' ').trim();
                    if (!text) return m.reply(`Usage: ${prefix}anticall text <message>`);
                    cfg.warnText = text;
                    cfg.warn = true;
                    saveAnticall(cfg);
                    return m.reply(`✅ Warning text updated.`);
                }

                // whitelist add|del <number>
                if (sub === 'whitelist') {
                    const op = (rest[0] || '').toLowerCase();
                    const num = (rest[1] || '').replace(/\D/g, '');
                    if (!['add', 'del', 'remove'].includes(op) || !num) {
                        return m.reply(`Usage: ${prefix}anticall whitelist add|del <number>`);
                    }
                    if (op === 'add') {
                        if (cfg.whitelist.includes(num)) return m.reply('Already whitelisted.');
                        cfg.whitelist.push(num);
                        saveAnticall(cfg);
                        return m.reply(`✅ Added *${num}* to whitelist.`);
                    } else {
                        cfg.whitelist = cfg.whitelist.filter(x => x !== num);
                        saveAnticall(cfg);
                        return m.reply(`✅ Removed *${num}* from whitelist.`);
                    }
                }

                // unblock <number|all>
                if (sub === 'unblock') {
                    const target = (rest[0] || '').toLowerCase();
                    if (!target) return m.reply(`Usage: ${prefix}anticall unblock <number|all>`);

                    if (target === 'all') {
                        const list = [...cfg.blocked];
                        for (const n of list) {
                            try {
                                await conn.updateBlockStatus(n + '@s.whatsapp.net', 'unblock');
                            } catch (e) {
                                console.error('[anticall] unblock', n, e?.message || e);
                            }
                        }
                        cfg.blocked = [];
                        saveAnticall(cfg);
                        return m.reply(`✅ Unblocked ${list.length} number(s).`);
                    }

                    const num = target.replace(/\D/g, '');
                    if (!num) return m.reply('Invalid number.');
                    try {
                        await conn.updateBlockStatus(num + '@s.whatsapp.net', 'unblock');
                    } catch (e) {
                        return m.reply(`❌ Failed to unblock: ${e.message}`);
                    }
                    cfg.blocked = cfg.blocked.filter(x => x !== num);
                    saveAnticall(cfg);
                    return m.reply(`✅ Unblocked *${num}*.`);
                }

                return m.reply(`Unknown subcommand. Send *${prefix}anticall* for the menu.`);
            }

            case 'public': {
    if (!isOwner(m)) return reply('Owner only')

    config.mode = 'public'
    fs.writeFileSync('./fig.json', JSON.stringify(config, null, 2))

    reply('Mode switched to public')
}
           break

           case 'self': {
    if (!isOwner(m)) return reply('Owner only')

    config.mode = 'self'
    fs.writeFileSync('./fig.json', JSON.stringify(config, null, 2))

    reply('Mode switched to self')
}
           break
           
           
            default:
                break;
        }
    } catch (err) {
        console.error('Error in command handler:', err);
    }
};

// Incoming-call handler, bound from index.js on the live socket.
module.exports.handleIncomingCall = handleIncomingCall;
module.exports.loadAnticall = loadAnticall;
