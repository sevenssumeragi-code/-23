/* ============================================================
   ミッドナイトライン ― エンジン
   描画・音響・資料パネル・入力・保存。状態とロジックは core.js。
   ============================================================ */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

let script = [], labels = {}, pc = 0, running = false, typing = null, tmr = null;
/* シナリオは {sec:n} を選択肢ノードの手前に独立したノードとして置く。
   直後の選択肢ノードに適用するため、いったんここに預かる。 */
let pendingSec = null;

/* ---------- 保存 ----------
   window.storage（ホスト提供の非標準API）→ localStorage → メモリ の順に試す。
   素のブラウザには window.storage が無いため、localStorage を挟まないと
   セーブがページリロードで消える。 */
const mem = {};
async function saveAll(){
  const s = JSON.stringify(S), g = JSON.stringify(G);
  try{ await window.storage.set('ml:save', s); await window.storage.set('ml:global', g); return; }catch(e){}
  try{ localStorage.setItem('ml:save', s); localStorage.setItem('ml:global', g); return; }catch(e){}
  mem.save = s; mem.global = g;
}
async function loadKey(k){
  try{ const r = await window.storage.get('ml:'+k); if(r) return JSON.parse(r.value); }catch(e){}
  try{ const v = localStorage.getItem('ml:'+k); if(v) return JSON.parse(v); }catch(e){}
  return mem[k] ? JSON.parse(mem[k]) : null;
}

/* ---------- 音響(WebAudio・素材不要) ---------- */
const AU = {
  ctx:null, on:true, amb:null, ambGain:null,
  init(){ if(!this.ctx){ try{ this.ctx = new (window.AudioContext||window.webkitAudioContext)(); }catch(e){} } },
  g(v){ const g = this.ctx.createGain(); g.gain.value = v; g.connect(this.ctx.destination); return g; },
  beep(f,d,v=.05,type='sine'){ if(!this.on) return; this.init(); if(!this.ctx) return;
    const o = this.ctx.createOscillator(), g = this.g(0); o.type = type; o.frequency.value = f;
    o.connect(g); o.start();
    g.gain.linearRampToValueAtTime(v, this.ctx.currentTime+.01);
    g.gain.exponentialRampToValueAtTime(.0001, this.ctx.currentTime+d);
    o.stop(this.ctx.currentTime+d+.02);
  },
  ring(kind){ if(!this.on) return; this.init(); if(!this.ctx) return;
    if(kind==='old'){ // 十年前の黒電話
      for(let i=0;i<7;i++) setTimeout(()=>this.beep(1050,.06,.05,'triangle'),i*90);
    } else if(kind==='broken'){ // 文字化け着信
      for(let i=0;i<6;i++) setTimeout(()=>this.beep(300+Math.random()*900,.09,.045,'square'),i*70);
    } else { this.beep(880,.18,.045,'sine'); setTimeout(()=>this.beep(880,.18,.045,'sine'),240); }
  },
  hang(kind){ if(!this.on) return; this.init(); if(!this.ctx) return;
    if(kind==='silent') return;
    if(kind==='cut'){ this.beep(180,.05,.06,'square'); return; }
    this.beep(400,.5,.035,'sine');
  },
  noise(sec=.5,v=.05){ if(!this.on) return; this.init(); if(!this.ctx) return;
    const b = this.ctx.createBuffer(1, this.ctx.sampleRate*sec, this.ctx.sampleRate), d = b.getChannelData(0);
    for(let i=0;i<d.length;i++) d[i] = (Math.random()*2-1)*.6;
    const s = this.ctx.createBufferSource(); s.buffer = b;
    const f = this.ctx.createBiquadFilter(); f.type='bandpass'; f.frequency.value=1200;
    const g = this.g(v); s.connect(f); f.connect(g); s.start();
  },
  ambient(level){ // 章ごとの空気(低周波ドローン)
    if(!this.on) return; this.init(); if(!this.ctx) return;
    if(this.amb){ try{ this.amb.forEach(o=>o.stop()); }catch(e){} this.amb=null; }
    const base = [55,58.3,73.4,49,41.2,65.4,87][level] || 55;
    const g = this.g(.012); this.ambGain = g; const list = [];
    [1,1.5,2.02].forEach((m,i)=>{ const o = this.ctx.createOscillator();
      o.type = i===2?'triangle':'sine'; o.frequency.value = base*m; o.connect(g); o.start(); list.push(o); });
    this.amb = list;
  },
  stopAmb(){ if(this.amb){ try{ this.amb.forEach(o=>o.stop()); }catch(e){} this.amb=null; } },
  click(){ this.beep(1400,.03,.02,'square'); }
};

