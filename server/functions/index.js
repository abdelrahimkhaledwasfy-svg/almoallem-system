// =====================================================================
// سيرفر نظام المعلم — بيشتغل على Google 24 ساعة حتى لو كل الأجهزة مقفولة
// =====================================================================
// 1) tick كل 10 دقايق: لو مفيش جهاز مدير/محاسب فاتح السيستم (meta/sysAlive قديم)، السيرفر بيعمل شغلهم:
//    - تارجت ومحقق المناديب + إحصائيات العملاء (meta/repProgress) — نفس حساب السيستم بالظبط
//    - الإشعارات التلقائية للعملاء (نسيت حاجة / عرض / مندوبك عندك / وحشتنا) — بنفس قفل meta/autoNotif_* فمفيش تكرار
// 2) repDigest الساعة 9:30 الصبح: ملخص كل مندوب (بنفس قفل meta/repDigest اللي السيستم بيستخدمه)
// 3) dailyBackup الساعة 3 الفجر: نسخة كاملة من كل الجداول في backups/<اليوم>
// كل حاجة هنا بتقرا وبتكتب في نفس الأماكن اللي السيستم بيستخدمها؛ مفيش أي مسح لبيانات.
process.env.TZ = 'Africa/Cairo';
const SERVER_VERSION = '2026-11-20-2';   // بيتغير مع كل رفع عشان Firebase يعيد إنشاء المواعيد

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const FV = admin.firestore.FieldValue;
setGlobalOptions({ region: 'europe-west1', memory: '512MiB', timeoutSeconds: 300, maxInstances: 1 });

const PUSH_PROXY = 'https://noisy-glitter-c1b3.abdelrahimkhaledwasfy.workers.dev';
const PUSH_ORIGIN = 'https://abdelrahimkhaledwasfy-svg.github.io';

// ---------------------------------------------------------------- أدوات
const pad2 = n => String(n).padStart(2, '0');
const isoLocal = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const monthKey = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1);
const autoMonthKey = ms => { const d = new Date(ms || Date.now()); return d.getFullYear() + pad2(d.getMonth() + 1); };
function last10(v) { return String(v || '').replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[^0-9]/g, '').slice(-10); }
function salesDayStart(ref) { const now = ref ? new Date(ref) : new Date(); const s = new Date(now); s.setHours(9, 0, 0, 0); if (now < s) s.setDate(s.getDate() - 1); return s; }
function fill(tpl, vars) { return String(tpl || '').replace(/\{([^{}]+)\}/g, (m, k) => vars[k] != null ? String(vars[k]) : ''); }
async function logAction(type, details) {
    const id = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    try { await db.collection('auditLogRecords').doc(id).set({ id, date: new Date().toISOString(), username: 'server', fullName: 'السيرفر (تلقائي)', role: '-', type, details }); } catch (e) { console.error('log', e); }
}
async function status(field, value) {
    try { await db.collection('meta').doc('serverStatus').set({ [field]: value, updatedAt: Date.now() }, { merge: true }); } catch (e) { console.error('status', e); }
}

