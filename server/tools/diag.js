// تشخيص (قراية بس): آخر الإشعارات والعمليات + تجربة سيرفر الإشعارات برقم وهمي
process.env.TZ = 'Africa/Cairo';
const admin = require('../functions/node_modules/firebase-admin');
admin.initializeApp({ projectId: 'almoallem-system' });
const db = admin.firestore();
(async () => {
  const from = Date.now() - 6 * 3600e3;
  const log = await db.collection('meta').doc('notifLog').get();
  console.log('== notifLog (آخر 8)');
  ((log.exists && log.data().items) || []).slice(0, 8).forEach(x => console.log(new Date(x.createdAt).toLocaleString('en-GB'), '|', x.targetLabel, '|', x.title, '| reached', x.reached, '/', x.total, '|', x.by));
  console.log('== audit (آخر 6 ساعات، فيها إشعار/طلب/حالة)');
  const au = await db.collection('auditLogRecords').orderBy('date', 'desc').limit(400).get();
  au.docs.map(d => d.data()).filter(x => new Date(x.date).getTime() >= from && /إشعار|طلب|حالة|تجهيز|تسليم/.test((x.type || '') + (x.details || ''))).slice(0, 40)
    .forEach(x => console.log(new Date(x.date).toLocaleTimeString('en-GB'), '|', x.fullName, '|', x.type, '|', String(x.details || '').slice(0, 140)));
  const ns = await db.collection('meta').doc('notifSettings').get();
  console.log('== autoNotif settings', JSON.stringify((ns.data() || {}).autoNotif || null));
  console.log('== proxy probe (رقم وهمي)');
  for (const t of ['01000000000', 'rep_ZZZ']) {
    try { const r = await fetch('https://noisy-glitter-c1b3.abdelrahimkhaledwasfy.workers.dev', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://abdelrahimkhaledwasfy-svg.github.io' }, body: JSON.stringify({ targetPhone: t, title: 'test', message: 'test' }) });
      console.log(t, r.status, (await r.text()).slice(0, 400)); } catch (e) { console.log(t, 'ERR', e.message); }
  }
  // عيّنة: كام عميل في appCustomers وعندهم تسجيل إشعارات
  const ac = await db.collection('appCustomers').select('phone', 'onesignalId', 'pushId', 'notifOk').limit(5).get();
  console.log('== appCustomers sample fields', ac.docs.map(d => Object.keys(d.data()).join(',')).join(' / '));
  process.exit(0);
})().catch(e => { console.log('diag failed', e.message); process.exit(0); });
