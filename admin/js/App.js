/* ÉCHÉANCE v1.0 — point d'entrée : état, actions, écrans. La logique métier est dans logic.js (pure, testée). */
import { APP_VERSION, LICENSE_PUBLIC_KEY, SELLER, LIMITS, PLANS } from './config.js';
import * as motion from './motion.js';
import { trialStatus, trialPlan, canAddReminder, capReminders, gated, planBadge, offerMessage, offerPrice } from './plans.js';
import { todayStr, addDays, endOfMonth, formatFriendly, formatLong, formatMonthYear, diffDays } from './dates.js';
import { parseAmount, formatMoney, round2 } from './money.js';
import {
  STANDARD_CATEGORIES, ADVANCED_CATEGORIES, CURRENCIES, CURRENCY_LABEL, RECURRENCES, REMINDER_OFFSETS,
  reminderLabel, DOCUMENT_PRESETS, resolveCategory, ADVANCED_IDS, isProCategory
} from './catalog.js';
import {
  canCreate, activeCount, isReceivable, isIncome, moneyMonth, cashflow, payOrder, addPayment, remainingOf, relanceUrl, receivablesSummary, markPaid, markUnpaid, filterCounts, matchesFilter, matchesSearch, sortItems, monthSummary, alertCounts,
  todayReminders, paidItems, filterHistory, totalsByCurrency, urgency
, nextCleanSince, streakDays, monthGrid, shiftMonth } from './logic.js';
import { newId, anchorFor, newCustomCategoryId, sanitizeImport, mergeData, buildExport, sanitizeSettings, pickSynced, sanitizeTombs } from './schema.js';
import { createStore } from './storage.js';
import { verifyLicense, FREE_PLAN, PRO_PLAN, LICENSE_ERRORS } from './license.js';
import * as cloud from './cloud.js';
import * as account from './account.js';
import * as sync from './sync.js';
import { createPinConfig, verifyPin, isValidPinFormat, lockRemainingMs, pinSupported } from './pin.js';
import { itemsToCsv } from './csv.js';
import * as native from './native.js';
import { syncReminders, showDueNotifications, webNotificationsSupported, webPermission } from './notify.js';
import { $, el, btn, clear, toast, openModal, closeModal, closeTopModal, topModal, installModalKeys, confirmDialog, downloadText } from './ui.js';
import { calcNew, calcPress, calcValue, calcConvert, calcText } from './calc.js';
import { monthReport, budgetStatus, inSpace, prevMonthKey, drawReportPng } from './report.js';
import { buildCard, buildHistoryCard, buildDocCard, renderDocRenew, renderMetrics, renderStats, renderMoney, renderPayOrder, buildOrderGroups } from './views.js';
import { parseQuick } from './nlp.js';

const store = createStore();
const state = {
  orderDraft: null, payCurrency: null,
  items: [], customCategories: [], settings: null, pin: null, plan: FREE_PLAN, license: { status: 'none' },
  screen: 'home', view: 'dashboard', filter: 'all', docFilter: 'all', sort: 'nearest', query: '',
  hist: { query: '', category: '', currency: '', period: 'all' }, statsCurrency: 'USD', statsRange: '6m', statsTab: 'money',
  form: null, locked: false, today: todayStr(), hiddenAt: 0, pinBuffer: '', pendingImport: null, pinMode: 'enable'
};
let installEvent = null;
let waitingWorker = null;
let syncTimer = null;

const ctx = () => ({ today: state.today, customCategories: state.customCategories, firstDay: state.settings.firstDayOfWeek });
const nowIso = () => new Date().toISOString();

/* ================================================================ persistance / rendu */
function markDeleted(ids) {
  const at = nowIso(); const set = new Set(ids);
  state.deleted = sanitizeTombs([...ids.map((id) => ({ id, at })), ...(state.deleted || []).filter((t) => !set.has(t.id))]);
}
function persist() {
  store.saveTombs(state.deleted || []);
  const ok = store.saveData({ items: state.items, customCategories: state.customCategories });
  if (!ok && store.persistent) toast("Enregistrement impossible : espace de stockage plein.", 5000);
  $('notice-storage').classList.toggle('hidden', store.persistent);
  scheduleSync();
  scheduleAutoSync();
}
let settingsSig = null;
function persistSettings() {
  const sig = JSON.stringify(pickSynced(state.settings));
  const changed = settingsSig !== null && sig !== settingsSig;
  settingsSig = sig;
  if (changed && !applyingSync) state.settings.updatedAt = nowIso();
  store.saveSettings(state.settings); scheduleSync();
  if (changed) scheduleAutoSync();
}
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncReminders(state.items, state.settings, state.today, new Date(), { digest: state.plan.isPro }).catch(() => {});
    showDueNotifications(state.items, state.settings, state.today, store).catch(() => {});
  }, 250);
}

const effSpace = () => (gated(state.plan, 'spaces') ? 'all' : state.settings.space);
const vis = () => inSpace(state.items, effSpace());
function renderAll() {
  renderHeader();
  renderSpaceSwitch();
  renderDashboard();
  renderDocs();
  renderHistory();
  renderStatsView();
  $('docs-total-count').textContent = String(vis().filter((i) => i.category === 'DOCUMENT').length);
  $('history-total-count').textContent = String(vis().filter((i) => i.isCompleted).length);
  $('stats-pro-mini').classList.toggle('hidden', state.plan.isPro);
  $('view-dashboard').classList.toggle('is-empty', state.items.length === 0);
  $('notice-demo').classList.toggle('hidden', !state.items.some((i) => i.isDemo));
}

function renderHeader() {
  $('plan-label').textContent = planBadge(state.plan, activeCount(state.items));
  $('btn-plan').setAttribute('aria-label', state.plan.trial ? `Essai PRO : ${state.plan.daysLeft} jours restants` : state.plan.isPro ? 'ÉCHÉANCE PRO actif' : `Formule gratuite : ${activeCount(state.items)} échéances actives sur ${state.plan.maxActive}. Découvrir PRO`);
}

function renderMoneyCard(root) {
  const locked = gated(state.plan, 'income');
  const data = locked ? { locked: true } : { month: moneyMonth(vis(), state.today), flows: cashflow(vis(), state.today, { days: 30, balances: state.settings.cash || {} }) };
  renderMoney(root, data, {
    upsell: () => openUpsell('income'),
    addIncome: () => openForm({ direction: 'income' }),
    editCash: () => openCash()
  });
}
/* ---------------------------------------------------------------- rituel de paie (v1.18) */
function renderRitual() {
  const plan = payOrder(vis(), state.today, { days: 30, balances: state.settings.cash || {} });
  const body = clear($('ritual-body'));
  body.appendChild(buildOrderGroups(plan, { onPay: (row) => ritualPay(row.item.id) }, () => { closeModal('modal-ritual'); openCash(); }));
  const any = plan.groups.some((g) => g.rows.length);
  $('ritual-desc').textContent = any ? 'Voici dans quel ordre payer. Touchez « Payé ✓ » au fur et à mesure : l\u2019argent disponible se met à jour.' : 'Tout est à jour pour les 30 prochains jours.';
}
function openRitual() {
  if (gated(state.plan, 'income')) return openUpsell('income');
  renderRitual(); openModal('modal-ritual');
}
function ritualPay(id) {
  const it = state.items.find((i) => i.id === id);
  if (!it || it.isCompleted) return;
  const rem = remainingOf(it);
  const r = markPaid(state.items, id, state.today, nowIso());
  state.items = r.items; persist();
  const c = state.settings.cash || {};
  if (typeof c[it.currency] === 'number' && rem) { state.settings.cash = { ...c, [it.currency]: Math.max(0, round2(c[it.currency] - rem)) }; persistSettings(); }
  toast('Payée ✓');
  renderAll(); renderRitual();
}
/** Un revenu vient d'être marqué reçu : proposer d'ajouter l'argent, puis ouvrir le rituel. */
async function afterIncomeReceived(it) {
  if (gated(state.plan, 'income') || !it.amount) return;
  const amt = formatMoney(it.amount, it.currency);
  const v = await choiceDialog({ title: 'Revenu reçu ✓', desc: `Vous avez reçu ${amt}. Voulez-vous l'ajouter à votre argent disponible, puis voir quoi payer en premier ?`, options: [
    { label: `Oui, ajouter ${amt}`, value: 'add', cls: 'btn btn-primary' }, { label: 'Voir quoi payer, sans l\u2019ajouter', value: 'skip' }, { label: 'Plus tard', value: null }] });
  if (!v) return;
  if (v === 'add') { const c = state.settings.cash || {}; state.settings.cash = { ...c, [it.currency]: round2((typeof c[it.currency] === 'number' ? c[it.currency] : 0) + it.amount) }; persistSettings(); renderAll(); }
  openRitual();
}

/* ---------------------------------------------------------------- saisie en une phrase (v1.18) */
function applyQuick() {
  const text = $('f-quick').value.trim(), note = $('f-quick-note');
  note.classList.remove('is-bad');
  if (!text) { note.textContent = ''; return; }
  const r = parseQuick(text, { today: state.today, defaultCurrency: state.settings.defaultCurrency || 'USD' });
  if (!r.ok) { note.textContent = 'Je n\u2019ai pas compris. Essayez : loyer 300 $ le 5'; note.classList.add('is-bad'); return; }
  const q = r.fields, f = state.form, warn = [];
  let dir = q.direction;
  if (dir === 'receive' && gated(state.plan, 'debts')) { dir = 'pay'; warn.push('« On me doit » est réservé à PRO'); }
  if (dir === 'income' && gated(state.plan, 'income')) { dir = 'pay'; warn.push('Les revenus sont réservés à PRO'); }
  let cat = q.category;
  if (!state.plan.isPro && isProCategory(cat)) cat = 'AUTRE';
  f.direction = dir; f.category = dir === 'income' ? 'AUTRE' : cat; f.currency = q.currency; f.recurrence = q.recurrence;
  f.reminders = dir === 'income' ? [0] : capReminders(state.plan, f.category === 'DOCUMENT' ? [30, 15, 7, 0] : [3, 0]);
  $('f-title').value = q.title; $('f-amount').value = q.amount ? String(q.amount).replace('.', ',') : '';
  if (q.dueDate) $('f-date').value = q.dueDate; if (q.dueTime) $('f-time').value = q.dueTime;
  $('f-party').value = dir === 'receive' ? q.party : '';
  if (q.dueTime) $('f-more').open = true;
  buildCategoryGrid(); syncFormControls();
  const miss = r.missing.length ? ` · à compléter : ${r.missing.join(', ')}` : '';
  const notes = [...r.notes]; notes[0] = { pay: 'À payer', receive: 'On me doit', income: 'Revenu' }[dir];
  note.textContent = `Compris : ${notes.join(' · ')}${miss}. Vérifiez ci-dessous.` + (warn.length ? ` (${warn.join(' ; ')})` : '');
  if (r.missing.length) note.classList.add('is-bad');
  if (!q.dueDate) $('f-date').focus(); else if (!q.amount && f.category !== 'DOCUMENT') $('f-amount').focus();
}

function openCash() {
  const c = state.settings.cash || {};
  $('cash-usd').value = c.USD !== undefined ? String(c.USD).replace('.', ',') : '';
  $('cash-cdf').value = c.CDF !== undefined ? String(c.CDF).replace('.', ',') : '';
  $('cash-error').textContent = '';
  openModal('modal-cash'); setTimeout(() => $('cash-usd').focus(), 50);
}
function saveCash() {
  const out = {};
  for (const [id, cur] of [['cash-usd', 'USD'], ['cash-cdf', 'CDF']]) {
    const raw = $(id).value.trim();
    if (!raw) continue;
    const n = parseAmount(raw);
    if (n === null || Number.isNaN(n) || n < 0) { $('cash-error').textContent = 'Écrivez un montant valide (ex : 150).'; return; }
    out[cur] = n;
  }
  state.settings.cash = out; persistSettings(); closeModal('modal-cash'); renderAll(); toast('Argent disponible enregistré ✓');
}

/** Ligne cliquable de l'accueil : résumé de « Mon argent ». */
function renderMoneyChip() {
  const b = $('money-chip'), t = $('money-chip-text'); if (!b) return;
  let txt = '', bad = false;
  if (gated(state.plan, 'income')) txt = 'Découvrez votre reste à vivre';
  else {
    const m = moneyMonth(vis(), state.today), flows = cashflow(vis(), state.today, { days: 30, balances: state.settings.cash || {} });
    const c = m.currencies.find((x) => x.income > 0);
    const sf = flows.find((f) => f.hasBalance && f.shortfall);
    if (sf) { txt = `⚠ Manque ${formatMoney(sf.shortfall.amount, sf.currency)} le ${formatFriendly(sf.shortfall.date).replace(/ \d{4}$/, '')}`; bad = true; }
    else if (c) txt = `Reste à vivre : ${formatMoney(c.left, c.currency)}`;
    else txt = 'Ajoutez vos revenus';
  }
  t.textContent = txt; b.classList.toggle('is-bad', bad);
}

