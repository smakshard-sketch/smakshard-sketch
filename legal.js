/* Pages légales : la flèche « ← ÉCHÉANCE » revient à la page précédente.
 * Dans l'application (hôte interne) elle ouvre l'accueil ; sur le site public elle ne mène jamais à l'espace d'administration. */
(function () {
  var a = document.querySelector('.legal-brand a'); if (!a) return;
  var inApp = /appassets\.androidplatform\.net$|^localhost$|^127\.0\.0\.1$/.test(location.hostname) || location.protocol === 'file:';
  if (inApp) return; // le lien normal (index.html) ouvre l'application
  if (history.length < 2) { a.hidden = true; return; }
  a.textContent = '← Retour';
  a.setAttribute('href', '#');
  a.addEventListener('click', function (e) {
    e.preventDefault();
    history.back();
  });
})();
