// اختبار: السيرفر بيحسب تارجت المناديب بنفس حساب السيستم بالظبط.  تشغيل: (cd server/functions && npm i) && TZ=Africa/Cairo node tests/server-equal.js
const {chromium}=require('playwright');const fs=require('fs');const path=require('path');const NM=path.dirname(require.resolve('firebase/package.json'))+'/';
process.env.TZ='Africa/Cairo'; process.env.ALMOALLEM_TEST='1'; process.env.GCLOUD_PROJECT='almoallem-system';
const now=Date.now(), D=86400e3;
const customers=[], invoices=[], orders=[];
for(let i=0;i<40;i++) customers.push({code:'C'+i,name:'ع'+i,phone:'0101111'+String(1000+i),salesmanCode:i%3?('R'+(i%3)):''});
let n=0; for(let d=0;d<75;d++) for(let k=0;k<4;k++){ const c='C'+((d*7+k*3)%40); const t=now-d*D-k*3600e3; const id='ORD-'+t;
  if(k%2){orders.push({id,customerCode:c,createdAt:t,repCode:k===3?'R2':'',status:'delivered'});}
  invoices.push({id:'I'+(n++),type:k===2&&d%5===0?'purchase':'sale',customerCode:c,grandTotal:100+d+k,date:new Date(t+2*3600e3).toISOString(),
    sourceOrderId:k%2?id:undefined, orderCreatedAt:k===1&&d%2?t:undefined, salesmanCode:k===0&&d%3===0?'R1':undefined, responsibleRepCode:k===2?'R2':undefined}); }
(async()=>{
 const b=await chromium.launch();const p=await b.newPage();
 await p.route('**/*',r=>{const u=r.request().url(); if(u.startsWith('https://x.test/'))return r.fulfill({body:fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8'),contentType:'text/html'});
  const m=u.match(/firebasejs\/10\.12\.2\/(firebase-[a-z-]+\.js)/); if(m) return r.fulfill({body:fs.readFileSync(NM+m[1],'utf8'),contentType:'application/javascript'}); return r.abort();});
 await p.emulateTimezone? null:null;
 const ctxTZ=null;
 await p.goto('https://x.test/');await p.waitForTimeout(2000);
 const client=await p.evaluate(({customers,invoices,orders})=>new Promise(res=>{
   window.customers=customers; customers_=0;
   eval('customers=arguments[0]');
 }),{customers,invoices,orders}).catch(()=>null);
 const out=await p.evaluate(({c,i,o})=>new Promise(res=>{ customers=c; invoices=i; customerOrders=o; currentUser={username:'t',role:'admin'}; window.xlRole=()=>'admin'; window.isCloudReady=()=>true;
   appSeenCache={at:Date.now(),map:{}}; repProgressLastJson='';
   db={collection:(n)=>({doc:()=>({set:(d)=>{res(JSON.stringify({monthKey:d.monthKey,reps:d.reps,cust:d.cust}));return Promise.resolve();}}),where:()=>({get:()=>Promise.resolve({docs:[]})})})};
   publishRepProgress(); setTimeout(()=>res('none'),3000);}),{c:customers,i:invoices,o:orders});
 await b.close();
 const T=require(path.join(__dirname,'..','server','functions','index.js')).__test;
 const srv=T.computeRepProgress({customers,invoices,orders},T.makeSaleTime(orders),{});
 const s=JSON.stringify({monthKey:srv.monthKey,reps:srv.reps,cust:srv.cust});
 console.log('client len',out.length,'server len',s.length,'EQUAL',out===s);
 if(out!==s){const a=JSON.parse(out),bb=JSON.parse(s);console.log(JSON.stringify(a.reps),JSON.stringify(bb.reps));}
})();