function renderDashboard() {
  const c = ctx();
  const sum = monthSummary(vis(), state.today);
  { const h = new Date().getHours(); const nm = (state.settings.profileName || '').split(' ')[0];
    $('dashboard-greeting').textContent = (h < 12 ? 'Bonjour' : h < 18 ? 'Bon après-midi' : 'Bonsoir') + (nm ? ', ' + nm : ''); }
  $('dashboard-month-label').textContent = formatMonthYear(state.today);
  { // prochaine échéance à payer (hors créances)
    const nx = vis().filter((i) => !i.isCompleted && !isReceivable(i) && !isIncome(i) && i.category !== 'DOCUMENT' && i.dueDate >= state.today).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
    const box = $('dashboard-next'); box.classList.toggle('hidden', !nx); clear(box);
    if (nx) { box.append(el('span', 'dash-next-label', 'Prochaine'), el('span', 'dash-next-title', nx.title), el('span', 'dash-next-when', (nx.dueDate === state.today ? "aujourd'hui" : formatFriendly(nx.dueDate)) + (nx.amount ? ' · ' + formatMoney(remainingOf(nx), nx.currency) : ''))); }
  }
  $('dashboard-month-count').textContent = sum.count === 0 ? '0 échéance' : sum.count === 1 ? '1 échéance' : `${sum.count} échéances`;
  renderMetrics($('dashboard-metrics'), sum, { rate: state.plan.isPro ? state.settings.usdRate : null, receivables: receivablesSummary(vis(), state.today) });
  $('month-progress-fill').style.width = sum.percent + '%';
  $('month-progress-percent').textContent = sum.percent + ' %';
  $('month-progress-text').textContent = `${sum.percent} % payé ce mois-ci`;

  const al = alertCounts(vis(), state.today);
  const bar = clear($('alerts-bar'));
  if (al.overdue) bar.appendChild(el('span', 'pill-alert urgent', `${al.overdue} en retard`));
  if (al.today) bar.appendChild(el('span', 'pill-alert warning', `${al.today} aujourd'hui`));
  updateStreak();
  if (state.streak >= 2) { const sp = el('span', 'pill-alert streak', null, { title: 'Jours de suite sans aucune échéance en retard' }); sp.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15 9 22 9.3 16.5 14 18.2 21 12 17.3 5.8 21 7.5 14 2 9.3 9 9"/></svg>'); sp.appendChild(el('span', null, `Série de ${state.streak} jours`)); bar.appendChild(sp); }

  renderMoneyChip();
  renderTodayBox();
  renderDocRenew($('dashboard-docs-renew'), vis().filter((i) => i.category === 'DOCUMENT'), c, actions);
  motion.enter('renew', $('dashboard-docs-renew'), '.doc-renew-item-row');
  motion.popIfChanged('dash', $('dashboard-metrics').textContent, $('dashboard-metrics'));
  motion.countUp($('dashboard-metrics'));

  // filtres
  const counts = filterCounts(vis(), state.today, c.firstDay);
  const defs = [['all', 'Toutes'], ['today', "Aujourd'hui"], ['week', 'Cette semaine'], ['month', 'Ce mois'], ['overdue', 'En retard'], ['docs', 'Documents']];
  const fb = clear($('filters-bar'));
  for (const [id, label] of defs) {
    const b = btn('filter-tab' + (state.filter === id ? ' active' : ''), null, () => { state.filter = id; motion.markFresh('dashboard'); renderDashboard(); }, { 'data-filter': id });
    b.append(label + ' ', el('span', 'tab-count', String(counts[id])));
    fb.appendChild(b);
  }
  renderList();
}

function renderTodayBox() {
  const box = clear($('today-reminders-box'));
  const list = todayReminders(vis(), state.today);
  box.classList.toggle('hidden', !list.length);
  if (!list.length) return;
  const head = el('div', 'today-reminders-header');
  head.appendChild(el('div', 'today-reminders-title', `🔔 Rappels du jour (${list.length})`));
  head.appendChild(el('span', 'field-sublabel', formatFriendly(state.today)));
  box.appendChild(head);
  const l = el('div', 'today-reminders-list');
  for (const r of list) {
    const it = state.items.find((i) => i.id === r.itemId);
    if (!it) continue;
    const row = el('div', 'today-reminder-row'); row.dataset.id = it.id;
    const info = el('div', 'today-reminder-info');
    info.append(el('span', 'today-reminder-title', it.title), el('span', 'today-reminder-meta', r.body));
    row.append(info, btn('today-reminder-action', 'Régler', () => actions.togglePaid(it.id), { 'data-action': 'quick-complete' }));
    l.appendChild(row);
  }
  box.appendChild(l);
}

const EMPTY = {
  all: ['Aucune échéance à payer', "Ne manquez plus aucun paiement. Enregistrez votre loyer, facture, abonnement ou document important.", true],
  unpaid: ['Aucune échéance à payer', 'Bravo, tout est réglé !', true],
  today: ["Aucune échéance aujourd'hui", "Rien n'est dû aujourd'hui.", true],
  week: ['Aucune échéance cette semaine', 'Vous êtes tranquille cette semaine.', true],
  month: ['Aucune échéance ce mois-ci', 'Rien de prévu sur le mois en cours.', true],
  overdue: ['Aucune échéance en retard', 'Bravo, vous êtes à jour !', false],
  paid: ['Aucune échéance payée', "Vos échéances réglées apparaîtront ici et dans l'historique.", false],
  docs: ['Aucun document enregistré', "Ajoutez un passeport, un permis ou un contrat pour suivre son expiration.", true]
};

function renderList() {
  const c = ctx();
  const root = clear($('echeances-list'));
  const q = state.query.trim();
  let list = vis().filter((i) => matchesFilter(i, state.filter, state.today, c.firstDay));
  if (q) list = list.filter((i) => matchesSearch(i, q, state.today, state.customCategories));
  list = sortItems(list, state.sort);

  const empty = $('empty-state');
  empty.classList.toggle('hidden', list.length > 0);
  if (!list.length) {
    const [h, t, add] = q ? ['Aucun résultat', `Aucune échéance ne correspond à « ${q} ».`, false] : EMPTY[state.filter];
    $('empty-heading').textContent = h; $('empty-text').textContent = t;
    $('btn-empty-add').classList.toggle('hidden', !add);
    return;
  }

  const section = (title, dot, items, badge) => {
    const s = el('section', 'timeline-section', null, { 'aria-label': title });
    const h = el('div', 'timeline-section-header');
    const w = el('div', 'timeline-section-title-wrap');
    w.append(el('span', 'timeline-indicator-dot ' + dot), el('h3', 'timeline-section-title', title));
    h.append(w, el('span', 'timeline-section-badge', badge));
    s.appendChild(h);
    const cards = el('div', 'timeline-section-cards');
    if (!items.length) cards.appendChild(el('div', 'timeline-section-empty', 'Aucune échéance'));
    for (const it of items) cards.appendChild(buildCard(it, c, actions));
    s.appendChild(cards);
    root.appendChild(s);
  };

  if (state.filter === 'all' && !q && state.sort === 'nearest') {
    const now = [], week = [], later = [];
    for (const it of list) {
      const open = !it.isCompleted;
      if (open && it.dueDate <= state.today) now.push(it);
      else if (open && diffDays(state.today, it.dueDate) <= 7) week.push(it);
      else later.push(it);
    }
    section("AUJOURD'HUI ET EN RETARD", 'today', now, String(now.length));
    section('7 PROCHAINS JOURS', 'week', week, String(week.length));
    section('PLUS TARD', 'later', later, String(later.length));
  } else {
    const names = { all: 'À PAYER', unpaid: 'NON PAYÉES', today: "AUJOURD'HUI", week: 'CETTE SEMAINE', month: 'CE MOIS-CI', overdue: 'EN RETARD', paid: 'PAYÉES', docs: 'DOCUMENTS' };
    section(q ? `RÉSULTATS (${list.length})` : `${names[state.filter]} (${list.length})`, 'today', list, { nearest: 'Plus proche', furthest: 'Plus éloigné', amount_asc: 'Montant ↑', amount_desc: 'Montant ↓' }[state.sort]);
  }
  motion.enter('dashboard', root, '.echeance-card');
}

function renderDocs() {
  const c = ctx();
  const all = vis().filter((i) => i.category === 'DOCUMENT');
  const counts = { all: all.length, soon: 0, overdue: 0, valid: 0 };
  for (const d of all) { const x = diffDays(state.today, d.dueDate); if (x < 0) counts.overdue++; else if (x <= 30) counts.soon++; else counts.valid++; }
  $('docs-badge-count').textContent = all.length === 1 ? '1 document' : `${all.length} documents`;
  const fb = clear($('docs-filters'));
  for (const [id, label] of [['all', 'Tous'], ['soon', 'Expire bientôt (≤ 30 j)'], ['overdue', 'Expirés'], ['valid', 'À jour']]) {
    const b = btn('doc-filter-btn' + (state.docFilter === id ? ' active' : ''), null, () => { state.docFilter = id; renderDocs(); }, { 'data-docfilter': id });
    b.append(label + ' ', el('span', 'doc-filter-count', String(counts[id])));
    fb.appendChild(b);
  }
  const keep = (d) => { const x = diffDays(state.today, d.dueDate); return state.docFilter === 'all' || (state.docFilter === 'overdue' && x < 0) || (state.docFilter === 'soon' && x >= 0 && x <= 30) || (state.docFilter === 'valid' && x > 30); };
  const list = all.filter(keep).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  const root = clear($('docs-list'));
  $('docs-empty').classList.toggle('hidden', list.length > 0);
  for (const d of list) root.appendChild(buildDocCard(d, c, actions));
  motion.enter('docs', root, '[data-id]');
}

function renderHistory() {
  const c = ctx();
  const all = paidItems(vis());
  const isPro = state.plan.isPro;
  $('history-badge-count').textContent = all.length === 1 ? '1 payée' : `${all.length} payées`;
  $('history-sub').textContent = isPro ? 'Trace complète de vos règlements' : `Vos ${LIMITS.FREE_HISTORY} derniers règlements (totaux sur l'ensemble)`;
  const tot = totalsByCurrency(all);
  const sum = clear($('history-summary'));
  for (const cur of CURRENCIES) {
    if (!tot[cur] && !(cur === 'USD' && !Object.keys(tot).length)) continue;
    const p = el('div', 'history-stat-pill'); p.append(el('span', null, `Total réglé (${cur}) :`), el('span', 'history-stat-amount', new Intl.NumberFormat('fr-FR').format(tot[cur] || 0) + (cur === 'USD' ? ' $' : ' FC')));
    sum.appendChild(p);
  }
  $('history-tools').classList.toggle('hidden', !isPro);

  // catégories du filtre (PRO)
  const sel = $('hist-category');
  if (isPro && sel.options.length === 0) {
    sel.appendChild(new Option('Toutes catégories', ''));
    for (const k of [...STANDARD_CATEGORIES, ...ADVANCED_CATEGORIES, ...state.customCategories]) sel.appendChild(new Option(k.name, k.id));
  }
  let list = isPro ? filterHistory(all, state.hist, state.today, state.customCategories) : all;
  const hidden = !isPro && all.length > LIMITS.FREE_HISTORY ? all.length - LIMITS.FREE_HISTORY : 0;
  if (!isPro) list = list.slice(0, LIMITS.FREE_HISTORY);
  const root = clear($('history-list'));
  for (const it of list) root.appendChild(buildHistoryCard(it, c, actions));
  motion.enter('history', root, '[data-id]');
  motion.popIfChanged('hist', $('history-summary').textContent, [...$('history-summary').querySelectorAll('.history-stat-amount')]);
  $('history-empty').classList.toggle('hidden', all.length > 0);
  $('history-upsell').classList.toggle('hidden', hidden === 0);
  if (hidden) $('history-upsell-text').textContent = `${hidden} paiement${hidden > 1 ? 's' : ''} plus ancien${hidden > 1 ? 's sont masqués' : ' est masqué'} (vos données sont conservées).`;
}

const STATS_TABS = [['money', 'Argent'], ['bilan', 'Bilan'], ['analyses', 'Analyses']];
function renderStatsView() {
  if (state.view !== 'stats') return;
  const root = clear($('view-stats'));
  const tabs = el('div', 'stats-tabs', null, { role: 'tablist', 'aria-label': 'Sections' });
  for (const [k, label] of STATS_TABS) {
    tabs.appendChild(btn('stats-tab' + (state.statsTab === k ? ' active' : ''), label, () => { state.statsTab = k; renderStatsView(); }, { role: 'tab', 'aria-selected': String(state.statsTab === k), 'data-stab': k }));
  }
  root.appendChild(tabs);
  const body = el('div', 'stats-body'); root.appendChild(body);
  if (state.statsTab === 'money') {
    const mc = el('section', 'money-card', null, { id: 'money-card', 'aria-label': 'Mon argent' }); body.appendChild(mc);
    renderMoneyCard(mc);
    if (!gated(state.plan, 'income')) {
      const oc = el('section', 'money-card order-card', null, { id: 'order-card', 'aria-label': 'Ordre de paiement conseillé' }); body.appendChild(oc);
      renderPayOrder(oc, payOrder(vis(), state.today, { days: 30, balances: state.settings.cash || {} }), { open: (id) => openForm({ id }), editCash: () => openCash(), ritual: () => openRitual() });
    }
    renderPro2Cards(body, 'budgets');
  } else if (state.statsTab === 'bilan') renderPro2Cards(body, 'bilan');
  else renderStats(body, { items: vis(), today: state.today, customCategories: state.customCategories, isPro: state.plan.isPro, statsCurrency: state.statsCurrency, statsRange: state.statsRange }, actions);
}
/** Chemin direct : ouvre l'onglet « Argent » sur la section voulue. */
function goStats(tab) {
  state.statsTab = tab;
  if (state.screen !== 'home') showScreen('home', { push: false });
  setView('stats'); window.scrollTo(0, 0);
}

/* ---------------------------------------------------------------- paquet PRO 2 : bilan, budgets, espaces */
let reportMonth = 'current';
function renderPro2Cards(root, part) {
  const box = el('section', 'pro2-cards');
  if (!state.plan.isPro) {
    if (part === 'budgets') return;
    const t = el('div', 'pro2-card pro2-locked');
    t.append(el('h3', 'pro2-title', 'Bilan du mois et budgets'), el('p', 'pro2-sub', "Une image de votre mois à partager, des budgets par catégorie et deux espaces (Perso / Pro). Réservé à ÉCHÉANCE PRO."));
    t.appendChild(btn('btn btn-primary btn-sm', 'Découvrir PRO', () => actions.openPro()));
    box.appendChild(t); root.appendChild(box); return;
  }
  // bilan
  const mk = reportMonth === 'prev' ? prevMonthKey(state.today) : state.today.slice(0, 7);
  const r = monthReport(vis(), state.today, mk, state.customCategories);
  const c = el('div', 'pro2-card pro2-bilan');
  c.appendChild(el('h3', 'pro2-title', 'Bilan de ' + r.label.toLowerCase()));
  const tabs = el('div', 'pro2-tabs');
  tabs.append(btn('chip-date' + (reportMonth === 'current' ? ' active' : ''), 'Ce mois', () => { reportMonth = 'current'; renderStatsView(); }),
    btn('chip-date' + (reportMonth === 'prev' ? ' active' : ''), 'Mois dernier', () => { reportMonth = 'prev'; renderStatsView(); }));
  c.appendChild(tabs);
  const line = r.count ? `${r.paidCount} payée${r.paidCount > 1 ? 's' : ''} sur ${r.count} (${r.percent} %)` + (r.late ? ` · ${r.late} en retard` : ' · aucun retard') : 'Aucune échéance ce mois-là.';
  c.appendChild(el('p', 'pro2-sub', line));
  for (const m of r.currencies) c.appendChild(el('p', 'pro2-line', `${formatMoney(m.paid, m.currency) || '0'} payé sur ${formatMoney(m.total, m.currency)}` + (m.remaining ? ` · reste ${formatMoney(m.remaining, m.currency)}` : '')));
  const row = el('div', 'pro2-actions');
  row.appendChild(btn('btn btn-primary btn-sm', "Partager l'image", () => shareReport(r), { 'data-action': 'share-report' }));
  row.appendChild(btn('btn btn-secondary btn-sm', 'Voir mon argent', () => { state.statsTab = 'money'; renderStatsView(); }));
  c.appendChild(row); if (part === 'bilan') { box.appendChild(c); root.appendChild(box); return; }
  // budgets
  const bc = el('div', 'pro2-card');
  bc.appendChild(el('h3', 'pro2-title', 'Budgets du mois'));
  const bs = budgetStatus(vis(), state.today.slice(0, 7), state.settings.budgets, state.customCategories);
  if (!bs.length) bc.appendChild(el('p', 'pro2-sub', 'Fixez un plafond par catégorie (ex : 300 $ pour le loyer) et suivez ce qu\'il reste.'));
  for (const b of bs) {
    const it = el('button', 'budget-row' + (b.over ? ' is-over' : ''), null, { type: 'button', 'data-budget': b.id });
    it.onclick = () => budgetDialog(b.id);
    const top = el('div', 'budget-top'); top.append(el('span', 'budget-name', `${b.emoji} ${b.name}`.trim()), el('span', 'budget-val', `${formatMoney(b.spent, b.currency) || '0'} / ${formatMoney(b.budget, b.currency)}`));
    const bar = el('div', 'card-partial-bar'); const f = el('div', 'card-partial-fill budget-fill'); f.style.width = b.pct + '%'; bar.appendChild(f);
    it.append(top, bar, el('small', 'budget-note', b.over ? `Dépassé de ${formatMoney(-b.left, b.currency)}` : `Il reste ${formatMoney(b.left, b.currency)}`));
    bc.appendChild(it);
  }
  bc.appendChild(btn('btn btn-secondary btn-sm', bs.length ? 'Ajouter un budget' : 'Définir un budget', () => budgetDialog(null), { 'data-action': 'add-budget' }));
  box.appendChild(bc);
  root.appendChild(box);
}
/** Numéro de contact → format simple (RDC : +243 97 59 17 818 devient 0975917818). */
function cleanPhone(tel) {
  let n = String(tel || '').replace(/[^\d+]/g, '');
  if (n.startsWith('+243')) n = '0' + n.slice(4); else if (n.startsWith('243') && n.length >= 12) n = '0' + n.slice(3);
  return n.slice(0, 20);
}
function fillContact(name, tel) {
  if (name) $('f-party').value = String(name).trim().slice(0, 60);
  if (tel) $('f-party-phone').value = cleanPhone(tel);
}
async function pickContact() {
  if (native.isNative() && native.nativeCanPickContact()) { native.nativePickContact(); return; }
  if (navigator.contacts && typeof navigator.contacts.select === 'function') { // Chrome Android
    try { const r = await navigator.contacts.select(['name', 'tel'], { multiple: false }); if (r && r[0]) fillContact(r[0].name && r[0].name[0], r[0].tel && r[0].tel[0]); } catch (e) { /* annulé */ }
    return;
  }
  toast('Le choix de contact n\'est pas disponible ici : saisissez le nom et le numéro.', 4000);
}
function budgetDialog(editId) {
  const sel = clear($('budget-cat'));
  const cats = [...STANDARD_CATEGORIES, ...ADVANCED_CATEGORIES, ...state.customCategories.map((c) => ({ id: c.id, name: c.name, emoji: c.emoji }))];
  for (const c of cats) sel.appendChild(new Option(`${c.emoji || ''} ${c.name}`.trim(), c.id));
  const cur = editId ? state.settings.budgets[editId] : null;
  sel.value = editId || cats[0].id; sel.disabled = !!editId;
  $('budget-amount').value = cur ? String(cur.amount).replace('.', ',') : '';
  let currency = cur ? cur.currency : state.settings.defaultCurrency;
  const tog = clear($('budget-currency'));
  const paint = () => tog.querySelectorAll('.curr-btn').forEach((b) => { const on = b.dataset.curr === currency; b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on)); });
  for (const k of ['USD', 'CDF']) tog.appendChild(btn('curr-btn', k === 'USD' ? '$ USD' : 'FC CDF', () => { currency = k; paint(); }, { 'data-curr': k, role: 'radio' }));
  paint(); $('budget-error').textContent = '';
  $('budget-del').classList.toggle('hidden', !editId);
  $('budget-del').onclick = () => { const b = { ...state.settings.budgets }; delete b[editId]; state.settings.budgets = b; persistSettings(); closeModal('modal-budget'); renderAll(); };
  $('budget-ok').onclick = () => {
    const n = parseAmount($('budget-amount').value);
    if (!n || Number.isNaN(n) || n <= 0) { $('budget-error').textContent = 'Écrivez un plafond (ex : 300).'; return; }
    state.settings.budgets = { ...state.settings.budgets, [sel.value]: { amount: n, currency } };
    persistSettings(); closeModal('modal-budget'); renderAll(); toast('Budget enregistré ✓');
  };
  openModal('modal-budget');
}
let reportCur = null;
function paintReport() {
  try { reportCur.b64 = drawReportPng(reportCur.r, { space: effSpace(), name: state.settings.profileName }); } catch (e) { toast("Impossible de créer l'image."); return false; }
  $('report-img').src = 'data:image/jpeg;base64,' + reportCur.b64; return true;
}
function shareReport(r) { // aperçu d'abord ; le partage se fait depuis l'aperçu
  reportCur = { r, b64: null };
  if (!paintReport()) return;
  openModal('modal-report');
}
function sendReport() {
  const { r, b64 } = reportCur || {}; if (!b64) return;
  const name = `bilan-${r.key}.jpg`;
  if (native.isNative()) { if (native.nativeCanShareImage()) native.nativeShareImage(name, b64); else native.nativeSaveFile(name, 'image/jpeg', b64); return; } // Android : enregistrée dans la galerie, puis menu de partage
  const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  const blob = new Blob([bytes], { type: 'image/jpeg' });
  const file = new File([blob], name, { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: 'Mon bilan ÉCHÉANCE' }).catch(() => {}); return; }
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000); toast('Image téléchargée ✓');
}
function setSpace(v) {
  if (v !== 'all' && gated(state.plan, 'spaces')) return openUpsell('spaces');
  if (v === 'pro' && gated(state.plan, 'spaces')) return openUpsell('spaces');
  state.settings.space = v; persistSettings(); renderAll();
}
function renderSpaceSwitch() {
  const cur = gated(state.plan, 'spaces') ? 'all' : state.settings.space;
  document.querySelectorAll('#space-switch .space-btn').forEach((b) => { const on = b.dataset.space === cur; b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on)); });
}