/* ---------- 画面ヘルパ ---------- */
function refreshHead(){
  const tl = timeLeft(), fg = fatigue();
  $('#hDay').innerHTML = 'DAY '+String(S.day).padStart(2,'0') +
    `<span style="margin-left:10px;color:${tl<=45?'#c4443a':tl<=120?'#f0c674':'#8792a2'}">残 ${tl}分</span>` +
    (fg?`<span style="margin-left:8px;color:#c4443a">疲労 ${'●'.repeat(fg)}</span>`:'');
  $('#hClock').textContent = clockStr(S.clock);
  $('#hChap').textContent = S.chapTitle.split(' ')[0] + (S.loop>1?'　周回'+S.loop:'');
  const nm = ['回線良好','微弱な雑音','二重音声を検知','境界接近 — 回線不安定'][S.noise];
  $('#hNoiseTx').textContent = nm;
  $('#hLamp').className = 'lamp' + (S.noise>=2?' on':'');
  document.body.className = S.noise?('n'+S.noise):'';
}
function setNoise(n){ S.noise = n; refreshHead(); if(n>=2) AU.noise(.4,.03); }
function fx(kind){
  if(kind==='shake'){ document.body.classList.add('shake'); setTimeout(()=>document.body.classList.remove('shake'),520); }
  if(kind==='flash'){ const f=$('#flash'); f.style.opacity=.85; setTimeout(()=>f.style.opacity=0,110); }
}

/* 波形(署名演出:声の状態で揺れる) */
const wv = {cv:null,ct:null,amp:0,col:'#f0c674',t:0};
function waveInit(){ wv.cv = $('#wave'); wv.ct = wv.cv.getContext('2d'); loopWave(); }
function loopWave(){
  const c = wv.ct, W = wv.cv.width, H = wv.cv.height; wv.t += .05;
  c.clearRect(0,0,W,H);
  const n = S ? S.noise : 0;
  c.strokeStyle = wv.col; c.lineWidth = 1.2; c.globalAlpha = .85; c.beginPath();
  for(let x=0;x<W;x+=2){
    const base = Math.sin(x*.02 + wv.t)*Math.sin(x*.005 - wv.t*.6);
    const noi = (Math.random()-.5)*n*4;
    const y = H/2 + base*wv.amp*H*.38 + noi;
    x===0 ? c.moveTo(x,y) : c.lineTo(x,y);
  }
  c.stroke();
  if(n>=2){ c.globalAlpha=.35; c.strokeStyle='#c4443a'; c.beginPath();
    for(let x=0;x<W;x+=3){ const y = H/2 + Math.sin(x*.05 - wv.t*1.7)*wv.amp*H*.2 + (Math.random()-.5)*n*3;
      x===0?c.moveTo(x,y):c.lineTo(x,y); } c.stroke(); }
  c.globalAlpha = 1;
  wv.amp *= .93;
  requestAnimationFrame(loopWave);
}

/* ---------- テキスト表示 ---------- */
function pushLine(html, cls){
  const d = document.createElement('div'); d.className = 'tx '+(cls||''); d.innerHTML = html;
  $('#text').appendChild(d);
  const w = $('#textwrap'); w.scrollTop = w.scrollHeight;
  return d;
}
function typeInto(el, text, speed, done){
  let i = 0; el._full = (el.innerHTML||'') + text; el._done = done; const cur = document.createElement('span'); cur.className='cursor';
  const body = document.createElement('span'); el.appendChild(body); el.appendChild(cur);
  clearInterval(typing);
  typing = setInterval(()=>{
    if(i >= text.length){ clearInterval(typing); typing=null; cur.remove(); done && done(); return; }
    body.textContent += text[i++];
    wv.amp = Math.min(1, wv.amp + .25);
    if(i%3===0) $('#textwrap').scrollTop = $('#textwrap').scrollHeight;
  }, speed);
}
function skipType(){
  if(typing){
    clearInterval(typing); typing = null;
    const el = $('#text').lastChild;
    if(el && el._full) el.innerHTML = el._full;
    if(el && el._done){ const d = el._done; el._done = null; running = false; d(); }
    return true;
  }
  return false;
}

/* ---------- 右ペイン ---------- */
function renderAside(){
  const a = $('#aside'); let h = '<h4>相談者の状態</h4>';
  TRACKED.forEach(k=>{
    const c = S.chars[k], m = CHARS[k];
    if(!S.flags['MET_'+k]) return;
    const bar=(v,col)=>`<div class="bar"><i style="width:${v}%;background:${col}"></i></div>`;
    h += `<div class="pc"><span class="st ${c.state}">${c.life==='生存'?c.state:c.life}</span>
      <div class="n" style="color:${m.col}">${m.name}</div>
      <div class="lb">信頼 ${c.trust}</div>${bar(c.trust,'#f0c674')}
      <div class="lb">疑念 ${c.doubt}</div>${bar(c.doubt,'#8f7fc9')}
      <div class="lb">恐怖 ${c.fear}</div>${bar(c.fear,'#c4443a')}
      <div class="lb">ストレス ${c.stress}</div>${bar(c.stress,'#5f8fa8')}${
        // 追補 §7-5: 数値は見せず、言葉で警告する
        c.life==='生存' ? (()=>{ const p = callPressure(k);
          if(p >= 60) return '<div class="warn2">もう、かけてこないかもしれない</div>';
          if(p >= 50) return '<div class="warn1">かけてくる回数が減っている</div>';
          return ''; })() : ''
      }</div>`;
  });
  if(h === '<h4>相談者の状態</h4>') h += '<p class="empty">まだ誰の声も聞いていない。</p>';
  a.innerHTML = h;
}

