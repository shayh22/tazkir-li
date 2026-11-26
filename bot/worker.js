/**
 * תזכיר לי - בוט טלגרם לתזכורות
 *
 * - כל דקה (cron) בודק אילו משימות הגיע זמנן ושולח הודעה עם כפתורי "בוצע" ו"נודניק".
 * - כל בוקר בשעה שנבחרה (ברירת מחדל 08:00) שולח סיכום של משימות היום לפי עדיפות.
 * - האפליקציה מסנכרנת את המשימות לכאן עם קוד חיבור שהבוט נותן בפקודה /start.
 *
 * KV (TASKS):
 *   users            -> ["CODE", ...]
 *   u:<CODE>         -> { chatId, tz, digest, tasks, extraDone, snooze, updatedAt }
 *   chat:<chatId>    -> CODE
 *   config:bot_token -> טוקן הבוט (כשהוזן בדף /connect)
 * סודות: TELEGRAM_BOT_TOKEN (אופציונלי), SETUP_KEY (מפתח חד פעמי לדף /connect)
 */

const PRIORITY = { high: { icon: '🔥', label: 'דחוף', rank: 0 }, medium: { icon: '⚡', label: 'בינוני', rank: 1 }, low: { icon: '🌱', label: 'רגיל', rank: 2 } };
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export default {
    async fetch(req, env) {
        env = await withToken(env);
        const url = new URL(req.url);
        if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
        try {
            if (url.pathname === '/telegram' && req.method === 'POST') return await handleTelegram(req, env);
            if (url.pathname === '/sync' && req.method === 'POST') return cors(await handleSync(req, env));
            if (url.pathname === '/setup') return await handleSetup(url, env);
            if (url.pathname === '/connect' && req.method === 'GET') return connectPage();
            if (url.pathname === '/connect' && req.method === 'POST') return await handleConnect(req, url, env);
            if (url.pathname === '/health') return json({ ok: true, bot: !!env.TELEGRAM_BOT_TOKEN });
            return json({ ok: true, name: 'tazkir-li-bot' });
        } catch (e) {
            return cors(json({ ok: false, error: String(e && e.message || e) }, 500));
        }
    },

    async scheduled(event, env, ctx) {
        env = await withToken(env);
        ctx.waitUntil(runMinute(event.scheduledTime, env));
    }
};