const NAV_ICONS = {
  dashboard: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  docs: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  history: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
  stats: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'
};
function buildBottomNav() {
  document.querySelectorAll('.view-switch-btn').forEach((b) => {
    if (b.querySelector('.nav-ico')) return;
    const ico = el('span', 'nav-ico', null, { 'aria-hidden': 'true' });
    ico.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${NAV_ICONS[b.dataset.view] || ''}</svg>`;
    b.prepend(ico);
  });
}

function setView(v) {
  if (v !== state.view) motion.markFresh(v);
  state.view = v;
  $('view-dashboard').classList.toggle('hidden', v !== 'dashboard');
  for (const k of ['docs', 'history', 'stats']) $('view-' + k).classList.toggle('hidden', v !== k);
  document.querySelectorAll('.view-switch-btn').forEach((b) => { const on = b.dataset.view === v; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); });
  const fab = $('fab-home-add');
  fab.classList.toggle('hidden', v === 'stats' || v === 'history');
  const fl = fab.querySelector('span'); if (fl) fl.textContent = v === 'docs' ? 'Document' : 'Ajouter';
  fab.setAttribute('aria-label', v === 'docs' ? 'Ajouter un document' : 'Ajouter une échéance');
  renderStatsView();
}

/* ================================================================ navigation */
const SCREENS = ['home', 'form', 'settings', 'pro', 'calendar', 'pin-lock', 'onboarding'];
function showScreen(name, { push = true } = {}) {
  for (const s of SCREENS) $('screen-' + s).classList.toggle('active', s === name);
  const was = state.screen;
  state.screen = name;
  window.scrollTo(0, 0);
  if (push && name !== 'home' && name !== 'pin-lock' && name !== 'onboarding' && !native.isNative() && was !== name) {
    try { history.pushState({ s: name }, ''); } catch (e) { /* ignore */ }
  }
  if (name === 'settings') renderSettings();
  if (name === 'pro') renderPro();
  if (name === 'calendar') { state.cal = { ym: state.today.slice(0, 7), sel: state.today }; renderCalendar(); }
}
function goHome() { showScreen('home', { push: false }); renderAll(); }

/** Retour système : true si consommé. */
function handleBack() {
  if (state.locked) return false;
  if (closeTopModal()) return true;
  if (state.screen !== 'home' && state.screen !== 'onboarding') { goHome(); return true; }
  if (state.view !== 'dashboard') { setView('dashboard'); return true; }
  return false;
}
window.__echeanceOnBack = handleBack;
window.addEventListener('popstate', () => { if (!state.locked && (closeTopModal() || state.screen !== 'home')) { if (state.screen !== 'home') goHome(); } });

/* ================================================================ actions sur les échéances */
const actions = {
  edit: (id) => openForm({ id }),
  remove: async (id) => {
    const it = state.items.find((i) => i.id === id);
    if (!it) return;
    const ok = await confirmDialog({ title: "Supprimer l'échéance ?", desc: `« ${it.title} » sera supprimée définitivement.`, ok: 'Supprimer', danger: true });
    if (!ok) return;
    state.items = state.items.filter((i) => i.id !== id);
    markDeleted([id]);
    persist();
    toast('Échéance supprimée');
    if (state.screen === 'form') { goHome(); return; }
    motion.leave(document.querySelector(`.echeance-card[data-id="${id}"], #docs-list [data-id="${id}"], #history-list [data-id="${id}"]`), renderAll);
  },
  togglePaid: (id) => {
    const it = state.items.find((i) => i.id === id);
    if (!it) return;
    if (it.isCompleted) return actions.unpay(id);
    const r = markPaid(state.items, id, state.today, nowIso());
    state.items = r.items; persist();                      // données et rappels d'abord
    toast(r.next ? `Payée ✓ — prochaine échéance le ${formatFriendly(r.next.dueDate)}` : (isIncome(it) ? 'Marqué comme reçu ✓' : 'Marquée comme payée ✓'));
    motion.leave(document.querySelector(`#echeances-list .echeance-card[data-id="${id}"]`), renderAll);
    if (isIncome(it)) setTimeout(() => afterIncomeReceived(it), 450);
  },
  partial: async (id) => {
    if (gated(state.plan, 'partial')) return openUpsell('partial');
    const it = state.items.find((i) => i.id === id);
    if (!it || it.isCompleted || !it.amount) return;
    const left = remainingOf(it);
    const rec = it.direction !== 'pay';
    const v = await amountDialog({ title: rec ? 'Montant reçu' : 'Enregistrer un acompte', desc: `Reste ${formatMoney(left, it.currency)} sur ${formatMoney(it.amount, it.currency)}.`, max: left, cur: it.currency });
    if (v === null) return;
    const r = addPayment(state.items, id, v, state.today, state.today, nowIso());
    if (r.error) return;
    state.items = r.items; persist();
    toast(r.completed ? (rec ? 'Tout est reçu ✓' : 'Soldée ✓') : `Enregistré — reste ${formatMoney(remainingOf(r.items.find((i) => i.id === id)), it.currency)}`);
    renderAll();
  },
  relance: (id) => {
    if (gated(state.plan, 'debts')) return openUpsell('debts');
    const it = state.items.find((i) => i.id === id);
    if (it) openLink(relanceUrl(it, state.today));
  },
  unpay: (id) => {
    const it = state.items.find((i) => i.id === id);
    if (!it) return;
    if (!it.isDemo && !canCreate(state.plan, state.items.filter((i) => i.id !== id))) return openUpsell('items');
    state.items = markUnpaid(state.items, id, nowIso()).items; persist();
    toast('Remise en attente');
    motion.leave(document.querySelector(`#history-list [data-id="${id}"]`), renderAll);
  },
  openPro: () => { showScreen('pro'); },
  setStatsCurrency: (c) => { state.statsCurrency = c; renderStatsView(); },
  setStatsRange: (r) => { state.statsRange = r; renderStatsView(); }
};

/* ================================================================ formulaire */
const emptyForm = () => ({ id: null, currency: state.settings.defaultCurrency, recurrence: 'NONE', reminders: [], category: 'LOYER', completed: false, wasCompleted: false, direction: 'pay', space: 'perso' });

function buildFormControls() {
  const cur = $('f-currency');
  for (const c of CURRENCIES) cur.appendChild(btn('curr-btn', CURRENCY_LABEL[c], () => { state.form.currency = c; syncFormControls(); }, { 'data-curr': c, role: 'radio' }));
  const rec = $('f-recurrence');
  for (const r of Object.values(RECURRENCES)) rec.appendChild(btn('rec-btn', r.label, () => { state.form.recurrence = r.id; syncFormControls(); }, { 'data-rec': r.id, role: 'radio' }));
  const rem = $('f-reminders');
  for (const o of REMINDER_OFFSETS) {
    const b = btn('reminder-chip', null, () => {
      const s = new Set(state.form.reminders);
      if (!s.has(o) && !canAddReminder(state.plan, s.size)) return openUpsell('reminders');
      s.has(o) ? s.delete(o) : s.add(o);
      state.form.reminders = [...s].sort((a, b2) => b2 - a);
      syncFormControls();
    }, { 'data-offset': String(o), 'aria-pressed': 'false' });
    b.append(el('span', 'reminder-check-indicator'), el('span', 'reminder-label', reminderLabel(o)), el('span', 'reminder-date-calc', null, { id: 'calc-' + o }));
    rem.appendChild(b);
  }
  const qd = $('f-quick-dates');
  const quick = [['Aujourd\'hui', 0], ['Demain', 1], ['Dans 3 j', 3], ['Dans 7 j', 7], ['Dans 1 mois', 30], ['Dans 6 mois', 180], ['Dans 1 an', 365]];
  for (const [label, off] of quick) qd.appendChild(btn('chip-date', label, () => { $('f-date').value = addDays(state.today, off); syncFormControls(); }, { 'data-offset': String(off) }));
  qd.appendChild(btn('chip-date', 'Fin du mois', () => { $('f-date').value = endOfMonth(state.today); syncFormControls(); }, { 'data-end-month': 'true' }));
  const pc = $('doc-presets-chips');
  for (const p of DOCUMENT_PRESETS) pc.appendChild(btn('chip-doc-preset', `${p.icon} ${p.name}`, () => { $('f-title').value = p.name; state.form.reminders = capReminders(state.plan, p.reminders); syncFormControls(); }, { 'data-preset': p.id }));
  document.querySelectorAll('#f-space .status-btn').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.sp === 'pro' && gated(state.plan, 'spaces') && state.form.space !== 'pro') return openUpsell('spaces');
    state.form.space = b.dataset.sp; syncFormControls();
  }));
  document.querySelectorAll('#space-switch .space-btn').forEach((b) => b.addEventListener('click', () => setSpace(b.dataset.space)));
  document.querySelectorAll('#f-direction .status-btn').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.dir === 'receive' && gated(state.plan, 'debts') && state.form.direction !== 'receive') return openUpsell('debts');
    if (b.dataset.dir === 'income' && gated(state.plan, 'income') && state.form.direction !== 'income') return openUpsell('income');
    state.form.direction = b.dataset.dir; syncFormControls();
  }));
  document.querySelectorAll('#f-status .status-btn').forEach((b) => b.addEventListener('click', () => {
    state.form.completed = b.dataset.status === 'completed';
    if (state.form.completed && !$('f-paid-date').value) $('f-paid-date').value = state.today;
    syncFormControls();
  }));
}