/* ---------- 資料パネル ---------- */
const PANELS = [
  ['memo','相談メモ'],['rel','人物相関図'],['tl','事件年表'],['evd','証拠一覧'],
  ['rec','録音再生'],['hist','通話履歴'],['vm','留守番電話'],['dial','折り返し発信'],['prof','相談者プロフィール'],
  ['still','スチル'],['flag','フラグ確認'],['sys','セーブ / 周回']
];
function renderNav(){
  let h = '<h4>相談ファイル</h4>';
  PANELS.forEach(([k,t])=>{
    let badge = '';
    if(k==='vm'){ const n = S.vm.filter(v=>!v.played && !v.dead).length;
      if(n) badge = `<span class="badge">${n}</span>`; }
    if(k==='rec'&& S.recs.some(r=>!r.played)) badge = '<span class="badge">●</span>';
    h += `<button data-p="${k}">${t}${badge}</button>`;
  });
  $('#nav').innerHTML = h;
  $$('#nav button').forEach(b=>b.onclick=()=>{ AU.click(); openPanel(b.dataset.p); });
}
function openPanel(k){
  const t = (PANELS.find(p=>p[0]===k)||[])[1] || '';
  $('#pTitle').textContent = t; $('#pBody').innerHTML = PANEL_HTML[k]();
  $('#panel').classList.add('on');
  $('#nav').classList.remove('on'); $('#aside').classList.remove('on');
  $$('#mobtabs button').forEach(x=>x.classList.toggle('act', x.dataset.m==='call'));
  bindPanel(k);
}
const PANEL_HTML = {
  memo: () => S.memo.length ? S.memo.map((m,i)=>`<div class="card"><div class="d">DAY ${m.d}${
          m.mark==='b'?'　<span style="color:#7fd3a0">〈信じる〉</span>':m.mark==='d'?'　<span style="color:#c4443a">〈疑う〉</span>':''
        }</div><h5>${m.t}</h5><p>${m.x}</p>${
          m.k?`<div class="tools"><button data-mk="${i}" data-v="b"${m.mark==='b'?' class="on"':''}>信じる</button>
          <button data-mk="${i}" data-v="d"${m.mark==='d'?' class="on"':''}>疑う</button></div>`:''
        }</div>`).join('')
        : '<p class="empty">まだ書き留めたことはない。<br>通話中の言葉は、聞き逃せば二度と戻らない。</p>',
  rel:  () => S.rel.length ? '<div class="rel">'+S.rel.map(r=>`<div class="rel ${r.dot?'dot':''}">${r.dot?'┈┈':'──'} <b>${r.a}</b> ${r.t} <b>${r.b}</b></div>`).join('')+'</div>'
        : '<p class="empty">線はまだ一本も引かれていない。</p>',
  tl:   () => '<table>'+S.tl.map(e=>`<tr><td class="t">${e.d}</td><td>${e.t}</td></tr>`).join('')+'</table>',
  evd:  () => S.evd.length ? S.evd.map(e=>`<div class="card evd"><h5>${e.t}</h5><p>${e.x}</p></div>`).join('')
        : '<p class="empty">証拠はまだない。声だけが唯一の物証だ。</p>',
  rec:  () => S.recs.length ? S.recs.map((r,i)=>`<div class="card ${r.opened?'hidn':''}"><div class="d">DAY ${r.day} ／ ${r.ti}</div>
        <p>${r.opened&&r.hid ? r.tx+'<br><span style="color:#c9a0e0">〔0.5倍速〕'+r.hid+'</span>' : r.tx}</p>
        <div class="tools"><button data-rec="${i}" data-md="play">再生</button>
        ${r.hid?`<button data-rec="${i}" data-md="slow">0.5倍速で聴く</button><button data-rec="${i}" data-md="rev">逆再生</button>`:''}</div></div>`).join('')
        : '<p class="empty">録音はまだない。<br>通話はすべて自動で記録される。</p>',
  hist: () => S.hist.length ? '<table>'+S.hist.map(e=>`<tr><td class="t">D${e.d} ${e.c}</td><td>${e.w}<br><span style="color:#8792a2;font-size:11px">${e.len} ／ ${e.r}</span></td></tr>`).join('')+'</table>'
        : '<p class="empty">履歴なし。</p>',
  vm:   () => {
        const miss = CNT('VM_MISS');
        const head = miss ? `<p class="empty" style="color:#c4443a;margin-bottom:12px">上書きされて消えたメッセージ：${miss}件</p>` : '';
        if(!S.vm.length) return head + '<p class="empty">新しいメッセージはありません。</p>';
        return head + S.vm.map((v,i)=>{
          const left = 1 - (S.day - v.d);   // 当夜=1, 翌夜=0, それ以降は消える
          const st = v.dead ? '<span style="color:#5f6b7c">上書き済み — 再生できません</span>'
            : v.played ? v.x
            : `未再生${left<=0?'<span style="color:#c4443a">　※次の夜で上書きされます</span>':''}`;
          return `<div class="card"><div class="d">DAY ${v.d} ${v.c}</div><h5>${v.w}</h5><p>${st}</p>${
            v.dead||v.played?'':`<div class="tools"><button data-vm="${i}">再生する</button></div>`}</div>`;
        }).join('');
        },
  dial: () => {
        const open = DIALS.filter(d=>d.open());
        if(!open.length) return '<p class="empty">折り返せる番号は、まだ一つもない。</p>';
        return `<p class="empty" style="margin-bottom:12px">発信も通話時間を使う。残 ${timeLeft()}分。</p>` +
          open.map(d=>`<div class="card"><h5>${d.label}<span style="color:#8792a2;font-size:11px">　${d.num}</span></h5>
          ${(S.dialLog||{})[d.id]?`<p>${S.dialLog[d.id]}</p>`:'<p style="color:#5f6b7c">未発信</p>'}
          <div class="tools"><button data-dial="${d.id}">この番号にかける</button></div></div>`).join('');
        },
  prof: () => TRACKED.filter(k=>F('MET_'+k)).map(k=>{
        const c = S.chars[k], m = CHARS[k];
        return `<div class="card"><h5 style="color:${m.col}">${m.name}<span style="color:#8792a2;font-size:11px">　${m.sub}</span></h5>
        <p>${(c.known||[]).map(s=>'・'+s).join('<br>')||'・情報なし'}</p>
        <p style="margin-top:6px;color:#8792a2;font-size:11px">状態：${c.life==='生存'?c.state:c.life}／信頼 ${c.trust}／疑念 ${c.doubt}</p></div>`;
        }).join('') || '<p class="empty">まだ誰のことも知らない。</p>',
  still:() => STILLS.map(s=>{
        const got = S.stills.includes(s.id) || (G.stills||[]).includes(s.id);
        return `<div class="still ${got?'':'lockd'}" ${got?`data-still="${s.id}"`:''}>
          <div class="im" style="background:${s.bg}"></div>
          <div class="cap"><b>${got?s.t:'??????'}</b>${got?s.c:'未取得 — 取得条件：'+s.cond}</div></div>`;
        }).join(''),
  flag: () => {
        const ks = Object.keys(S.flags);
        return `<p class="empty" style="margin-bottom:12px">立っているフラグ ${ks.length} 件／周回 ${S.loop}</p>` +
          '<div class="rel">'+ks.map(k=>`◆ ${k}${S.flags[k]!==1?' = '+S.flags[k]:''}`).join('<br>')+'</div>';
        },
  sys:  () => `<div class="card"><h5>記録</h5><p>この端末は自動で記録されています。手動保存もできます。</p>
        <div class="tools"><button data-sys="save">いま保存する</button><button data-sys="title">タイトルへ戻る</button></div></div>
        <div class="card"><h5>周回 ${S.loop}</h5><p>録音・メモ・証拠・相関図・年表・スチルは次の周回へ引き継がれます。信頼度はリセットされます——もう一度、はじめから話を聞くために。</p>
        <p style="margin-top:8px">到達済みエンディング：${(G.endings||[]).join('・')||'なし'}</p></div>`
};
function bindPanel(k){
  $$('#pBody [data-rec]').forEach(b=>b.onclick=()=>playRec(+b.dataset.rec, b.dataset.md));
  $$('#pBody [data-vm]').forEach(b=>b.onclick=()=>{
    const v=S.vm[+b.dataset.vm];
    if(v.dead) return;
    v.played=1; AU.noise(.3,.03);
    // 聞いてもらえた、という事実そのものが相手に届く（追補 §5-1）
    if(v.who && S.chars[v.who]) applyPar({c:v.who, trust:3, doubt:-5});
    if(v.k) SET('VM_'+v.k);
    openPanel('vm'); renderNav(); renderAside(); saveAll();
  });
  $$('#pBody [data-mk]').forEach(b=>b.onclick=()=>{
    markMemo(S.memo[+b.dataset.mk], b.dataset.v); AU.click(); openPanel('memo'); saveAll();
  });
  $$('#pBody [data-dial]').forEach(b=>b.onclick=()=>{ AU.click(); dial(b.dataset.dial); });
  $$('#pBody [data-still]').forEach(b=>b.onclick=()=>showStill(b.dataset.still));
  $$('#pBody [data-sys]').forEach(b=>b.onclick=()=>{ if(b.dataset.sys==='save'){ saveAll(); b.textContent='保存しました'; } else location.reload(); });
}
function playRec(i, mode){
  const r = S.recs[i]; r.played = 1;
  AU.noise(.5,.04);
  if(mode!=='play' && r.hid){
    // フラグは毎回立て直す。opened は周回を跨いで引き継がれるが
    // フラグは周回ごとにリセットされるため、初回だけ立てると
    // 2周目で証拠照合の req が満たせなくなる。
    if(r.flag){ SET(r.flag); }
    if(!(G.recs||[]).includes(r.id)){ G.recs = G.recs||[]; G.recs.push(r.id); }
    if(!r.opened){   // 演出は「はじめて底が見えた」ときだけ
      r.opened = 1;
      fx('shake'); AU.beep(80,1.2,.05,'sawtooth');
      toast('録音の底から、別の声が浮かび上がった。');
    }
  }
  openPanel('rec'); renderNav(); saveAll();
}
function toast(t){
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:80;background:#141d29;border:1px solid #f0c674;color:#f0c674;padding:10px 18px;border-radius:4px;font-size:12.5px;letter-spacing:.1em';
  d.textContent = t; document.body.appendChild(d);
  setTimeout(()=>{ d.style.transition='opacity .8s'; d.style.opacity=0; setTimeout(()=>d.remove(),800); }, 2200);
}
function showStill(id, cont){
  const s = STILLS.find(x=>x.id===id); if(!s){ cont && cont(); return; }
  $('#svIm').style.background = s.bg;
  $('#svCp').innerHTML = `<b>${s.t}</b>${s.c}`;
  $('#stillview').classList.add('on');
  $('#stillview').onclick = ()=>{ $('#stillview').classList.remove('on'); cont && cont(); };
}
function unlockStill(id, cont){
  if(!S.stills.includes(id)) S.stills.push(id);
  G.stills = G.stills||[]; if(!G.stills.includes(id)) G.stills.push(id);
  AU.beep(520,.5,.03,'sine');
  showStill(id, cont);
}