/* ---------------- עזרים ---------------- */
async function withToken(env) {
    if (env.TELEGRAM_BOT_TOKEN) return env;
    const t = await env.TASKS.get('config:bot_token');
    return t ? { ...env, TELEGRAM_BOT_TOKEN: t } : env;
}
function safeEqual(a, b) {
    a = String(a || ''); b = String(b || '');
    if (!a || a.length !== b.length) return false;
    let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
}
function json(obj, status = 200) {
    return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
function cors(res) {
    const h = new Headers(res.headers);
    h.set('access-control-allow-origin', '*');
    h.set('access-control-allow-methods', 'POST, OPTIONS');
    h.set('access-control-allow-headers', 'content-type, x-sync-code');
    h.set('access-control-max-age', '86400');
    return new Response(res.body, { status: res.status, headers: h });
}
function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
async function sha256hex(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function webhookSecret(env) { return (await sha256hex('tazkir-li|' + env.TELEGRAM_BOT_TOKEN)).slice(0, 48); }
function newCode() {
    const b = crypto.getRandomValues(new Uint8Array(8));
    const s = [...b].map(x => CODE_ALPHABET[x % CODE_ALPHABET.length]).join('');
    return s.slice(0, 4) + '-' + s.slice(4);
}
function normCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2'); }

async function tg(env, method, body) {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return r.json().catch(() => ({ ok: false }));
}

async function getUser(env, code) { return code ? await env.TASKS.get('u:' + code, 'json') : null; }
async function putUser(env, code, u) { await env.TASKS.put('u:' + code, JSON.stringify(u)); }
async function getUsers(env) { return (await env.TASKS.get('users', 'json')) || []; }

/* ---------------- זמן מקומי ---------------- */
function localParts(ms, tz) {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    const hour = p.hour === '24' ? '00' : p.hour;
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}` };
}
function dowOf(ds) { const [y, m, d] = ds.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function dimOf(ds) { const [y, m] = ds.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function fmtDate(ds) { const [y, m, d] = ds.split('-'); return `${Number(d)}.${Number(m)}`; }

/* ---------------- לוגיקת משימות (זהה לאפליקציה) ---------------- */
function isDueOn(t, ds) {
    switch (t.category) {
        case 'daily': return !t.startDate || ds >= t.startDate;
        case 'weekly': return (t.weekDays || []).includes(dowOf(ds));
        case 'monthly': {
            const days = t.monthDays || []; if (!days.length) return false;
            const dim = dimOf(ds), dom = Number(ds.slice(8, 10));
            return days.some(n => n === dom || (n > dim && dom === dim));
        }
        case 'general': return t.date === ds;
    }
    return false;
}
function occKey(t, ds) { return t.category === 'general' ? (t.date || ds) : ds; }
function isDone(u, t, ds) {
    const k = occKey(t, ds);
    return (t.completions || []).some(c => c.date === k) || ((u.extraDone || {})[t.id] || []).includes(k);
}
function isOverdue(u, t, today) { return t.category === 'general' && t.date && t.date < today && !isDone(u, t, t.date); }
function sortTasks(a, b) {
    const pa = (PRIORITY[a.priority] || PRIORITY.medium).rank, pb = (PRIORITY[b.priority] || PRIORITY.medium).rank;
    if (pa !== pb) return pa - pb;
    return (a.dueTime || '99:99') < (b.dueTime || '99:99') ? -1 : 1;
}

function todayList(u, nowMs) {
    const { date } = localParts(nowMs, u.tz);
    const tasks = u.tasks || [];
    const overdue = tasks.filter(t => isOverdue(u, t, date)).sort(sortTasks);
    const today = tasks.filter(t => isDueOn(t, date) && !isDone(u, t, date)).sort(sortTasks);
    const done = tasks.filter(t => isDueOn(t, date) && isDone(u, t, date)).length;
    return { date, overdue, today, done };
}

function taskLine(t, extra = '') {
    const p = PRIORITY[t.priority] || PRIORITY.medium;
    return `${p.icon} ${t.dueTime ? `<b>${t.dueTime}</b> · ` : ''}${esc(t.title)}${t.project ? ` <i>(${esc(t.project)})</i>` : ''}${extra}`;
}

function digestText(u, nowMs, heading) {
    const { date, overdue, today, done } = todayList(u, nowMs);
    let s = `${heading}\n<b>${fmtDate(date)}</b> · ${today.length + overdue.length} פתוחות${done ? ` · ${done} הושלמו` : ''}\n`;
    if (overdue.length) s += `\n⚠️ <b>באיחור</b>\n` + overdue.map(t => taskLine(t, ` · מ-${fmtDate(t.date)}`)).join('\n') + '\n';
    if (today.length) s += `\n🎯 <b>להיום, לפי עדיפות</b>\n` + today.map(t => taskLine(t)).join('\n');
    if (!overdue.length && !today.length) s += '\nאין משימות פתוחות להיום 🎉';
    return s;
}

function reminderKeyboard(t, ds) {
    return { inline_keyboard: [[
        { text: '✅ בוצע', callback_data: `d|${t.id}|${ds}`.slice(0, 64) },
        { text: '⏰ 10 דק׳', callback_data: `s|${t.id}|10`.slice(0, 64) },
        { text: '⏰ שעה', callback_data: `s|${t.id}|60`.slice(0, 64) }
    ]] };
}

/* ---------------- כל דקה ---------------- */
async function runMinute(scheduledMs, env) {
    if (!env.TELEGRAM_BOT_TOKEN) return;
    const T = Math.floor(scheduledMs / 60000) * 60000;
    const codes = await getUsers(env);
    for (const code of codes) {
        const u = await getUser(env, code);
        if (!u || !u.chatId) continue;
        const { date, time } = localParts(T, u.tz);
        const sends = [];

        if ((u.digest || '08:00') === time) {
            sends.push(tg(env, 'sendMessage', { chat_id: u.chatId, parse_mode: 'HTML', text: digestText(u, T, '☀️ <b>בוקר טוב! זה היום שלך</b>') }));
        }
        for (const t of (u.tasks || [])) {
            if (t.dueTime === time && isDueOn(t, date) && !isDone(u, t, date)) {
                sends.push(tg(env, 'sendMessage', {
                    chat_id: u.chatId, parse_mode: 'HTML', reply_markup: reminderKeyboard(t, date),
                    text: `🔔 <b>תזכורת</b>\n${taskLine(t)}${t.desc ? `\n\n${esc(t.desc)}` : ''}`
                }));
            }
            const snoozes = [(u.snooze || {})[t.id], t.snoozeUntil ? Date.parse(t.snoozeUntil) : null];
            if (snoozes.some(s => s && s > T - 60000 && s <= T) && !isDone(u, t, occKey(t, date))) {
                sends.push(tg(env, 'sendMessage', {
                    chat_id: u.chatId, parse_mode: 'HTML', reply_markup: reminderKeyboard(t, occKey(t, date)),
                    text: `⏰ <b>תזכורת נודניק</b>\n${taskLine(t)}`
                }));
            }
        }
        await Promise.all(sends);
    }
}

/* ---------------- משימה מהודעה חופשית ---------------- */
const DAYS = { 'ראשון': 0, 'שני': 1, 'שלישי': 2, 'רביעי': 3, 'חמישי': 4, 'שישי': 5, 'שבת': 6 };
const DAY_RE = '(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)';
function addDaysYmd(ds, n) { const [y, m, d] = ds.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, d + n)); return x.toISOString().slice(0, 10); }

function parseTask(input, nowMs, tz) {
    let s = ' ' + input.replace(/\s+/g, ' ').trim() + ' ';
    const { date: today, time: nowTime } = localParts(nowMs, tz);
    const cut = re => { const m = s.match(re); if (m) s = s.replace(m[0], ' '); return m; };
    const t = { id: 'tg_' + nowMs.toString(36) + '_' + Math.floor(Math.random() * 1e4).toString(36), category: 'general', priority: 'medium', dueTime: '', weekDays: [], monthDays: [], completions: [], startDate: today, createdAt: new Date(nowMs).toISOString(), source: 'telegram' };

    // עדיפות
    if (cut(/\s(לא דחוף|רגיל|בלי לחץ)(?=\s)/)) t.priority = 'low';
    else if (cut(/\s(דחוף מאוד|דחוף|חשוב|!!+|!)(?=\s)/) || /!\s*$/.test(s.trim()) && (s = s.replace(/!+(\s*)$/, '$1'))) t.priority = 'high';
    // פרויקט
    const pm = cut(/\s#([^\s#]+)/);
    if (pm) t.project = pm[1].replace(/_/g, ' ');
    // שעה
    let tm = cut(/\s(?:בשעה|ב-?|ל-?)?\s?(\d{1,2}):(\d{2})(?=\s)/);
    if (tm && Number(tm[1]) < 24 && Number(tm[2]) < 60) t.dueTime = `${tm[1].padStart(2, '0')}:${tm[2]}`;
    else { tm = cut(/\s(?:בשעה|ב-?שעה)\s?(\d{1,2})(?=\s)/); if (tm && Number(tm[1]) < 24) t.dueTime = `${tm[1].padStart(2, '0')}:00`; }
    if (!t.dueTime) {
        const pt = cut(/\s(בבוקר|בצהריים|אחה"צ|אחר הצהריים|בערב|בלילה)(?=\s)/);
        if (pt) t.dueTime = { 'בבוקר': '09:00', 'בצהריים': '12:00', 'אחה"צ': '15:00', 'אחר הצהריים': '15:00', 'בערב': '19:00', 'בלילה': '21:00' }[pt[1]];
    }
    // חזרתיות
    let m;
    if ((m = cut(new RegExp('\\sכל\\s(?:יום\\s)?' + DAY_RE + '(?:\\s?(?:ו-?|,\\s?)(?:יום\\s)?' + DAY_RE + ')?(?=\\s)')))) {
        t.category = 'weekly'; t.weekDays = [DAYS[m[1]], ...(m[2] ? [DAYS[m[2]]] : [])];
    } else if (cut(/\sכל יום(?=\s)|\sכל בוקר(?=\s)|\sכל ערב(?=\s)|\sיומי(?=\s)/)) {
        t.category = 'daily';
    } else if (cut(/\sכל שבוע(?=\s)|\sשבועי(?=\s)/)) {
        t.category = 'weekly'; t.weekDays = [dowOf(today)];
    } else if ((m = cut(/\s(?:ב-?)?(\d{1,2})\s?(?:לכל חודש|בכל חודש|לחודש)(?=\s)/))) {
        t.category = 'monthly'; t.monthDays = [Math.min(31, Math.max(1, Number(m[1])))];
    } else if (cut(/\sכל חודש(?=\s)|\sחודשי(?=\s)/)) {
        t.category = 'monthly'; t.monthDays = [Number(today.slice(8, 10))];
    }
    // תאריך (למשימה חד פעמית)
    if (t.category === 'general') {
        let date = null;
        if (cut(/\sמחרתיים(?=\s)/)) date = addDaysYmd(today, 2);
        else if (cut(/\s(?:ל|עד )?מחר(?=\s)/)) date = addDaysYmd(today, 1);
        else if (cut(/\s(?:ל|עד )?היום(?=\s)/)) date = today;
        else if ((m = cut(/\sבעוד\s(\d{1,3}|שבוע|שבועיים|יומיים)\s?(ימים|יום)?(?=\s)/))) {
            const n = { 'שבוע': 7, 'שבועיים': 14, 'יומיים': 2 }[m[1]] || Number(m[1]);
            date = addDaysYmd(today, n);
        } else if ((m = cut(new RegExp('\\s(?:ב|ל|עד )?(?:יום\\s)?' + DAY_RE + '(?:\\s?הבא)?(?=\\s)')))) {
            if (/יום|^\s?[בל]/.test(m[0]) || m[1] !== 'שני') {
                let n = (DAYS[m[1]] - dowOf(today) + 7) % 7;
                if (n === 0 || /הבא/.test(m[0])) n = n || 7;
                date = addDaysYmd(today, n);
            } else s = s.replace(' ', m[0]); // "שני" בלי "יום" - כנראה מספר, להשאיר
        } else if ((m = cut(/\s(?:ב-?|ל-?|עד )?(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?=\s)/))) {
            const d = Number(m[1]), mo = Number(m[2]);
            let y = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : Number(today.slice(0, 4));
            let cand = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            if (!m[3] && cand < today) cand = `${y + 1}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) date = cand;
        }
        if (!date) date = (t.dueTime && t.dueTime <= nowTime) ? addDaysYmd(today, 1) : today;
        t.date = date;
    } else {
        t.date = null;
    }
    t.title = s.replace(/\s+/g, ' ').replace(/^\s*(?:תזכיר לי|תזכירי לי|להזכיר לי|תזכורת)\s*[:-]?\s*/, '').replace(/^[\s,:–-]+|[\s,:–-]+$/g, '').trim().slice(0, 300);
    return t;
}