function buildCategoryGrid() {
  const g = clear($('f-categories'));
  const f = state.form;
  const make = (cat, locked) => {
    const b = btn('category-card-btn' + (f.category === cat.id ? ' selected' : '') + (locked ? ' locked' : ''), null, () => {
      if (locked) return openUpsell('category');
      f.category = cat.id; buildCategoryGrid(); syncFormControls();
    }, { 'data-category': cat.id, role: 'radio', 'aria-checked': String(f.category === cat.id) });
    if (cat.icon) b.insertAdjacentHTML('afterbegin', cat.icon); else b.appendChild(el('span', 'cat-emoji', cat.emoji, { 'aria-hidden': 'true' }));
    b.appendChild(el('span', null, cat.name));
    if (locked) b.appendChild(el('span', 'lock-tag', 'PRO'));
    g.appendChild(b);
  };
  STANDARD_CATEGORIES.forEach((c) => make(c, false));
  ADVANCED_CATEGORIES.forEach((c) => make(c, !state.plan.isPro && f.category !== c.id));
  state.customCategories.forEach((c) => make(c, false));
}

function syncFormControls() {
  const f = state.form;
  document.querySelectorAll('#f-currency .curr-btn').forEach((b) => { const on = b.dataset.curr === f.currency; b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on)); });
  document.querySelectorAll('#f-recurrence .rec-btn').forEach((b) => { const on = b.dataset.rec === f.recurrence; b.classList.toggle('active', on); b.setAttribute('aria-checked', String(on)); });
  const due = $('f-date').value;
  document.querySelectorAll('#f-reminders .reminder-chip').forEach((b) => {
    const o = +b.dataset.offset; const on = f.reminders.includes(o);
    b.classList.toggle('selected', on); b.setAttribute('aria-pressed', String(on));
    $('calc-' + o).textContent = due && /^\d{4}-\d{2}-\d{2}$/.test(due) ? formatFriendly(addDays(due, -o)) : '';
  });
  document.querySelectorAll('#f-quick-dates .chip-date').forEach((b) => {
    const on = b.dataset.endMonth ? due === endOfMonth(state.today) : due === addDays(state.today, +b.dataset.offset);
    b.classList.toggle('active', on);
  });
  const rel = due && /^\d{4}-\d{2}-\d{2}$/.test(due) ? diffDays(state.today, due) : null;
  $('f-date-preview').textContent = rel === null ? '' : `${formatFriendly(due)} ${rel < 0 ? `(en retard de ${-rel} j)` : rel === 0 ? "(aujourd'hui)" : rel === 1 ? '(demain)' : `(dans ${rel} j)`}`;
  const remTxt = f.reminders.length ? 'Rappels : ' + [...f.reminders].sort((a, b) => a - b).map((o) => (o === 0 ? 'jour même' : o + ' j avant')).join(', ') : 'Aucun rappel';
  $('f-more-sub').textContent = remTxt + (f.recurrence !== 'NONE' ? ' · ' + RECURRENCES[f.recurrence].label.toLowerCase() : '');
  $('doc-presets').classList.toggle('hidden', f.category !== 'DOCUMENT');
  $('f-date-label').firstChild.textContent = f.category === 'DOCUMENT' ? "Date d'expiration " : 'Date limite ';
  document.querySelectorAll('#f-status .status-btn').forEach((b) => b.classList.toggle('active', (b.dataset.status === 'completed') === f.completed));
  document.querySelectorAll('#f-direction .status-btn').forEach((b) => b.classList.toggle('active', b.dataset.dir === f.direction));
  $('f-party-field').classList.toggle('hidden', f.direction !== 'receive');
  document.querySelectorAll('#f-space .status-btn').forEach((b) => b.classList.toggle('active', b.dataset.sp === f.space));
  $('f-paid-row').classList.toggle('hidden', !f.completed);
}

function openForm({ id = null, category = null, title = '', reminders = null, date = '', direction = null } = {}) {
  let item = null;
  if (id) { item = state.items.find((i) => i.id === id); if (!item) return; }
  else if (!canCreate(state.plan, state.items)) return openUpsell('items');
  else if (category && !state.plan.isPro && isProCategory(category)) return openUpsell('category');
  state.form = emptyForm();
  const f = state.form;
  $('form-error').classList.add('hidden');
  for (const k of ['f-title-error', 'f-date-error', 'f-amount-error']) $(k).classList.add('hidden');
  $('f-status-field').classList.toggle('hidden', !item);
  $('f-quick-field').classList.toggle('hidden', !!item); $('f-quick').value = ''; $('f-quick-note').textContent = '';
  $('f-delete-row').classList.toggle('hidden', !item);
  $('form-title').textContent = item ? "Modifier l'échéance" : 'Ajouter une échéance';
  if (item) {
    Object.assign(f, { id: item.id, currency: item.currency, recurrence: item.recurrence, reminders: [...item.reminders], category: item.category, completed: item.isCompleted, wasCompleted: item.isCompleted, direction: item.direction, space: item.space || 'perso' });
    $('f-party').value = item.party || ''; $('f-party-phone').value = item.partyPhone || '';
    $('f-title').value = item.title; $('f-amount').value = item.amount ? String(item.amount).replace('.', ',') : '';
    $('f-date').value = item.dueDate; $('f-time').value = item.dueTime || ''; $('f-notes').value = item.notes; $('f-paid-date').value = item.paidAt || '';
  } else {
    if (category) f.category = category;
    if (direction === 'income') { f.direction = 'income'; f.category = 'AUTRE'; f.reminders = [0]; }
    f.space = state.settings.space === 'pro' && !gated(state.plan, 'spaces') ? 'pro' : 'perso';
    $('f-party').value = ''; $('f-party-phone').value = '';
    f.reminders = f.direction === 'income' ? [0] : capReminders(state.plan, reminders || (category === 'DOCUMENT' ? [30, 15, 7, 0] : [3, 0]));
    $('f-title').value = title; $('f-amount').value = ''; $('f-date').value = date; $('f-time').value = ''; $('f-notes').value = ''; $('f-paid-date').value = '';
  }
  $('f-more').open = !!item;
  buildCategoryGrid(); syncFormControls();
  showScreen('form');
  setTimeout(() => $('f-title').focus(), 50);
}

function submitForm(e) {
  e.preventDefault();
  const f = state.form;
  const title = $('f-title').value.trim().replace(/\s+/g, ' ');
  const due = $('f-date').value;
  const amount = parseAmount($('f-amount').value);
  const errs = { title: !title, date: !/^\d{4}-\d{2}-\d{2}$/.test(due), amount: Number.isNaN(amount) };
  $('f-title-error').classList.toggle('hidden', !errs.title);
  $('f-date-error').classList.toggle('hidden', !errs.date);
  $('f-amount-error').classList.toggle('hidden', !errs.amount);
  if (errs.title || errs.date || errs.amount) { (errs.title ? $('f-title') : errs.amount ? $('f-amount') : $('f-date')).focus(); return; }

  const now = nowIso();
  const base = {
    title: title.slice(0, 120), category: f.category, amount, currency: f.currency, dueDate: due, dueTime: /^([01]\d|2[0-3]):[0-5]\d$/.test($('f-time').value) ? $('f-time').value : null, recurrence: f.recurrence,
    reminders: [...f.reminders], notes: $('f-notes').value.trim().slice(0, 500),
    space: f.space === 'pro' ? 'pro' : 'perso', direction: f.direction === 'receive' ? 'receive' : f.direction === 'income' ? 'income' : 'pay', party: f.direction === 'receive' ? $('f-party').value.trim().slice(0, 60) : '', partyPhone: f.direction === 'receive' ? $('f-party-phone').value.replace(/[^\d+]/g, '').slice(0, 20) : ''
  };
  if (!f.id) {
    if (!canCreate(state.plan, state.items)) return openUpsell('items');
    state.items = [...state.items, { id: newId(), ...base, anchorDay: anchorFor(base.recurrence, due), isCompleted: false, paidAt: null, payments: [], nextId: null, isDemo: false, createdAt: now, updatedAt: now }];
    persist(); goHome(); toast('Échéance enregistrée ✓');
    return;
  }
  const old = state.items.find((i) => i.id === f.id);
  if (!old) return goHome();
  if (f.wasCompleted && !f.completed && !old.isDemo && !canCreate(state.plan, state.items.filter((i) => i.id !== old.id))) return openUpsell('items');
  const changedAnchor = old.dueDate !== due || old.recurrence !== base.recurrence;
  let updated = { ...old, ...base, anchorDay: changedAnchor ? anchorFor(base.recurrence, due) : old.anchorDay, updatedAt: now };
  let items = state.items.map((i) => (i.id === old.id ? updated : i));
  if (!f.wasCompleted && f.completed) {
    const paid = /^\d{4}-\d{2}-\d{2}$/.test($('f-paid-date').value) ? $('f-paid-date').value : state.today;
    items = markPaid(items, old.id, paid, now).items;
  } else if (f.wasCompleted && !f.completed) {
    items = markUnpaid(items, old.id, now).items;
  } else if (f.completed) {
    const paid = /^\d{4}-\d{2}-\d{2}$/.test($('f-paid-date').value) ? $('f-paid-date').value : (old.paidAt || state.today);
    items = items.map((i) => (i.id === old.id ? { ...i, paidAt: paid } : i));
  }
  state.items = items;
  persist(); goHome(); toast('Modifications enregistrées ✓');
}