// ---------------------------------------------------------------- تحميل البيانات (مع كاش ساعة: لما السيستم مقفول البيانات دي مبتتغيرش)
const cache = {};
async function cached(key, ttlMs, loader) {
    const c = cache[key];
    if (c && Date.now() - c.at < ttlMs) return c.val;
    const val = await loader(); cache[key] = { at: Date.now(), val }; return val;
}
const H = 3600000;
const loadAll = (col) => db.collection(col).get().then(s => s.docs.map(d => d.data()));
async function loadData() {
    const [invoices, customers, products, invDocs, main] = await Promise.all([
        cached('invoices', H, () => loadAll('invoiceRecords')),
        cached('customers', H, () => loadAll('customerRecords')),
        cached('products', H, () => loadAll('productRecords')),
        cached('inventory', H, () => db.collection('inventoryRecords').get().then(s => { const m = {}; s.docs.forEach(d => { m[d.id] = d.data(); }); return m; })),
        cached('main', 30 * 60000, () => db.collection('storeData').doc('main').get().then(s => (s.exists && s.data()) || {}))
    ]);
    // الطلبات: آخر 75 يوم (عشان وقت الطلب ومين عمله) — بتتجدد كل 20 دقيقة
    const orders = await cached('orders', 20 * 60000, () => db.collection('customerOrders').where('createdAt', '>=', Date.now() - 75 * 86400000).get().then(s => s.docs.map(d => Object.assign({ id: d.id }, d.data()))));
    return { invoices, customers, products, inventory: invDocs, salesmen: main.salesmen || [], appOffers: main.appOffers || [], orders };
}
function makeSaleTime(orders) {
    const byId = {}; orders.forEach(o => { byId[o.id] = o; });
    return i => {
        if (i.orderCreatedAt) return Number(i.orderCreatedAt);
        if (i.sourceOrderId) {
            const o = byId[i.sourceOrderId]; if (o && o.createdAt) return Number(o.createdAt);
            const m = /^ORD-(\d{12,})/.exec(String(i.sourceOrderId)); if (m) return Number(m[1]);
        }
        return new Date(i.date).getTime();
    };
}

// ---------------------------------------------------------------- تارجت ومحقق المناديب (نفس publishRepProgress في السيستم)
async function appSeenMap() {
    return cached('appSeen', 30 * 60000, () => db.collection('customerCarts').where('lastSeenAt', '>=', Date.now() - 3 * 86400000).get().then(snap => {
        const m = {}; snap.docs.forEach(d => { if (d.id.indexOf('seen_') !== 0) return; const x = d.data() || {}; const l = last10(x.phone || d.id.slice(5)); if (l) m[l] = Math.max(m[l] || 0, Number(x.lastSeenAt) || 0); });
        return m;
    }).catch(e => { console.error('appSeen', e); return {}; }));
}
function custStats(D, saleTime, seenMap) {
    const since = Date.now() - 70 * 86400000, by = {};
    const now = new Date(), mStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime(), pmStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
    D.invoices.forEach(i => {
        if (i.type !== 'sale' || !i.customerCode) return;
        const t = saleTime(i); if (!t) return;
        const r = by[i.customerCode] || (by[i.customerCode] = { l: 0, n: 0, wd: {}, m: 0, pm: 0 });
        if (t > r.l) r.l = t;
        if (t >= mStart) r.m++; else if (t >= pmStart) r.pm++;
        if (t >= since) { r.n++; r.wd[salesDayStart(new Date(t)).toDateString()] = 1; }
    });
    const out = {};
    D.customers.forEach(c => {
        if (!c.salesmanCode) return;
        const seen = seenMap[last10(c.phone)] || 0;
        const r = by[c.code]; if (!r) { if (seen) out[c.code] = { l: 0, u: -1, n: 0, m: 0, pm: 0, o: Math.floor(seen / 1000) }; return; }
        const cnt = [0, 0, 0, 0, 0, 0, 0]; let days = 0;
        Object.keys(r.wd).forEach(d => { cnt[new Date(d).getDay()]++; days++; });
        let u = -1, best = 0; cnt.forEach((v, k) => { if (v > best) { best = v; u = k; } });
        if (best < 3 || best / Math.max(1, days) < 0.4) u = -1;
        out[c.code] = { l: Math.floor(r.l / 1000), u, n: r.n, m: r.m, pm: r.pm };
        if (seen) out[c.code].o = Math.floor(seen / 1000);
    });
    return out;
}
function computeRepProgress(D, saleTime, seenMap) {
    const now = new Date();
    const custRep = {}; D.customers.forEach(c => { if (c.salesmanCode) custRep[c.code] = c.salesmanCode; });
    const orderRep = {}; D.orders.forEach(o => { if (o.repCode) orderRep[o.id] = o.repCode; });
    const repOf = i => {
        if (i.salesmanCode) return i.salesmanCode;
        if (i.sourceOrderId && orderRep[i.sourceOrderId]) return orderRep[i.sourceOrderId];
        if (i.responsibleRepCode) return i.responsibleRepCode;
        if (i.sourceOrderId) return custRep[i.customerCode] || '';
        return '';
    };
    const dayStart = salesDayStart(now).getTime(), dayEnd = dayStart + 86400000;
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const reps = {};
    D.invoices.forEach(i => {
        if (i.type !== 'sale') return;
        const t = saleTime(i); if (t < mStart) return;
        const code = repOf(i); if (!code) return;
        const r = reps[code] || (reps[code] = { month: 0, today: 0 });
        const v = Number(i.grandTotal) || 0;
        r.month += v; if (t >= dayStart && t < dayEnd) r.today += v;
    });
    Object.keys(reps).forEach(k => { reps[k].month = Math.round(reps[k].month); reps[k].today = Math.round(reps[k].today); });
    return { monthKey: monthKey(now), reps, cust: custStats(D, saleTime, seenMap) };
}
async function publishRepProgress(D) {
    const saleTime = makeSaleTime(D.orders);
    const payload = computeRepProgress(D, saleTime, await appSeenMap());
    await db.collection('meta').doc('repProgress').set(Object.assign({ updatedAt: Date.now(), by: 'server' }, payload));
    return Object.keys(payload.reps).length;
}

