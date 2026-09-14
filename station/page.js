// 器具清洗放行台页面：纯原生 JS，无构建步骤；桌面与手机自适应。
export function renderPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>器具清洗放行台 · 墨锭试磨室</title>
<style>
:root{
  --bg:#eef1ea; --panel:#fff; --ink:#21261f; --muted:#6a7264; --line:#d3dccf;
  --accent:#4f6c41; --accent-d:#3c5231; --warn:#a44734; --amber:#9a6b12; --info:#355d7a;
  --chip:#f3f5ef;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",Arial,sans-serif}
a{color:var(--accent-d)}
header{position:sticky;top:0;z-index:20;background:#fff;border-bottom:1px solid var(--line);padding:12px 18px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header h1{font-size:19px;margin:0;white-space:nowrap}
header .sub{color:var(--muted);font-size:12px}
.spacer{flex:1}
select,input,textarea,button{font:inherit}
select,input,textarea{border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:#fff;color:var(--ink)}
button{border:0;border-radius:8px;background:var(--accent);color:#fff;padding:9px 14px;font-weight:700;cursor:pointer}
button:hover{background:var(--accent-d)}
button.ghost{background:#e7ebe2;color:var(--ink)}
button.danger{background:var(--warn)}
button.small{padding:6px 10px;font-size:13px}
button:disabled{opacity:.45;cursor:not-allowed}
.identity{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.identity select,.identity input{padding:7px 9px}
.wrap{padding:16px 18px;max-width:1280px;margin:0 auto}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.tabs button{background:#e2e7dd;color:var(--ink)}
.tabs button.active{background:var(--accent);color:#fff}
.stats{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:14px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px}
.stat .n{font-size:26px;font-weight:800;line-height:1.1}
.stat .l{color:var(--muted);font-size:13px}
.stat[data-s="可用"]{border-top:3px solid var(--accent)}
.stat[data-s="过期"]{border-top:3px solid var(--warn)}
.stat[data-s="停用"]{border-top:3px solid #888}
.stat[data-s="待检验"]{border-top:3px solid var(--info)}
.alerts{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}
.alert{border-radius:12px;border:1px solid var(--line);padding:12px;background:#fff}
.alert h3{margin:0 0 8px;font-size:14px;display:flex;gap:8px;align-items:center}
.alert.near{border-left:4px solid var(--amber)}
.alert.bad{border-left:4px solid var(--warn)}
.tag{font-size:11px;border-radius:999px;padding:2px 8px;background:var(--chip);border:1px solid var(--line)}
.tag.warn{background:#f7e7e2;color:var(--warn);border-color:#e6c0b6}
.tag.amber{background:#f6ecd6;color:var(--amber);border-color:#e6d3a8}
.tag.info{background:#e2edf5;color:var(--info);border-color:#bfd6e6}
.tag.ok{background:#e5efe0;color:var(--accent-d);border-color:#c4d8bb}
.tag.gray{background:#eee;color:#555;border-color:#ddd}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:9px}
.card h4{margin:0;font-size:16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.kv{color:var(--muted);font-size:13px}.kv b{color:var(--ink)}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}
.panel{background:#fff;border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:14px}
.panel h2{margin:0 0 12px;font-size:17px}
.formgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
label.f{display:flex;flex-direction:column;gap:5px;font-size:13px;color:var(--muted)}
.checklist{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;border:1px dashed var(--line);border-radius:10px;padding:10px;max-height:200px;overflow:auto;background:#fafcf8}
.checklist label{display:flex;gap:8px;align-items:center;font-size:14px;color:var(--ink)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 9px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;position:sticky;top:0;background:#fff}
.tbl-wrap{overflow:auto;max-height:60vh;border:1px solid var(--line);border-radius:10px}
.pill{font-size:12px;border-radius:999px;padding:2px 9px;border:1px solid var(--line);background:var(--chip);white-space:nowrap}
.muted{color:var(--muted)}
.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:50;background:#22281f;color:#fff;padding:11px 18px;border-radius:10px;opacity:0;transition:.25s;max-width:92vw;box-shadow:0 8px 30px rgba(0,0,0,.25)}
.toast.show{opacity:1}
.toast.err{background:#7c2d1f}
.toast.ok{background:#2f5d27}
.limits{font-size:12px;color:var(--muted);margin-top:6px}
.hidden{display:none !important}
.empty{color:var(--muted);padding:14px;text-align:center}
@media (max-width:820px){
  .stats{grid-template-columns:repeat(3,1fr)}
  .alerts{grid-template-columns:1fr}
  header{padding:10px 12px}
  .wrap{padding:12px}
  .stat .n{font-size:22px}
  .grid{grid-template-columns:1fr}
  th:nth-child(n+5),td:nth-child(n+5){display:none}
}
</style>
</head>
<body>
<header>
  <div>
    <h1>器具清洗放行台</h1>
    <div class="sub">墨锭试磨室 · 清洗—检验—领用闭环</div>
  </div>
  <div class="spacer"></div>
  <div class="identity">
    <label class="muted" style="font-size:12px">角色</label>
    <select id="role">
      <option value="cleaner">清洗员</option>
      <option value="inspector">检验员</option>
      <option value="tester" selected>试验员</option>
      <option value="admin">管理员</option>
    </select>
    <input id="actor" placeholder="姓名/工号" value="试验员-01" style="width:120px">
    <button class="ghost small" id="refresh">刷新</button>
  </div>
</header>

<div class="wrap">
  <div class="tabs">
    <button data-tab="board" class="active">总览</button>
    <button data-tab="clean">清洗登记（清洗员）</button>
    <button data-tab="inspect">检验放行（检验员）</button>
    <button data-tab="utensils">器具台账</button>
    <button data-tab="audit">审计与领用</button>
  </div>

  <!-- 总览 -->
  <section id="tab-board">
    <div class="stats" id="stats"></div>
    <div class="alerts">
      <div class="alert near">
        <h3>⏳ 临期器具 <span class="tag amber" id="nearCount">0</span></h3>
        <div id="nearList" class="muted">加载中…</div>
      </div>
      <div class="alert bad">
        <h3>⚠️ 异常器具 <span class="tag warn" id="badCount">0</span></h3>
        <div id="badList" class="muted">加载中…</div>
      </div>
    </div>
    <div class="panel">
      <h2>清洗批次</h2>
      <div class="tbl-wrap"><table id="batchTable">
        <thead><tr><th>批次号</th><th>状态</th><th>清洗剂/位置</th><th>水温/时长</th><th>件数</th><th>参数</th><th>创建/放行</th></tr></thead>
        <tbody></tbody>
      </table></div>
    </div>
  </section>

  <!-- 清洗登记 -->
  <section id="tab-clean" class="hidden">
    <div class="panel">
      <h2>登记清洗批次</h2>
      <form id="batchForm">
        <div class="formgrid">
          <label class="f">清洗剂<input name="detergent" required placeholder="如：食用碱 / 专用清洗剂"></label>
          <label class="f">清洗位置<input name="location" required placeholder="如：清洗间1号槽"></label>
          <label class="f">水温 ℃<input name="temperature" type="number" step="0.5" required></label>
          <label class="f">时长（分钟）<input name="durationMin" type="number" step="1" required></label>
        </div>
        <div class="limits">放行接受区间：水温 40~60℃、时长 10~30 分钟。越界可登记送检，但检验时无法放行，须重洗。</div>
        <h3 style="margin:14px 0 8px;font-size:14px">选择器具（仅「待清洗/过期」可加入；已在批次中的自动排除）</h3>
        <div class="checklist" id="cleanPicker"></div>
        <div class="actions" style="margin-top:12px">
          <button type="submit">写入清洗批次</button>
          <span class="muted">批次写入为原子操作：任一器具已在其它批次，整批回滚、不留半条数据。</span>
        </div>
      </form>
    </div>
    <div class="panel">
      <h2>进行中 / 待检验批次（清洗员可送检）</h2>
      <div id="cleanBatches" class="grid"></div>
    </div>
  </section>

  <!-- 检验放行 -->
  <section id="tab-inspect" class="hidden">
    <div class="panel">
      <h2>待检验批次</h2>
      <div id="inspectBatches" class="grid"></div>
    </div>
  </section>

  <!-- 台账 -->
  <section id="tab-utensils" class="hidden">
    <div class="panel admin-only">
      <h2>新建设具（唯一编号）</h2>
      <form id="createForm" class="formgrid" style="align-items:end">
        <label class="f">器具编号<input name="code" required placeholder="如 YJ-007"></label>
        <label class="f">名称<input name="name" required placeholder="如 研钵"></label>
        <label class="f">备注<input name="note" placeholder="可选"></label>
        <button>建档</button>
      </form>
    </div>
    <div class="panel">
      <h2>器具台账
        <span class="row" style="display:inline-flex;margin-left:8px">
          <select id="filterStatus" style="padding:5px 8px;font-size:13px">
            <option value="">全部状态</option>
          </select>
          <input id="filterQ" placeholder="搜编号/名称" style="padding:5px 8px;font-size:13px">
        </span>
      </h2>
      <div class="grid" id="utensilGrid"></div>
    </div>
  </section>

  <!-- 审计 -->
  <section id="tab-audit" class="hidden">
    <div class="panel">
      <h2>审计日志（含越权拒绝、放行、领用、到期、回滚）</h2>
      <div class="tbl-wrap"><table>
        <thead><tr><th>时间</th><th>操作人</th><th>角色</th><th>动作</th><th>对象</th><th>结果</th><th>详情</th></tr></thead>
        <tbody id="auditBody"></tbody>
      </table></div>
    </div>
    <div class="panel">
      <h2>领用记录</h2>
      <div class="tbl-wrap"><table>
        <thead><tr><th>时间</th><th>试验员</th><th>器具</th><th>来源批次</th></tr></thead>
        <tbody id="reqBody"></tbody>
      </table></div>
    </div>
  </section>
</div>

<div class="toast" id="toast"></div>

<script>
const ROLE_LABEL={admin:"管理员",cleaner:"清洗员",inspector:"检验员",tester:"试验员",system:"系统"};
let meta={limits:{temperatureMin:40,temperatureMax:60,durationMin:10,durationMax:30,nearExpiryHours:24}};
let summary=null, utensils=[], batches=[];
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
const fmt=t=>t?new Date(t).toLocaleString("zh-CN",{hour12:false}):"—";
const role=()=>$('#role').value, actor=()=>$('#actor').value.trim()||"匿名";

function toast(msg,kind=""){const t=$('#toast');t.textContent=msg;t.className="toast show "+kind;clearTimeout(t._h);t._h=setTimeout(()=>{t.className="toast"},3200);}
async function api(path,opts={}){
  // HTTP 头只能是 Latin-1，中文姓名需百分号编码（服务端 decodeURIComponent 还原）
  const headers=Object.assign({"Content-Type":"application/json","X-Role":role(),"X-Actor":encodeURIComponent(actor())},opts.headers||{});
  if(opts.method==="POST")headers["Idempotency-Key"]=crypto.randomUUID?crypto.randomUUID():(Date.now()+"-"+Math.random());
  const res=await fetch(path,{...opts,headers});
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw Object.assign(new Error(data.message||data.error||"请求失败"),{data});
  return data;
}
function statusPill(s){
  const cls={"可用":"ok","过期":"warn","停用":"gray","待检验":"info","待清洗":"","清洗中":"amber"}[s]||"";
  return '<span class="pill tag '+cls+'">'+s+'</span>';
}

async function loadAll(){
  meta=await api('/station/api/meta');
  summary=await api('/station/api/summary');
  utensils=await api('/station/api/utensils');
  batches=summary.batches;
  render();
}
function render(){renderStats();renderAlerts();renderBatches();renderClean();renderInspect();renderUtensils();renderAudit();applyRole();}

function renderStats(){
  const c=summary.counts;
  $('#stats').innerHTML=Object.keys(c).map(s=>'<div class="stat" data-s="'+s+'"><div class="n">'+c[s]+'</div><div class="l">'+s+'</div></div>').join('');
}
function hoursLeft(u){return u.expiresAt?Math.round((u.expiresAt-summary.now)/3600000):null;}
function renderAlerts(){
  const near=summary.nearExpiry||[];
  $('#nearCount').textContent=near.length;
  $('#nearList').innerHTML=near.length?near.map(u=>'<div class="kv">'+esc(u.code)+' '+esc(u.name)+' · 剩 <b>'+u.hoursLeft+'h</b> · 到期 '+fmt(u.expiresAt)+'</div>').join(''):'<span class="muted">无临期器具</span>';
  const bad=summary.abnormal||[];
  $('#badCount').textContent=bad.length;
  $('#badList').innerHTML=bad.length?bad.map(u=>'<div class="kv">'+esc(u.code)+' '+esc(u.name)+' '+statusPill(u.status)+' <span class="tag warn">'+esc(u.reason)+'</span></div>').join(''):'<span class="muted">无异常</span>';
}
function paramTag(b){
  if(b.status==="已放行")return '<span class="tag ok">已按界内放行</span>';
  if(b.status==="已驳回")return '<span class="tag gray">已驳回</span>';
  return b.withinLimits?'<span class="tag ok">参数界内</span>':'<span class="tag warn">越界·不得放行</span>';
}
function renderBatches(){
  $('#batchTable tbody').innerHTML=batches.length?batches.map(b=>'<tr>'+
    '<td><b>'+esc(b.batch_no)+'</b></td><td>'+statusPill(b.status)+'</td>'+
    '<td>'+esc(b.detergent)+'<br><span class="muted">'+esc(b.location)+'</span></td>'+
    '<td>'+b.temperature+'℃ / '+b.duration_min+'min</td><td>'+b.itemCount+'</td><td>'+paramTag(b)+'</td>'+
    '<td><span class="muted">'+fmt(b.created_at)+'</span><br><span class="muted">'+(b.released_at?fmt(b.released_at):"")+'</span></td>'+
    '</tr>').join(''):'<tr><td colspan="7" class="empty">暂无批次</td></tr>';
}

function renderClean(){
  const pick=$('#cleanPicker');
  const eligible=utensils.filter(u=>(u.status==="待清洗"||u.status==="过期")&&!u.active_batch_id);
  pick.innerHTML=eligible.length?eligible.map(u=>'<label><input type="checkbox" name="u" value="'+u.id+'">'+esc(u.code)+' '+esc(u.name)+' '+statusPill(u.status)+'</label>').join(''):'<span class="empty">暂无可加入的器具</span>';
  const mine=batches.filter(b=>b.status==="清洗中"||b.status==="待检验");
  $('#cleanBatches').innerHTML=mine.length?mine.map(batchCard).join(''):'<div class="empty">暂无进行中批次</div>';
}
function batchCard(b){
  const inRange=b.withinLimits;
  const submitBtn=b.status==="清洗中"?'<button class="small" data-submit="'+b.id+'">清洗完成 → 送检</button>':'';
  return '<div class="card"><h4>'+esc(b.batch_no)+' '+statusPill(b.status)+'</h4>'+
    '<div class="kv">清洗剂 <b>'+esc(b.detergent)+'</b> · 位置 <b>'+esc(b.location)+'</b></div>'+
    '<div class="kv">水温 <b>'+b.temperature+'℃</b>，时长 <b>'+b.duration_min+'min</b>，器具 <b>'+b.itemCount+'</b> 件 '+paramTag(b)+'</div>'+
    (b.status==="待检验"&&!inRange?'<div class="tag warn">参数越界：'+esc((b.paramProblems||[]).join('；'))+'</div>':'')+
    '<div class="actions">'+submitBtn+'</div></div>';
}

function renderInspect(){
  const pend=batches.filter(b=>b.status==="待检验");
  $('#inspectBatches').innerHTML=pend.length?pend.map(b=>{
    const disabled=b.withinLimits?'':'disabled title="参数越界，不能放行"';
    return '<div class="card"><h4>'+esc(b.batch_no)+'</h4>'+
      '<div class="kv">'+esc(b.detergent)+' · '+esc(b.location)+' · '+b.itemCount+' 件</div>'+
      '<div class="kv">水温 <b>'+b.temperature+'℃</b>，时长 <b>'+b.duration_min+'min</b></div>'+
      (b.withinLimits?'<span class="tag ok">参数在放行区间内</span>':'<span class="tag warn">越界，禁止放行：'+esc((b.paramProblems||[]).join('；'))+'</span>')+
      '<label class="f" style="margin-top:6px">放行有效期（小时）<input type="number" id="vh-'+b.id+'" value="72" min="1" max="8760"></label>'+
      '<div class="actions"><button class="small" data-release="'+b.id+'" '+disabled+'>放行并设定有效期</button>'+
      '<button class="small danger" data-reject="'+b.id+'">驳回重洗</button></div></div>';
  }).join(''):'<div class="empty">暂无待检验批次</div>';
}

function renderUtensils(){
  const sel=$('#filterStatus');
  if(sel.options.length<=1)sel.innerHTML='<option value="">全部状态</option>'+(summary?Object.keys(summary.counts):[]).map(s=>'<option>'+s+'</option>').join('');
  const f=sel.value, q=$('#filterQ').value.trim();
  const list=utensils.filter(u=>(!f||u.status===f)&&(!q||(u.code+u.name).includes(q)));
  $('#utensilGrid').innerHTML=list.length?list.map(utensilCard).join(''):'<div class="empty">无匹配器具</div>';
}
function utensilCard(u){
  const near=u.nearExpiry?'<span class="tag amber">临期 '+Math.round((u.expires_at-summary.now)/3600000)+'h</span>':'';
  const exp=u.status==="可用"&&u.expires_at?'<div class="kv">有效期至 <b>'+fmt(u.expires_at)+'</b></div>':'';
  const batch=u.active_batch_no?'<div class="kv">批次 <b>'+esc(u.active_batch_no)+'</b></div>':'';
  let acts="";
  if(u.status==="可用")acts='<button class="small" data-req="'+u.id+'">试验员领用</button>';
  if(u.status==="停用")acts='<button class="small ghost admin-only" data-react="'+u.id+'">重新启用</button>';
  else if(!u.active_batch_id&&u.status!=="清洗中"&&u.status!=="待检验")acts+='<button class="small danger admin-only" data-retire="'+u.id+'">停用</button>';
  return '<div class="card"><h4>'+esc(u.code)+' '+statusPill(u.status)+near+'</h4>'+
    '<div class="kv">'+esc(u.name)+(u.note?' · '+esc(u.note):'')+'</div>'+batch+exp+
    '<div class="actions">'+acts+'</div></div>';
}

async function renderAudit(){
  const [logs,reqs]=await Promise.all([api('/station/api/audit'),api('/station/api/requisitions')]);
  $('#auditBody').innerHTML=logs.length?logs.map(l=>'<tr><td class="muted">'+fmt(l.at)+'</td><td>'+esc(l.actor)+'</td><td>'+(ROLE_LABEL[l.role]||esc(l.role))+'</td><td>'+esc(l.action)+'</td><td>'+esc(l.target)+'</td><td>'+(l.ok?'<span class="tag ok">成功</span>':'<span class="tag warn">拒绝/失败</span>')+'</td><td class="muted">'+esc(l.detail)+'</td></tr>').join(''):'<tr><td colspan="7" class="empty">暂无日志</td></tr>';
  $('#reqBody').innerHTML=reqs.length?reqs.map(r=>'<tr><td class="muted">'+fmt(r.at)+'</td><td>'+esc(r.tester)+'</td><td>'+esc(r.utensil_code)+'</td><td>#'+(r.batch_id??"—")+'</td></tr>').join(''):'<tr><td colspan="4" class="empty">暂无领用记录</td></tr>';
}

function applyRole(){
  const r=role();
  $$('.admin-only').forEach(el=>el.classList.toggle('hidden',r!=="admin"));
  $('#actor').value=$('#actor').value||({cleaner:"清洗员-01",inspector:"检验员-01",tester:"试验员-01",admin:"管理员-01"}[r]);
}

// 事件
$$('.tabs button').forEach(b=>b.onclick=()=>{
  $$('.tabs button').forEach(x=>x.classList.toggle('active',x===b));
  ['board','clean','inspect','utensils','audit'].forEach(t=>$('#tab-'+t).classList.toggle('hidden',t!==b.dataset.tab));
});
$('#role').onchange=()=>{applyRole();};
$('#refresh').onclick=()=>loadAll().then(()=>toast("已刷新","ok")).catch(e=>toast(e.message,"err"));
$('#filterStatus').onchange=renderUtensils; $('#filterQ').oninput=renderUtensils;

$('#batchForm').onsubmit=async e=>{
  e.preventDefault();
  const fd=new FormData(e.target);
  const utensilIds=$$('#cleanPicker input:checked').map(i=>Number(i.value));
  if(!utensilIds.length)return toast("请至少选择一件器具","err");
  const payload={detergent:fd.get('detergent'),location:fd.get('location'),temperature:Number(fd.get('temperature')),durationMin:Number(fd.get('durationMin')),utensilIds};
  try{
    const b=await api('/station/api/batches',{method:'POST',body:JSON.stringify(payload)});
    toast("已写入批次 "+b.batch_no+"（"+b.items.length+" 件）","ok");e.target.reset();await loadAll();
  }catch(err){toast("批次写入失败已回滚："+err.message,"err");await loadAll();}
};

document.addEventListener('click',async e=>{
  const t=e.target;
  const id=t.dataset.submit||t.dataset.release||t.dataset.reject;
  const code=t.dataset.req||t.dataset.retire||t.dataset.react;
  try{
    if(t.dataset.submit){await api('/station/api/batches/'+t.dataset.submit+'/submit',{method:'POST',body:'{}'});toast("已送检","ok");}
    else if(t.dataset.release){
      const vh=$('#vh-'+t.dataset.release).value;
      await api('/station/api/batches/'+t.dataset.release+'/release',{method:'POST',body:JSON.stringify({validHours:Number(vh)})});
      toast("已放行，有效期已写入","ok");
    }
    else if(t.dataset.reject){
      const reason=prompt("驳回原因（将退回待清洗重洗）","参数越界");
      if(reason===null)return;
      await api('/station/api/batches/'+t.dataset.reject+'/reject',{method:'POST',body:JSON.stringify({reason})});
      toast("已驳回，器具退回待清洗","ok");
    }
    else if(t.dataset.req){await api('/station/api/utensils/'+t.dataset.req+'/requisition',{method:'POST',body:'{}'});toast("领用成功","ok");}
    else if(t.dataset.retire){if(!confirm("确认停用该器具？"))return;await api('/station/api/utensils/'+t.dataset.retire+'/retire',{method:'POST',body:'{}'});toast("已停用","ok");}
    else if(t.dataset.react){await api('/station/api/utensils/'+t.dataset.react+'/reactivate',{method:'POST',body:'{}'});toast("已重新启用","ok");}
    else return;
    await loadAll();
  }catch(err){toast(err.message,"err");await loadAll();}
});

$('#createForm').onsubmit=async e=>{
  e.preventDefault();const fd=new FormData(e.target);
  try{await api('/station/api/utensils',{method:'POST',body:JSON.stringify({code:fd.get('code'),name:fd.get('name'),note:fd.get('note')})});toast("建档成功","ok");e.target.reset();await loadAll();}
  catch(err){toast(err.message,"err");}
};
loadAll().catch(e=>toast("初始加载失败："+e.message,"err"));
</script>
</body>
</html>`;
}
