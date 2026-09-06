const sampleSessions = [
  { title: 'Refactor authentication middleware', note: 'Mapped the session flow and edge-case tests before asking for changes.', type: 'Code & files', tokens: 12400, time: '12 min ago', icon: '⌘' },
  { title: 'Investigate slow dashboard queries', note: 'Shared explain plans, schema fragments, and the latency baseline.', type: 'Terminal output', tokens: 8700, time: '2h ago', icon: '⌁' },
  { title: 'Design notification preferences', note: 'Turned product notes into a small, accessible settings model.', type: 'Chat prompts', tokens: 6400, time: 'Yesterday', icon: '✦' },
  { title: 'Migrate API client to v3', note: 'Collected migration notes and affected call sites for a safe rollout.', type: 'Documentation', tokens: 5300, time: 'Yesterday', icon: '▤' },
  { title: 'Fix mobile navigation state', note: 'Kept the component tree, device repro, and desired behavior together.', type: 'Code & files', tokens: 4100, time: 'Tue', icon: '⌘' },
  { title: 'Plan release checklist', note: 'Consolidated deployment commands, owners, and rollback criteria.', type: 'Chat prompts', tokens: 1342, time: 'Mon', icon: '✦' }
];
const stored = JSON.parse(localStorage.getItem('contextTopSessions') || 'null');
let sessions = stored || sampleSessions;
const fmt = n => n >= 1000 ? `${(n / 1000).toFixed(n % 1000 ? 1 : 0)}k` : n;
function row(s) { return `<article class="session-row"><div class="session-icon">${s.icon || '✦'}</div><div><div class="session-title">${escapeHtml(s.title)}</div><div class="session-note">${escapeHtml(s.note || 'No notes captured')}</div></div><span class="tag">${s.type}</span><span class="token-count">${fmt(Number(s.tokens))} tokens</span><span class="time">${s.time}</span></article>`; }
function escapeHtml(value){ const p=document.createElement('p');p.textContent=value;return p.innerHTML; }
function render() {
  document.getElementById('session-list').innerHTML = sessions.slice(0, 4).map(row).join('');
  document.getElementById('all-session-list').innerHTML = sessions.map(row).join('');
  document.getElementById('session-count').textContent = sessions.length;
  document.getElementById('sessions-total').textContent = sessions.length;
  document.getElementById('context-total').textContent = fmt(sessions.reduce((sum, s) => sum + Number(s.tokens), 0));
}
document.getElementById('date-label').textContent = new Intl.DateTimeFormat('en-US',{weekday:'long',month:'long',day:'numeric'}).format(new Date()).toUpperCase();
render();
const modal = document.getElementById('session-modal');
document.getElementById('open-modal').onclick = () => modal.showModal();
document.getElementById('session-form').addEventListener('submit', e => {
  if (e.submitter.value === 'cancel') return;
  e.preventDefault(); const data = new FormData(e.currentTarget);
  sessions.unshift({title:data.get('title'),note:data.get('note'),type:data.get('type'),tokens:data.get('tokens'),time:'Just now',icon:'✦'});
  localStorage.setItem('contextTopSessions', JSON.stringify(sessions)); render(); modal.close(); e.currentTarget.reset();
});
function show(name){document.querySelectorAll('.view').forEach(v=>v.classList.add('hidden'));document.getElementById(`${name}-view`).classList.remove('hidden');document.querySelectorAll('.nav-item[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===name));document.getElementById('page-title').textContent=name==='sessions'?'Every conversation, in context.':'Your context, at a glance.'}
document.querySelectorAll('.nav-item[data-view]').forEach(b=>b.onclick=()=>show(b.dataset.view));
document.getElementById('view-sessions').onclick=()=>show('sessions'); document.getElementById('back-overview').onclick=()=>show('overview');
document.getElementById('dismiss-notice').onclick=e=>e.currentTarget.parentElement.remove();
document.getElementById('session-search').addEventListener('input',e=>{const q=e.target.value.toLowerCase();document.getElementById('all-session-list').innerHTML=sessions.filter(s=>`${s.title} ${s.note} ${s.type}`.toLowerCase().includes(q)).map(row).join('')||'<p class="session-note">No sessions match that search.</p>'});
