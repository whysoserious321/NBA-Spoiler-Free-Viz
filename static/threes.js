/* Spoiler-free 3-point page. It only ever loads /api/threes, which holds
   rosters with 3PM/3PA and team 3P% - no scores, records, ratings or odds -
   so it is safe to open while watching a game. */
(function () {
  'use strict';

  var main = document.getElementById('main');
  var meta = document.getElementById('meta');
  var pill = document.getElementById('demo-pill');
  var D = null, sel = [], demo = false;

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) {
      try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ }
    },
  };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function isDark() { return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches; }
  function logo(abbr, cls) {
    return '<img class="' + (cls || 'logo') + '" src="/img/logos/' + abbr + (isDark() ? '-dark' : '') +
      '.png" alt="" width="30" height="30" loading="lazy" onerror="this.style.visibility=\'hidden\'">';
  }
  function relTime(iso) {
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 60) return mins < 1 ? 'just now' : mins + ' min ago';
    var h = Math.round(mins / 60);
    return h < 24 ? h + ' h ago' : Math.round(h / 24) + ' d ago';
  }
  function team(abbr) { return D.teams.filter(function (t) { return t.abbr === abbr; })[0]; }

  // demo flag is shared with the dashboard (same browser storage key)
  (function () {
    var q = new URLSearchParams(location.search);
    if (q.get('demo') === '1') store.set('nbaviz-demo', '1');
    if (q.get('live') === '1') store.set('nbaviz-demo', null);
    if (q.has('demo') || q.has('live')) {
      try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* ignore */ }
    }
    demo = store.get('nbaviz-demo') === '1';
  })();

  function readSel() {
    var h = location.hash.replace(/^#/, '').toUpperCase();
    var list = (h || store.get('nbaviz-3p') || '').split('-').filter(Boolean);
    sel = list.filter(function (a) { return team(a); }).slice(0, 2);
  }
  function writeSel() {
    store.set('nbaviz-3p', sel.join('-') || null);
    try { history.replaceState(null, '', location.pathname + (sel.length ? '#' + sel.join('-') : '')); } catch (e) { /* ignore */ }
  }

  function load() {
    fetch('/api/threes' + (demo ? '?demo=1' : ''), { cache: 'no-cache' })
      .then(function (r) {
        return r.json().catch(function () { throw new Error('The server answered with HTTP ' + r.status + '. Is NBAViz running?'); })
          .then(function (j) {
            if (!r.ok) { var err = new Error(j.error || 'HTTP ' + r.status); err.status = r.status; throw err; }
            return j;
          });
      })
      .then(function (d) { D = d; readSel(); render(); })
      .catch(function (e) {
        var retry = e.status === 503;
        main.innerHTML = '<div class="error"><p><b>Couldn’t load the data.</b></p><p>' + esc(e.message) + '</p>' +
          (retry ? '<p>Checking again every 15 seconds…</p>' : '') + '</div>';
        if (retry) setTimeout(load, 15000);
      });
  }

  function render(scrollTo) {
    pill.hidden = !demo;
    meta.textContent = (D.season || '') + ' · ' + (demo ? 'made-up numbers' : 'season to date, updated ' + relTime(D.generated));
    var html = '<section class="card"><div class="card-h"><p class="kicker">Spoiler-free</p><h2>Pick one or two teams</h2>' +
      '<p>Only 3-point shooting lives on this page: no scores, records, ratings or odds.</p></div>';
    if (D.games && D.games.length) {
      var label = D.games_date ? new Date(D.games_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : 'Today';
      html += '<p class="kicker" style="margin-top:2px">Games ' + esc(label) + ' (US date)</p><div class="chips game-chips">' +
        D.games.map(function (g) {
          var on = sel.length === 2 && sel.indexOf(g.away) >= 0 && sel.indexOf(g.home) >= 0;
          return '<button type="button" class="chip" data-game="' + g.away + '-' + g.home + '" aria-pressed="' + on + '">' +
            g.away + ' @ ' + g.home + '</button>';
        }).join('') + '</div>';
    }
    html += '<div class="tpick-grid">' + D.teams.map(function (t) {
      return '<button type="button" class="tpick" data-abbr="' + t.abbr + '" aria-pressed="' + (sel.indexOf(t.abbr) >= 0) +
        '" aria-label="' + esc(t.name) + '">' + logo(t.abbr) + '<span>' + t.abbr + '</span></button>';
    }).join('') + '</div></section>';

    if (!sel.length) {
      html += '<section class="card empty"><p>Tap a logo, or a game above, to see every player’s 3P%.</p></section>';
    }
    sel.forEach(function (abbr) {
      var t = team(abbr);
      html += '<section class="card tp-card" id="tp-' + abbr + '"><div class="sh-top" style="margin:0 0 10px">' + logo(abbr) +
        '<div><h3>' + esc(t.name) + '</h3><p>Season 3-point shooting, sorted by attempts</p></div></div>' +
        window.tpChart(t, t.players, D.league_tp, { heading: false }) + '</section>';
    });
    html += '<p class="credit">Season totals through the last update (daily, 08:00). Data: ESPN.<br>' +
      (demo ? 'Demo data: every number and player here is made up. <button type="button" data-act="live">Show live data</button>'
        : '<a href="/" class="inline-link">Full dashboard ↗</a> (has results, ratings and odds) · <button type="button" data-act="demo">Demo</button>') +
      '</p>';
    main.innerHTML = '<div class="view">' + html + '</div>';
    if (scrollTo) {
      var el = document.getElementById('tp-' + scrollTo);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  main.addEventListener('click', function (e) {
    var pick = e.target.closest('.tpick'), game = e.target.closest('[data-game]'), act = e.target.closest('[data-act]');
    if (pick) {
      var a = pick.getAttribute('data-abbr'), i = sel.indexOf(a);
      if (i >= 0) sel.splice(i, 1);
      else { sel.push(a); if (sel.length > 2) sel.shift(); }
      writeSel();
      render(i >= 0 ? null : a);
    } else if (game) {
      sel = game.getAttribute('data-game').split('-');
      writeSel();
      render(sel[0]);
    } else if (act) {
      if (act.getAttribute('data-act') === 'demo') { store.set('nbaviz-demo', '1'); demo = true; load(); }
      else pill.click();
    }
  });
  pill.addEventListener('click', function () {
    if (confirm('Switch to live data?\n\nThis page only shows 3-point numbers, but they include games up to the last update.')) {
      store.set('nbaviz-demo', null);
      demo = false;
      load();
    }
  });
  window.addEventListener('hashchange', function () { if (D) { readSel(); render(); } });
  if (window.matchMedia) {
    var mq = matchMedia('(prefers-color-scheme: dark)');
    var re = function () { if (D) render(); };
    if (mq.addEventListener) mq.addEventListener('change', re); else if (mq.addListener) mq.addListener(re);
  }
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () { /* optional */ }); });
  }
  load();
})();
