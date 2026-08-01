export const ADMIN_PAGE = String.raw`<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>Workflow AI V2 — Kỹ thuật</title>
  <style>
    :root{font-family:Inter,Segoe UI,Arial,sans-serif;color:#172033;background:#f3f6fb;line-height:1.45}
    *{box-sizing:border-box}body{margin:0}.top{position:sticky;top:0;z-index:10;background:#101828;color:#fff;padding:14px 22px;display:flex;gap:16px;align-items:center;justify-content:space-between;box-shadow:0 3px 12px #0003}.top h1{font-size:18px;margin:0}.top small{color:#b8c2d8}.wrap{max-width:1500px;margin:0 auto;padding:20px}.panel{background:#fff;border:1px solid #dfe5ef;border-radius:14px;padding:17px;box-shadow:0 5px 18px #1f29370d;margin-bottom:17px}.grid{display:grid;gap:12px}.stats{grid-template-columns:repeat(auto-fit,minmax(135px,1fr))}.cols{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}.stat{background:#f8fafc;border:1px solid #e5eaf2;border-radius:11px;padding:13px}.stat b{font-size:23px;display:block}.label{font-size:12px;color:#667085;text-transform:uppercase;letter-spacing:.04em}input,select,button{font:inherit}input,select{width:100%;border:1px solid #cbd5e1;border-radius:9px;padding:9px 11px;background:#fff}button{border:0;border-radius:9px;padding:9px 13px;cursor:pointer;font-weight:700;background:#2563eb;color:#fff}button.ghost{background:#eef2f7;color:#344054}button.success{background:#067647}button.danger{background:#b42318}.row{display:flex;gap:9px;align-items:end;flex-wrap:wrap}.row>div{flex:1;min-width:170px}.actions{display:flex;gap:7px;flex-wrap:wrap}.table-wrap{overflow:auto;border:1px solid #e5eaf2;border-radius:11px}table{border-collapse:collapse;width:100%;min-width:850px}th,td{text-align:left;padding:10px 11px;border-bottom:1px solid #edf0f5;vertical-align:top}th{background:#f8fafc;font-size:12px;text-transform:uppercase;color:#667085;position:sticky;top:0}tr:hover td{background:#fafcff}.badge{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:800;background:#eef2f7;color:#344054}.badge.COMPLETED,.badge.SUCCEEDED,.badge.APPROVED{background:#dcfae6;color:#067647}.badge.FAILED,.badge.REJECTED{background:#fee4e2;color:#b42318}.badge.RUNNING{background:#dbeafe;color:#1d4ed8}.badge.WAITING_INPUT{background:#f3e8ff;color:#7e22ce}.badge.WAITING_APPROVAL,.badge.PENDING{background:#fef0c7;color:#b54708}.badge.RETRY_WAIT{background:#e0f2fe;color:#0369a1}.muted{color:#667085;font-size:13px}.error{color:#b42318;white-space:pre-wrap}.ok{color:#067647}.section-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:11px}.section-title h2{font-size:17px;margin:0}.notice{padding:10px 12px;border-radius:9px;background:#eff8ff;color:#175cd3}.hidden{display:none!important}pre{white-space:pre-wrap;word-break:break-word;background:#101828;color:#d0d5dd;padding:14px;border-radius:10px;max-height:600px;overflow:auto}.modal{position:fixed;inset:0;background:#10182899;display:flex;align-items:center;justify-content:center;padding:20px;z-index:30}.modal-card{background:#fff;border-radius:16px;padding:20px;width:min(900px,100%);max-height:90vh;overflow:auto}@media(max-width:720px){.top{align-items:flex-start;flex-direction:column}.wrap{padding:11px}.panel{padding:13px}}
  </style>
</head>
<body>
<header class="top">
  <div><h1>Workflow AI V2 — Khu vực kỹ thuật</h1><small>Giao việc hằng ngày tại /app · V1 vẫn là hệ thống đối chiếu</small></div>
  <div class="actions"><button class="ghost" id="openApp">Mở giao diện chat</button><button class="ghost" id="refresh">Làm mới</button></div>
</header>
<main class="wrap">
  <section class="panel">
    <div class="section-title"><h2>Kết nối quản trị</h2><span id="connection" class="badge">CHƯA KẾT NỐI</span></div>
    <div class="row">
      <div><label class="label">API token cục bộ</label><input type="password" id="token" autocomplete="off" placeholder="API_AUTH_TOKEN"></div>
      <div><label class="label">Owner</label><input id="owner" value="danganhdung"></div>
      <div><label class="label">Workspace</label><input id="workspace" value="workflow-v2-sandbox"></div>
      <div style="flex:0 0 auto"><button id="connect">Kết nối</button></div>
    </div>
    <div class="muted" style="margin-top:7px">Token chỉ lưu trong sessionStorage của tab kỹ thuật hiện tại; giao diện chat không yêu cầu token.</div>
  </section>
  <section class="grid stats" id="stats"></section>
  <section class="panel">
    <div class="section-title"><h2>Runtime</h2><span id="phase" class="badge">V1_ONLY</span></div>
    <div class="grid cols">
      <div><div class="label">Lý do cutover</div><div id="phaseReason">—</div></div>
      <div><div class="label">Cập nhật bởi</div><div id="phaseBy">—</div></div>
      <div><div class="label">Adapters</div><div id="adapters">—</div></div>
      <div><div class="label">Model/API</div><div><span class="badge COMPLETED">LOCAL / 0 API COST</span></div></div>
    </div>
  </section>
  <section class="panel">
    <div class="section-title"><h2>Phê duyệt đang chờ</h2><span id="approvalCount" class="badge">0</span></div>
    <div id="approvals" class="muted">Chưa tải dữ liệu.</div>
  </section>
  <section class="panel">
    <div class="section-title"><h2>Nhiệm vụ gần đây</h2><div class="actions"><select id="statusFilter"><option value="">Tất cả trạng thái</option><option>QUEUED</option><option>RUNNING</option><option>WAITING_INPUT</option><option>WAITING_APPROVAL</option><option>RETRY_WAIT</option><option>COMPLETED</option><option>FAILED</option><option>CANCELLED</option></select></div></div>
    <div id="tasks" class="muted">Chưa tải dữ liệu.</div>
  </section>
</main>
<div class="modal hidden" id="detailsModal"><div class="modal-card"><div class="section-title"><h2>Chi tiết nhiệm vụ</h2><button class="ghost" id="closeDetails">Đóng</button></div><pre id="details"></pre></div></div>
<script>
(function(){
  'use strict';
  var q=function(id){return document.getElementById(id)};
  var state={token:sessionStorage.getItem('agentV2AdminToken')||'',owner:'danganhdung',workspace:'workflow-v2-sandbox'};
  q('token').value=state.token;
  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function badge(value){return '<span class="badge '+esc(value)+'">'+esc(value)+'</span>'}
  function fmt(value){if(!value)return '—';try{return new Date(value).toLocaleString('vi-VN')}catch(e){return esc(value)}}
  function headers(){return {'authorization':'Bearer '+state.token,'content-type':'application/json'}}
  async function api(path,options){var response=await fetch(path,Object.assign({headers:headers()},options||{}));var text=await response.text();var data={};try{data=text?JSON.parse(text):{}}catch(e){data={message:text}}if(!response.ok)throw new Error(data.message||data.summary||data.error||('HTTP '+response.status));return data}
  function query(extra){var p=new URLSearchParams();state.owner=q('owner').value.trim();state.workspace=q('workspace').value.trim();if(state.owner)p.set('ownerId',state.owner);if(state.workspace)p.set('workspaceId',state.workspace);Object.keys(extra||{}).forEach(function(k){if(extra[k])p.set(k,extra[k])});return p.toString()}
  function setConnection(ok,message){q('connection').textContent=ok?'ĐÃ KẾT NỐI':'LỖI';q('connection').className='badge '+(ok?'COMPLETED':'FAILED');q('connection').title=message||''}
  async function refresh(){if(!state.token){setConnection(false,'Thiếu token quản trị');return}try{var results=await Promise.all([api('/v1/admin/overview?'+query({})),api('/v1/admin/tasks?'+query({status:q('statusFilter').value,limit:'100'})),api('/v1/admin/approvals?'+query({status:'PENDING',limit:'100'})),api('/v1/admin/adapters')]);renderOverview(results[0]);renderTasks(results[1].items||[]);renderApprovals(results[2].items||[]);renderAdapters(results[3]);setConnection(true,'PASS')}catch(e){setConnection(false,e.message);q('tasks').innerHTML='<div class="error">'+esc(e.message)+'</div>'}}
  function renderOverview(data){var counts=data.counts||{};var keys=['QUEUED','RUNNING','WAITING_INPUT','WAITING_APPROVAL','RETRY_WAIT','COMPLETED','FAILED','CANCELLED'];q('stats').innerHTML=keys.map(function(k){return '<div class="stat"><span class="label">'+esc(k)+'</span><b>'+Number(counts[k]||0)+'</b></div>'}).join('');q('phase').textContent=(data.cutover&&data.cutover.phase)||'UNKNOWN';q('phase').className='badge '+q('phase').textContent;q('phaseReason').textContent=(data.cutover&&data.cutover.reason)||'—';q('phaseBy').textContent=(data.cutover&&data.cutover.changed_by)||'—';q('approvalCount').textContent=String(data.pendingApprovals||0)}
  function renderAdapters(data){var configured=data.configured||[];q('adapters').innerHTML=configured.length?configured.map(function(a){return '<div>'+badge(a.executor)+' '+(a.healthy?'<span class="ok">PASS</span>':'<span class="error">FAIL</span>')+'</div>'}).join(''):'Chưa cấu hình adapter live'}
  function renderTasks(items){if(!items.length){q('tasks').innerHTML='<div class="notice">Không có nhiệm vụ phù hợp.</div>';return}q('tasks').innerHTML='<div class="table-wrap"><table><thead><tr><th>Trạng thái</th><th>Mục tiêu</th><th>Owner/Workspace</th><th>Lần chạy</th><th>Cập nhật</th><th>Lỗi</th><th></th></tr></thead><tbody>'+items.map(function(t){return '<tr><td>'+badge(t.status)+'</td><td><strong>'+esc(t.objective)+'</strong><div class="muted">'+esc(t.taskId)+'</div></td><td>'+esc(t.ownerId)+'<br><span class="muted">'+esc(t.workspaceId)+'</span></td><td>'+esc(t.attempt)+' / '+esc(t.maxAttempts)+'</td><td>'+fmt(t.updatedAt)+'</td><td class="error">'+esc(t.lastError||'')+'</td><td><button class="ghost detailsBtn" data-id="'+esc(t.taskId)+'">Xem</button></td></tr>'}).join('')+'</tbody></table></div>';Array.from(document.querySelectorAll('.detailsBtn')).forEach(function(b){b.onclick=function(){showDetails(b.getAttribute('data-id'))}})}
  function renderApprovals(items){if(!items.length){q('approvals').innerHTML='<div class="notice">Không có phê duyệt đang chờ.</div>';return}q('approvals').innerHTML='<div class="table-wrap"><table><thead><tr><th>Yêu cầu</th><th>Nhiệm vụ</th><th>Rủi ro</th><th>Thời gian</th><th>Quyết định</th></tr></thead><tbody>'+items.map(function(a){return '<tr><td>'+esc(a.approvalId)+'</td><td>'+esc(a.objective)+'<div class="muted">'+esc(a.taskId)+'</div></td><td>'+badge(a.riskLevel)+'</td><td>'+fmt(a.requestedAt)+'</td><td><div class="actions"><button class="success approvalBtn" data-id="'+esc(a.approvalId)+'" data-decision="APPROVED">Duyệt</button><button class="danger approvalBtn" data-id="'+esc(a.approvalId)+'" data-decision="REJECTED">Từ chối</button></div></td></tr>'}).join('')+'</tbody></table></div>';Array.from(document.querySelectorAll('.approvalBtn')).forEach(function(b){b.onclick=function(){decideApproval(b.getAttribute('data-id'),b.getAttribute('data-decision'))}})}
  async function decideApproval(id,decision){var reason=decision==='REJECTED'?(prompt('Lý do từ chối:')||'Từ chối từ bảng kỹ thuật'):undefined;await api('/v1/approvals/'+encodeURIComponent(id)+'/decision',{method:'POST',body:JSON.stringify({decision:decision,actor:state.owner,reason:reason})});await refresh()}
  async function showDetails(id){try{var data=await api('/v1/admin/tasks/'+encodeURIComponent(id));q('details').textContent=JSON.stringify(data,null,2);q('detailsModal').classList.remove('hidden')}catch(e){alert(e.message)}}
  q('connect').onclick=function(){state.token=q('token').value.trim();sessionStorage.setItem('agentV2AdminToken',state.token);refresh()};q('refresh').onclick=refresh;q('statusFilter').onchange=refresh;q('closeDetails').onclick=function(){q('detailsModal').classList.add('hidden')};q('detailsModal').onclick=function(e){if(e.target===q('detailsModal'))q('detailsModal').classList.add('hidden')};q('openApp').onclick=function(){location.href='/app'};if(state.token)refresh();
})();
</script>
</body>
</html>`;
