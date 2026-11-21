const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const NONE = 'NONE';
let tok = null, me = null, tab = 'order';

// ---- ورود (redirect با id_token؛ بدون popup، سازگار با PWA آیفون) ----
function redirectUri() { return location.origin + location.pathname; }
function login() {
  const nonce = crypto.randomUUID();
  sessionStorage.setItem('nonce', nonce);
  const p = new URLSearchParams({ client_id: CFG.CLIENT_ID, redirect_uri: redirectUri(), response_type: 'id_token', scope: 'openid email profile', nonce, prompt: 'select_account' });
  location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + p;
}
function jwt(t) { try { return JSON.parse(decodeURIComponent(escape(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))))); } catch (e) { return null; } }
function loadToken() {
  if (location.hash.includes('id_token=')) {
    const t = new URLSearchParams(location.hash.slice(1)).get('id_token');
    history.replaceState(null, '', location.pathname);
    const j = jwt(t);
    if (j && j.nonce === sessionStorage.getItem('nonce')) localStorage.setItem('tok', t);
  }
  const t = localStorage.getItem('tok'), j = t && jwt(t);
  if (j && j.exp * 1000 > Date.now() + 30000) return t;
  localStorage.removeItem('tok'); return null;
}
function logout() { localStorage.removeItem('tok'); location.reload(); }

async function api(action, data = {}) {
  const t = loadToken();
  if (!t) { showLogin('نشست تمام شد، دوباره وارد شوید'); throw new Error('AUTH'); }
  let r;
  try {
    // text/plain: بدون preflight (Apps Script از OPTIONS پشتیبانی نمی‌کند)
    r = await fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action, idToken: t, ...data }) });
    r = await r.json();
  } catch (e) { throw new Error('اتصال برقرار نشد'); }
  if (!r.ok) {
    if (r.code === 'AUTH') { localStorage.removeItem('tok'); showLogin(r.error); }
    throw new Error(r.error);
  }
  return r.data;
}

function showLogin(msg = '') {
  $('#nav').hidden = true; $('#out').hidden = true; $('#hd').textContent = '';
  $('#app').innerHTML = `<div id="login" class="card"><h2>خوش آمدید</h2><p class="mut">برای ثبت غذا با حساب Google خود وارد شوید.</p><p class="err">${esc(msg)}</p><button id="lb">ورود با Google</button></div>`;
  $('#lb').onclick = login;
}