// ---------------------------------------------------------------- الإشعارات (نفس notifyCustomerPhone / notifyRep في السيستم)
async function sendPush(targetPhone, title, message, extra) {
    const payload = { targetPhone, title, message };
    if (extra && typeof extra === 'object') { if (extra.image) payload.image = extra.image; payload.data = { kind: extra.kind || '', orderId: extra.orderId || '', productCode: extra.productCode || '' }; }
    try {
        const r = await fetch(PUSH_PROXY, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Origin': PUSH_ORIGIN }, body: JSON.stringify(payload) });
        const data = await r.json().catch(() => ({}));
        if (data.errors) { console.error('push errors', data.errors); return false; }
        return r.ok;
    } catch (e) { console.error('push failed', e); return false; }
}
function notifItem(title, body, extra) { return Object.assign({ id: 'n' + Date.now() + Math.random().toString(36).slice(2, 7), title, body, at: Date.now() }, extra || {}); }
async function inboxWrite(key, item) {
    if (!key) return;
    const ref = db.collection('appMeta').doc(key);
    try {
        await db.runTransaction(async t => {
            const s = await t.get(ref);
            const items = ((s.exists && s.data().items) || []).filter(x => x && x.id !== item.id);
            items.unshift(item);
            t.set(ref, { items: items.slice(0, 40), updatedAt: Date.now() });
        });
    } catch (e) { console.error('inbox', key, e); }
}
function inboxKey(phone) { const l = last10(phone); return l.length === 10 ? 'inbox_0' + l : (l ? 'inbox_' + l : ''); }
async function appIdsByL10() {
    return cached('appIds', H, () => db.collection('appCustomers').select().get().then(s => {
        const m = {}; s.docs.forEach(d => { const l = last10(d.id); if (l.length === 10) (m[l] = m[l] || []).push(d.id); }); return m;
    }));
}
async function notifyCustomerPhone(phone, title, body, extra) {
    const ids = (await appIdsByL10())[last10(phone)] || [];
    if (!ids.length) return 0;
    await inboxWrite(inboxKey(phone || ids[0]), notifItem(title, body, extra));
    const r = await Promise.all(ids.map(id => sendPush(id, title, body, extra)));
    return r.some(Boolean) ? 1 : 0;
}
async function notifyRep(code, title, body, extra) {
    if (!code) return false;
    await inboxWrite('inbox_rep_' + code, notifItem(title, body, extra));
    return sendPush('rep_' + code, title, body, extra);
}

// ---------------------------------------------------------------- الإشعارات التلقائية للعملاء (نفس autoNotifTick في السيستم)
const PROMO_TPL = {
    forgot: { title: 'نسيت حاجة؟ 🤔', body: 'يا {الاسم}، طلبك اتسجل ✓ بس ناقصه {الأصناف} اللي بتطلبهم دايمًا. تحب تضيفهم قبل ما الطلب يخرج؟' },
    offerFav: { title: '🔥 عرض على {الصنف}', body: 'يا {الاسم}، {الصنف} اللي بتطلبه عليه عرض دلوقتي: {السعر} ج بدل {القديم} ج. الحق قبل ما العرض يخلص!' },
    repday: { title: 'مندوبك عندك النهارده 🚶', body: 'يا {الاسم}، {المندوب} مندوب المعلم معدّي عليك النهارده. جهّز طلباتك، أو اطلب من الأبليكشن على طول 📲' },
    winback: { title: 'وحشتنا يا {الاسم} 💛', body: 'بقالنا {الأيام} يوم ما شفناش طلبك. عندنا عروض جديدة مستنياك — افتح الأبليكشن وشوف!' }
};
const AUTO_NOTIF_DEF = { forgot: 'نسيت حاجة؟ (بعد الطلب بساعة)', offerFav: 'عرض على صنف بيشتريه', repday: 'مندوبك عندك النهارده (الساعة 10 الصبح)', winback: 'وحشتنا (ما طلبش من 21 يوم)' };
async function autoClaim(keys) {
    if (!keys.length) return [];
    const ref = db.collection('meta').doc('autoNotif_' + autoMonthKey());
    return db.runTransaction(async t => {
        const s = await t.get(ref); const d = (s.exists && s.data()) || {}, now = Date.now(), got = [];
        keys.forEach(k => { if (!d[k]) got.push(k); });
        if (got.length) { const upd = {}; got.forEach(k => { upd[k] = now; }); t.set(ref, upd, { merge: true }); }
        return got;
    });
}
async function autoNotifTick(D) {
    const ns = await db.collection('meta').doc('notifSettings').get().then(s => (s.exists && s.data()) || {});
    const c = Object.assign({ forgot: false, offerFav: false, repday: false, winback: false }, ns.autoNotif || {});
    if (!Object.keys(AUTO_NOTIF_DEF).some(k => c[k])) return 0;
    const tpl = k => { const t = (ns.promoTpl || {})[k] || {}; return { title: t.title || PROMO_TPL[k].title, body: t.body || PROMO_TPL[k].body }; };
    const now = new Date(), h = now.getHours() + now.getMinutes() / 60;
    if (h < 10 || h >= 21.5) return 0;
    const saleTime = makeSaleTime(D.orders);
    const today = isoLocal(new Date(Date.now() - 4 * H));
    const custByL = {}; D.customers.forEach(cu => { const l = last10(cu.phone); if (l.length === 10) custByL[l] = cu; });
    const custByCode = {}; D.customers.forEach(cu => { custByCode[cu.code] = cu; });
    const prodByCode = {}; D.products.forEach(p => { prodByCode[p.code] = p; });
    const nameOf = cu => (cu && (cu.shopName || cu.name)) || 'عميلنا';
    const invByCust = {}; D.invoices.filter(i => i.type === 'sale' && i.customerCode).forEach(i => (invByCust[i.customerCode] = invByCust[i.customerCode] || []).push(i));
    Object.values(invByCust).forEach(a => a.sort((x, y) => saleTime(y) - saleTime(x)));
    const recent = await db.collection('customerOrders').where('createdAt', '>=', salesDayStart().getTime() - 3 * H).get().then(s => s.docs.map(d => Object.assign({ id: d.id }, d.data())));
    const orderL10 = o => { const cu = custByCode[o.customerCode]; return last10(o.phone || (cu && cu.phone) || o.customerCode); };
    const orderedToday = new Set(recent.filter(o => o.status !== 'rejected' && o.status !== 'cancelled').map(orderL10));
    const jobs = [];
    if (c.forgot) recent.forEach(o => {
        const age = Date.now() - (o.createdAt || 0);
        if (age < 60 * 60000 || age > 4 * H || o.source === 'rep' || o.repCode || o.repDelivery) return;
        if (['out', 'delivered', 'rejected', 'cancelled', 'returned', 'merged'].includes(o.status)) return;
        const cu = custByL[orderL10(o)] || custByCode[o.customerCode]; if (!cu) return;
        const hist = (invByCust[cu.code] || []).slice(0, 6); if (hist.length < 3) return;
        const cnt = {}; hist.forEach(i => new Set((i.items || []).map(x => x.productCode)).forEach(pc => { cnt[pc] = (cnt[pc] || 0) + 1; }));
        const inOrder = new Set((o.items || []).map(x => x.productCode));
        const miss = Object.keys(cnt).filter(pc => cnt[pc] >= 3 && !inOrder.has(pc) && (Number((D.inventory[pc] || {}).qty) || 0) > 0 && (prodByCode[pc] || {}).showInApp !== false)
            .sort((a, b) => cnt[b] - cnt[a]).slice(0, 3);
        if (!miss.length) return;
        const pn = pc => (prodByCode[pc] || {}).name || pc;
        jobs.push({ key: 'forgot_' + o.id, phone: o.phone || cu.phone, kind: 'forgot', vars: { 'الاسم': nameOf(cu), 'الأصناف': miss.map(pn).join(' و') }, extra: { kind: 'promo', productCode: miss[0] } });
    });
    if (c.offerFav) {
        const live = (D.appOffers || []).filter(of => of.active && of.productCode && (!of.endDate || new Date(of.endDate + 'T23:59:59') >= new Date()));
        const since = Date.now() - 60 * 86400000;
        live.forEach(of => Object.keys(invByCust).forEach(code => {
            const cu = custByCode[code]; if (!cu) return; const l = last10(cu.phone); if (l.length !== 10 || orderedToday.has(l)) return;
            if (!invByCust[code].some(i => saleTime(i) >= since && (i.items || []).some(x => x.productCode === of.productCode))) return;
            jobs.push({ key: 'offer_' + of.id + '_' + l, mkt: 'day_' + today + '_' + l, phone: cu.phone, kind: 'offerFav', vars: { 'الاسم': nameOf(cu), 'الصنف': of.productName || of.title || '', 'السعر': of.newPrice, 'القديم': of.oldPrice }, extra: { kind: 'promo', productCode: of.productCode } });
        }));
    }
    if (c.repday && h < 13) {
        const wd = new Date(Date.now() - 4 * H).getDay();
        D.customers.forEach(cu => {
            if (!cu.salesmanCode || !Array.isArray(cu.visitDays) || cu.visitDays.indexOf(wd) === -1) return;
            const rp = D.salesmen.find(s => s.code === cu.salesmanCode); if (!rp || (rp.status && rp.status !== 'نشط')) return;
            const l = last10(cu.phone); if (l.length !== 10 || orderedToday.has(l)) return;
            jobs.push({ key: 'repday_' + today + '_' + l, mkt: 'day_' + today + '_' + l, phone: cu.phone, kind: 'repday', vars: { 'الاسم': nameOf(cu), 'المندوب': String(rp.name || '').split(' ')[0] || 'المندوب' }, extra: { kind: 'promo' } });
        });
    }
    if (c.winback) Object.keys(invByCust).forEach(code => {
        const a = invByCust[code], last = saleTime(a[0]), days = Math.floor((Date.now() - last) / 86400000);
        if (days < 21 || days > 75 || a.filter(i => saleTime(i) >= Date.now() - 120 * 86400000).length < 2) return;
        const cu = custByCode[code]; if (!cu) return; const l = last10(cu.phone); if (l.length !== 10 || orderedToday.has(l)) return;
        jobs.push({ key: 'winback_' + l + '_' + Math.floor(last / 86400000), wb: l, mkt: 'day_' + today + '_' + l, phone: cu.phone, kind: 'winback', vars: { 'الاسم': nameOf(cu), 'الأيام': days }, extra: { kind: 'promo' } });
    });
    if (!jobs.length) return 0;
    const pmKey = autoMonthKey(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15).getTime());
    const [prev, cur] = await Promise.all([
        cached('autoPrev_' + pmKey, 6 * H, () => db.collection('meta').doc('autoNotif_' + pmKey).get().then(s => (s.exists && s.data()) || {})),
        db.collection('meta').doc('autoNotif_' + autoMonthKey()).get().then(s => (s.exists && s.data()) || {})
    ]);
    const recentWb = l => [prev, cur].some(d => Object.keys(d).some(k => k.indexOf('wbl_' + l) === 0 && Date.now() - d[k] < 30 * 86400000));
    const seenMkt = new Set(), list = [];
    jobs.forEach(j => {
        if (cur[j.key]) return;
        if (j.wb && recentWb(j.wb)) return;
        if (j.mkt) { if (cur[j.mkt] || seenMkt.has(j.mkt)) return; seenMkt.add(j.mkt); }
        list.push(j);
    });
    const batch = list.slice(0, 60);
    const keys = []; batch.forEach(j => { keys.push(j.key); if (j.mkt) keys.push(j.mkt); if (j.wb) keys.push('wbl_' + j.wb); });
    const gs = new Set(await autoClaim(keys));
    const send = batch.filter(j => gs.has(j.key) && (!j.mkt || gs.has(j.mkt)));
    let sent = 0;
    for (const j of send) {
        const t = tpl(j.kind);
        try { sent += await notifyCustomerPhone(j.phone, fill(t.title, j.vars), fill(t.body, j.vars), Object.assign({ auto: j.kind }, j.extra || {})); } catch (e) { console.error(e); }
    }
    if (send.length) await logAction('إشعارات تلقائية', `(من السيرفر) اتبعت ${sent} من ${send.length}: ` + Object.keys(AUTO_NOTIF_DEF).map(k => { const n = send.filter(j => j.kind === k).length; return n ? AUTO_NOTIF_DEF[k] + ' ' + n : ''; }).filter(Boolean).join('، '));
    return sent;
}

