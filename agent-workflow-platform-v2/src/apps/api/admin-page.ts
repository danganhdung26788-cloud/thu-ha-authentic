export const ADMIN_PAGE = String.raw`<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Workflow AI V2 — Điều hành</title>
  <style>
    :root{font-family:Inter,Segoe UI,Arial,sans-serif;color:#172033;background:#f3f6fb;line-height:1.45}
    *{box-sizing:border-box}body{margin:0}.top{position:sticky;top:0;z-index:10;background:#101828;color:#fff;padding:14px 24px;display:flex;gap:18px;align-items:center;justify-content:space-between;box-shadow:0 3px 12px #0003}.top h1{font-size:18px;margin:0}.top small{color:#b8c2d8}.wrap{max-width:1500px;margin:0 auto;padding:22px}.panel{background:#fff;border:1px solid #dfe5ef;border-radius:14px;padding:18px;box-shadow:0 5px 18px #1f29370d;margin-bottom:18px}.grid{display:grid;gap:14px}.cols{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}.stats{grid-template-columns:repeat(auto-fit,minmax(145px,1fr))}.stat{background:#f8fafc;border:1px solid #e5eaf2;border-radius:12px;padding:14px}.stat b{font-size:24px;display:block}.label{font-size:12px;color:#667085;text-transform:uppercase;letter-spacing:.04em}input,select,textarea,button{font:inherit}input,select,textarea{width:100%;border:1px solid #cbd5e1;border-radius:9px;padding:9px 11px;background:#fff}textarea{min-height:82px;resize:vertical}button{border:0;border-radius:9px;padding:9px 13px;cursor:pointer;font-weight:650;background:#2563eb;color:#fff}button.secondary{background:#475467}button.danger{background:#b42318}button.success{background:#067647}button.ghost{background:#eef2f7;color:#344054}.row{display:flex;gap:10px;align-items:end;flex-wrap:wrap}.row>div{flex:1;min-width:180px}.actions{display:flex;gap:8px;flex-wrap:wrap}.table-wrap{overflow:auto;border:1px solid #e5eaf2;border-radius:12px}table{border-collapse:collapse;width:100%;min-width:850px}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #edf0f5;vertical-align:top}th{background:#f8fafc;font-size:12px;text-transform:uppercase;color:#667085;position:sticky;top:0}tr:hover td{background:#fafcff}.badge{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:700;background:#eef2f7;color:#344054}.badge.COMPLETED,.badge.SUCCEEDED{background:#dcfae6;color:#067647}.badge.FAILED,.badge.REJECTED{background:#fee4e2;color:#b42318}.badge.RUNNING{background:#dbeafe;color:#1d4ed8}.badge.WAITING_APPROVAL,.badge.PENDING{background:#fef0c7;color:#b54708}.badge.RETRY_WAIT{background:#f3e8ff;color:#7e22ce}.muted{color:#667085;font-size:13px}.error{color:#b42318;white-space:pre-wrap}.ok{color:#067647}.hidden{display:none!important}pre{white-space:pre-wrap;word-break:break-word;background:#101828;color:#d0d5dd;padding:14px;border-radius:10px;max-height:520px;overflow:auto}.section-title{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.section-title h2{font-size:17px;margin:0}.notice{padding:10px 12px;border-radius:9px;background:#eff8ff;color:#175cd3;margin-bottom:12px}.warning{background:#fffaeb;color:#b54708}.modal{position:fixed;inset:0;background:#10182899;display:flex;align-items:center;justify-content:center;padding:20px;z-index:30}.modal-card{background:#fff;border-radius:16px;padding:20px;width:min(760px,100%);max-height:90vh;overflow:auto}.right{text-align:right}@media(max-width:720px){.top{align-items:flex-start;flex-direction:column}.wrap{padding:12px}.panel{padding:14px}}
  </style>
</head>
<body>
  <header class="top">
    <div><h1>Workflow AI V2 — Trung tâm điều hành</h1><small>V1 vẫn là hệ thống đối chiếu cho đến khi cutover hoàn tất</small></div>
    <div class="actions"><button class="ghost" id="refresh">Làm mới</button><button id="newTask">Giao nhiệm vụ</button></div>
  </header>
  <main class="wrap">
    <section class="panel">
      <div class="section-title"><h2>Kết nối an toàn</h2><span id="connection" class="badge">CHƯA KẾT NỐI</span></div>
      <div class="row">
        <div><label class="label">API token cục bộ</label><input type="password" id="token" autocomplete="off" placeholder="Dán API_AUTH_TOKEN"></div>
        <div><label class="label">Owner</label><input id="owner" value="danganhdung"></div>
        <div><label class="label">Workspace</label><input id="workspace" value="workflow-v2-sandbox"></div>
        <div style="flex:0 0 auto"><button id="connect">Kết nối</button></div>
      </div>
      <div class="muted" style="margin-top:8px">Token chỉ được lưu trong sessionStorage của tab hiện tại.</div>
    </section>

    <section class="grid stats" id="stats"></section>

    <section class="panel">
      <div class="section-title"><h2>Runtime và cutover</h2><span id="phase" class="badge">V1_ONLY</span></div>
      <div class="grid cols">
        <div><div class="label">Lý do trạng thái</div><div id="phaseReason">—</div></div>
        <div><div class="label">Cập nhật bởi</div><div id="phaseBy">—</div></div>
        <div><div class="label">Adapter</div><div id="adapters">—</div></div>
        <div><div class="label">Gemini</div><div class="badge">DISABLED / 0 COST</div></div>
      </div>
    </section>

    <section class="panel">
      <div class="section-title"><h2>Phê duyệt đang chờ</h2><span id="approvalCount" class="badge">0</span></div>
      <div id="approvals" class="muted">Chưa tải dữ liệu.</div>
    </section>

    <section class="panel">
      <div class="section-title">
        <h2>Nhiệm vụ gần đây</h2>
        <div class="actions"><select id="statusFilter"><option value="">Tất cả trạng thái</option><option>QUEUED</option><option>RUNNING</option><option>WAITING_APPROVAL</option><option>RETRY_WAIT</option><option>COMPLETED</option><option>FAILED</option></select></div>
      </div>
      <div id="tasks" class="muted">Chưa tải dữ liệu.</div>
    </section>

    <section class="panel hidden" id="detailsPanel">
      <div class="section-title"><h2>Chi tiết nhiệm vụ</h2><button class="ghost" id="closeDetails">Đóng</button></div>
      <pre id="details"></pre>
    </section>
  </main>

  <div class="modal hidden" id="taskModal">
    <div class="modal-card">
      <div class="section-title"><h2>Giao nhiệm vụ mới</h2><button class="ghost" id="cancelTask">Đóng</button></div>
      <div class="grid cols">
        <div><label class="label">Owner</label><input id="taskOwner" value="danganhdung"></div>
        <div><label class="label">Workspace</label><input id="taskWorkspace" value="workflow-v2-sandbox"></div>
        <div><label class="label">Autonomy</label><select id="taskAutonomy"><option>SANDBOX_HIGH</option><option>UAT_HIGH</option><option>READ_ONLY</option><option>PRODUCTION_GUARDED</option></select></div>
        <div><label class="label">Risk</label><select id="taskRisk"><option>LOW</option><option>MEDIUM</option><option>HIGH</option><option>CRITICAL</option></select></div>
      </div>
      <div style="margin-top:12px"><label class="label">Mục tiêu</label><textarea id="taskObjective" placeholder="Mô tả kết quả cần đạt, không cần chỉ từng lệnh"></textarea></div>
      <div class="grid cols" style="margin-top:12px">
        <div><label class="label">Read scope, mỗi dòng một đường dẫn</label><textarea id="taskRead">.</textarea></div>
        <div><label class="label">Write scope, mỗi dòng một đường dẫn</label><textarea id="taskWrite">.</textarea></div>
      </div>
      <div class="right" style="margin-top:14px"><button id="submitTask">Giao cho AI</button></div>
      <div id="taskMessage" class="muted" style="margin-top:10px"></div>
    </div>
  </div>

<script>
(function(){
  'use strict';
  var q=function(id){return document.getElementById(id)};
  var state={token:sessionStorage.getItem('agentV2Token')||'',owner:'danganhdung',workspace:'workflow-v2-sandbox'};
  q('token').value=state.token;

  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function badge(value){return '<span class="badge '+esc(value)+'">'+esc(value)+'</span>'}
  function fmt(value){if(!value)return '—';try{return new Date(value).toLocaleString('vi-VN')}catch(e){return esc(value)}}
  function headers(){return {'authorization':'Bearer '+state.token,'content-type':'application/json'}}
  async function api(path,options){
    var response=await fetch(path,Object.assign({headers:headers()},options||{}));
    var text=await response.text();var data=text?JSON.parse(text):{};
    if(!response.ok)throw new Error(data.message||data.summary||data.error||('HTTP '+response.status));
    return data;
  }
  function filterQuery(extra){
    var p=new URLSearchParams();
    state.owner=q('owner').value.trim();state.workspace=q('workspace').value.trim();
    if(state.owner)p.set('ownerId',state.owner);if(state.workspace)p.set('workspaceId',state.workspace);
    Object.keys(extra||{}).forEach(function(k){if(extra[k])p.set(k,extra[k])});
    return p.toString();
  }
  function setConnection(ok,message){q('connection').textContent=ok?'ĐÃ KẾT NỐI':'LỖI';q('connection').className='badge '+(ok?'COMPLETED':'FAILED');q('connection').title=message||''}
  async function refresh(){
    if(!state.token){setConnection(false,'Thiếu token');return}
    try{
      var query=filterQuery({});
      var results=await Promise.all([
        api('/v1/admin/overview?'+query),
        api('/v1/admin/tasks?'+filterQuery({status:q('statusFilter').value,limit:'100'})),
        api('/v1/admin/approvals?'+filterQuery({status:'PENDING',limit:'100'})),
        api('/v1/admin/adapters')
      ]);
      renderOverview(results[0]);renderTasks(results[1].items||[]);renderApprovals(results[2].items||[]);renderAdapters(results[3]);setConnection(true,'PASS');
    }catch(e){setConnection(false,e.message);q('tasks').innerHTML='<div class="error">'+esc(e.message)+'</div>'}
  }
  function renderOverview(data){
    var counts=data.counts||{};var keys=['QUEUED','RUNNING','WAITING_APPROVAL','RETRY_WAIT','COMPLETED','FAILED'];
    q('stats').innerHTML=keys.map(function(k){return '<div class="stat"><span class="label">'+esc(k)+'</span><b>'+Number(counts[k]||0)+'</b></div>'}).join('');
    q('phase').textContent=(data.cutover&&data.cutover.phase)||'UNKNOWN';q('phase').className='badge '+q('phase').textContent;
    q('phaseReason').textContent=(data.cutover&&data.cutover.reason)||'—';q('phaseBy').textContent=(data.cutover&&data.cutover.changed_by)||'—';
    q('approvalCount').textContent=String(data.pendingApprovals||0);
  }
  function renderAdapters(data){
    var configured=data.configured||[];
    q('adapters').innerHTML=configured.length?configured.map(function(a){return '<div>'+badge(a.executor)+' '+(a.healthy?'<span class="ok">PASS</span>':'<span class="error">FAIL</span>')+'</div>'}).join(''):'Chưa cấu hình adapter live';
  }
  function renderTasks(items){
    if(!items.length){q('tasks').innerHTML='<div class="notice">Không có nhiệm vụ phù hợp.</div>';return}
    q('tasks').innerHTML='<div class="table-wrap"><table><thead><tr><th>Trạng thái</th><th>Mục tiêu</th><th>Owner/Workspace</th><th>Lần chạy</th><th>Cập nhật</th><th>Lỗi</th><th></th></tr></thead><tbody>'+items.map(function(t){return '<tr><td>'+badge(t.status)+'</td><td><strong>'+esc(t.objective)+'</strong><div class="muted">'+esc(t.taskId)+'</div></td><td>'+esc(t.ownerId)+'<br><span class="muted">'+esc(t.workspaceId)+'</span></td><td>'+esc(t.attempt)+' / '+esc(t.maxAttempts)+'</td><td>'+fmt(t.updatedAt)+'</td><td class="error">'+esc(t.lastError||'')+'</td><td><button class="ghost detailsBtn" data-id="'+esc(t.taskId)+'">Xem</button></td></tr>'}).join('')+'</tbody></table></div>';
    Array.from(document.querySelectorAll('.detailsBtn')).forEach(function(b){b.addEventListener('click',function(){showDetails(b.getAttribute('data-id'))})});
  }
  function renderApprovals(items){
    if(!items.length){q('approvals').innerHTML='<div class="notice">Không có phê duyệt đang chờ.</div>';return}
    q('approvals').innerHTML='<div class="table-wrap"><table><thead><tr><th>Yêu cầu</th><th>Nhiệm vụ</th><th>Rủi ro</th><th>Thời gian</th><th>Quyết định</th></tr></thead><tbody>'+items.map(function(a){return '<tr><td>'+esc(a.approvalId)+'<pre>'+esc(JSON.stringify(a.action,null,2))+'</pre></td><td>'+esc(a.objective)+'<div class="muted">'+esc(a.taskId)+'</div></td><td>'+badge(a.riskLevel)+'</td><td>'+fmt(a.requestedAt)+'</td><td><div class="actions"><button class="success approvalBtn" data-id="'+esc(a.approvalId)+'" data-decision="APPROVED">Duyệt</button><button class="danger approvalBtn" data-id="'+esc(a.approvalId)+'" data-decision="REJECTED">Từ chối</button></div></td></tr>'}).join('')+'</tbody></table></div>';
    Array.from(document.querySelectorAll('.approvalBtn')).forEach(function(b){b.addEventListener('click',function(){decide(b.getAttribute('data-id'),b.getAttribute('data-decision'))})});
  }
  async function decide(id,decision){
    var reason=prompt(decision==='APPROVED'?'Lý do phê duyệt:':'Lý do từ chối:');if(reason===null)return;
    try{await api('/v1/approvals/'+encodeURIComponent(id)+'/decision',{method:'POST',body:JSON.stringify({decision:decision,actor:state.owner||'admin-web',reason:reason||undefined})});await refresh()}catch(e){alert(e.message)}
  }
  async function showDetails(id){
    try{var data=await api('/v1/admin/tasks/'+encodeURIComponent(id));q('details').textContent=JSON.stringify(data,null,2);q('detailsPanel').classList.remove('hidden');q('detailsPanel').scrollIntoView({behavior:'smooth'})}catch(e){alert(e.message)}
  }
  async function submitTask(){
    var objective=q('taskObjective').value.trim();if(!objective){q('taskMessage').textContent='Phải nhập mục tiêu.';return}
    var body={
      idempotencyKey:'ADMIN-'+Date.now()+'-'+Math.random().toString(16).slice(2),ownerId:q('taskOwner').value.trim(),workspaceId:q('taskWorkspace').value.trim(),objective:objective,
      readScope:q('taskRead').value.split(/\r?\n/).map(function(x){return x.trim()}).filter(Boolean),writeScope:q('taskWrite').value.split(/\r?\n/).map(function(x){return x.trim()}).filter(Boolean),
      autonomyMode:q('taskAutonomy').value,riskLevel:q('taskRisk').value,payload:{source:'ADMIN_WEB'},maxAttempts:3
    };
    try{var result=await api('/v1/tasks',{method:'POST',body:JSON.stringify(body)});q('taskMessage').textContent='Đã tạo '+result.task.taskId;q('taskObjective').value='';setTimeout(function(){q('taskModal').classList.add('hidden');refresh()},600)}catch(e){q('taskMessage').innerHTML='<span class="error">'+esc(e.message)+'</span>'}
  }
  q('connect').addEventListener('click',function(){state.token=q('token').value.trim();sessionStorage.setItem('agentV2Token',state.token);refresh()});
  q('refresh').addEventListener('click',refresh);q('statusFilter').addEventListener('change',refresh);
  q('newTask').addEventListener('click',function(){q('taskOwner').value=q('owner').value;q('taskWorkspace').value=q('workspace').value;q('taskModal').classList.remove('hidden')});
  q('cancelTask').addEventListener('click',function(){q('taskModal').classList.add('hidden')});q('submitTask').addEventListener('click',submitTask);
  q('closeDetails').addEventListener('click',function(){q('detailsPanel').classList.add('hidden')});
  if(state.token)refresh();
})();
</script>
</body>
</html>`;