/* ---------- core からの通知を UI に繋ぐ ---------- */
Hooks.par   = () => renderAside();
Hooks.meet  = () => renderAside();
Hooks.memo  = t => toast('相談メモに記録：'+t);
Hooks.evd   = t => toast('証拠を入手：'+t);
Hooks.vm    = () => { renderNav(); toast('留守番電話に1件のメッセージ'); };
Hooks.rec   = () => { renderNav(); toast('通話を録音しました'); };
Hooks.tlfix = () => toast('事件年表の空白が埋まった。');
Hooks.toastx= () => { const n = ['MUN_TEACH_01','MUN_TEACH_02','MUN_TEACH_03'].filter(F).length;
                      toast('ムニに教えたこと '+n+' / 3'); };
Hooks.noise = () => refreshHead();
Hooks.shift = () => {
  if(CNT('OVERTIME') >= 2) toast('疲労が溜まっている。判断できる時間が短くなった。');
  pushLine('午前四時。勤務時間は終了した。<br>それでも受話器を置けないなら、置かないでいい。ただし、明日の夜のあなたは、今夜より少し疲れている。','sys');
  AU.beep(300,.9,.03,'sine'); refreshHead();
};
Hooks.vmLost = (lost, n) => {
  pushLine(`留守番電話 ${lost}件が、新しい着信に上書きされた。<br>——聞かないまま消えたメッセージ：累計 ${n}件`,'sys');
  AU.beep(140,.7,.045,'sawtooth'); toast('未再生の留守電が上書きされました');
  if(n === 3) pushLine('この部屋には、聞かれなかった声が溜まっていく。<br>受話器を取っても、相手が本題に入るまでの時間が、少しずつ長くなった。','nar');
  if(n >= 5) pushLine('無言の着信が増えた。取っても、誰も喋らない。<br>——ただ、切る直前に、いつも同じ雨音がする。','nar');
  renderNav(); renderAside(); refreshHead();
};
Hooks.hold   = () => {
  $('#cMeta').textContent = (S.cur?S.cur.num:'') + ' ／ 保留中';
  AU.beep(660,.2,.02,'triangle'); setTimeout(()=>AU.beep(880,.2,.02,'triangle'),220);
  pushLine('回線を保留にした。保留音——オルゴールの、あの曲。','sys');
};
Hooks.resume = (min) => {
  $('#cMeta').textContent = (S.cur?S.cur.num:'') + ' ／ 通話中';
  pushLine(`保留 ${min}分。待たされた側の呼吸が、変わっている。`,'sys');
  renderAside();
};

