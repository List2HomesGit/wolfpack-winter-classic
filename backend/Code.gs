/**
 * Wolfpack Winter Classic — tournament backend (Google Apps Script)
 *
 * Stores applications in the "Applications" tab of the Google Sheet this
 * script is attached to, and sends every email from your Google account.
 *
 * One-time setup (see README.md for screenshots-free step by step):
 *   1. Edit CONFIG below.
 *   2. Project Settings → Script properties → add ADMIN_KEY (your organizer password).
 *   3. Run setup() once and approve the permissions.
 *   4. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone.
 *   5. Paste the /exec URL into CONFIG.API_URL in index.html.
 */

const CONFIG = {
  EVENT_NAME: 'Wolfpack Winter Classic',
  DATES_LABEL: 'December 18–20, 2026',
  LOCATION: 'Dickson, Alberta',
  SITE_URL: 'https://YOUR-SITE.netlify.app',      // public site address, no trailing slash
  ORGANIZER_EMAILS: 'you@example.com',             // comma-separated; gets new-application and overdue alerts
  REPLY_TO: '',                                    // where manager replies go (defaults to your Google account)
  FROM_NAME: 'Wolfpack Winter Classic',
  ENTRY_FEE: 'TBA',                                // e.g. '$1,250 per team'
  ETRANSFER_EMAIL: '',                             // Interac e-Transfer recipient
  PAYMENT_LINK: '',                                // optional online payment link
  PAYMENT_WINDOW_HOURS: 48,
  REMINDER_HOURS_BEFORE: 12,                       // reminder email this long before the deadline
  DIVISIONS: ['U9 Tier 2', 'U9 Tier 3'],
  ROSTER_FOLDER_NAME: 'Wolfpack Winter Classic – Rosters',
  MAX_UPLOAD_MB: 8,
  TIME_ZONE: 'America/Edmonton'
};

const SHEET_NAME = 'Applications';
const COLS = ['id', 'createdAt', 'status', 'division', 'teamName', 'association', 'hcrTeamNumber', 'playerCount',
  'managerName', 'email', 'phone', 'coachName', 'notes', 'token', 'approvedAt', 'deadlineAt', 'rosterSubmittedAt',
  'rosterJson', 'rosterFileUrl', 'paymentNote', 'paidAt', 'confirmedAt', 'reminderSentAt', 'overdueNotifiedAt', 'decidedAt'];

/* ============================== HTTP ============================== */

function doGet() {
  return json({ ok: true, service: CONFIG.EVENT_NAME });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    switch (req.action) {
      case 'apply':  return json(handleApply(req.application || {}));
      case 'team':   return json(handleTeam(req.token));
      case 'roster': return json(handleRoster(req));
      case 'list':   requireAdmin(req.key); return json({ ok: true, apps: readAll().map(publicRow) });
      case 'update': requireAdmin(req.key); return json(handleUpdate(req.id, req.op));
      default:       return json({ ok: false, error: 'Unknown request.' });
    }
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: err.message || 'Something went wrong.' });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function requireAdmin(key) {
  const real = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  if (!real) throw new Error('ADMIN_KEY is not set. Add it under Project Settings → Script properties.');
  if (!key || key !== real) throw new Error('That organizer key is not correct.');
}

/* ============================== Actions ============================== */