function whenText(t, u) {
    if (t.category === 'daily') return 'כל יום';
    if (t.category === 'weekly') return 'כל שבוע, ביום ' + t.weekDays.map(d => Object.keys(DAYS)[d]).join(' ו');
    if (t.category === 'monthly') return `כל חודש, ב-${t.monthDays.join(', ')}`;
    const today = localParts(Date.now(), u.tz).date;
    if (t.date === today) return 'היום';
    if (t.date === addDaysYmd(today, 1)) return 'מחר';
    return `יום ${Object.keys(DAYS)[dowOf(t.date)]}, ${fmtDate(t.date)}`;
}
function addedText(t, u) {
    const p = PRIORITY[t.priority] || PRIORITY.medium;
    return `✅ <b>נוספה משימה</b>\n${esc(t.title)}\n\n📅 ${whenText(t, u)}${t.dueTime ? ` · 🔔 ${t.dueTime}` : ' · בלי תזכורת בשעה מסוימת'}\n${p.icon} ${p.label}${t.project ? ` · 📁 ${esc(t.project)}` : ''}`;
}
function addedKeyboard(t) {
    const b = (k, label) => ({ text: (t.priority === k ? '● ' : '') + label, callback_data: `p|${t.id}|${k}` });
    return { inline_keyboard: [[b('high', '🔥 דחוף'), b('medium', '⚡ בינוני'), b('low', '🌱 רגיל')], [{ text: '❌ ביטול', callback_data: `x|${t.id}` }]] };
}