/* ---------- 折り返し発信（追補 §3） ---------- */
function dial(id){
  const d = DIALS.find(x=>x.id===id); if(!d) return;
  S.dialLog = S.dialLog || {};
  if(timeLeft() <= 0){
    S.dialLog[id] = '——交換台はもう夜勤明けだ。外線は朝まで繋がらない。';
    openPanel('dial'); return;
  }
  const r = d.resp();
  S.dialLog[id] = r.log;
  S.hist.push({d:S.day, c:clockStr(S.clock), w:'（発信）'+d.label, len:(r.len||1)+'分', r:r.result});
  S.clock += (r.len||1);
  if(r.ring==='none') AU.beep(180,.6,.03,'square');
  else if(r.ring==='old') AU.ring('old');
  else { AU.beep(520,.25,.03,'sine'); setTimeout(()=>AU.beep(520,.25,.03,'sine'),600); }
  if(r.noise!=null) setNoise(r.noise);
  if(r.set) Object.entries(r.set).forEach(([k,v])=>SET(k,v));
  if(r.par) applyPar(r.par);
  if(r.memo) S.memo.push({d:S.day,t:r.memo[0],x:r.memo[1],k:r.memo[2]||null,mark:null});
  if(r.evd) S.evd.push({t:r.evd[0], x:r.evd[1]});
  if(r.toast) toast(r.toast);
  refreshHead(); checkShift(); renderNav(); renderAside(); saveAll();
  if(r.still) unlockStill(r.still, ()=>openPanel('dial')); else openPanel('dial');
}

