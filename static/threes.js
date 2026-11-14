/* Spoiler-free 3-point page. It only ever loads /api/threes, which holds
   rosters with 3PM/3PA and team 3P%, and /api/shots, a tapped player's hot
   zones - no scores, records, ratings or odds - so it is safe to open while
   watching a game. */
(function () {
  'use strict';

  var main = document.getElementById('main');
  var pill = document.getElementById('mode-pill');
  var sheet = document.getElementById('sheet');
  var sheetBody = document.getElementById('sheet-body');
  var backdrop = document.getElementById('sheet-backdrop');
  var D = null, sel = [], choice = null;

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

  /* The 3P% range the charts draw: the league average ± ZOOM points (about 29-43%),
     where nearly every career mark and the bulk of season numbers sit. Further out
     is drawn as an arrow at the edge. One range for every team, so charts compare. */
  var ZOOM = 7;
  function domain() {
    var lg = D.league_tp;
    if (lg == null) {                                 // no league figure: centre on the players' median
      var vals = [];
      D.teams.forEach(function (t) { t.players.forEach(function (p) { if (p.tpa >= 10) vals.push(100 * p.tpm / p.tpa); }); });
      if (!vals.length) return null;                  // nothing yet: the chart's own 0-70 range
      vals.sort(function (x, y) { return x - y; });
      lg = vals[Math.floor(vals.length / 2)];
    }
    var lo = Math.round(lg - ZOOM);
    return [lo, lo + 2 * ZOOM];
  }

  // Live, up to a saved date, or demo: chosen on the start screen (shared with the dashboard).
  function start(c) {
    closeSheet();
    choice = c;
    // Bottom bar: dashboard tabs open with the same data choice, like the "Full dashboard" link.
    Array.prototype.forEach.call(document.querySelectorAll('.tabbar a'), function (a) {
      var tab = a.getAttribute('data-tab');
      a.setAttribute('href', (tab ? '/' : '/threes') + NBAGate.linkQuery(c) + (tab ? '#' + tab : ''));
    });
    main.innerHTML = '<div class="skeleton" aria-hidden="true"><div></div><div></div></div>';
    load();
  }
  function changeData() { NBAGate.ask(start, { cancelable: true }); }

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
    fetch('/api/threes' + NBAGate.query(choice), { cache: 'no-cache' })
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
    var p = NBAGate.pill(choice, D.generated);
    pill.textContent = p.text;
    pill.className = 'mode-pill ' + p.cls;
    pill.hidden = false;
    var html = '<section class="card"><div class="card-h"><h2>Pick one or two teams</h2></div>';
    if (D.games && D.games.length) {
      var label = !D.games_date ? 'Games'
        : (choice.mode === 'date' ? 'Next games, ' : 'Games today, ') + NBAGate.day(D.games_date, true) + ' (US date)';
      html += '<p class="kicker" style="margin-top:2px">' + esc(label) + '</p><div class="chips game-chips">' +
        D.games.map(function (g) {
          var on = sel.length === 2 && sel.indexOf(g.away) >= 0 && sel.indexOf(g.home) >= 0;
          return '<button type="button" class="chip" data-game="' + g.away + '-' + g.home + '" aria-pressed="' + on + '">' +
            g.away + ' @ ' + g.home + '</button>';
        }).join('') + '</div>';
    }
    html += '<div class="tpick-grid">' + D.teams.map(function (t) {
      return '<button type="button" class="tpick" data-abbr="' + t.abbr + '" aria-pressed="' + (sel.indexOf(t.abbr) >= 0) +
        '" aria-label="' + esc(t.name) + '">' + logo(t.abbr) + '<span>' + t.abbr + '</span></button>';
    }).join('') + '</div>' +
      '<details class="help"><summary><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/>' +
      '<path d="M8 7.2v4M8 4.6v.1"/></svg>How to read this</summary><div class="help-body"><p class="foot">' +
      'Spoiler-free: only 3-point shooting lives on this page, with no scores, records, ratings or odds. ' +
      'Tap a game or up to two logos to compare their players, and a player for their hot zones.</p></div></details></section>';

    if (!sel.length) {
      html += '<section class="card empty"><p>Tap a logo, or a game above, to see every player’s 3P%.</p></section>';
    }
    var dom = domain();
    sel.forEach(function (abbr) {
      var t = team(abbr);
      html += '<section class="card tp-card" id="tp-' + abbr + '"><div class="sh-top" style="margin:0 0 10px">' + logo(abbr) +
        '<div><h3>' + esc(t.name) + '</h3></div></div>' +
        window.tpChart(t, t.players, D.league_tp, { heading: false, sort: 'pct', domain: dom, interactive: true }) + '</section>';
    });
    html += '<p class="credit">' + (choice.mode === 'demo' ? 'Demo data: every number and player here is made up.'
      : choice.mode === 'date' ? 'Season totals as of the refresh on ' + (NBAGate.stamp(D.generated) ? NBAGate.stamp(D.generated) + ' (' + NBAGate.zone() + '), ' : '') +
          'games through ' + NBAGate.day(choice.date, true) + ' (US date) only. Data: ESPN.'
        : esc(D.season || '') + ' season totals, updated ' + (NBAGate.stamp(D.generated) ? NBAGate.stamp(D.generated) + ' (' + relTime(D.generated) + ')' : relTime(D.generated)) +
          ', refreshed daily. Data: ESPN.') +
      ' <button type="button" data-act="gate">Change</button><br>' +
      '<a href="/' + NBAGate.linkQuery(choice) + '" class="inline-link">Full dashboard ↗</a> (results, ratings and odds' +
      (choice.mode === 'date' ? ', also only up to that date)' : ')') + '</p>';
    main.innerHTML = '<div class="view">' + html + '</div>';
    if (scrollTo) {
      var el = document.getElementById('tp-' + scrollTo);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  /* ------------------------------------------------- hot zones in a sheet */
  // Same look and gestures as the dashboard's sheet (app.js): backdrop, close button,
  // Escape, drag the grip down, and the browser's back button closes it.

  var sheetOpen = false, lastFocus = null, backPending = false, backTimer = null, afterBack = null;
  var hz = { pid: null, data: null, sel: null, seq: 0, view: store.get('nbaviz-hz-view') === 'career' ? 'career' : 'season' };
  var shotCache = {};

  function openSheet(html) {
    sheetBody.innerHTML = html;
    sheetBody.scrollTop = 0;
    if (!sheetOpen) {
      sheetOpen = true;
      lastFocus = document.activeElement;
      sheet.hidden = false;
      backdrop.hidden = false;
      document.body.classList.add('sheet-open');
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { sheet.classList.add('on'); backdrop.classList.add('on'); });
      });
      try { history.pushState({ sheet: 1 }, ''); } catch (e) { /* ignore */ }
    }
    sheet.querySelector('.sheet-close').focus({ preventScroll: true });
  }
  function closeSheet(fromPop) {
    if (!sheetOpen) return;
    sheetOpen = false;
    hz.seq++;                                         // drop an answer still on its way
    sheet.classList.remove('on');
    backdrop.classList.remove('on');
    sheet.style.transform = '';
    document.body.classList.remove('sheet-open');
    setTimeout(function () { if (!sheetOpen) { sheet.hidden = true; backdrop.hidden = true; } }, 330);
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
    if (!fromPop && history.state && history.state.sheet) {
      // history.back() lands later; a player tapped meanwhile opens once it has
      backPending = true;
      clearTimeout(backTimer);
      backTimer = setTimeout(finishBack, 3000);
      history.back();
    }
  }
  function finishBack() {
    backPending = false;
    clearTimeout(backTimer);
    var f = afterBack;
    afterBack = null;
    if (f) f();
  }
  window.addEventListener('popstate', function () {
    if (backPending) finishBack();
    else if (sheetOpen) closeSheet(true);
  });
  backdrop.addEventListener('click', function () { closeSheet(); });
  sheet.querySelector('.sheet-close').addEventListener('click', function () { closeSheet(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !document.querySelector('.gate')) closeSheet(); });
  (function () {
    var grip = sheet.querySelector('.sheet-grip'), y0 = null, dy = 0;
    grip.addEventListener('pointerdown', function (e) {
      y0 = e.clientY; dy = 0; sheet.classList.add('dragging');
      try { grip.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    grip.addEventListener('pointermove', function (e) {
      if (y0 == null) return;
      dy = Math.max(0, e.clientY - y0);
      sheet.style.transform = 'translateY(' + dy + 'px)';
    });
    function end() {
      if (y0 == null) return;
      y0 = null; sheet.classList.remove('dragging');
      if (dy > 90) closeSheet(); else sheet.style.transform = '';
    }
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
  })();

  function findPlayer(pid) {
    for (var i = 0; i < D.teams.length; i++) {
      for (var j = 0; j < D.teams[i].players.length; j++) {
        if (D.teams[i].players[j].id === pid) return { p: D.teams[i].players[j], t: D.teams[i] };
      }
    }
    return null;
  }

  function openPlayer(pid) {
    if (backPending) { afterBack = function () { openPlayer(pid); }; return; }
    var hit = findPlayer(pid);
    if (!hit) return;
    hz.pid = pid;
    hz.sel = null;
    hz.data = null;
    var seq = ++hz.seq;
    openSheet('<div class="sh-top">' + logo(hit.t.abbr) + '<div><p class="kicker">Hot zones</p><h3 id="sheet-title">' +
      esc(hit.p.name) + '</h3><p>' + esc(hit.t.name) + (hit.p.pos ? ' · ' + esc(hit.p.pos) : '') + '</p></div></div>' +
      '<div class="hz" id="hz"><div class="skeleton" aria-hidden="true"><div></div></div></div>');
    var q = NBAGate.query(choice), key = pid + q;
    var got = shotCache[key] ? Promise.resolve(shotCache[key]) :
      fetch('/api/shots' + (q ? q + '&' : '?') + 'player=' + encodeURIComponent(pid), { cache: 'no-cache' })
        .then(function (r) {
          return r.json().catch(function () { throw new Error('The server answered with HTTP ' + r.status + '.'); })
            .then(function (j) { if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j; });
        });
    got.then(function (d) {
      shotCache[key] = d;
      if (seq !== hz.seq || !sheetOpen) return;
      hz.data = d;
      drawHz();
    }).catch(function (e) {
      if (seq !== hz.seq || !sheetOpen) return;
      document.getElementById('hz').innerHTML = '<div class="error"><p><b>Couldn’t load the hot zones.</b></p><p>' + esc(e.message) + '</p></div>';
    });
  }

  function drawHz(focus) {
    var box = document.getElementById('hz');
    if (!box || !hz.data) return;
    box.innerHTML = window.hotspot.render(hz.data, hz);
    var el = focus && box.querySelector(focus);
    if (el) el.focus({ preventScroll: true });
  }

  function hzAct(t) {
    var view = t.closest('[data-hz-view]'), zone = t.closest('[data-zone]');
    if (view) {
      hz.view = view.getAttribute('data-hz-view');
      store.set('nbaviz-hz-view', hz.view);
      drawHz('[data-hz-view="' + hz.view + '"]');
    } else if (zone) {
      var z = +zone.getAttribute('data-zone');
      hz.sel = hz.sel === z ? null : z;
      drawHz('[data-zone="' + z + '"]');
    }
  }
  sheetBody.addEventListener('click', function (e) { hzAct(e.target); });
  sheetBody.addEventListener('keydown', function (e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[data-zone]')) {
      e.preventDefault();
      hzAct(e.target);
    }
  });

  main.addEventListener('click', function (e) {
    var pick = e.target.closest('.tpick'), game = e.target.closest('[data-game]'), act = e.target.closest('[data-act]');
    var player = e.target.closest('[data-player]');
    if (player) {
      openPlayer(player.getAttribute('data-player'));
    } else if (pick) {
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
      changeData();
    }
  });
  pill.addEventListener('click', changeData);
  window.addEventListener('hashchange', function () { if (D) { readSel(); render(); } });
  if (window.matchMedia) {
    var mq = matchMedia('(prefers-color-scheme: dark)');
    var re = function () { if (D) render(); };
    if (mq.addEventListener) mq.addEventListener('change', re); else if (mq.addListener) mq.addListener(re);
  }
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () { /* optional */ }); });
  }
  var fromUrl = NBAGate.fromUrl();
  if (fromUrl) start(fromUrl); else NBAGate.ask(start);
})();