const TABS = { order: '🍽️ سفارش', kitchen: '👨‍🍳 آشپز', costs: '💰 هزینه', admin: '⚙️ مدیریت' };
function tabsFor(role) { return role === 'manager' ? ['order', 'kitchen', 'costs', 'admin'] : role === 'cook' ? ['order', 'kitchen', 'costs'] : ['order']; }
function renderNav() {
  const t = tabsFor(me.role); $('#nav').hidden = t.length < 2;
  $('#nav').innerHTML = t.map(k => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${TABS[k]}</button>`).join('');
  $('#nav').onclick = e => { const b = e.target.closest('button'); if (b) { tab = b.dataset.t; show(); } };
}
function msg(t, ok) { const m = $('#msg'); if (m) { m.className = ok ? 'ok' : 'err'; m.textContent = t; } }
const fa = n => Number(n).toLocaleString('fa-IR');

async function show() {
  renderNav();
  $('#app').innerHTML = '<p class="mut" style="text-align:center">در حال بارگذاری…</p>';
  try { await ({ order: vOrder, kitchen: vKitchen, costs: vCosts, admin: vAdmin })[tab](); } catch (e) { if (e.message !== 'AUTH') $('#app').innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

async function vOrder() {
  const d = await api('today');
  me = d.user; $('#hd').textContent = `${me.name || me.email}`; $('#out').hidden = false;
  const opts = d.menu.map(m => `<button class="opt ${d.choice === m ? 'on' : ''}" data-c="${esc(m)}" ${d.locked ? 'disabled' : ''}>${esc(m)}</button>`).join('')
    + (d.menu.length ? `<button class="opt ${d.choice === NONE ? 'on' : ''}" data-c="${NONE}" ${d.locked ? 'disabled' : ''}>❌ غذا نمی‌خورم</button>` : '');
  $('#app').innerHTML = `<div class="card"><b>منوی امروز (${esc(d.date)})</b>
    <p class="mut">${d.locked ? '🔒 زمان ثبت تمام شد' : `ثبت تا ساعت ${esc(d.cutoff)}`}</p>
    ${opts || '<p class="mut">هنوز منو ثبت نشده است.</p>'}<p id="msg"></p>
    ${d.choice ? `<p class="ok">انتخاب شما: ${d.choice === NONE ? 'غذا نمی‌خورم' : esc(d.choice)}</p>` : (d.menu.length ? '<p class="err">هنوز انتخاب نکرده‌اید</p>' : '')}</div>`;
  $('#app').onclick = async e => {
    const b = e.target.closest('.opt'); if (!b || b.disabled) return;
    try { await api('setOrder', { choice: b.dataset.c }); vOrder().then(() => msg('ثبت شد ✓', true)); } catch (x) { msg(x.message); }
  };
}

async function vKitchen() {
  const d = await api('stats');
  const rows = Object.keys(d.counts).map(k => `<div class="row"><span>${k === NONE ? 'غذا نمی‌خورند' : esc(k)}</span><b>${fa(d.counts[k])}</b></div>`).join('') || '<p class="mut">سفارشی نیست</p>';
  let h = `<div class="card"><b>تعداد غذا امروز: ${fa(d.total)}</b>${rows}<button class="sec" id="rf">بازخوانی</button></div>`;
  if (d.missing) h += `<div class="card"><b>ثبت نکرده‌اند (${fa(d.missing.length)})</b><p class="mut">${d.missing.map(esc).join('، ') || '—'}</p></div>`;
  if (d.people) h += `<div class="card"><b>لیست</b>${d.people.map(p => `<div class="row"><span>${esc(p.name || p.email)}</span><span>${p.choice === NONE ? '—' : esc(p.choice)}</span></div>`).join('')}</div>`;
  h += `<div class="card"><b>تعیین منو (هر خط یک غذا)</b><input type="date" id="md" value="${d.date}" min="${d.date}"><textarea id="mi" rows="4" style="width:100%;font:inherit;padding:10px;border-radius:10px;border:1px solid #d1d5db">${d.menu.map(esc).join('\n')}</textarea><button id="sm">ذخیره منو</button><p id="msg"></p></div>`;
  $('#app').innerHTML = h; $('#app').onclick = null;
  $('#rf').onclick = show;
  $('#sm').onclick = async () => { try { await api('setMenu', { date: $('#md').value, items: $('#mi').value.split('\n') }); msg('ذخیره شد ✓', true); } catch (x) { msg(x.message); } };
}

async function vCosts() {
  const d = await api('costs');
  const today = new Date().toISOString().slice(0, 10);
  $('#app').innerHTML = `<div class="card"><b>ثبت هزینه</b><input id="ct" placeholder="عنوان (مثلاً برنج)"><input id="ca" type="number" inputmode="numeric" placeholder="مبلغ (تومان)"><input id="cd" type="date" value="${today}"><input id="cn" placeholder="توضیح (اختیاری)"><button id="cs">ثبت</button><p id="msg"></p></div>
  <div class="card"><b>هزینه‌های ${esc(d.month)} — جمع: ${fa(d.sum)}</b>${d.list.map(c => `<div class="row"><span>${esc(c.date)} ${esc(c.title)}<br><small class="mut">${esc(c.by)} ${esc(c.note)}</small></span><span>${fa(c.amount)} ${me.role === 'manager' ? `<button class="red" data-del="${esc(c.id)}">✕</button>` : ''}</span></div>`).join('') || '<p class="mut">—</p>'}</div>`;
  $('#cs').onclick = async () => { try { await api('addCost', { title: $('#ct').value, amount: $('#ca').value, date: $('#cd').value, note: $('#cn').value }); show(); } catch (x) { msg(x.message); } };
  $('#app').onclick = async e => { const b = e.target.closest('[data-del]'); if (b && confirm('حذف شود؟')) { try { await api('deleteCost', { id: b.dataset.del }); show(); } catch (x) { alert(x.message); } } };
}

async function vAdmin() {
  const d = await api('users');
  $('#app').innerHTML = `<div class="card"><b>افزودن/ویرایش کاربر</b><input id="ue" type="email" placeholder="ایمیل Google"><input id="un" placeholder="نام"><select id="ur"><option value="employee">کارمند</option><option value="cook">آشپز</option><option value="manager">مدیر</option></select><select id="ua"><option value="true">فعال</option><option value="false">غیرفعال</option></select><button id="us">ذخیره</button><p id="msg"></p></div>
  <div class="card"><b>ساعت قفل ثبت</b><input id="cu" type="time" value="11:30"><button id="cus">ذخیره ساعت</button></div>
  <div class="card"><b>کاربران (${fa(d.users.length)})</b>${d.users.map(u => `<div class="row" data-e="${esc(u.email)}" data-n="${esc(u.name)}" data-r="${esc(u.role)}" data-a="${u.active}"><span>${esc(u.name)}<br><small class="mut">${esc(u.email)}</small></span><span>${esc(u.role)} ${u.active ? '' : '⛔'}</span></div>`).join('')}</div>`;
  $('#app').onclick = e => { const r = e.target.closest('[data-e]'); if (r) { $('#ue').value = r.dataset.e; $('#un').value = r.dataset.n; $('#ur').value = r.dataset.r; $('#ua').value = r.dataset.a; scrollTo(0, 0); } };
  $('#us').onclick = async () => { try { await api('saveUser', { email: $('#ue').value, name: $('#un').value, role: $('#ur').value, active: $('#ua').value === 'true' }); show(); } catch (x) { msg(x.message); } };
  $('#cus').onclick = async () => { try { await api('saveSettings', { cutoff: $('#cu').value }); msg('ذخیره شد ✓', true); } catch (x) { msg(x.message); } };
}

(function init() {
  $('#out').onclick = logout;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');
  if (CFG.CLIENT_ID.startsWith('PUT_')) { $('#app').innerHTML = '<div class="card err">config.js هنوز تنظیم نشده است.</div>'; return; }
  loadToken() ? show() : showLogin();
})();