/* ================================================================ formules / PRO */
const proCatNames = () => ADVANCED_CATEGORIES.map((c) => c.name).join(', ');
const UPSELL = {
  items: () => [`Limite de ${PLANS.free.maxActive} échéances atteinte`, `La formule gratuite permet ${PLANS.free.maxActive} échéances actives (non payées). Marquez-en une comme payée, ou passez à PRO pour en suivre sans limite. Vos données existantes ne sont jamais bloquées.`],
  category: () => ['Catégorie PRO', `Ces catégories sont réservées à ÉCHÉANCE PRO : ${proCatNames()}, ainsi que les catégories personnalisées.`],
  custom: () => ['Catégories personnalisées', 'Créez vos propres catégories avec ÉCHÉANCE PRO.'],
  reminders: () => ['Plusieurs rappels : PRO', `La formule gratuite permet ${PLANS.free.maxReminders} rappel par échéance. Avec PRO, ajoutez-en autant que vous voulez (1 semaine avant, la veille, le jour même…).`],
  spaces: () => ['Espaces Perso / Pro : PRO', 'Séparez vos échéances personnelles et professionnelles, avec des totaux et des bilans distincts. Réservé à ÉCHÉANCE PRO.'],
  debts: () => ['Dettes et créances : PRO', "Notez l'argent qu'on vous doit et relancez en un geste par WhatsApp avec un message poli, déjà rédigé. Réservé à ÉCHÉANCE PRO."],
  partial: () => ['Paiements partiels : PRO', "Enregistrez un acompte et suivez le reste à payer sur chaque échéance. Réservé à ÉCHÉANCE PRO."],
  income: () => ['Mon argent : PRO', "Notez vos revenus, voyez votre reste à vivre chaque mois et soyez averti avant de manquer d'argent. Réservé à ÉCHÉANCE PRO."],
  rate: () => ['Taux de change : PRO', 'Fixez votre taux dollar / franc pour voir un total unique de vos échéances. Réservé à ÉCHÉANCE PRO.'],
  backup: () => ['Sauvegarde : PRO', 'Exporter et restaurer vos données (changement de téléphone) est réservé à ÉCHÉANCE PRO. Vos données restent toujours sur votre appareil.']
};
function openUpsell(kind) {
  const [t, d] = (UPSELL[kind] || UPSELL.items)();
  $('upsell-title').textContent = t; $('upsell-desc').textContent = d;
  openModal('modal-upsell');
}

async function refreshLicense() {
  const code = store.loadLicenseCode();
  state.plan = FREE_PLAN; state.license = { status: 'none' }; state.trial = { state: 'none', daysLeft: 0, endsOn: null };
  if (code) {
    const r = await verifyLicense(code, LICENSE_PUBLIC_KEY, state.today);
    if (r.ok) { state.plan = PRO_PLAN; state.license = { status: 'active', payload: r.payload }; return; }
    if (r.reason === 'expired') state.license = { status: 'expired', payload: r.payload };
    else state.license = { status: 'invalid' };
  }
  // Licence en ligne (code ECH-XXXX-XXXX) : état gardé sur l'appareil, valable hors-ligne jusqu'à son expiration.
  const c = cloud.loadCached();
  if (c) {
    const payload = { id: c.code, name: c.name, exp: c.expires_at };
    if (cloud.cachedValid(c, state.today)) { state.plan = PRO_PLAN; state.license = { status: 'active', payload }; }
    else if (state.license.status !== 'active') state.license = { status: 'expired', payload };
  }
  if (state.plan.isPro) return;
  // Essai PRO (une seule fois par appareil)
  if (PLANS.trial.days > 0 && PLANS.trial.autoStart && state.license.status === 'none' && !store.loadTrialStart()) store.saveTrialStart(state.today);
  const ts = trialStatus(store.loadTrialStart(), state.today);
  state.trial = ts;
  if (ts.state === 'active') {
    state.plan = trialPlan(ts.daysLeft);
    if (state.license.status === 'none') state.license = { status: 'trial', daysLeft: ts.daysLeft, endsOn: ts.endsOn };
  }
}

/** Au démarrage (en ligne) : le serveur dit si la licence a été révoquée, prolongée ou libérée. Silencieux hors-ligne. */
async function recheckLicenseOnline() {
  if (!cloud.cloudEnabled() || !cloud.loadCached()) return;
  const r = await cloud.recheck();
  if (r === 'unchanged') return;
  await refreshLicense(); renderPro(); renderAll();
  if (r === 'lost') toast('Votre licence PRO n\'est plus active sur ce téléphone. Contactez le vendeur.', 5000);
}

/** Licence et compte : lie la licence de ce téléphone au compte connecté, ou retrouve celle du compte (nouveau téléphone). */
async function syncLicenseAccount() {
  try {
    if (!cloud.cloudEnabled() || !account.getUser()) return;
    const token = await account.validToken(); if (!token) return;
    const r = await cloud.syncWithAccount(token);
    if (r.action === 'linked' || r.action === 'restored') {
      await refreshLicense(); renderPro(); renderAll();
      toast(r.action === 'restored' ? 'Licence PRO retrouvée sur votre compte ✓' : 'Votre licence PRO est maintenant liée à votre compte ✓', 4500);
    } else if (r.action === 'device_limit') toast(`Votre licence PRO est déjà utilisée sur ${r.max_devices || 2} téléphones. Sur l'un d'eux, déconnectez-vous en effaçant le téléphone, ou contactez-nous.`, 8000);
  } catch (e) { /* silencieux : réessayé au prochain démarrage */ }
}

function openLink(url) { if (native.isNative()) native.nativeOpenExternal(url); else window.open(url, '_blank', 'noopener'); }

function proTableRows() {
  const f = PLANS.free;
  const inf = 'Illimité';
  const rows = [
    ['Échéances actives', `${f.maxActive} max`, 'Illimitées'],
    ['Rappels par échéance', String(f.maxReminders), inf],
    ['Catégories', `${ALL_FREE_CATS} de base`, `+ ${ADVANCED_CATEGORIES.length} avancées${f.customCategories ? '' : ' + perso'}`],
    ['Historique', `${f.historyLimit} derniers`, 'Complet, filtres' + (PLANS.gate.csv ? ', CSV' : '')],
    ['Statistiques', 'Mois en cours', 'Tendance, prévisions'],
    ['Dettes et créances', '—', 'Relance WhatsApp'],
    ['Paiements partiels', '—', 'Acomptes et reste'],
    ['Bilan du mois en image', '—', '✔'],
    ['Budgets par catégorie', '—', '✔'],
    ['Espaces Perso / Pro', '—', '✔'],
    ['Taux USD / CDF, total unique', '—', '✔'],
    ['Résumé du dimanche', '—', '✔'],
    ['Sauvegarde du compte (automatique)', '✔ avec compte', '✔'],
    ['Export / import de fichier', PLANS.gate.backup ? '—' : '✔', '✔'],
    ['Rappels, PIN, notifications', '✔', '✔']
  ];
  return rows;
}
const ALL_FREE_CATS = STANDARD_CATEGORIES.length;

function renderProTable() {
  const root = clear($('pro-table-rows'));
  for (const [name, free, pro] of proTableRows()) {
    const row = el('div', 'pro-table-row', null, { role: 'row' });
    const c1 = el('div', 'pro-col-feature', null, { role: 'cell' }); c1.appendChild(el('strong', null, name));
    row.append(c1, el('div', 'pro-col-plan', free, { role: 'cell' }), el('div', 'pro-col-plan pro-val', pro, { role: 'cell' }));
    root.appendChild(row);
  }
}

function buyLink(offer) {
  return `https://wa.me/${SELLER.whatsapp}?text=${encodeURIComponent(offerMessage(offer, payCur()))}`;
}

/* ---- Achat par Mobile Money (validation manuelle par le vendeur, code reçu automatiquement) ---- */
const payNetworks = () => (SELLER.pay || []).filter((p) => p && p.number && String(p.number).trim());
const orderEnabled = () => cloud.cloudEnabled() && payNetworks().length > 0;

const payCur = () => state.payCurrency || (state.settings.defaultCurrency === 'CDF' ? 'CDF' : 'USD');