function handleApply(a) {
  if (a.website) return { ok: true, id: 'x' };               // honeypot: bots fill hidden fields
  const req = ['division', 'teamName', 'association', 'managerName', 'phone', 'email'];
  for (const k of req) if (!String(a[k] || '').trim()) throw new Error('Please fill in all required fields.');
  if (CONFIG.DIVISIONS.indexOf(a.division) < 0) throw new Error('Please choose a division.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)) throw new Error("That email address doesn't look right.");

  const row = {
    id: Utilities.getUuid().slice(0, 8),
    createdAt: new Date().toISOString(),
    status: 'pending',
    division: a.division,
    teamName: clip(a.teamName, 120),
    association: clip(a.association, 120),
    hcrTeamNumber: clip(a.hcrTeamNumber, 40),
    playerCount: clip(a.playerCount, 4),
    managerName: clip(a.managerName, 120),
    email: clip(a.email, 160).toLowerCase(),
    phone: clip(a.phone, 40),
    coachName: clip(a.coachName, 120),
    notes: clip(a.notes, 2000)
  };
  withLock(() => sheet().appendRow(COLS.map(c => safeCell(row[c]))));

  sendEmail(row.email, `Application received – ${row.teamName}`, emailApplied(row));
  notifyOrganizers(`New application: ${row.teamName} (${row.division})`,
    `<p><b>${h(row.teamName)}</b> applied for <b>${h(row.division)}</b>.</p>
     <p>${h(row.association)}<br>Manager: ${h(row.managerName)} · ${h(row.email)} · ${h(row.phone)}</p>
     ${row.notes ? `<p>Notes: ${h(row.notes)}</p>` : ''}
     <p><a href="${CONFIG.SITE_URL}/#admin">Open the organizer dashboard</a></p>`);
  return { ok: true, id: row.id };
}

function handleTeam(token) {
  const r = findBy('token', token);
  if (!r) throw new Error("This roster link isn't valid. Check the link in your approval email.");
  return { ok: true, team: teamView(r) };
}

function handleRoster(req) {
  const r = findBy('token', req.token);
  if (!r) throw new Error("This roster link isn't valid.");
  if (['approved', 'confirmed'].indexOf(r.status) < 0) throw new Error("This team isn't approved for roster submission.");
  const roster = req.roster || { players: [], staff: [] };
  const players = (roster.players || []).slice(0, 40).map(p => ({ name: clip(p.name, 80), jersey: clip(p.jersey, 4), year: clip(p.year, 4), hcr: clip(p.hcr, 30), goalie: !!p.goalie }));
  const staff = (roster.staff || []).slice(0, 12).map(s => ({ name: clip(s.name, 80), role: clip(s.role, 40), phone: clip(s.phone, 30) }));

  let fileUrl = r.rosterFileUrl || '';
  if (req.file && req.file.data) {
    const bytes = Utilities.base64Decode(req.file.data);
    if (bytes.length > CONFIG.MAX_UPLOAD_MB * 1048576) throw new Error(`That file is over ${CONFIG.MAX_UPLOAD_MB} MB.`);
    const name = `${r.division} – ${r.teamName} – ${clip(req.file.name, 80)}`;
    const file = rosterFolder().createFile(Utilities.newBlob(bytes, req.file.mimeType || 'application/octet-stream', name));
    fileUrl = file.getUrl();
  }

  withLock(() => update(r, {
    rosterJson: JSON.stringify({ players, staff }),
    rosterFileUrl: fileUrl,
    paymentNote: clip(req.paymentNote, 300),
    rosterSubmittedAt: new Date().toISOString()
  }));

  sendEmail(r.email, `Roster received – ${r.teamName}`, emailRosterReceived(r, players.length));
  notifyOrganizers(`Roster submitted: ${r.teamName}`,
    `<p><b>${h(r.teamName)}</b> (${h(r.division)}) submitted ${players.length} players${fileUrl ? ' and a roster file' : ''}.</p>
     <p>Payment note: ${h(r.paymentNote) || '—'}</p>
     <p>Check your e-Transfers, then mark the team paid in the <a href="${CONFIG.SITE_URL}/#admin">dashboard</a>.</p>`);
  maybeConfirm(r);
  return { ok: true, team: teamView(r) };
}

function handleUpdate(id, op) {
  const r = findBy('id', id);
  if (!r) throw new Error('That application no longer exists.');
  const now = new Date();

  switch (op) {
    case 'approve': {
      const deadline = new Date(now.getTime() + CONFIG.PAYMENT_WINDOW_HOURS * 3600e3);
      withLock(() => update(r, { status: 'approved', token: r.token || newToken(), approvedAt: now.toISOString(), deadlineAt: deadline.toISOString(), decidedAt: now.toISOString(), reminderSentAt: '', overdueNotifiedAt: '' }));
      sendEmail(r.email, `You're in! Roster & payment due within ${CONFIG.PAYMENT_WINDOW_HOURS} hours – ${r.teamName}`, emailApproved(r));
      break;
    }
    case 'decline':
      withLock(() => update(r, { status: 'declined', decidedAt: now.toISOString() }));
      sendEmail(r.email, `${CONFIG.EVENT_NAME} – application update`, emailDeclined(r));
      break;
    case 'waitlist':
      withLock(() => update(r, { status: 'waitlisted', decidedAt: now.toISOString() }));
      sendEmail(r.email, `${CONFIG.EVENT_NAME} – you're on the waitlist`, emailWaitlisted(r));
      break;
    case 'reopen':
      withLock(() => update(r, { status: 'pending' }));
      break;
    case 'markPaid':
      withLock(() => update(r, { paidAt: now.toISOString() }));
      maybeConfirm(r);
      break;
    case 'unmarkPaid':
      withLock(() => update(r, { paidAt: '', status: r.status === 'confirmed' ? 'approved' : r.status, confirmedAt: '' }));
      break;
    case 'extend': {
      const base = r.deadlineAt ? new Date(r.deadlineAt) : now;
      const next = new Date(Math.max(base.getTime(), now.getTime()) + 24 * 3600e3);
      withLock(() => update(r, { deadlineAt: next.toISOString(), reminderSentAt: '', overdueNotifiedAt: '' }));
      sendEmail(r.email, `Deadline extended – ${r.teamName}`, emailExtended(r));
      break;
    }
    case 'resend':
      if (r.status === 'approved') sendEmail(r.email, `Reminder: roster & payment – ${r.teamName}`, emailApproved(r));
      else if (r.status === 'confirmed') sendEmail(r.email, `You're confirmed – ${r.teamName}`, emailConfirmed(r));
      else sendEmail(r.email, `Application received – ${r.teamName}`, emailApplied(r));
      break;
    default:
      throw new Error('Unknown action.');
  }
  return { ok: true, app: publicRow(findBy('id', id)) };
}

function maybeConfirm(r) {
  const fresh = findBy('id', r.id);
  if (fresh.status === 'approved' && fresh.rosterSubmittedAt && fresh.paidAt) {
    withLock(() => update(fresh, { status: 'confirmed', confirmedAt: new Date().toISOString() }));
    sendEmail(fresh.email, `You're confirmed for the ${CONFIG.EVENT_NAME} – ${fresh.teamName}`, emailConfirmed(fresh));
  }
}

/* ============================== Deadlines ============================== */

/** Runs hourly once installTriggers() has been run. */
function checkDeadlines() {
  const now = Date.now();
  readAll().forEach(r => {
    if (r.status !== 'approved' || !r.deadlineAt) return;
    if (r.rosterSubmittedAt && r.paidAt) return;
    const due = new Date(r.deadlineAt).getTime();
    if (now < due && now > due - CONFIG.REMINDER_HOURS_BEFORE * 3600e3 && !r.reminderSentAt && !r.rosterSubmittedAt) {
      sendEmail(r.email, `Reminder: roster & payment due ${fmt(r.deadlineAt)} – ${r.teamName}`, emailReminder(r));
      withLock(() => update(r, { reminderSentAt: new Date().toISOString() }));
    }
    if (now >= due && !r.overdueNotifiedAt) {
      notifyOrganizers(`Overdue: ${r.teamName} (${r.division})`,
        `<p><b>${h(r.teamName)}</b> passed its ${CONFIG.PAYMENT_WINDOW_HOURS}-hour deadline (${fmt(r.deadlineAt)}).</p>
         <p>Roster: ${r.rosterSubmittedAt ? 'received' : '<b>missing</b>'} · Payment: ${r.paidAt ? 'marked paid' : r.paymentNote ? 'reported, not yet marked paid' : '<b>missing</b>'}</p>
         <p>Manager: ${h(r.managerName)} · ${h(r.email)} · ${h(r.phone)}</p>
         <p>In the <a href="${CONFIG.SITE_URL}/#admin">dashboard</a> you can extend 24 hours or decline and offer the spot to a waitlisted team.</p>`);
      withLock(() => update(r, { overdueNotifiedAt: new Date().toISOString() }));
    }
  });
}

/* ============================== Setup ============================== */

/** Run once from the editor: creates the sheet, roster folder and hourly deadline check. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(COLS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, COLS.length).setFontWeight('bold').setBackground('#111216').setFontColor('#ffffff');
  }
  rosterFolder();
  installTriggers();
  MailApp.getRemainingDailyQuota(); // forces the email permission prompt now
  console.log('Setup complete. Now deploy as a web app.');
}

function installTriggers() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'checkDeadlines').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkDeadlines').timeBased().everyHours(1).create();
}

/* ============================== Sheet helpers ============================== */

function sheet() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sh) throw new Error('Run setup() first.');
  return sh;
}