/* ---------------- טלגרם (webhook) ---------------- */
async function handleTelegram(req, env) {
    if (req.headers.get('x-telegram-bot-api-secret-token') !== await webhookSecret(env)) return new Response('forbidden', { status: 403 });
    const upd = await req.json();

    if (upd.callback_query) {
        const q = upd.callback_query, chatId = q.message && q.message.chat.id;
        const code = await env.TASKS.get('chat:' + chatId);
        const u = await getUser(env, code);
        const [kind, taskId, arg] = String(q.data || '').split('|');
        const t = u && (u.tasks || []).find(x => x.id === taskId);
        if (t && (kind === 'p' || kind === 'x')) {
            if (kind === 'p' && PRIORITY[arg]) {
                t.priority = arg;
                const a = (u.added || []).find(x => x.id === taskId);
                if (a) a.priority = arg; else { u.edits = u.edits || {}; u.edits[taskId] = { ...(u.edits[taskId] || {}), priority: arg }; }
                await putUser(env, code, u);
                await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: `עדיפות: ${PRIORITY[arg].label}` });
                await tg(env, 'editMessageText', { chat_id: chatId, message_id: q.message.message_id, parse_mode: 'HTML', text: addedText(t, u), reply_markup: addedKeyboard(t) });
            } else if (kind === 'x') {
                u.tasks = u.tasks.filter(x => x.id !== taskId);
                u.added = (u.added || []).filter(x => x.id !== taskId);
                // ייתכן שהאפליקציה כבר קיבלה אותה - נבקש ממנה למחוק (נשכח כשהיא כבר לא אצלה)
                u.removed = u.removed || []; if (!u.removed.includes(taskId)) u.removed.push(taskId);
                await putUser(env, code, u);
                await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: 'המשימה בוטלה' });
                await tg(env, 'editMessageText', { chat_id: chatId, message_id: q.message.message_id, parse_mode: 'HTML', text: `<s>${esc(t.title)}</s>\n\n❌ בוטלה` });
            }
            return json({ ok: true });
        }
        if (!t) { await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: 'המשימה לא נמצאה' }); return json({ ok: true }); }
        let note = '';
        if (kind === 'd') {
            u.extraDone = u.extraDone || {};
            const list = u.extraDone[taskId] || [];
            if (!list.includes(arg)) list.push(arg);
            u.extraDone[taskId] = list;
            if (u.snooze) delete u.snooze[taskId];
            note = '✅ בוצע';
        } else if (kind === 's') {
            u.snooze = u.snooze || {};
            u.snooze[taskId] = Date.now() + Number(arg || 10) * 60000;
            note = Number(arg) >= 60 ? '⏰ אזכיר בעוד שעה' : `⏰ אזכיר בעוד ${arg} דקות`;
        }
        await putUser(env, code, u);
        await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: note });
        await tg(env, 'editMessageText', { chat_id: chatId, message_id: q.message.message_id, parse_mode: 'HTML', text: `${taskLine(t)}\n\n${note}` });
        return json({ ok: true });
    }

    const msg = upd.message;
    if (!msg || !msg.text) return json({ ok: true });
    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const cmd = text.split(/\s+/)[0].split('@')[0];
    const send = (t, extra = {}) => tg(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: t, ...extra });

    let code = await env.TASKS.get('chat:' + chatId);
    if (cmd === '/start') {
        if (!code) {
            code = newCode();
            await putUser(env, code, { chatId, tz: 'Asia/Jerusalem', digest: '08:00', tasks: [], extraDone: {}, snooze: {}, createdAt: Date.now() });
            await env.TASKS.put('chat:' + chatId, code);
            const users = await getUsers(env);
            if (!users.includes(code)) { users.push(code); await env.TASKS.put('users', JSON.stringify(users)); }
        }
        await send(`👋 <b>ברוכים הבאים לתזכיר לי</b>\n\nקוד החיבור שלך:\n<code>${code}</code>\n\nבאפליקציה: ⚙️ הגדרות ← תזכורות בטלגרם ← מדביקים את הקוד ולוחצים "חיבור".\n\n➕ <b>הוספת משימה</b>: פשוט כותבים אותה, למשל:\n<code>מחר ב-10:00 להתקשר לציפורה #אח_לטוב דחוף</code>\n<code>כל יום ראשון 09:00 סקירה שבועית</code>\n\nמבינים: היום / מחר / מחרתיים / יום שלישי / 3.12 / בעוד 5 ימים · שעה 14:30 או \"בשעה 9\" · דחוף / רגיל · #פרויקט · כל יום / כל שבוע / כל חודש / כל יום שני\n\n/today משימות להיום · /digest שעת סיכום הבוקר · /stop ניתוק`);
        return json({ ok: true });
    }
    const u = await getUser(env, code);
    if (!u) { await send('עוד לא התחברת. שלחו /start כדי לקבל קוד חיבור.'); return json({ ok: true }); }

    if (cmd === '/today' || text === 'היום') {
        await send(digestText(u, Date.now(), '📋 <b>המשימות שלך</b>'));
    } else if (cmd === '/digest') {
        const m = text.match(/(\d{1,2}):(\d{2})/);
        if (m && Number(m[1]) < 24 && Number(m[2]) < 60) {
            u.digest = `${m[1].padStart(2, '0')}:${m[2]}`;
            await putUser(env, code, u);
            await send(`☀️ סיכום הבוקר יישלח כל יום ב-<b>${u.digest}</b>.`);
        } else {
            await send(`סיכום הבוקר נשלח כל יום ב-<b>${u.digest || '08:00'}</b>.\nלשינוי: <code>/digest 07:30</code>`);
        }
    } else if (cmd === '/stop') {
        await env.TASKS.delete('u:' + code);
        await env.TASKS.delete('chat:' + chatId);
        const users = (await getUsers(env)).filter(c => c !== code);
        await env.TASKS.put('users', JSON.stringify(users));
        await send('נותקת. המשימות נמחקו מהבוט. לחיבור מחדש: /start');
    } else if (cmd === '/help') {
        await send(`➕ <b>הוספת משימה</b>: פשוט כותבים אותה, למשל:\n<code>מחר ב-10:00 להתקשר לציפורה #אח_לטוב דחוף</code>\n<code>כל יום ראשון 09:00 סקירה שבועית</code>\n\nמבינים: היום / מחר / מחרתיים / יום שלישי / 3.12 / בעוד 5 ימים · שעה 14:30 או \"בשעה 9\" · דחוף / רגיל · #פרויקט · כל יום / כל שבוע / כל חודש / כל יום שני\n\n/today משימות להיום · /digest שעת סיכום הבוקר · /stop ניתוק`);
    } else {
        // כל טקסט אחר (או /add ...) = משימה חדשה
        const body = cmd === '/add' ? text.replace(/^\S+\s*/, '') : text;
        if (!body || body.startsWith('/')) { await send(`➕ <b>הוספת משימה</b>: פשוט כותבים אותה, למשל:\n<code>מחר ב-10:00 להתקשר לציפורה #אח_לטוב דחוף</code>\n<code>כל יום ראשון 09:00 סקירה שבועית</code>\n\nמבינים: היום / מחר / מחרתיים / יום שלישי / 3.12 / בעוד 5 ימים · שעה 14:30 או \"בשעה 9\" · דחוף / רגיל · #פרויקט · כל יום / כל שבוע / כל חודש / כל יום שני\n\n/today משימות להיום · /digest שעת סיכום הבוקר · /stop ניתוק`); return json({ ok: true }); }
        const t = parseTask(body, Date.now(), u.tz);
        if (!t.title) { await send('לא הבנתי מה המשימה. נסו למשל: <code>מחר 10:00 להתקשר לרופא</code>'); return json({ ok: true }); }
        u.tasks = u.tasks || []; u.added = u.added || [];
        u.tasks.push(t); u.added.push(t);
        await putUser(env, code, u);
        await send(addedText(t, u), { reply_markup: addedKeyboard(t) });
    }
    return json({ ok: true });
}