// ---------------------------------------------------------------- tick كل 10 دقايق
exports.tick = onSchedule({ schedule: 'every 10 minutes', timeZone: 'Africa/Cairo' }, async () => {
    const alive = await db.collection('meta').doc('sysAlive').get().then(s => (s.exists && s.data()) || {}).catch(() => ({}));
    const sysOpen = alive.at && Date.now() - alive.at < 20 * 60000;
    await status('lastTick', { at: Date.now(), sysOpen: !!sysOpen, v: SERVER_VERSION });
    if (sysOpen) return;   // فيه جهاز مدير/محاسب فاتح — هو بيعمل الشغل ده، والسيرفر مبيقراش حاجة (توفير)
    const errs = [];
    let D = null;
    // التارجت: كل ساعة، أو أول ما يوم البيع يتغير (9 الصبح)، لو آخر تحديث قديم
    try {
        const rp = await db.collection('meta').doc('repProgress').get().then(s => (s.exists && s.data()) || {});
        const age = Date.now() - (rp.updatedAt || 0), dayChanged = !rp.updatedAt || salesDayStart(new Date(rp.updatedAt)).getTime() !== salesDayStart().getTime();
        if (age > 55 * 60000 || (dayChanged && age > 15 * 60000)) { D = D || await loadData(); const n = await publishRepProgress(D); await status('lastRepProgress', { at: Date.now(), reps: n }); }
    } catch (e) { console.error('repProgress', e); errs.push('repProgress: ' + (e.message || e)); }
    try {
        const h = new Date().getHours() + new Date().getMinutes() / 60;
        if (h >= 10 && h < 21.5) { D = D || await loadData(); const n = await autoNotifTick(D); await status('lastAutoNotif', { at: Date.now(), sent: n }); }
    } catch (e) { console.error('autoNotif', e); errs.push('autoNotif: ' + (e.message || e)); }
    if (errs.length) await status('lastErrors', { at: Date.now(), errs });
});

