// Google Apps Script — سفارش غذای شرکت
// Deploy ← New deployment ← Web app ← Execute as: Me ← Who has access: Anyone
// (دسترسی واقعی با id_token گوگل و برگهٔ Users کنترل می‌شود)
const CLIENT_ID = 'PUT_YOUR_CLIENT_ID.apps.googleusercontent.com';
const TZ = 'Asia/Tehran';
const H = {
  Users: ['email', 'name', 'role', 'active'],
  Menu: ['date', 'items'],
  Orders: ['date', 'email', 'name', 'choice', 'updatedAt'],
  Costs: ['id', 'date', 'by', 'title', 'amount', 'note'],
  Settings: ['key', 'value']
};
const ROLES = ['employee', 'cook', 'manager'];
const NONE = 'NONE';

// یک بار از داخل ادیتور اجرا کن: برگه‌ها را می‌سازد و ایمیل تو را مدیر می‌کند
function setup() {
  Object.keys(H).forEach(n => sh_(n));
  const me = Session.getEffectiveUser().getEmail();
  if (me && !findUser_(me)) sh_('Users').appendRow([me, 'مدیر', 'manager', 'true']);
  if (!setting_('cutoff')) sh_('Settings').appendRow(['cutoff', '11:30']);
}

function sh_(name) {
  const ss = SpreadsheetApp.getActive();
  let s = ss.getSheetByName(name);
  if (!s) {
    s = ss.insertSheet(name);
    s.getRange(1, 1, 1, H[name].length).setValues([H[name]]).setFontWeight('bold');
    s.setFrozenRows(1); s.setRightToLeft(true);
    s.getRange(1, 1, 1000, H[name].length).setNumberFormat('@');
  }
  return s;
}
function rows_(name) {
  const s = sh_(name), n = H[name].length, last = s.getLastRow();
  return last < 2 ? [] : s.getRange(2, 1, last - 1, n).getValues().map(r => r.map(String));
}
function setting_(k) { const r = rows_('Settings').find(r => r[0] === k); return r ? r[1] : ''; }
function findUser_(email) {
  const r = rows_('Users').find(r => r[0].toLowerCase() === String(email).toLowerCase());
  return r ? { email: r[0].toLowerCase(), name: r[1], role: r[2], active: r[3] !== 'false' } : null;
}
function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function nowHM_() { return Utilities.formatDate(new Date(), TZ, 'HH:mm'); }
function locked_(date) {
  const t = today_();
  if (date < t) return true;
  if (date > t) return false;
  return nowHM_() >= (setting_('cutoff') || '11:30');
}
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function fail_(code, msg) { const e = new Error(msg || code); e.code = code; throw e; }

// ---- احراز هویت ----
function verify_(idToken) {
  if (!idToken) fail_('AUTH', 'ورود لازم است');
  const cache = CacheService.getScriptCache();
  const key = 'tk' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken));
  const hit = cache.get(key);
  if (hit) return hit;
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) fail_('AUTH', 'توکن نامعتبر یا منقضی');
  const t = JSON.parse(res.getContentText());
  if (t.aud !== CLIENT_ID) fail_('AUTH', 'توکن برای این برنامه نیست');
  if (String(t.email_verified) !== 'true') fail_('AUTH', 'ایمیل تأیید نشده');
  if (Number(t.exp) * 1000 < Date.now()) fail_('AUTH', 'توکن منقضی');
  const ttl = Math.max(1, Math.min(600, Number(t.exp) - Math.floor(Date.now() / 1000)));
  cache.put(key, t.email.toLowerCase(), ttl);
  return t.email.toLowerCase();
}

function doGet() { return out_({ ok: true, msg: 'food-app api' }); }

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const d = JSON.parse(e.postData.contents);
    const email = verify_(d.idToken);
    const u = findUser_(email);
    if (!u || !u.active) fail_('DENIED', 'این ایمیل اجازهٔ ورود ندارد: ' + email);
    return out_({ ok: true, data: route_(d, u) });
  } catch (err) {
    return out_({ ok: false, code: err.code || 'ERR', error: err.code ? err.message : 'خطای سرور' });
  } finally { try { lock.releaseLock(); } catch (x) {} }
}

function need_(u, roles) { if (roles.indexOf(u.role) < 0) fail_('FORBIDDEN', 'دسترسی ندارید'); }
function validDate_(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s)); }

function menuFor_(date) {
  const r = rows_('Menu').find(r => r[0] === date);
  return r ? r[1].split('|').map(s => s.trim()).filter(Boolean) : [];
}