/* ---------------- סנכרון מהאפליקציה ---------------- */
const KEEP = ['id', 'title', 'desc', 'project', 'priority', 'category', 'date', 'dueTime', 'weekDays', 'monthDays', 'startDate', 'snoozeUntil'];
async function handleSync(req, env) {
    const code = normCode(req.headers.get('x-sync-code'));
    const u = await getUser(env, code);
    if (!u) return json({ ok: false, error: 'unknown_code' }, 404);
    const body = await req.json();
    if (!Array.isArray(body.tasks) || body.tasks.length > 2000) return json({ ok: false, error: 'bad_tasks' }, 400);

    u.tasks = body.tasks.filter(t => t && t.id && t.title).map(t => {
        const o = {};
        KEEP.forEach(k => { if (t[k] !== undefined && t[k] !== null) o[k] = t[k]; });
        o.title = String(o.title).slice(0, 300);
        if (o.desc) o.desc = String(o.desc).slice(0, 1000);
        o.completions = (t.completions || []).slice(0, 60).map(c => ({ date: c.date }));
        return o;
    });
    if (body.tz && typeof body.tz === 'string' && body.tz.length < 64) u.tz = body.tz;

    // השלמות מטלגרם שהאפליקציה כבר קיבלה - אפשר לשכוח
    const extra = {};
    const ids = new Set(u.tasks.map(t => t.id));
    Object.entries(u.extraDone || {}).forEach(([id, dates]) => {
        if (!ids.has(id)) return;
        const t = u.tasks.find(x => x.id === id);
        const left = dates.filter(d => !(t.completions || []).some(c => c.date === d));
        if (left.length) extra[id] = left;
    });
    u.extraDone = extra;

    // משימות שנוספו בטלגרם: נשארות עד שהאפליקציה מחזירה אותן ברשימה שלה
    const added = (u.added || []).filter(t => !ids.has(t.id));
    u.added = added;
    u.tasks.push(...added);
    // ביטולים ושינויי עדיפות שנעשו בטלגרם למשימות שכבר באפליקציה
    const removed = (u.removed || []).filter(id => ids.has(id));
    u.removed = removed;
    u.tasks = u.tasks.filter(t => !removed.includes(t.id));
    const edits = {};
    Object.entries(u.edits || {}).forEach(([id, e]) => {
        const t = u.tasks.find(x => x.id === id);
        if (!t) return;
        if (Object.keys(e).some(k => t[k] !== e[k])) { edits[id] = e; Object.assign(t, e); }
    });
    u.edits = edits;

    u.updatedAt = Date.now();
    await putUser(env, code, u);
    return json({ ok: true, extraDone: extra, added, removed, edits, digest: u.digest || '08:00', count: u.tasks.length });
}