function readAll() {
  const sh = sheet();
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  return sh.getRange(2, 1, n, header.length).getValues().map((vals, i) => {
    const o = { _row: i + 2 };
    header.forEach((k, j) => { const v = vals[j]; o[k] = v instanceof Date ? v.toISOString() : String(v === null ? '' : v); });
    return o;
  }).filter(o => o.id);
}

function findBy(field, value) {
  if (!value) return null;
  return readAll().find(r => r[field] === String(value)) || null;
}

function update(r, changes) {
  const sh = sheet();
  const header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  Object.keys(changes).forEach(k => {
    const col = header.indexOf(k);
    if (col < 0) return;
    sh.getRange(r._row, col + 1).setValue(safeCell(changes[k]));
    r[k] = changes[k];
  });
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function publicRow(r) {
  const o = {};
  COLS.forEach(k => o[k] = r[k] || '');
  try { o.rosterJson = r.rosterJson ? JSON.parse(r.rosterJson) : null; } catch (e) { o.rosterJson = null; }
  return o;
}

function teamView(r) {
  let roster = null;
  try { roster = r.rosterJson ? JSON.parse(r.rosterJson) : null; } catch (e) {}
  return { teamName: r.teamName, division: r.division, managerName: r.managerName, status: r.status, deadlineAt: r.deadlineAt,
    rosterSubmittedAt: r.rosterSubmittedAt || '', paid: !!r.paidAt, roster, paymentNote: r.paymentNote || '' };
}

function rosterFolder() {
  const it = DriveApp.getFoldersByName(CONFIG.ROSTER_FOLDER_NAME);
  return it.hasNext() ? it.next() : DriveApp.createFolder(CONFIG.ROSTER_FOLDER_NAME);
}

function newToken() { return Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8); }
function clip(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function safeCell(v) { const s = String(v == null ? '' : v); return /^[=+\-@]/.test(s) ? "'" + s : s; } // blocks formula injection
function h(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmt(iso) { return Utilities.formatDate(new Date(iso), CONFIG.TIME_ZONE, "EEE, MMM d 'at' h:mm a z"); }
function rosterLink(r) { return `${CONFIG.SITE_URL}/?roster=${encodeURIComponent(r.token)}`; }

/* ============================== Email ============================== */

function sendEmail(to, subject, html) {
  const opts = { to, subject, htmlBody: html, name: CONFIG.FROM_NAME };
  if (CONFIG.REPLY_TO) opts.replyTo = CONFIG.REPLY_TO;
  MailApp.sendEmail(opts);
}

function notifyOrganizers(subject, inner) {
  if (!CONFIG.ORGANIZER_EMAILS) return;
  sendEmail(CONFIG.ORGANIZER_EMAILS, `[WWC] ${subject}`, wrap(subject, inner));
}

function wrap(title, inner) {
  return `<div style="background:#f4f6f8;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#111216">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:6px;overflow:hidden;border:1px solid #d9dee5">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0d0e11;color:#ffffff"><tr>
      <td width="84" style="padding:16px 0 16px 20px;vertical-align:middle"><img src="${CONFIG.SITE_URL}/tournwolf-180.png" width="68" height="68" alt="" style="display:block"></td>
      <td style="padding:16px 20px 16px 14px;vertical-align:middle">
        <div style="font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#a9afba">${h(CONFIG.DATES_LABEL)} · ${h(CONFIG.LOCATION)}</div>
        <div style="font-size:26px;font-weight:900;text-transform:uppercase;margin-top:6px">Wolfpack <span style="color:#e0334c">Winter</span> Classic</div>
      </td></tr></table>
    <div style="height:6px;background:#c8102e"></div>
    <div style="padding:24px;font-size:15px;line-height:1.55">
      <h2 style="font-size:20px;margin:0 0 12px">${h(title)}</h2>
      ${inner}
    </div>
  </div></div>`;
}

function button(href, label) {
  return `<p style="margin:20px 0"><a href="${href}" style="background:#c8102e;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 18px;border-radius:6px;display:inline-block">${h(label)}</a></p>`;
}

function paymentHtml(r) {
  let s = `<p><b>Entry fee:</b> ${h(CONFIG.ENTRY_FEE)}</p>`;
  if (CONFIG.ETRANSFER_EMAIL) s += `<p>Send an Interac e-Transfer to <b>${h(CONFIG.ETRANSFER_EMAIL)}</b> with <b>${h(r.teamName)} – WWC</b> in the message.</p>`;
  if (CONFIG.PAYMENT_LINK) s += `<p>Or pay online: <a href="${CONFIG.PAYMENT_LINK}">${h(CONFIG.PAYMENT_LINK)}</a></p>`;
  return s;
}

function emailApplied(r) {
  return wrap('We received your application', `
    <p>Hi ${h(r.managerName)},</p>
    <p>Thanks for applying to the ${h(CONFIG.EVENT_NAME)}. Here's what we have:</p>
    <table style="font-size:15px;border-collapse:collapse">
      <tr><td style="color:#596070;padding:2px 16px 2px 0">Team</td><td><b>${h(r.teamName)}</b></td></tr>
      <tr><td style="color:#596070;padding:2px 16px 2px 0">Division</td><td>${h(r.division)}</td></tr>
      <tr><td style="color:#596070;padding:2px 16px 2px 0">Association</td><td>${h(r.association)}</td></tr>
    </table>
    <p>The organizing committee will review applications and email you with a decision. If your team is approved, you'll have <b>${CONFIG.PAYMENT_WINDOW_HOURS} hours</b> to submit your roster and pay the entry fee, so it helps to have both ready.</p>
    <p>Questions? Just reply to this email.</p>`);
}

function emailApproved(r) {
  return wrap(`${r.teamName} is approved!`, `
    <p>Hi ${h(r.managerName)},</p>
    <p>Great news: <b>${h(r.teamName)}</b> has been approved for <b>${h(r.division)}</b> at the ${h(CONFIG.EVENT_NAME)}, ${h(CONFIG.DATES_LABEL)} in ${h(CONFIG.LOCATION)}.</p>
    <p style="background:#fbefd9;border-left:4px solid #c8102e;padding:10px 12px"><b>To hold your spot, complete both steps by ${fmt(r.deadlineAt)}</b> (${CONFIG.PAYMENT_WINDOW_HOURS} hours from now).</p>
    <p><b>1. Submit your roster.</b> Fill in your players and staff, or upload your approved roster, using your team's private link:</p>
    ${button(rosterLink(r), 'Submit roster & payment details')}
    <p><b>2. Pay the entry fee.</b></p>
    ${paymentHtml(r)}
    <p>Spots that aren't completed by the deadline may be offered to waitlisted teams.</p>
    <p>Keep this email: the link above is unique to your team and you can use it to update your roster later.</p>`);
}

function emailReminder(r) {
  return wrap('Your roster and payment are due soon', `
    <p>Hi ${h(r.managerName)},</p>
    <p>Friendly reminder: <b>${h(r.teamName)}</b>'s roster and entry fee are due <b>${fmt(r.deadlineAt)}</b>.</p>
    ${button(rosterLink(r), 'Submit roster & payment details')}
    ${paymentHtml(r)}`);
}

function emailRosterReceived(r, count) {
  return wrap('Roster received', `
    <p>Hi ${h(r.managerName)},</p>
    <p>We received the roster for <b>${h(r.teamName)}</b>${count ? ` (${count} players)` : ''}.</p>
    <p>${r.paidAt ? 'Your payment is already confirmed.' : "Once we've matched your payment, we'll send your confirmation."} You can update your roster any time with the same link:</p>
    ${button(rosterLink(r), 'View or update roster')}`);
}

function emailConfirmed(r) {
  return wrap(`${r.teamName} is confirmed`, `
    <p>Hi ${h(r.managerName)},</p>
    <p>Your roster and payment are in. <b>${h(r.teamName)}</b> is confirmed for <b>${h(r.division)}</b> at the ${h(CONFIG.EVENT_NAME)}, ${h(CONFIG.DATES_LABEL)} in ${h(CONFIG.LOCATION)}.</p>
    <p>We'll email the game schedule and arena details before the tournament. See you at the rink!</p>`);
}

function emailDeclined(r) {
  return wrap('Application update', `
    <p>Hi ${h(r.managerName)},</p>
    <p>Thank you for applying to the ${h(CONFIG.EVENT_NAME)}. Unfortunately we aren't able to offer <b>${h(r.teamName)}</b> a spot in ${h(r.division)} this year.</p>
    <p>We appreciate your interest and hope to see you at a future Wolfpack event.</p>`);
}

function emailWaitlisted(r) {
  return wrap("You're on the waitlist", `
    <p>Hi ${h(r.managerName)},</p>
    <p><b>${h(r.teamName)}</b> is on the waitlist for ${h(r.division)}. If a spot opens up, we'll email you right away with roster and payment instructions.</p>`);
}

function emailExtended(r) {
  return wrap('Your deadline has been extended', `
    <p>Hi ${h(r.managerName)},</p>
    <p>We've extended <b>${h(r.teamName)}</b>'s roster and payment deadline to <b>${fmt(r.deadlineAt)}</b>.</p>
    ${button(rosterLink(r), 'Submit roster & payment details')}`);
}