/* ---------- 実行 ---------- */
function loadChapter(id, startLabel){
  pendingSec = null;
  script = SCENARIO[id]; labels = {};
  script.forEach((n,i)=>{ if(n.n) labels[n.n] = i; });
  S.chapter = id;
  pc = startLabel!=null ? labels[startLabel] : 0;
}
function jump(l){ if(labels[l]==null){ console.warn('no label',l); return; } pc = labels[l]; }

function step(){
  if(running) return;
  if(pc >= script.length){ return; }
  const nd = script[pc++];
  exec(nd);
}
function advance(){ // ▼クリック
  if(skipType()){ $('#next').style.display='block'; return; }
  $('#next').style.display='none';
  step();
}
function exec(nd){
  // --- 表示系(ここで実行を中断する。同一ノードの他のキーは評価されない) ---
  if(nd.say!=null){
    const m = CHARS[nd.c] || CHARS.UNK;
    S.clock += (nd.min || 1); refreshHead(); checkShift();
    wv.col = m.col;
    const el = pushLine(`<span class="nm" style="color:${m.col}">${nd.nm||m.name}</span>`, nd.w?'wsp':'');
    running = true;
    typeInto(el, nd.say, nd.slow?46:22, ()=>{ running=false; $('#next').style.display='block'; });
    if(nd.se) AU.beep(...(SE[nd.se]||[600,.06,.02,'sine']));
    return;
  }
  if(nd.me!=null){
    S.clock += 1; refreshHead(); wv.col = CHARS.ME.col;
    const el = pushLine(`<span class="nm">あなた</span>`, 'me');
    running = true; typeInto(el, nd.me, 20, ()=>{ running=false; $('#next').style.display='block'; });
    return;
  }
  if(nd.nar!=null){
    wv.col = '#5f6b7c';
    const el = pushLine('', 'nar'); running = true;
    typeInto(el, nd.nar, 18, ()=>{ running=false; $('#next').style.display='block'; });
    return;
  }
  if(nd.sys!=null){
    pushLine(nd.sys, 'sys'); AU.beep(1200,.04,.02,'square'); $('#next').style.display='block'; return;
  }
  // --- 演出系(即時・自動で次へ) ---
  if(nd.call){ startCall(nd.call); }
  if(nd.hang!=null){ endCall(nd.hang, nd.hangKind); }
  if(nd.ring){ AU.ring(nd.ring); }
  if(nd.sec!=null) pendingSec = nd.sec;
  if(nd.noise!=null) setNoise(nd.noise);
  if(nd.fx) fx(nd.fx);
  if(nd.amb!=null) AU.ambient(nd.amb);
  if(nd.clock || nd.day || nd.min != null){ applyTime(nd); refreshHead(); checkShift(); }
  // --- データ系(core と共通) ---
  applyData(nd);
  // --- 演出系(中断するもの) ---
  if(nd.still){ saveAll(); unlockStill(nd.still, step); return; } // スチルを閉じると再開
  if(nd.chapTitle){ S.chapTitle = nd.chapTitle; }
  if(nd.card){ showChapCard(nd.card); return; }
  if(nd.wait){ setTimeout(step, nd.wait); return; }
  // --- 制御系 ---
  if(nd.hold){ holdLine(nd.hold); }
  if(nd.resume){ resumeLine(); }
  if(nd.multi){ showMulti(nd); return; }
  if(nd.ch){ showChoices(nd); return; }
  const target = resolveJump(nd); if(target) jump(target);
  if(nd.chap){ saveAll(); loadChapter(nd.chap); $('#text').innerHTML=''; step(); return; }
  if(nd.end){ return endGame(nd.end); }
  if(nd.clear){ $('#text').innerHTML=''; }
  step();
}
/* 効果音キーの対応表(se: 用)。現状シナリオ未使用だが、参照先が無いと
   se: を書いても常に既定音になってしまうため実体を用意しておく。 */
const SE = {};

/* 通話 */
function startCall(c){
  S.cur = c; S.callStart = S.clock;
  $('#cWho').textContent = c.who;
  $('#cWho').style.color = (CHARS[c.c]||CHARS.UNK).col;
  $('#cMeta').textContent = (c.num||'番号非通知') + ' ／ 通話中';
  AU.beep(700,.08,.03,'sine');
}
function endCall(reason, kind){
  if(S.cur){
    const len = Math.max(1, S.clock - S.callStart);
    S.hist.push({d:S.day, c:clockStr(S.callStart), w:S.cur.who, len:len+'分', r:reason||'通話終了'});
  }
  AU.hang(kind || 'normal');
  $('#cWho').textContent = 'みおはらライン';
  $('#cWho').style.color = '';
  $('#cMeta').textContent = '待機中 — 着信なし';
  S.cur = null;
}