/* ---------------- דף הדבקת הטוקן ---------------- */
async function handleConnect(req, url, env) {
    const body = await req.json().catch(() => ({}));
    if (!env.SETUP_KEY || !safeEqual(body.key, env.SETUP_KEY)) return json({ ok: false, error: 'הקישור לא תקין או שכבר השתמשו בו. בקשו קישור חדש.' }, 403);
    if (await env.TASKS.get('config:setup_used') === env.SETUP_KEY) return json({ ok: false, error: 'כבר השתמשו בקישור הזה. בקשו קישור חדש.' }, 403);
    const token = String(body.token || '').trim();
    if (!/^\d{5,15}:[A-Za-z0-9_-]{30,50}$/.test(token)) return json({ ok: false, error: 'זה לא נראה כמו טוקן של בוט. הוא בנוי כמו 123456789:ABC...' }, 400);
    const me = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json().catch(() => ({}));
    if (!me.ok) return json({ ok: false, error: 'טלגרם לא מכיר את הטוקן הזה. בדקו שהעתקתם אותו במלואו מ-BotFather.' }, 400);
    await env.TASKS.put('config:bot_token', token);
    await env.TASKS.put('config:setup_used', env.SETUP_KEY);
    const setup = await handleSetup(url, { ...env, TELEGRAM_BOT_TOKEN: token });
    const s = await setup.json();
    return json({ ok: !!s.ok, bot: me.result.username, error: s.ok ? undefined : 'הטוקן נשמר, אבל חיבור הבוט לשרת נכשל. נסו שוב בעוד דקה.' });
}

