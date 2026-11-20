// اختبارات تلقائية لنظام المعلم — بتتشغل قبل أي تحديث:  cd tests && npm install && node run.js
// مبتلمسش أي بيانات حقيقية: الصفحة بتتفتح محليًا، والسحابة متبدلة بنسخة وهمية في الذاكرة.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const FILE = path.join(__dirname, '..', 'index.html');
const NM = path.dirname(require.resolve('firebase/package.json')) + '/';
const results = [];
async function test(name, fn) { try { await fn(); results.push([true, name]); } catch (e) { results.push([false, name, e.message]); } }
function assert(c, msg) { if (!c) throw new Error(msg || 'assert'); }

(async () => {
  const browser = await chromium.launch();
  async function openPage() {
    const p = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    p.__errs = []; p.on('pageerror', e => /Connection failed|network-request-failed|ERR_FAILED/i.test(e.message) || p.__errs.push(e.message + (process.env.DBG ? ' @' + Date.now() % 100000 + ' ' + String(e.stack).slice(0, 300) : '')));
    await p.route('**/*', r => {
      const u = r.request().url();
      if (u.startsWith('https://x.test/')) return r.fulfill({ body: fs.readFileSync(FILE, 'utf8'), contentType: 'text/html' });
      const m = u.match(/firebasejs\/10\.12\.2\/(firebase-[a-z-]+\.js)/);
      if (m) return r.fulfill({ body: fs.readFileSync(NM + m[1], 'utf8'), contentType: 'application/javascript' });
      return r.abort();
    });
    await p.goto('https://x.test/'); await p.waitForTimeout(2500);
    // (النت مقفول في الاختبار عن قصد، فأخطاء الاتصال بتاعة Firebase نفسها مش بتتحسب)
    // سحابة وهمية في الذاكرة
    await p.evaluate(() => {
      const store = window.__store = {};
      const mk = (path) => ({ path, id: path.split('/').pop(),
        get: () => Promise.resolve(path.split('/').length % 2 === 0 ? { exists: !!store[path], data: () => store[path] }
          : { docs: Object.keys(store).filter(k => k.startsWith(path + '/') && k.split('/').length === path.split('/').length + 1).sort().reverse().map(k => ({ id: k.split('/').pop(), ref: mk(k), data: () => store[k] })) }),
        set: (d, o) => { const n = new TextEncoder().encode(JSON.stringify(d)).length; if (n > 1048000) return Promise.reject(new Error('doc too big ' + n)); store[path] = o && o.merge ? Object.assign({}, store[path], d) : d; return Promise.resolve(); },
        update: (d) => { store[path] = Object.assign({}, store[path], d); return Promise.resolve(); },
        delete: () => { delete store[path]; return Promise.resolve(); },
        onSnapshot: () => () => {}, orderBy: function(){ return this; }, limit: function(){ return this; }, where: function(){ return this; },
        doc: (id) => mk(path + '/' + id), collection: (c) => mk(path + '/' + c) });
      db = { collection: (c) => mk(c) };
      currentUser = { username: 'test', fullName: 'اختبار', role: 'admin' };
      window.xlRole = () => 'admin';
    });
    return p;
  }

  const p = await openPage();
  await test('السيستم بيفتح من غير أخطاء', async () => { assert(!p.__errs.length, p.__errs.join(' | ')); });
  await test('عدّاد القراية متركّب على Firebase', async () => {
    const r = await p.evaluate(() => !!(firebase.firestore.Query.prototype.__counted && firebase.firestore.DocumentReference.prototype.__counted));
    assert(r, 'مش متركّب');
  });
  await test('تقرير البيع: بيحسب الطلبات (مش المسلّمة بس) ويستبعد المرفوض', async () => {
    const r = await p.evaluate(() => {
      const t0 = Date.now() - 3600e3;
      customers = [{ code: 'C1', name: 'أ', phone: '01011112222', salesmanCode: 'R1' }];
      invoices = [{ id: 'I1', type: 'sale', sourceOrderId: 'O2', grandTotal: 900, customerCode: 'C1', date: new Date().toISOString() },
                  { id: 'I2', type: 'sale', grandTotal: 50, customerCode: 'C1', date: new Date().toISOString(), createdAt: Date.now() }];
      const orders = [{ id: 'O1', customerCode: 'C1', status: 'pending', total: 1200, createdAt: t0 },
                      { id: 'O2', customerCode: 'C1', status: 'delivered', total: 1000, createdAt: t0 },
                      { id: 'O3', customerCode: 'C1', status: 'rejected', total: 777, createdAt: t0 }];
      const rows = repSalesRows(orders, t0 - 1000, Date.now() + 1000);
      return { n: rows.length, sum: rows.reduce((a, x) => a + x.total, 0) };
    });
    assert(r.n === 3 && r.sum === 2150, JSON.stringify(r));
  });
  await test('النسخة الاحتياطية: كاملة، قطعها تحت حد Firebase، وبترجع سليمة', async () => {
    const r = await p.evaluate(() => new Promise(res => {
      products = [{ code: 'p' }]; invoices = [{ id: 1, type: 'sale' }]; accJournals = [];
      __store['customerOrders/o1'] = { total: 5, note: 'عربي'.repeat(200000) };
      __store['journalEntries/j1'] = { memo: 'قيد' };
      runDailyBackup(true);
      setTimeout(() => {
        const day = new Date().toISOString().slice(0, 10), meta = __store['backups/' + day];
        const parts = Object.keys(__store).filter(k => k.startsWith('backups/' + day + '/parts/')).sort();
        let j = null; try { j = JSON.parse(parts.map(k => __store[k].data).join('')); } catch (e) {}
        res({ v: meta && meta.v, complete: meta && meta.complete, parts: parts.length, ok: !!(j && j.raw.customerOrders.o1.total === 5 && j.raw.journalEntries.j1) });
      }, 4000);
    }));
    assert(r.v === 2 && r.complete && r.parts >= 2 && r.ok, JSON.stringify(r));
  });
  await test('صحة السيستم: بتنبّه على طلب خرج من 3 أيام', async () => {
    const r = await p.evaluate(() => { customerOrders = [{ id: 'x', status: 'ready', createdAt: Date.now() - 3 * 86400e3 }]; return sysHealthChecks().map(x => x.t).join(' | '); });
    assert(/خرج للتسليم/.test(r), r);
  });
  await test('صحة السيستم: الكارت بيظهر على الصفحة الرئيسية', async () => {
    await p.evaluate(() => { renderSysHealth(); }); await p.waitForTimeout(500);
    const t = await p.evaluate(() => { const b = document.getElementById('sysHealthCard'); return b && b.style.display !== 'none' ? b.innerText : ''; });
    assert(/صحة السيستم/.test(t), 'الكارت مش ظاهر: ' + t);
    await p.evaluate(() => { sysHealthOpen = true; renderSysHealth(); }); await p.waitForTimeout(400);
    try { await p.evaluate(() => { const b = document.getElementById('sysHealthCard'); document.body.appendChild(b); b.style.cssText += ';position:fixed;top:10px;left:10px;right:10px;z-index:999999;background:#fff7e6;'; }); await p.locator('#sysHealthCard').screenshot({ path: path.join(__dirname, 'health.png') }); } catch (e) {}
  });
  await test('مفيش أخطاء ظهرت أثناء الاختبارات', async () => { assert(!p.__errs.length, p.__errs.join(' | ')); });
  await browser.close();

  let bad = 0; results.forEach(([ok, n, e]) => { if (!ok) bad++; console.log((ok ? '✓ ' : '✗ ') + n + (ok ? '' : '  ←  ' + e)); });
  console.log(bad ? `\n${bad} اختبار فشل — ما ترفعش التحديث` : `\nكل الاختبارات نجحت (${results.length})`);
  process.exit(bad ? 1 : 0);
})();