/* 選択肢 */
function showChoices(nd){
  const box = $('#choices'); box.innerHTML = ''; $('#next').style.display='none';
  const list = visibleChoices(nd);
  list.forEach(o=>{
    const ok = cond(o.req);
    const b = document.createElement('button');
    b.className = 'cbtn' + (o.silent?' silent':'') + (ok?'':' lock') + (o.hide?' hid':'');
    const cost = o.cost || 2;
    b.innerHTML = (o.tag?`<span class="tag">${o.tag}</span>`:'') + o.t +
      (cost >= 5 ? ` <span class="tag" style="color:#c4443a">— ${cost}分</span>` : '') +
      (ok?'':' <span class="tag">— まだ言葉が見つからない</span>');
    b.onclick = ()=>{ if(!ok) return; AU.click(); pick(o, nd); };
    box.appendChild(b);
  });
  const sec = nd.sec != null ? nd.sec : pendingSec;
  pendingSec = null;
  if(sec) startTimer(realSec(sec), ()=>{ // 制限時間切れ = 沈黙してしまった
    pick(timeoutChoice(nd), nd, true);
  });
}

/* ---------- 同時着信（追補 §6-2） ----------
   取れるのは一本だけ。取らなかった回線はその場で留守電に落ち、
   §5 の保存期限ルールにそのまま接続する。 */
function showMulti(nd){
  const box = $('#choices'); box.innerHTML = ''; $('#next').style.display='none';
  pushLine('複数の回線が同時に鳴っています。取れるのは一本です。','sys');
  AU.ring('normal'); setTimeout(()=>AU.ring('normal'), 300);
  const drop = (taken)=> nd.multi.forEach(x=>{
    if(x === taken) return;
    if(x.vm) applyData({vm:x.vm});
    if(x.skip) applyPar(x.skip);
  });
  nd.multi.forEach((o,i)=>{
    const b = document.createElement('button');
    b.className = 'cbtn';
    b.innerHTML = `<span class="tag">回線 ${i+1}</span>${o.label}` +
      (o.note?`<span class="tag" style="display:block;margin:4px 0 0">${o.note}</span>`:'');
    b.onclick = ()=>{
      clearInterval(tmr); $('#timer').style.transform='scaleX(0)';
      AU.click(); box.innerHTML = '';
      drop(o);
      pushLine(`回線${i+1}に応答。他の回線は留守番電話に転送された。`,'sys');
      renderNav(); renderAside(); saveAll();
      if(o.go) jump(o.go);
      step();
    };
    box.appendChild(b);
  });
  const sec = nd.sec != null ? nd.sec : pendingSec;
  pendingSec = null;
  if(sec) startTimer(realSec(sec), ()=>{   // 迷っているうちに、どちらも切れる
    box.innerHTML = '';
    drop(null);
    pushLine('迷っているあいだに、どちらの呼び出し音も止まった。','sys');
    SET('MULTI_MISS', CNT('MULTI_MISS')+1);
    renderNav(); renderAside();
    if(nd.miss) jump(nd.miss);
    step();
  });
}
function startTimer(sec, cb){
  const bar = $('#timer'); let t = sec*1000; const t0 = Date.now();
  bar.style.transform = 'scaleX(1)';
  clearInterval(tmr);
  tmr = setInterval(()=>{
    const p = 1 - (Date.now()-t0)/t;
    bar.style.transform = 'scaleX('+Math.max(0,p)+')';
    if(p<=0){ clearInterval(tmr); bar.style.transform='scaleX(0)'; cb(); }
  }, 50);
}
function pick(o, nd, timedout){
  clearInterval(tmr); $('#timer').style.transform='scaleX(0)';
  $('#choices').innerHTML = '';
  if(o.say!==false && o.t) pushLine(`<span class="nm">あなた</span>${timedout?'（沈黙した）':(o.line||o.t)}`, 'me');
  applyChoice(o);
  refreshHead(); checkShift(); renderAside();
  if(o.go){ jump(o.go); }
  saveAll();
  step();
}

/* 章タイトルカード */
function showChapCard(c){
  const d = document.createElement('div'); d.className='chapcard';
  d.innerHTML = `<div class="no">${c[0]}</div><div class="ti">${c[1]}</div><div class="dt">${c[2]||''}</div>`;
  document.body.appendChild(d);
  AU.ambient(c[3]||0);
  setTimeout(()=>{ d.style.transition='opacity 1s'; d.style.opacity=0;
    setTimeout(()=>{ d.remove(); step(); }, 1000); }, 2400);
}

/* ---------- エンディング ---------- */
function endGame(tag){
  const id = tag === 'check' ? judge() : tag;
  AU.stopAmb();
  G.endings = G.endings||[]; if(!G.endings.includes(id)) G.endings.push(id);
  G.memo = S.memo.slice(); G.evd = S.evd.slice(); G.rel = S.rel.slice(); G.tl = S.tl.slice();
  G.loops = (G.loops||0) + 1;
  G.recs = G.recs||[]; G.stills = G.stills||[];
  saveAll();
  const e = ENDINGS[id];
  const ov = document.createElement('div'); ov.className='ov fade';
  ov.innerHTML = `<div class="endname">${e.name}</div>
    <div class="sub" style="margin:18px 0 26px">${id} END</div>
    <p>${e.text}</p>
    <div style="margin-top:34px">
      <button class="mbtn" id="eNext">次の周回へ<small>録音・メモ・証拠・年表・スチルを引き継ぐ</small></button>
      <button class="mbtn" id="eTitle">タイトルへ</button></div>`;
  document.body.appendChild(ov);
  $('#eNext').onclick = ()=> startGame(true);
  $('#eTitle').onclick = ()=> location.reload();
}