function startOrder(o) {
  if (cloud.loadOrder()) { toast('Vous avez déjà une commande en cours de vérification.'); $('pro-order-card').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
  state.orderDraft = { offerId: o.id, currency: payCur(), network: payNetworks()[0].network, name: '', phone: '', txn: '' };
  renderOrderCard();
  $('pro-order-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderOrderCard() {
  const box = clear($('pro-order-card'));
  const pending = cloud.loadOrder();
  const d = state.orderDraft;
  const licensed = state.plan.isPro && !state.plan.trial;
  const showIt = !licensed && (!!pending || !!d);
  box.classList.toggle('hidden', !showIt);
  if (!showIt) return;
  const left = (n) => { n.classList.add('order-left'); return n; };
  if (pending) {
    box.appendChild(el('h3', 'pro-cta-title', 'Paiement en cours de vérification'));
    box.appendChild(el('p', 'pro-cta-explainer', `Commande ${pending.ref} · ${pending.label || ''} · ${pending.price || ''} par ${pending.network}.`));
    box.appendChild(el('p', 'pro-cta-explainer', "Dès que le vendeur a vu votre paiement, votre code s'active tout seul ici (en général quelques minutes). Vous pouvez fermer l'application."));
    const acts = el('div', 'pro-buy-actions');
    acts.appendChild(btn('btn btn-pro-action btn-sm', 'Vérifier maintenant', () => checkOrder(true)));
    if (SELLER.whatsapp) acts.appendChild(btn('btn btn-secondary btn-sm', 'Écrire sur WhatsApp', () => openLink(`https://wa.me/${SELLER.whatsapp}?text=${encodeURIComponent('Bonjour, voici ma commande ÉCHÉANCE PRO ' + pending.ref + ' (' + (pending.price || '') + ' par ' + pending.network + ').')}`)));
    acts.appendChild(btn('btn btn-danger-outline btn-sm', 'Annuler', async () => { if (await confirmDialog({ title: 'Annuler la commande ?', desc: "Si vous avez déjà payé, ne l'annulez pas : écrivez-nous plutôt.", ok: 'Annuler la commande', cancel: 'Retour', danger: true })) { cloud.clearOrder(); renderPro(); } }));
    box.appendChild(acts);
    return;
  }
  const offer = PLANS.offers.find((o) => o.id === d.offerId);
  if (!offer) { state.orderDraft = null; box.classList.add('hidden'); return; }
  const nets = payNetworks();
  const net = nets.find((n) => n.network === d.network) || nets[0];
  const price = offerPrice(offer, d.currency);
  box.appendChild(el('h3', 'pro-cta-title', `Payer ${offer.label} · ${price}`));
  const chips = el('div', 'order-chips');
  for (const n of nets) chips.appendChild(btn('order-chip' + (n.network === net.network ? ' on' : ''), n.network, () => { d.network = n.network; renderOrderCard(); }, { 'aria-pressed': String(n.network === net.network) }));
  box.appendChild(chips);
  const steps = left(el('ol', 'order-steps'));
  steps.appendChild(el('li', null, `Envoyez ${price} par ${net.network} au ${net.number}${net.holder ? ' (' + net.holder + ')' : ''}.`));
  steps.appendChild(el('li', null, 'Gardez le SMS de confirmation : il contient la référence de la transaction.'));
  steps.appendChild(el('li', null, 'Remplissez ci-dessous puis touchez « J\'ai payé ».'));
  box.appendChild(steps);
  const lg = left(el('p', 'order-legal-note', 'En payant, vous acceptez les '));
  lg.append(btn('link-btn', 'Conditions', () => {}, { 'data-legal': 'conditions' }), document.createTextNode(' et la '), btn('link-btn', 'politique de remboursement', () => {}, { 'data-legal': 'remboursement' }), document.createTextNode('.'));
  box.appendChild(lg);
  const field = (label, key, attrs) => {
    const w = left(el('div', 'order-field'));
    const id = 'order-' + key;
    w.appendChild(el('label', 'field-label', label, { for: id }));
    const i = el('input', 'field-input', null, { id, autocomplete: 'off', ...attrs });
    i.value = d[key] || '';
    i.addEventListener('input', () => { d[key] = i.value; });
    w.appendChild(i); return w;
  };
  box.appendChild(field('Référence de la transaction *', 'txn', { placeholder: 'ex. MP240601.1234.A56789', maxlength: '40', autocapitalize: 'characters', spellcheck: 'false' }));
  box.appendChild(field('Votre nom', 'name', { placeholder: 'facultatif', maxlength: '120' }));
  box.appendChild(field('Votre numéro WhatsApp', 'phone', { placeholder: 'facultatif', maxlength: '30', inputmode: 'tel' }));
  const err = el('span', 'field-error hidden', '', { role: 'alert' }); box.appendChild(err);
  const go = btn('btn btn-primary', "J'ai payé", async () => {
    if (String(d.txn || '').trim().length < 4) { err.textContent = cloud.ORDER_ERRORS.format; err.classList.remove('hidden'); return; }
    go.disabled = true;
    const r = await cloud.createOrder({ offer: offer.id, currency: d.currency, network: net.network, name: d.name, phone: d.phone, txn: d.txn });
    go.disabled = false;
    if (!r.ok) { err.textContent = cloud.ORDER_ERRORS[r.error] || cloud.ORDER_ERRORS.network; err.classList.remove('hidden'); return; }
    cloud.saveOrder({ ref: r.ref, offer: offer.id, label: offer.label, price, network: net.network, at: Date.now() });
    state.orderDraft = null; renderPro(); toast('Commande envoyée ✓ Vérification en cours');
  });
  box.appendChild(go);
  box.appendChild(btn('btn btn-secondary btn-sm', 'Annuler', () => { state.orderDraft = null; renderOrderCard(); }));
}

let orderChecking = false;
/** Demande au serveur où en est la commande ; si le vendeur a validé, active le code reçu. Silencieux hors-ligne. */
async function checkOrder(manual) {
  const o = cloud.loadOrder();
  if (!o || orderChecking || !cloud.cloudEnabled()) return;
  orderChecking = true;
  try {
    const r = await cloud.orderStatus(o.ref);
    if (!r.ok) {
      if (r.error === 'not_found') { cloud.clearOrder(); renderPro(); if (manual) toast('Commande introuvable. Écrivez-nous sur WhatsApp.', 5000); }
      else if (manual) toast(cloud.ORDER_ERRORS.network, 4000);
      return;
    }
    if (r.status === 'pending') { if (manual) toast('Toujours en cours de vérification…'); return; }
    if (r.status === 'rejected') { cloud.clearOrder(); renderPro(); toast("Paiement non confirmé. Écrivez-nous sur WhatsApp avec votre SMS.", 7000); return; }
    const a = await cloud.activateOnline(r.code);
    if (!a.ok) { if (manual) toast(cloud.ONLINE_ERRORS[a.error] || cloud.ONLINE_ERRORS.network, 5000); return; }
    cloud.saveCached(a); cloud.clearOrder();
    await refreshLicense(); renderPro(); renderAll(); toast('Paiement confirmé : ÉCHÉANCE PRO activé ✓', 5000);
    syncLicenseAccount();
  } finally { orderChecking = false; }
}

function renderCurrencyToggle(show) {
  const box = clear($('pro-currency'));
  box.classList.toggle('hidden', !show);
  if (!show) return;
  for (const [v, t] of [['USD', 'Payer en dollars ($)'], ['CDF', 'Payer en francs (FC)']]) {
    box.appendChild(btn('order-chip' + (payCur() === v ? ' on' : ''), t, () => { state.payCurrency = v; if (state.orderDraft) state.orderDraft = null; renderPro(); }, { 'aria-pressed': String(payCur() === v) }));
  }
}

function renderOffers(show) {
  renderCurrencyToggle(show && PLANS.offers.length > 0);
  const box = clear($('pro-offers'));
  box.classList.toggle('hidden', !show || !PLANS.offers.length);
  if (!show) return;
  for (const o of PLANS.offers) {
    const card = btn('pro-offer' + (o.badge ? ' has-badge' : ''), null, () => { if (orderEnabled() && o.usd) startOrder(o); else if (SELLER.whatsapp) openLink(buyLink(o)); }, { 'data-offer': o.id });
    if (o.badge) card.appendChild(el('span', 'pro-offer-badge', o.badge));
    card.append(el('span', 'pro-offer-label', o.label), el('span', 'pro-offer-price', offerPrice(o, payCur())));
    box.appendChild(card);
  }
}

function renderPro() {
  const licensed = state.plan.isPro && !state.plan.trial;
  const trial = state.plan.trial;
  $('pro-license-card').classList.toggle('hidden', licensed);
  document.querySelector('.pro-comparison-table').classList.toggle('hidden', licensed);
  $('pro-active-card').classList.toggle('hidden', !licensed);
  $('pro-hero-title').textContent = licensed ? 'ÉCHÉANCE PRO' : 'Passez à ÉCHÉANCE PRO';
  $('pro-hero-sub').textContent = licensed ? 'Merci de votre soutien !'
    : trial ? `Essai PRO en cours : ${state.plan.daysLeft} jour${state.plan.daysLeft > 1 ? 's' : ''} restant${state.plan.daysLeft > 1 ? 's' : ''}. Vos données seront conservées ensuite.`
    : state.trial && state.trial.state === 'ended' ? "Votre essai gratuit est terminé. Vos données sont conservées : choisissez une offre pour tout débloquer."
    : 'Gérez toutes vos échéances sans limite.';
  $('license-error').classList.add('hidden');
  renderProTable();
  renderOffers(!licensed);
  renderOrderCard();
  const canTrial = !licensed && !trial && PLANS.trial.days > 0 && !store.loadTrialStart() && state.license.status === 'none';
  $('btn-start-trial').classList.toggle('hidden', !canTrial);
  $('btn-start-trial').textContent = `Essayer PRO gratuitement ${PLANS.trial.days} jours`;
  if (licensed) {
    const p = state.license.payload;
    const left = p.exp ? diffDays(state.today, p.exp) : null;
    $('pro-active-text').textContent = (p.name ? `Merci ${p.name} ! ` : '') + (p.exp ? `Valable jusqu'au ${formatFriendly(p.exp)}` + (left !== null && left >= 0 ? ` (encore ${left} jour${left > 1 ? 's' : ''}).` : '.') : 'Valable à vie.');
  } else if (state.license.status === 'expired') {
    $('pro-license-title').textContent = 'Votre licence a expiré';
    $('pro-buy-text').textContent = `Elle a pris fin le ${formatFriendly(state.license.payload.exp)}. Vos données sont conservées : choisissez une offre pour renouveler.`;
  } else {
    $('pro-license-title').textContent = 'Activer un code PRO';
    $('pro-buy-text').textContent = orderEnabled()
      ? "Choisissez une offre ci-dessus et payez par Mobile Money : votre code s'active tout seul. Vous avez déjà un code ? Collez-le ci-dessous."
      : "Choisissez une offre ci-dessus : le vendeur vous envoie un code par WhatsApp. Collez-le ci-dessous (connexion requise une seule fois).";
  }
  const acts = clear($('pro-buy-actions'));
  if (!licensed && SELLER.whatsapp) acts.appendChild(btn('btn btn-pro-action btn-sm', 'Acheter via WhatsApp', () => openLink(buyLink(null))));
  if (!licensed && SELLER.email) acts.appendChild(btn('btn btn-secondary btn-sm', 'Écrire au vendeur', () => openLink('mailto:' + SELLER.email + '?subject=' + encodeURIComponent('ÉCHÉANCE PRO'))));
}

async function activateLicense() {
  const input = $('license-input').value;
  const err = $('license-error');
  if (cloud.isOnlineCode(input)) {
    $('btn-activate').disabled = true;
    const o = await cloud.activateOnline(input);
    $('btn-activate').disabled = false;
    if (!o.ok) { err.textContent = cloud.ONLINE_ERRORS[o.error] || cloud.ONLINE_ERRORS.network; err.classList.remove('hidden'); return; }
    cloud.saveCached(o);
    await refreshLicense();
    $('license-input').value = '';
    renderPro(); renderAll(); toast('ÉCHÉANCE PRO activé ✓');
    syncLicenseAccount();
    return;
  }
  const r = await verifyLicense(input, LICENSE_PUBLIC_KEY, state.today);
  if (!r.ok) { err.textContent = LICENSE_ERRORS[r.reason] || LICENSE_ERRORS.format; err.classList.remove('hidden'); return; }
  store.saveLicenseCode(input.replace(/[\s​-‏⁠﻿]/g, ''));
  await refreshLicense();
  $('license-input').value = '';
  renderPro(); renderAll(); toast('ÉCHÉANCE PRO activé ✓');
}

/* ================================================================ réglages */
function seg(id, options, value, onChange) {
  const box = clear($(id));
  for (const [v, label] of options) box.appendChild(btn('settings-seg-btn' + (v === value ? ' active' : ''), label, () => { onChange(v); renderSettings(); }, { 'data-value': String(v), 'aria-pressed': String(v === value) }));
}

function renderSettings() {
  const s = state.settings;
  renderAccountUI();
  seg('set-currency', [['USD', 'USD ($)'], ['CDF', 'CDF (FC)']], s.defaultCurrency, (v) => { s.defaultCurrency = v; persistSettings(); });
  seg('set-theme', [['dark', '🌙 Sombre'], ['light', '☀️ Clair'], ['system', 'Auto']], s.theme, (v) => { s.theme = v; persistSettings(); applyTheme(); });
  seg('set-firstday', [['monday', 'Lundi'], ['sunday', 'Dimanche']], s.firstDayOfWeek, (v) => { s.firstDayOfWeek = v; persistSettings(); renderAll(); });
  document.querySelector('.settings-pro-card').classList.toggle('is-active', !!state.plan.isPro);
  $('settings-plan-badge').textContent = state.plan.trial ? `Essai PRO (${state.plan.daysLeft} j)` : state.plan.isPro ? 'PRO actif' : `Formule gratuite (${PLANS.free.maxActive} max)`;
  $('settings-pro-title').textContent = state.plan.trial ? `Essai PRO : ${state.plan.daysLeft} jours restants` : state.plan.isPro ? 'ÉCHÉANCE PRO est actif' : 'Passez à ÉCHÉANCE PRO';
  $('settings-pro-sub').textContent = state.plan.trial ? 'Toutes les fonctions sont débloquées pendant l\'essai.' : state.plan.isPro ? 'Merci ! Toutes les fonctions sont débloquées.' : 'Échéances illimitées, catégories sur-mesure, historique complet, statistiques.';
  $('settings-pro-btn-label').textContent = state.plan.trial ? 'Choisir une offre' : state.plan.isPro ? 'Voir ma licence' : 'Découvrir / activer PRO';

  const hour = $('set-hour');
  if (!hour.options.length) for (let h = 0; h < 24; h++) hour.appendChild(new Option(String(h).padStart(2, '0') + ':00', String(h)));
  hour.value = String(s.reminderHour);
  $('set-autolock').value = String(s.autoLockSeconds);
  $('set-name').value = s.profileName || '';
  $('set-rate').value = s.usdRate ? String(s.usdRate).replace('.', ',') : '';
  $('set-digest').checked = s.weeklyDigest !== false;
  $('set-pin-toggle').checked = !!state.pin;
  $('pin-actions').classList.toggle('hidden', !state.pin);
  $('settings-trouble').classList.toggle('hidden', !native.isNative());
  if (native.isNative()) renderDiag();
  $('notif-web-note').classList.toggle('hidden', native.isNative());
  $('app-version').textContent = `ÉCHÉANCE v${APP_VERSION}`;
  updateNotifUI();
}

function renderDiag() {
  const d = native.nativeDiagnostics();
  if (!d) { $('diag-box').textContent = 'Diagnostic indisponible.'; return; }
  const t = (ms) => (ms ? new Date(ms).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
  const yn = (b) => (b ? 'oui' : 'NON');
  $('diag-box').textContent = [
    `Téléphone : ${d.brand} (Android ${d.sdkInt})`,
    `Heure du téléphone : ${t(d.now)}`,
    `Notifications autorisées : ${yn(d.notificationsEnabled)}`,
    `Rappels activés : ${yn(d.enabled)} (${d.remindersCount} en attente)`,
    `Batterie sans restriction : ${yn(d.ignoringBattery)}`,
    `Alarme exacte autorisée : ${yn(d.canExact)}`,
    `Prochaine alarme prévue : ${t(d.nextAt)}`,
    `Dernière alarme reçue : ${t(d.lastFireAt)} (${d.fireCount} au total)`,
    `Test programmé pour : ${t(d.testAt)}`,
    `Test reçu à : ${t(d.testFiredAt)}`
  ].join('\n');
}

function notifState() {
  if (native.isNative()) { const i = native.nativeInfo(); return { kind: 'native', granted: !!(i && i.notificationsEnabled), info: i }; }
  const p = webPermission();
  return { kind: 'web', granted: p === 'granted', denied: p === 'denied', unsupported: !webNotificationsSupported() };
}
function updateNotifUI() {
  const n = notifState();
  const on = state.settings.notificationsEnabled && n.granted;
  const sub = $('notif-sub'); const b = $('btn-notif');
  if (n.kind === 'web' && n.unsupported) { sub.textContent = "Non pris en charge par ce navigateur : les rappels s'affichent dans l'application."; b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  if (on) { sub.textContent = 'Activées'; b.textContent = 'Désactiver'; }
  else if (n.denied || (n.kind === 'native' && !n.granted && state.settings.notificationsEnabled)) { sub.textContent = 'Bloquées dans les réglages du téléphone.'; b.textContent = n.kind === 'native' ? 'Réglages' : 'Aide'; }
  else { sub.textContent = 'Désactivées : les rappels du jour restent visibles dans l\'application.'; b.textContent = 'Activer'; }
}

async function toggleNotifications() {
  const s = state.settings;
  const n = notifState();
  if (s.notificationsEnabled && n.granted) { s.notificationsEnabled = false; store.saveHealth({ ...store.loadHealth(), userOff: true }); persistSettings(); updateNotifUI(); toast('Notifications désactivées'); return; }
  if (n.kind === 'native') {
    store.saveHealth({ ...store.loadHealth(), userOff: false });
    if (n.granted) { s.notificationsEnabled = true; persistSettings(); updateNotifUI(); toast('Notifications activées ✓'); return; }
    if (n.info && n.info.canAskNotificationPermission) native.nativeRequestNotifications();
    else native.nativeOpenNotificationSettings();
    return;
  }
  if (n.denied) { toast("Notifications bloquées : autorisez-les dans les réglages du site de votre navigateur.", 5000); return; }
  try {
    const res = await Notification.requestPermission();
    if (res === 'granted') { s.notificationsEnabled = true; persistSettings(); toast('Notifications activées ✓'); }
    else toast('Autorisation refusée');
  } catch (e) { toast('Impossible de demander l\'autorisation'); }
  updateNotifUI();
}

function applyTheme() {
  const t = state.settings.theme;
  const dark = t === 'system' ? !(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) : t === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', dark ? '#0a1020' : '#f6f8fd');
  native.nativeSetTheme(dark ? 'dark' : 'light');
}

/* ================================================================ PIN */
function lockApp() {
  if (!state.pin) return;
  state.locked = true; state.pinBuffer = '';
  closeTopModalAll();
  $('screen-pin-lock').classList.add('active');
  document.querySelector('.app-container').classList.add('is-locked');
  for (const s of SCREENS) if (s !== 'pin-lock') $('screen-' + s).classList.remove('active');
  updatePinDots(); refreshPinLockMsg();
}
function closeTopModalAll() { while (topModal()) closeTopModal(); }
function unlockApp() {
  state.locked = false; state.pinBuffer = '';
  setTimeout(() => { if (typeof maybeAskAccount === 'function') maybeAskAccount(); }, 1200);
  document.querySelector('.app-container').classList.remove('is-locked');
  $('screen-pin-lock').classList.remove('active');
  showScreen('home', { push: false }); renderAll();
  checkPendingPay();
}
function updatePinDots() { document.querySelectorAll('#pin-dots-row .pin-dot').forEach((d, i) => d.classList.toggle('filled', i < state.pinBuffer.length)); }
let pinTick = null;
function refreshPinLockMsg() {
  clearInterval(pinTick);
  const msg = $('pin-error-msg');
  const left = lockRemainingMs(state.pin);
  if (left > 0) {
    const tick = () => { const l = lockRemainingMs(state.pin); if (l <= 0) { clearInterval(pinTick); msg.classList.add('hidden'); return; } msg.textContent = `Trop d'essais. Réessayez dans ${Math.ceil(l / 1000)} s.`; msg.classList.remove('hidden'); };
    tick(); pinTick = setInterval(tick, 500);
  }
}
async function pinDigit(d) {
  if (!state.locked || state.pinBuffer.length >= 4 || lockRemainingMs(state.pin) > 0) return;
  state.pinBuffer += d; updatePinDots();
  if (state.pinBuffer.length < 4) return;
  const entered = state.pinBuffer;
  const r = await verifyPin(state.pin, entered);
  state.pin = r.config; store.savePin(state.pin);
  if (r.ok) return unlockApp();
  state.pinBuffer = ''; updatePinDots();
  const msg = $('pin-error-msg');
  if (r.lockedMs > 0) refreshPinLockMsg();
  else { msg.textContent = 'Code PIN incorrect'; msg.classList.remove('hidden'); }
}
function buildKeypad() {
  const pad = $('pin-keypad');
  for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) pad.appendChild(btn('pin-key', d, () => pinDigit(d), { 'data-digit': d }));
  pad.appendChild(btn('pin-key pin-action-key', 'C', () => { state.pinBuffer = ''; updatePinDots(); }, { 'aria-label': 'Tout effacer' }));
  pad.appendChild(btn('pin-key', '0', () => pinDigit('0'), { 'data-digit': '0' }));
  pad.appendChild(btn('pin-key pin-action-key', '⌫', () => { state.pinBuffer = state.pinBuffer.slice(0, -1); updatePinDots(); }, { 'aria-label': 'Effacer' }));
  document.addEventListener('keydown', (e) => {
    if (!state.locked) return;
    if (/^\d$/.test(e.key)) pinDigit(e.key);
    else if (e.key === 'Backspace') { state.pinBuffer = state.pinBuffer.slice(0, -1); updatePinDots(); }
  });
}

function openPinModal(mode) {
  state.pinMode = mode; // enable | change | disable
  $('pin-setup-title').textContent = mode === 'enable' ? 'Configurer le code PIN' : mode === 'change' ? 'Modifier le code PIN' : 'Désactiver le code PIN';
  $('pin-setup-desc').textContent = mode === 'disable' ? 'Entrez votre code actuel pour désactiver la protection.' : 'Choisissez un code à 4 chiffres facile à retenir mais difficile à deviner.';
  $('pin-current-field').classList.toggle('hidden', mode === 'enable');
  for (const id of ['pin-new', 'pin-confirm']) $(id).closest('.form-field').classList.toggle('hidden', mode === 'disable');
  for (const id of ['pin-current', 'pin-new', 'pin-confirm']) $(id).value = '';
  $('pin-setup-error').classList.add('hidden');
  $('btn-pin-cancel').setAttribute('data-modal-cancel', '');
  openModal('modal-pin');
}
async function savePinModal() {
  const err = (m) => { $('pin-setup-error').textContent = m; $('pin-setup-error').classList.remove('hidden'); };
  const mode = state.pinMode;
  if (!pinSupported()) return err("Le code PIN nécessite une connexion sécurisée (HTTPS) ou l'application Android.");
  if (mode !== 'enable') {
    const r = await verifyPin(state.pin, $('pin-current').value);
    state.pin = r.config; store.savePin(state.pin);
    if (!r.ok) return err(r.lockedMs > 0 ? `Trop d'essais. Réessayez dans ${Math.ceil(r.lockedMs / 1000)} s.` : 'Code actuel incorrect.');
  }
  if (mode === 'disable') { state.pin = null; store.savePin(null); native.nativeSetPrivacyMode(false); closeModal('modal-pin'); renderSettings(); toast('Code PIN désactivé'); return; }
  const a = $('pin-new').value, b = $('pin-confirm').value;
  if (!isValidPinFormat(a)) return err('Le code doit comporter exactement 4 chiffres.');
  if (a !== b) return err('Les deux codes ne correspondent pas.');
  state.pin = await createPinConfig(a); store.savePin(state.pin);
  native.nativeSetPrivacyMode(true);
  closeModal('modal-pin'); renderSettings(); toast('Code PIN enregistré ✓');
}

/* ================================================================ données : export / import / reset */
function exportData() {
  const json = JSON.stringify(buildExport({ items: state.items, customCategories: state.customCategories, settings: state.settings }), null, 2);
  saveFile(`echeance-sauvegarde-${state.today}.json`, 'application/json', json);
}
function saveFile(name, mime, content) {
  if (native.isNative()) { native.nativeSaveFile(name, mime, content); return; }
  downloadText(name, mime, content); toast('Fichier téléchargé ✓');
}
async function onImportFile(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) return toast('Fichier trop volumineux (5 Mo max).');
  let data;
  try { data = JSON.parse(await file.text()); } catch (e) { return toast("Ce fichier n'est pas une sauvegarde valide."); }
  const imp = sanitizeImport(data, { nowIso: nowIso() });
  if (!imp || (!imp.items.length && !imp.customCategories.length)) return toast("Aucune échéance exploitable dans ce fichier.");
  state.pendingImport = imp;
  $('import-desc').textContent = `${imp.items.length} échéance${imp.items.length > 1 ? 's' : ''} détectée${imp.items.length > 1 ? 's' : ''}` + (imp.skipped ? ` (${imp.skipped} ignorée${imp.skipped > 1 ? 's' : ''} car invalide${imp.skipped > 1 ? 's' : ''})` : '') + '. Que souhaitez-vous faire ?';
  $('btn-import-cancel').setAttribute('data-modal-cancel', '');
  openModal('modal-import');
}
function applyImport(mode) {
  const imp = state.pendingImport; if (!imp) return;
  const cur = { items: state.items, customCategories: state.customCategories };
  const next = mode === 'merge' ? mergeData(cur, imp) : { items: imp.items, customCategories: imp.customCategories };
  if (mode === 'replace') { const keep = new Set(next.items.map((i) => i.id)); markDeleted(state.items.filter((i) => !keep.has(i.id)).map((i) => i.id)); }
  state.items = next.items; state.customCategories = next.customCategories;
  if (mode === 'replace' && imp.settings) {
    state.settings = { ...imp.settings, notificationsEnabled: state.settings.notificationsEnabled, onboardingDone: true };
    persistSettings(); applyTheme();
  }
  state.pendingImport = null; closeModal('modal-import');
  persist(); $('hist-category').replaceChildren(); renderAll(); renderSettings();
  toast('Données importées ✓');
}
async function resetAll() {
  const ok = await confirmDialog({ title: 'Supprimer toutes vos données ?', desc: 'Toutes vos échéances, catégories, réglages et votre code PIN seront effacés de cet appareil. Votre licence PRO est conservée. Cette action est irréversible.', ok: 'Tout supprimer', danger: true });
  if (!ok) return;
  store.wipe();
  native.nativeSetPrivacyMode(false);
  try { await Promise.race([syncReminders([], { ...state.settings, notificationsEnabled: false }, state.today), new Promise((r) => setTimeout(r, 1500))]); } catch (e) { /* ignore */ }
  location.reload();
}

/* ================================================================ compte et sauvegarde en ligne */
const DIAG_ERR = new Set(['unknown', 'server', 'mail_failed', 'rate_limit']);
function accountFeedback(message, isError = false, showDiag = false) {
  const f = $('account-feedback');
  f.textContent = message || '';
  f.classList.toggle('account-feedback-error', !!isError);
  $('account-diag').classList.toggle('hidden', !showDiag);
}
const showFresh = (on) => $('account-fresh').classList.toggle('hidden', !on);
async function handleFresh() {
  const user = account.getUser(); if (!user) return;
  const c = await choiceDialog({ title: 'Repartir de zéro ?',
    desc: "L'ancienne sauvegarde ne peut plus être lue : elle sera définitivement effacée. Les échéances de ce téléphone seront sauvegardées à la place, avec votre mot de passe actuel. Avant cela, essayez de retrouver votre ancien mot de passe ou votre ancien téléphone : après, ce sera impossible.",
    options: [{ label: 'Oui, repartir de zéro', value: 'go', cls: 'btn btn-danger' }, { label: 'Annuler', value: null }] });
  if (!c) return;
  let res = null;
  const ok = await passwordDialog({ title: 'Confirmez avec votre mot de passe', desc: 'Écrivez votre mot de passe actuel pour confirmer.', ok: 'Repartir de zéro',
    verify: async (pw) => {
      try {
        await account.checkPassword(pw);
        const token = await account.validToken(); if (!token) return 'Reconnectez-vous puis réessayez.';
        res = await sync.startFresh({ token, user, local: localSnapshot(), password: pw });
        return null;
      } catch (e) { return account.accountMessage(e) || syncMsg(e); } } });
  if (!ok || !res) return;
  if (res.action === 'readable') { accountFeedback("Bonne nouvelle : votre sauvegarde est lisible, rien n'a été effacé. Reconnectez-vous pour la récupérer."); return; }
  showFresh(false); syncFail = null; accountFeedback('C\'est fait : vos échéances sont de nouveau sauvegardées.'); syncInfo(); toast('Sauvegarde recréée ✓');
}
function renderAccountUI() {
  const user = account.getUser();
  const nm = state.settings.profileName;
  $('account-status').textContent = user ? (nm || user.email || 'Session active') : 'Compte non connecté';
  $('account-message').textContent = user ? (nm ? (user.email || '') : '')
    : 'Facultatif. Un compte permet de retrouver vos échéances si vous changez de téléphone.';
  $('account-message').classList.toggle('hidden', !!user && !nm);
  const offline = navigator.onLine === false;
  $('account-dot').classList.toggle('hidden', !user); $('account-dot').classList.toggle('is-offline', offline);
  $('account-hero').classList.toggle('is-offline', offline);
  $('account-avatar').textContent = nm ? nm[0].toUpperCase() : user && user.email ? user.email[0].toUpperCase() : '?';
  $('account-hero').classList.toggle('is-on', !!user);
  if (user) $('notice-account').classList.add('hidden');
  if (user) syncInfo();
  $('account-form').classList.toggle('hidden', !!user);
  $('account-connected').classList.toggle('hidden', !user);
  if (user) $('account-password').value = '';
}
function accountFail(e) {
  const code = (e && e.code) || 'unknown';
  accountFeedback(account.accountMessage(e), true, DIAG_ERR.has(code));
}
async function withBusy(ids, fn) {
  ids.forEach((i) => { $(i).disabled = true; });
  try { return await fn(); } finally { ids.forEach((i) => { $(i).disabled = false; }); }
}
const ACCOUNT_BTNS = ['account-signin', 'account-signup', 'account-forgot', 'account-resend'];
function accountEmail() {
  const email = $('account-email').value.trim();
  if (!email || !email.includes('@')) { accountFeedback("Écrivez d'abord votre adresse e-mail.", true); return null; }
  return email;
}
async function handleAccountSubmit(event) {
  event.preventDefault();
  const email = accountEmail(); if (!email) return;
  const password = $('account-password').value;
  if (!password) { accountFeedback('Écrivez votre mot de passe.', true); return; }
  await withBusy(ACCOUNT_BTNS, async () => {
    accountFeedback('');
    try { await account.signIn(email, password); renderAccountUI(); await afterSignedIn(password); }
    catch (e) { accountFail(e); }
  });
}
async function handleAccountSignUp() {
  const email = accountEmail(); if (!email) return;
  const password = $('account-password').value;
  if (password.length < 8) { accountFeedback(account.ACCOUNT_ERRORS.weak_password, true); return; }
  await withBusy(ACCOUNT_BTNS, async () => {
    accountFeedback('');
    try {
      const r = await account.signUp(email, password);
      if (r.status === 'signed_in') { renderAccountUI(); await afterSignedIn(password); }
      else accountFeedback('Mail de confirmation envoyé à ' + email + '. Ouvrez-le, puis revenez vous connecter (regardez aussi les spams).');
    } catch (e) { accountFail(e); }
  });
}
async function handleAccountResend() {
  const email = accountEmail(); if (!email) return;
  await withBusy(ACCOUNT_BTNS, async () => {
    accountFeedback('');
    try { await account.resendConfirmation(email); accountFeedback('Mail renvoyé à ' + email + '. Regardez aussi les spams.'); }
    catch (e) { accountFail(e); }
  });
}
async function handleAccountForgot() {
  const email = accountEmail(); if (!email) return;
  await withBusy(ACCOUNT_BTNS, async () => {
    accountFeedback('');
    try { await account.requestPasswordReset(email); accountFeedback('Mail envoyé à ' + email + ' pour choisir un nouveau mot de passe. Pensez à vous reconnecter d\'abord sur le téléphone où vous utilisiez ÉCHÉANCE : sur un nouveau téléphone, une sauvegarde faite avec l\'ancien mot de passe ne pourra pas être relue.'); }
    catch (e) { accountFail(e); }
  });
}
async function handleAccountSignOut() {
  const button = $('account-signout');
  button.disabled = true; accountFeedback('');
  try {
    let saved = true;
    if (autoOn()) saved = await flushAutoSync(); // dernière sauvegarde avant de quitter
    else if (await hasUnsaved()) {
      const c = await choiceDialog({ title: 'Modifications non sauvegardées', desc: "La sauvegarde automatique est désactivée. Sauvegardez maintenant, sinon les modifications faites depuis votre dernière sauvegarde seront perdues.", options: [
        { label: 'Sauvegarder, puis me déconnecter', value: 'save', cls: 'btn btn-primary' }, { label: 'Me déconnecter sans sauvegarder', value: 'discard', cls: 'btn btn-danger-outline' }, { label: 'Annuler', value: null }] });
      if (!c) return;
      if (c === 'save') { saved = await autoSync('manual'); if (!saved) { accountFeedback("La sauvegarde n'a pas pu se faire. Vérifiez votre connexion internet et réessayez.", true); return; } }
      else {
        try { // retour à la dernière version sauvegardée
          const token = await account.validToken(); if (!token) throw new Error('auth');
          const d = await sync.pullLatest({ token });
          applyingSync = true; try { applySynced(d); } finally { applyingSync = false; }
        } catch (e) { accountFeedback("Impossible de revenir à la dernière sauvegarde sans internet. Rien n'a été supprimé.", true); return; }
      }
    }
    const linkedLic = (() => { const l = cloud.loadCached(); return !!(l && l.linked); })();
    const keep = await choiceDialog({ title: 'Garder vos échéances sur ce téléphone ?',
      desc: saved ? 'Elles restent sauvegardées dans votre compte.' + (linkedLic
        ? ' Si vous les gardez ici, ce téléphone garde aussi ÉCHÉANCE PRO. Si vous les effacez, votre licence PRO repart avec votre compte : elle reviendra à votre prochaine connexion.'
        : ' Vous pouvez les garder ici (sans lien avec un compte) ou les effacer de ce téléphone.') : "Attention : des modifications récentes n'ont pas pu être envoyées à votre compte. Si vous effacez ce téléphone, elles seront perdues.",
      options: [{ label: 'Oui, les garder ici', value: 'keep', cls: 'btn btn-primary' }, { label: 'Non, les effacer de ce téléphone', value: 'wipe', cls: 'btn btn-danger-outline' }, { label: 'Annuler', value: null }] });
    if (!keep) return;
    if (keep === 'wipe' && linkedLic) { // la licence du compte repart avec lui : on libère d'abord la place de ce téléphone
      const token = await account.validToken();
      if (!token || !(await cloud.releaseDevice(token))) { accountFeedback("Internet est nécessaire pour effacer ce téléphone : votre licence PRO doit d'abord être libérée. Réessayez avec internet, ou gardez vos échéances ici.", true); return; }
      cloud.clearCached();
    }
    await account.signOut();
    sync.forgetLocalKeys(); // sur un téléphone déconnecté, aucune clé ne reste
    setOwner(null);
    if (keep === 'wipe') { clearLocalData(); await refreshLicense(); renderPro(); }
    renderAccountUI();
    if (keep === 'wipe') await askAccountChoice();
  } finally { button.disabled = false; }
}
/** Demande un mot de passe ; `verify(mdp)` renvoie un message d'erreur (la fenêtre reste ouverte) ou null (accepté). → true / false (annulé). */
/* ---------------------------------------------------------------- calculatrice */
let calcState = calcNew(), calcTarget = null;
function calcRender() {
  $('calc-disp').textContent = calcState.cur; $('calc-hist').textContent = calcText(calcState) || '\u00a0';
}
function calcKey(k) { calcState = calcPress(calcState, k); calcRender(); }
function openCalc(input) {
  calcTarget = input;
  const start = parseAmount(input.value);
  calcState = calcNew(); if (start && !Number.isNaN(start)) calcState = { ...calcState, cur: String(start).replace('.', ','), fresh: true };
  const rate = state.plan.isPro ? state.settings.usdRate : null;
  $('calc-conv').classList.toggle('hidden', !rate);
  calcRender(); openModal('modal-calc');
}
function wireCalc() {
  $('calc-grid').addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) calcKey(b.dataset.k); });
  $('calc-to-cdf').addEventListener('click', () => { calcState = calcConvert(calcState, state.settings.usdRate, 'toCDF'); calcRender(); });
  $('calc-to-usd').addEventListener('click', () => { calcState = calcConvert(calcState, state.settings.usdRate, 'toUSD'); calcRender(); });
  $('calc-use').addEventListener('click', () => {
    const v = calcValue(calcState);
    if (v === null || v < 0) return toast('Résultat invalide');
    if (calcTarget) { calcTarget.value = String(v).replace('.', ','); calcTarget.dispatchEvent(new Event('input', { bubbles: true })); }
    closeModal('modal-calc'); if (calcTarget) calcTarget.focus();
  });
  document.addEventListener('keydown', (e) => {
    if ($('modal-calc').classList.contains('hidden') || e.ctrlKey || e.metaKey || e.altKey) return;
    const map = { Enter: '=', '=': '=', Backspace: 'DEL', Delete: 'C', '.': ',', ',': ',', '+': '+', '-': '-', '*': '*', '/': '/', x: '*' };
    const k = /^[0-9]$/.test(e.key) ? e.key : map[e.key];
    if (k) { e.preventDefault(); calcKey(k); }
  });
  const icon = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="2.5" width="14" height="19" rx="2.5"/><rect x="8" y="5.5" width="8" height="3.5" rx=".8"/><path d="M8.5 13h.01M12 13h.01M15.5 13h.01M8.5 16.5h.01M12 16.5h.01M15.5 16.5h.01"/></svg>';
  for (const id of ['f-amount', 'amount-input', 'budget-amount']) {
    const input = $(id); if (!input) continue;
    const b = el('button', 'calc-btn', null, { type: 'button', 'aria-label': 'Ouvrir la calculatrice', 'data-calc-for': id });
    b.innerHTML = icon; b.addEventListener('click', () => openCalc(input));
    if (id === 'amount-input') { const row = el('div', 'calc-row'); input.replaceWith(row); row.append(input, b); } else input.insertAdjacentElement('afterend', b);
  }
}
function amountDialog({ title, desc, max, cur }) {
  return new Promise((resolve) => {
    $('amount-title').textContent = title; $('amount-desc').textContent = desc;
    const input = $('amount-input'), err = $('amount-error'), ok = $('amount-ok'), all = $('amount-all'), ca = $('amount-cancel');
    input.value = ''; err.textContent = '';
    const done = (v) => { ok.onclick = all.onclick = ca.onclick = input.onkeydown = null; closeModal('modal-amount'); resolve(v); };
    const go = () => { const n = parseAmount(input.value); if (!n || Number.isNaN(n) || n <= 0) { err.textContent = 'Écrivez un montant (ex : 25).'; return; } done(Math.min(n, max)); };
    ok.onclick = go; all.onclick = () => done(max); ca.onclick = () => done(null);
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
    openModal('modal-amount'); setTimeout(() => input.focus(), 50);
  });
}
function passwordDialog({ title, desc, ok, verify }) {
  return new Promise((resolve) => {
    $('pass-title').textContent = title; $('pass-desc').textContent = desc; $('pass-ok').textContent = ok;
    const input = $('pass-input'), err = $('pass-error'), okB = $('pass-ok'), caB = $('pass-cancel');
    input.value = ''; err.textContent = '';
    const done = (v) => { okB.onclick = null; caB.onclick = null; input.onkeydown = null; input.value = ''; closeModal('modal-pass'); resolve(v); };
    const go = async () => {
      if (!input.value) { err.textContent = 'Écrivez votre mot de passe.'; return; }
      okB.disabled = true; err.textContent = '';
      try { const msg = await verify(input.value); if (msg) err.textContent = msg; else done(true); } finally { okB.disabled = false; }
    };
    okB.onclick = go; caB.onclick = () => done(false); input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } };
    openModal('modal-pass');
  });
}
const fmtDay = (iso) => { try { return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return ''; } };