function connectPage() {
    const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>חיבור בוט טלגרם · תזכיר לי</title>
<style>
:root{--bg:#f4f7f9;--card:#fff;--fg:#14232f;--mute:#5b6b78;--line:#d6dee5;--brand:#1b4965;--ok:#047857;--bad:#be123c;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0e1720;--card:#15212c;--fg:#e8eef3;--mute:#9aabb9;--line:#2a3b4a;--brand:#8cc4ea;--ok:#34d399;--bad:#fb7185;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Arial,sans-serif}
main{max-width:520px;margin:0 auto;padding:32px max(16px,env(safe-area-inset-right)) 48px max(16px,env(safe-area-inset-left))}
h1{font-size:1.5rem;margin:0 0 4px}p{margin:0}.mute{color:var(--mute);font-size:.9rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin-top:20px}
ol{margin:0;padding-inline-start:20px;display:flex;flex-direction:column;gap:6px;font-size:.95rem}
code{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:0 5px;direction:ltr;display:inline-block}
label{display:block;font-weight:700;font-size:.9rem;margin-bottom:6px}
input{width:100%;padding:12px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--fg);font:15px ui-monospace,monospace;direction:ltr}
input:focus,button:focus-visible{outline:3px solid var(--brand);outline-offset:1px}
button{margin-top:12px;width:100%;padding:13px;border:0;border-radius:12px;background:var(--brand);color:var(--card);font-weight:800;font-size:1rem;cursor:pointer}
button[disabled]{opacity:.6;cursor:wait}
#msg{margin-top:12px;font-weight:700;min-height:1.4em}#msg.ok{color:var(--ok)}#msg.bad{color:var(--bad)}
.done a{color:var(--brand);font-weight:800}
</style></head><body><main>
<h1>📨 חיבור בוט טלגרם</h1>
<p class="mute">הטוקן נשמר רק בשרת התזכורות שלך ב-Cloudflare. הקישור לדף הזה עובד פעם אחת בלבד.</p>
<div class="card"><ol>
<li>בטלגרם, פותחים את <b>@BotFather</b> ושולחים <code>/newbot</code>.</li>
<li>בוחרים שם לבוט (למשל: תזכיר לי) ושם משתמש שמסתיים ב-<code>bot</code>.</li>
<li>BotFather שולח טוקן שנראה כך: <code>123456789:AAH...</code>. מעתיקים אותו.</li>
</ol></div>
<form class="card" id="f">
<label for="token">הטוקן של הבוט</label>
<input id="token" name="token" type="password" autocomplete="off" spellcheck="false" placeholder="123456789:AA..." required>
<button id="go" type="submit">שמירה וחיבור</button>
<p id="msg" role="status"></p>
</form>
<div class="card done" id="done" hidden></div>
</main><script>
const key = new URLSearchParams(location.hash.slice(1)).get('k');
const msg = document.getElementById('msg'), go = document.getElementById('go');
if (!key) { msg.className = 'bad'; msg.textContent = 'חסר מפתח בקישור. פתחו את הקישור המלא שקיבלתם.'; go.disabled = true; }
document.getElementById('f').addEventListener('submit', async e => {
  e.preventDefault(); go.disabled = true; msg.className = ''; msg.textContent = 'בודק את הטוקן מול טלגרם...';
  try {
    const r = await fetch('/connect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, token: document.getElementById('token').value }) });
    const d = await r.json();
    if (!d.ok) { msg.className = 'bad'; msg.textContent = d.error || 'משהו נכשל. נסו שוב.'; go.disabled = !!(r.status === 403); return; }
    history.replaceState(null, '', location.pathname);
    document.getElementById('f').hidden = true;
    const done = document.getElementById('done'); done.hidden = false;
    done.innerHTML = '<p class="ok" style="color:var(--ok);font-weight:800">✓ הבוט מחובר</p><ol style="margin-top:10px">'
      + '<li>פתחו את הבוט: <a href="https://t.me/' + d.bot + '" target="_blank" rel="noopener">@' + d.bot + '</a> ושלחו <code>/start</code>.</li>'
      + '<li>הבוט ישלח קוד חיבור. מעתיקים אותו.</li>'
      + '<li>באפליקציה תזכיר לי: ⚙️ הגדרות ← תזכורות בטלגרם ← מדביקים ולוחצים "חיבור".</li></ol>';
  } catch (err) { msg.className = 'bad'; msg.textContent = 'אין חיבור לשרת כרגע. נסו שוב.'; go.disabled = false; }
});
</script></body></html>`;
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' } });
}

/* ---------------- הגדרת ה-webhook ---------------- */
async function handleSetup(url, env) {
    if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'missing TELEGRAM_BOT_TOKEN secret' }, 400);
    const hook = await tg(env, 'setWebhook', {
        url: `${url.origin}/telegram`, secret_token: await webhookSecret(env),
        allowed_updates: ['message', 'callback_query'], drop_pending_updates: true
    });
    await tg(env, 'setMyCommands', { commands: [
        { command: 'add', description: 'הוספת משימה (או פשוט לכתוב אותה)' },
        { command: 'today', description: 'המשימות שלי להיום' },
        { command: 'help', description: 'איך כותבים משימה' },
        { command: 'digest', description: 'שעת סיכום הבוקר' },
        { command: 'start', description: 'קוד חיבור לאפליקציה' },
        { command: 'stop', description: 'ניתוק' }
    ] });
    const me = await tg(env, 'getMe', {});
    return json({ ok: !!hook.ok, webhook: hook.description || hook, bot: me.result && me.result.username });
}