/* ---------- 起動 ---------- */
async function boot(){
  setGlobal(await loadKey('global') || {loops:0, endings:[], recs:[], stills:[]});
  const sv = await loadKey('save');
  const ov = $('#title');
  ov.innerHTML = `<h1><small>MIDNIGHT LINE</small>ミッドナイトライン</h1>
    <div class="sub">澪原市いのちの電話</div>
    <button class="mbtn" id="mNew">夜勤に入る<small>${G.loops?('周回 '+(G.loops+1)+'／引き継ぎあり'):'DAY 01 22:00 から'}</small></button>
    ${sv?'<button class="mbtn" id="mCont">続きから<small>DAY '+sv.day+' ／ '+sv.chapTitle.split(' ')[0]+'</small></button>':''}
    <button class="mbtn" id="mInfo">この電話について<small>操作と、この仕事の心得</small></button>
    <div class="sub" style="margin-top:30px;font-size:11px">到達エンディング ${(G.endings||[]).length} / 5　　発見した録音 ${(G.recs||[]).length}</div>`;
  $('#mNew').onclick = ()=> startGame(G.loops>0);
  $('#mInfo').onclick = ()=> showInfo();
  if(sv) $('#mCont').onclick = ()=>{ setState(sv); $('#title').remove(); resume(); };
  waveInit();
  document.addEventListener('keydown', e=>{ if(e.key===' '||e.key==='Enter'){ if($('#choices').children.length===0) advance(); } });
  $('#textwrap').onclick = ()=>{ if($('#choices').children.length===0) advance(); };
  $('#next').onclick = advance;
  $('#pClose').onclick = ()=> $('#panel').classList.remove('on');
  $('#bMenu').onclick = ()=> openPanel('sys');
  $('#bSound').onclick = ()=>{ AU.on = !AU.on; $('#bSound').textContent = AU.on?'♪ ON':'♪ OFF';
    if(!AU.on) AU.stopAmb(); else AU.ambient(0); };
  $$('#mobtabs button').forEach(b=>b.onclick=()=>{
    $$('#mobtabs button').forEach(x=>x.classList.remove('act')); b.classList.add('act');
    $('#nav').classList.toggle('on', b.dataset.m==='nav');
    $('#aside').classList.toggle('on', b.dataset.m==='aside');
  });
}
function showInfo(){
  const ov = document.createElement('div'); ov.className='ov fade';
  ov.innerHTML = `<h1 style="font-size:24px;letter-spacing:.2em">この電話について</h1>
  <p style="text-align:left">あなたは澪原市の夜間電話相談員です。現場へは行けません。声、息づかい、物音、沈黙、雑音、そして話の矛盾——受話器から届くものだけが手がかりです。<br><br>
  ・画面をタップ／スペースキーで進みます。<br>
  ・選択肢には〈傾聴〉〈確認〉〈指摘〉〈沈黙〉などの札があります。沈黙もまた答えです。<br>
  ・通話はすべて自動録音されます。<b style="color:#f0c674;font-weight:400">0.5倍速や逆再生で聴き直すと、その時は聞こえなかった声が入っていることがあります。</b><br>
  ・信頼・疑念・恐怖・ストレスは相手ごとに変動し、話してもらえる内容そのものが変わります。<br>
  ・一周目で救えるとは限りません。録音とメモは次の周回へ引き継がれます。<br><br>
  <span style="color:#8792a2">切ってしまった電話は、二度と同じようには鳴りません。</span></p>
  <button class="mbtn" style="margin-top:26px" onclick="this.parentNode.remove()">戻る</button>`;
  document.body.appendChild(ov);
}
function startGame(carry){
  setState(newState(carry ? G : null));
  if(carry){
    S.loop = (G.loops||0) + 1;
    (G.memo||[]).forEach(m=>S.memo.push(m));
    (G.evd||[]).forEach(e=>S.evd.push(e));
    (G.rel||[]).forEach(r=>S.rel.push(r));
    if(G.tl && G.tl.length > S.tl.length) S.tl = G.tl.slice();
    SET('LOOP_02', S.loop);
  }
  const t = $('#title'); if(t) t.remove();
  $$('.ov').forEach(o=>o.remove());   // エンディング画面から直接次の周回へ入る場合
  resume(true);
}
function resume(fresh){
  renderNav(); renderAside(); refreshHead();
  $('#text').innerHTML = '';
  loadChapter(fresh ? 'pro' : S.chapter);
  AU.ambient(0);
  step();
}
window.addEventListener('load', boot);