// ---------------------------------------------------------------- ملخص المندوب الصبح (9:30)
exports.repDigest = onSchedule({ schedule: '30 9 * * *', timeZone: 'Africa/Cairo' }, async () => {
    const day = salesDayStart(new Date()).toDateString();
    const ref = db.collection('meta').doc('repDigest');
    const ok = await db.runTransaction(async tx => { const s = await tx.get(ref); if (s.exists && s.data().day === day) return false; tx.set(ref, { day, at: Date.now(), by: 'server' }); return true; });
    if (!ok) return;   // السيستم بعته النهارده
    const D = await loadData(), saleTime = makeSaleTime(D.orders), now = Date.now();
    const last = {}; D.invoices.forEach(i => { if (i.type !== 'sale' || !i.customerCode) return; const t = saleTime(i); if (!last[i.customerCode] || t > last[i.customerCode]) last[i.customerCode] = t; });
    const seen = {};
    (await db.collection('customerCarts').where('lastSeenAt', '>=', now - 2 * 86400000).get()).docs.forEach(d => { if (d.id.indexOf('seen_') !== 0) return; const x = d.data() || {}; seen[last10(x.phone || d.id.slice(5))] = Number(x.lastSeenAt); });
    const stats = custStats(D, saleTime, await appSeenMap());
    const fuAll = (await db.collection('customerVisitRecords').where('kind', '==', 'followUp').get()).docs.map(d => d.data());
    const nm = c => c.shopName || c.name;
    const mStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
    let sent = 0;
    for (const s of D.salesmen.filter(s => s.repType !== 'delivery' && (!s.status || s.status === 'نشط'))) {
        const mine = D.customers.filter(c => c.salesmanCode === s.code);
        const dormant = mine.filter(c => last[c.code] && now - last[c.code] >= 10 * 86400000).sort((a, b) => last[a.code] - last[b.code]);
        const opened = mine.filter(c => { const t = seen[last10(c.phone)]; return t && !(last[c.code] && last[c.code] >= t - 86400000); });
        const fu = fuAll.filter(f => f.repUsername === s.code);
        const lapsed = mine.filter(c => { const st = stats[c.code]; if (!st) return false; const done = fu.filter(f => String(f.customerCode) === String(c.code)).some(f => new Date(f.date).getTime() > mStart); return (st.pm || 0) >= 1 && !st.m && !done; });
        if (!dormant.length && !opened.length && !lapsed.length) continue;
        const parts = [];
        if (opened.length) parts.push(`👀 ${opened.length} فتحوا الأبليكشن ومطلبوش: ${opened.slice(0, 3).map(nm).join('، ')}`);
        if (dormant.length) parts.push(`😴 ${dormant.length} مطلبوش من 10 أيام أو أكتر: ${dormant.slice(0, 3).map(nm).join('، ')}${dormant.length > 3 ? '...' : ''}`);
        if (lapsed.length) parts.push(`📉 ${lapsed.length} كانوا بيطلبوا الشهر اللي فات وما طلبوش الشهر ده: ${lapsed.slice(0, 3).map(nm).join('، ')}${lapsed.length > 3 ? '...' : ''}`);
        await notifyRep(s.code, 'صباح الخير يا ' + String(s.name || '').split(' ')[0] + ' ☀️ عملاء محتاجين زيارتك', parts.join('\n'));
        sent++;
    }
    await status('lastRepDigest', { at: Date.now(), sent });
});