function route_(d, u) {
  switch (d.action) {
    case 'today': {
      const date = today_(), menu = menuFor_(date);
      const o = rows_('Orders').find(r => r[0] === date && r[1] === u.email);
      return { user: { email: u.email, name: u.name, role: u.role }, date, menu, choice: o ? o[3] : '', locked: locked_(date), cutoff: setting_('cutoff') || '11:30', serverTime: nowHM_() };
    }
    case 'setOrder': {
      const date = today_();
      if (locked_(date)) fail_('LOCKED', 'زمان ثبت تمام شده است');
      const choice = String(d.choice || '');
      if (choice !== NONE && menuFor_(date).indexOf(choice) < 0) fail_('BAD', 'گزینه در منو نیست');
      const s = sh_('Orders'), all = rows_('Orders');
      const i = all.findIndex(r => r[0] === date && r[1] === u.email);
      const row = [date, u.email, u.name, choice, Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss')];
      if (i >= 0) s.getRange(i + 2, 1, 1, row.length).setValues([row]); else s.appendRow(row);
      return { choice };
    }
    case 'setMenu': {
      need_(u, ['cook', 'manager']);
      const date = String(d.date || today_());
      if (!validDate_(date) || date < today_()) fail_('BAD', 'تاریخ نامعتبر');
      const items = (d.items || []).map(s => String(s).replace(/\|/g, ' ').trim()).filter(Boolean).slice(0, 15);
      const s = sh_('Menu'), i = rows_('Menu').findIndex(r => r[0] === date);
      const row = [date, items.join('|')];
      if (i >= 0) s.getRange(i + 2, 1, 1, 2).setValues([row]); else s.appendRow(row);
      return { date, items };
    }
    case 'stats': {
      need_(u, ['cook', 'manager']);
      const date = validDate_(d.date) ? d.date : today_();
      const os = rows_('Orders').filter(r => r[0] === date), counts = {};
      os.forEach(r => counts[r[3]] = (counts[r[3]] || 0) + 1);
      const total = os.filter(r => r[3] !== NONE).length;
      const res = { date, counts, total, menu: menuFor_(date), locked: locked_(date) };
      if (u.role === 'manager') {
        res.people = os.map(r => ({ name: r[2], email: r[1], choice: r[3] }));
        const ordered = os.map(r => r[1]);
        res.missing = rows_('Users').filter(r => r[3] !== 'false' && ordered.indexOf(r[0].toLowerCase()) < 0).map(r => r[1] || r[0]);
      }
      return res;
    }
    case 'addCost': {
      need_(u, ['cook', 'manager']);
      const amount = Number(d.amount), title = String(d.title || '').trim();
      if (!title || !(amount > 0)) fail_('BAD', 'عنوان و مبلغ لازم است');
      const date = validDate_(d.date) ? d.date : today_();
      const id = String(Date.now());
      sh_('Costs').appendRow([id, date, u.name || u.email, title.slice(0, 100), String(amount), String(d.note || '').slice(0, 200)]);
      return { id };
    }
    case 'costs': {
      need_(u, ['cook', 'manager']);
      const month = String(d.month || today_().slice(0, 7));
      const list = rows_('Costs').filter(r => r[1].slice(0, 7) === month).map(r => ({ id: r[0], date: r[1], by: r[2], title: r[3], amount: Number(r[4]), note: r[5] }));
      return { month, list, sum: list.reduce((a, b) => a + b.amount, 0) };
    }
    case 'deleteCost': {
      need_(u, ['manager']);
      const i = rows_('Costs').findIndex(r => r[0] === String(d.id));
      if (i < 0) fail_('BAD', 'پیدا نشد');
      sh_('Costs').deleteRow(i + 2); return {};
    }
    case 'users': { need_(u, ['manager']); return { users: rows_('Users').map(r => ({ email: r[0], name: r[1], role: r[2], active: r[3] !== 'false' })) }; }
    case 'saveUser': {
      need_(u, ['manager']);
      const em = String(d.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) fail_('BAD', 'ایمیل نامعتبر');
      if (ROLES.indexOf(d.role) < 0) fail_('BAD', 'نقش نامعتبر');
      if (em === u.email && (d.role !== 'manager' || d.active === false)) fail_('BAD', 'نقش یا وضعیت خودت را نمی‌شود کم کرد');
      const s = sh_('Users'), i = rows_('Users').findIndex(r => r[0].toLowerCase() === em);
      const row = [em, String(d.name || '').slice(0, 60), d.role, String(d.active !== false)];
      if (i >= 0) s.getRange(i + 2, 1, 1, 4).setValues([row]); else s.appendRow(row);
      return {};
    }
    case 'saveSettings': {
      need_(u, ['manager']);
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(d.cutoff))) fail_('BAD', 'ساعت نامعتبر');
      const s = sh_('Settings'), i = rows_('Settings').findIndex(r => r[0] === 'cutoff');
      if (i >= 0) s.getRange(i + 2, 2).setValue(d.cutoff); else s.appendRow(['cutoff', d.cutoff]);
      return {};
    }
  }
  fail_('BAD', 'درخواست نامعتبر');
}