async function handleAccountDelete() {
  const button = $('account-delete'); button.disabled = true; accountFeedback('');
  try {
    const c = await choiceDialog({ title: 'Supprimer votre compte ?',
      desc: "Votre compte et votre sauvegarde en ligne seront supprimés dans 14 jours. Pendant ce délai, il suffit de vous reconnecter pour annuler. Passé ce délai, plus personne ne pourra les récupérer. Vos éventuels achats PRO sont conservés. Que faire des échéances présentes sur ce téléphone ?",
      options: [{ label: 'Supprimer le compte, garder mes échéances ici', value: 'keep', cls: 'btn btn-danger' }, { label: 'Supprimer le compte et effacer ce téléphone', value: 'wipe', cls: 'btn btn-danger-outline' }, { label: 'Annuler', value: null }] });
    if (!c) return;
    clearTimeout(autoTimer); if (autoBusy && autoPromise) await autoPromise;
    await flushAutoSync(); // dernière sauvegarde : rien n'est perdu si vous changez d'avis dans les 14 jours
    let due = null;
    const ok = await passwordDialog({ title: 'Confirmez avec votre mot de passe', desc: 'Pour votre sécurité, écrivez votre mot de passe afin de programmer la suppression du compte.', ok: 'Programmer la suppression',
      verify: async (pw) => { try { due = await account.requestDeletion(pw); return null; } catch (e) { return account.accountMessage(e); } } });
    if (!ok || !due) return;
    sync.forgetLocalKeys(); setOwner(null); syncFail = null;
    if (c === 'wipe') clearLocalData();
    renderAccountUI();
    accountFeedback('Suppression programmée le ' + fmtDay(due) + '. Reconnectez-vous avant cette date pour l\'annuler.' + (c === 'wipe' ? ' Les échéances de ce téléphone ont été effacées.' : ' Vos échéances restent sur ce téléphone.'));
  } finally { button.disabled = false; }
}
/** Après une connexion : si la suppression du compte est programmée, on propose de l'annuler. → true = continuer, false = déconnecté. */
async function checkPendingDeletion() {
  let due = null;
  try { due = await account.getDeletion(); } catch (e) { return true; } // service injoignable : on ne bloque pas
  if (!due) return true;
  const c = await choiceDialog({ title: 'Suppression du compte programmée', desc: 'Ce compte sera supprimé le ' + fmtDay(due) + ', avec sa sauvegarde en ligne. Voulez-vous annuler la suppression et garder votre compte ?',
    options: [{ label: 'Annuler la suppression, garder mon compte', value: 'cancel', cls: 'btn btn-primary' }, { label: 'Laisser la suppression suivre son cours', value: null }] });
  if (c === 'cancel') { try { await account.cancelDeletion(); toast('Suppression annulée ✓'); return true; } catch (e) { accountFail(e); } }
  await account.signOut(); sync.forgetLocalKeys(); renderAccountUI();
  accountFeedback('Suppression maintenue : ce compte sera supprimé le ' + fmtDay(due) + '.