// ---------------------------------------------------------------- نسخة احتياطية كاملة (3 الفجر)
const BACKUP_KEEP = 14, BACKUP_CHUNK = 300000;
const TOP_KEYS = { invoiceRecords: 'invoices', purchaseInvoiceRecords: 'purchaseInvoices', productRecords: 'products', customerRecords: 'customers', supplierRecords: 'suppliers',
    stockMovementRecords: 'stockMovements', deliveryCollectionRecords: 'deliveryCollections', repSettlements: 'repSettlements', treasuryRecords: 'treasury', expenseRecords: 'expenses',
    salesReturnRecords: 'salesReturns', purchaseReturnRecords: 'purchaseReturns', supplierAdjustmentRecords: 'supplierAdjustments', journalEntries: 'journalEntries', customerOrders: 'customerOrders' };
async function runBackup(force) {
    const day = new Date().toISOString().slice(0, 10);
    const ref = db.collection('backups').doc(day);
    const ex = await ref.get();
    if (!force && ex.exists && ex.data().complete && ex.data().v === 2) return 'exists';
    const cols = (await db.listCollections()).map(c => c.id).filter(id => id !== 'backups');
    const payload = { backupVersion: 2, by: 'server', raw: {} }, counts = {}, errs = [];
    for (const col of cols) {
        try {
            const snap = await db.collection(col).get();
            if (col === 'inventoryRecords') { const m = {}; snap.docs.forEach(d => { m[d.id] = d.data(); }); payload.inventory = m; counts.inventory = snap.size; continue; }
            if (col === 'systemUsers') { payload.users = snap.docs.map(d => { const u = d.data() || {}; return { username: u.username, fullName: u.fullName, role: u.role, active: u.active }; }); counts.users = snap.size; continue; }
            if (TOP_KEYS[col]) { payload[TOP_KEYS[col]] = snap.docs.map(d => (col === 'customerOrders' || col === 'journalEntries') ? Object.assign({ id: d.id }, d.data()) : d.data()); counts[TOP_KEYS[col]] = snap.size; if (col === 'customerOrders') counts.raw_customerOrders = snap.size; if (col === 'journalEntries') counts.raw_journalEntries = snap.size; continue; }
            const m = {}; snap.docs.forEach(d => { m[d.id] = d.data(); }); payload.raw[col] = m; counts['raw_' + col] = snap.size;
        } catch (e) { errs.push(col + ': ' + (e.code || e.message)); }
    }
    const json = JSON.stringify(payload, (k, v) => (v && typeof v === 'object' && v.firestore && typeof v.path === 'string') ? { __ref: v.path } : v);
    const parts = []; for (let i = 0; i < json.length; i += BACKUP_CHUNK) parts.push(json.slice(i, i + BACKUP_CHUNK));
    for (let i = 0; i < parts.length; i += 8) await Promise.all(parts.slice(i, i + 8).map((d, j) => ref.collection('parts').doc(String(i + j).padStart(3, '0')).set({ i: i + j, data: d })));
    await ref.set({ day, v: 2, createdAt: Date.now(), by: { name: 'السيرفر (تلقائي)' }, parts: parts.length, sizeKB: Math.round(json.length / 1024), counts, rawErrors: errs, complete: true });
    const old = await ref.collection('parts').get(); await Promise.all(old.docs.filter(d => Number(d.id) >= parts.length).map(d => d.ref.delete()));
    // نسيب آخر 14 يوم بس
    const all = (await db.collection('backups').get()).docs.map(d => d.id).sort().reverse();
    for (const dd of all.slice(BACKUP_KEEP)) { const r = db.collection('backups').doc(dd); const ps = await r.collection('parts').get(); await Promise.all(ps.docs.map(p => p.ref.delete())); await r.delete(); }
    await logAction('نسخة احتياطية أوتوماتيك', `(من السيرفر) ${day} — ${Math.round(json.length / 1024)} KB${errs.length ? ' — جداول ماتقريتش: ' + errs.join('، ') : ''}`);
    return Math.round(json.length / 1024) + ' KB';
}
exports.dailyBackup = onSchedule({ schedule: '0 3 * * *', timeZone: 'Africa/Cairo', timeoutSeconds: 540, memory: '1GiB' }, async () => {
    const r = await runBackup(false);
    await status('lastBackup', { at: Date.now(), result: r });
});

// للاختبارات بس (مش بيترفع كـ function)
if (process.env.ALMOALLEM_TEST) module.exports.__test = { computeRepProgress, makeSaleTime, custStats, salesDayStart, autoNotifTick, runBackup, publishRepProgress, cache, db };
