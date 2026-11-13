/* Page de téléchargement : lit la dernière version et les annonces publiées depuis l'administration
 * (serveur), sinon updates.json du même site. Échec silencieux. Aucune donnée personnelle envoyée. */
(function () {
  var EN = document.documentElement.lang === 'en';
  var SB = 'https://oydwnxpejqwdngkylgwc.supabase.co/rest/v1/rpc/app_updates', KEY = 'sb_publishable_u6bfuVBc5gkXHJ0XUTkqYQ_kB6DzzIH';
  var box = document.getElementById('news'), ver = document.getElementById('dl-ver'), btn = document.getElementById('dl-btn');
  function safeUrl(u) { return typeof u === 'string' && /^https:\/\//.test(u) ? u : ''; }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; }
  function pick(o, k) { return (EN && typeof o[k + '_en'] === 'string' && o[k + '_en']) ? o[k + '_en'] : o[k]; }
  function load() {
    return fetch(SB, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: '{}', cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .catch(function () { return fetch('updates.json', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw 0; return r.json(); }); });
  }
  load().then(function (j) {
    if (!j || typeof j !== 'object') throw 0;
    var hasVer = typeof j.version === 'string' && /^\d+(\.\d+){1,3}$/.test(j.version);
    if (hasVer) ver.textContent = ver.getAttribute('data-pre') + j.version + ver.getAttribute('data-suf');
    var dl = safeUrl(j.apk); if (dl && btn) btn.setAttribute('href', dl);
    box.textContent = '';
    var notes = pick(j, 'notes');
    if (hasVer && typeof notes === 'string' && notes) { var v = el('div', 'news-item'); v.appendChild(el('strong', '', (EN ? 'Version ' : 'Version ') + j.version)); v.appendChild(el('span', '', notes.slice(0, 400))); box.appendChild(v); }
    (Array.isArray(j.announcements) ? j.announcements.slice(0, 6) : []).forEach(function (a) {
      var title = a && pick(a, 'title'); if (typeof title !== 'string' || !title) return;
      var d = el('div', 'news-item'); d.appendChild(el('strong', '', title.slice(0, 120)));
      var body = pick(a, 'body'); if (typeof body === 'string' && body) d.appendChild(el('span', '', body.slice(0, 400)));
      var u = safeUrl(a.url); if (u) { var act = pick(a, 'action'); var l = el('a', '', ' ' + (typeof act === 'string' && act ? act.slice(0, 30) : (EN ? 'Learn more' : 'En savoir plus'))); l.href = u; l.rel = 'noopener'; d.appendChild(l); }
      box.appendChild(d);
    });
    if (!box.firstChild) box.appendChild(el('p', 'note', EN ? 'Nothing new for now.' : 'Aucune nouveauté pour le moment.'));
  }).catch(function () { if (box) { box.textContent = ''; box.appendChild(el('p', 'note', EN ? 'News unavailable right now.' : 'Nouveautés indisponibles pour le moment.')); } });
})();
