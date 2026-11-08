/* NBAViz front end - vanilla JS, hand-written SVG, no build step. */
(function () {
  'use strict';

  var TABS = ['ratings', 'leaders', 'mvp', 'title'];
  var SERIES = ['--s1', '--s2', '--s3', '--s4', '--s5'];
  var S = {
    data: null, teams: {}, players: {}, ranks: {},
    demo: false, tab: 'ratings',
    view: null, mode: 'adj', conf: 'all', stat: 0,
    range: { mvp: 'all', title: '1m' },
    sel: null, width: window.innerWidth,
  };

  var main = document.getElementById('main');
  var tip = document.getElementById('tip');
  var sheet = document.getElementById('sheet');
  var sheetBody = document.getElementById('sheet-body');
  var backdrop = document.getElementById('sheet-backdrop');
  var meta = document.getElementById('meta');
  var demoPill = document.getElementById('demo-pill');

  /* ------------------------------------------------------------ helpers */

  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) {
      try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ }
    },
  };
  function $(sel, el) { return (el || document).querySelector(sel); }
  function $$(sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function isDark() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t) return t === 'dark';
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function sign(v, d) {
    d = d == null ? 1 : d;
    var s = Math.abs(v).toFixed(d);
    if (Number(s) === 0) return s;
    return (v > 0 ? '+' : '−') + s;
  }
  function num(v, d) { return v == null ? '–' : (v < 0 ? '−' : '') + Math.abs(v).toFixed(d == null ? 1 : d); }
  function pct(p, d) {
    if (p == null) return '–';
    var x = p * 100;
    if (x > 0 && x < 0.1) return '<0.1%';
    return x.toFixed(d == null ? 1 : d) + '%';
  }
  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function initials(name) {
    var w = String(name || '?').replace(/[^A-Za-z\s-]/g, '').split(/[\s-]+/).filter(Boolean);
    return ((w[0] || '?')[0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
  }
  function dateShort(d) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function relTime(iso) {
    var mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var h = Math.round(mins / 60);
    if (h < 24) return h + ' h ago';
    return Math.round(h / 24) + ' d ago';
  }
  function niceStep(span, target) {
    var raw = span / target, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  }
  function ticks(lo, hi, target) {
    var step = niceStep(hi - lo, target || 4), out = [];
    for (var v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }
  function logoSrc(abbr) { return '/img/logos/' + abbr + (isDark() ? '-dark' : '') + '.png'; }
  function logo(abbr, cls, label) {
    return '<img class="' + (cls || 'logo') + '" src="' + logoSrc(abbr) + '" alt="' + esc(label || '') +
      '" width="24" height="24" loading="lazy" onerror="this.style.visibility=\'hidden\'">';
  }
  function headHTML(name, src, team, size) {
    var st = size ? ' style="width:' + size + 'px;height:' + size + 'px"' : '';
    return '<span class="hw"><span class="head"' + st + '><b class="ini">' + esc(initials(name)) + '</b>' +
      (src ? '<img src="' + src + '" alt="" loading="lazy" onerror="this.remove()">' : '') + '</span>' +
      (team ? logo(team, 'tm') : '') + '</span>';
  }
  function playerHead(id, size) {
    var p = S.players[id];
    if (!p) return headHTML('?', null, null, size);
    return headHTML(p.name, p.head ? '/img/heads/' + id + '.png' : null, p.team, size);
  }
  function segBtns(ctl, opts, cur) {
    return '<div class="seg" role="group" data-ctl="' + ctl + '">' + opts.map(function (o) {
      return '<button type="button" data-val="' + o[0] + '" aria-pressed="' + (o[0] === cur) + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }
  function svgEl(w, h, label, cls) {
    return '<svg class="chart ' + (cls || '') + '" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h +
      '" role="img" aria-label="' + esc(label) + '">';
  }
  function avail(el) { return Math.max(260, Math.floor(el.getBoundingClientRect().width)); }

  /* ------------------------------------------------------------- tooltip */

  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    var r = tip.getBoundingClientRect();
    var left = clamp(x - r.width / 2, 8, window.innerWidth - r.width - 8);
    var top = y - r.height - 14;
    if (top < 8) top = y + 18;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }
  function hideTip() { tip.hidden = true; }
  window.addEventListener('scroll', hideTip, { passive: true });

  /* --------------------------------------------------------------- sheet */

  var sheetOpen = false, lastFocus = null;
  function openSheet(html) {
    hideTip();
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
    $('.sheet-close', sheet).focus({ preventScroll: true });
  }
  function closeSheet(fromPop) {
    if (!sheetOpen) return;
    sheetOpen = false;
    sheet.classList.remove('on');
    backdrop.classList.remove('on');
    sheet.style.transform = '';
    document.body.classList.remove('sheet-open');
    setTimeout(function () { if (!sheetOpen) { sheet.hidden = true; backdrop.hidden = true; } }, 330);
    setSelection(null);
    if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
    if (!fromPop && history.state && history.state.sheet) history.back();
  }
  window.addEventListener('popstate', function () { if (sheetOpen) closeSheet(true); });
  backdrop.addEventListener('click', function () { closeSheet(); });
  $('.sheet-close', sheet).addEventListener('click', function () { closeSheet(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
  sheetBody.addEventListener('click', function (e) {
    var t = e.target.closest('[data-team]'), p = e.target.closest('[data-player]');
    if (p) openPlayer(p.getAttribute('data-player'));
    else if (t) openTeam(t.getAttribute('data-team'));
  });

  // Drag the grip down to dismiss.
  (function () {
    var grip = $('.sheet-grip', sheet), y0 = null, dy = 0;
    grip.addEventListener('pointerdown', function (e) {
      y0 = e.clientY; dy = 0; sheet.classList.add('dragging'); grip.setPointerCapture(e.pointerId);
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

  /* ---------------------------------------------------------- data + nav */

  (function initDemo() {
    var q = new URLSearchParams(location.search);
    if (q.get('demo') === '1') store.set('nbaviz-demo', '1');
    if (q.get('live') === '1') store.set('nbaviz-demo', null);
    if (q.has('demo') || q.has('live')) {
      try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* ignore */ }
    }
    S.demo = store.get('nbaviz-demo') === '1';
    var v = store.get('nbaviz-view');
    if (v === 'ladder' || v === 'diamond') S.view = v;
  })();

  function load() {
    fetch('/api/dashboard' + (S.demo ? '?demo=1' : ''), { cache: 'no-cache' })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); })
      .then(function (d) {
        S.data = d;
        S.teams = {};
        d.teams.forEach(function (t) { S.teams[t.abbr] = t; });
        S.players = d.players || {};
        S.ranks = {};
        d.leaders.stats.forEach(function (s) {
          var m = {};
          s.rows.forEach(function (r, i) { m[r[0]] = i + 1; });
          S.ranks[s.key] = m;
        });
        renderHeader();
        route(true);
      })
      .catch(function (e) {
        main.innerHTML = '<div class="error"><p><b>Couldn’t load the data.</b></p><p>' + esc(e.message) +
          '</p><p><button class="chip" onclick="location.reload()">Try again</button></p></div>';
      });
  }

  function renderHeader() {
    var d = S.data;
    demoPill.hidden = !S.demo;
    if (S.demo) {
      meta.textContent = d.season + ' · made-up numbers';
    } else {
      var through = d.through ? 'through ' + dateShort(new Date(d.through + 'T12:00:00')) : '';
      meta.textContent = [d.season, through, 'updated ' + relTime(d.generated)].filter(Boolean).join(' · ');
    }
  }
  demoPill.addEventListener('click', function () {
    if (confirm('Switch to live data?\n\nIt shows the latest results, including games you may not have watched yet.')) {
      store.set('nbaviz-demo', null);
      S.demo = false;
      closeSheet();
      load();
    }
  });

  function route(initial) {
    var parts = location.hash.replace(/^#/, '').split('/');
    var tab = parts[0], arg = parts[1];
    var openT = null, openP = null;
    if (tab === 'team') { openT = arg; tab = 'ratings'; }
    if (tab === 'player') { openP = arg; tab = 'leaders'; }
    if (TABS.indexOf(tab) < 0) tab = 'ratings';
    if (tab === 'ratings' && (arg === 'ladder' || arg === 'diamond')) S.view = arg;
    if (tab === 'leaders' && arg) {
      var i = S.data.leaders.stats.map(function (s) { return s.key; }).indexOf(arg);
      if (i >= 0) S.stat = i;
    }
    if (!initial && tab === S.tab && !openT && !openP) return;
    S.tab = tab;
    render();
    if (!initial) window.scrollTo(0, 0);
    if (openT && S.teams[openT]) openTeam(openT);
    if (openP && S.players[openP]) openPlayer(openP);
  }
  window.addEventListener('hashchange', function () { if (S.data) { closeSheet(true); route(false); } });

  function render() {
    hideTip();
    S.sel = null;
    main.innerHTML = '<div class="view"></div>';
    var v = main.firstChild;
    ({ ratings: renderRatings, leaders: renderLeaders, mvp: renderMVP, title: renderTitle })[S.tab](v);
    v.insertAdjacentHTML('beforeend', '<p class="credit">' + (S.demo
      ? 'Demo data: every number and player here is made up. <button type="button" data-act="live">Show live data</button>'
      : 'Data: ESPN · Polymarket. Ratings computed by NBAViz. <button type="button" data-act="demo">Spoiler-free demo</button>') + '</p>');
    $$('.tabbar a').forEach(function (a) {
      if (a.getAttribute('data-tab') === S.tab) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  main.addEventListener('click', function (e) {
    var act = e.target.closest('[data-act]');
    if (act) {
      if (act.getAttribute('data-act') === 'demo') { store.set('nbaviz-demo', '1'); S.demo = true; load(); }
      else demoPill.click();
      return;
    }
    var segBtn = e.target.closest('.seg button');
    if (segBtn) return onControl(segBtn.parentNode.getAttribute('data-ctl'), segBtn.getAttribute('data-val'), segBtn);
    var chip = e.target.closest('.chip[data-conf]');
    if (chip) return onControl('conf', chip.getAttribute('data-conf'), chip);
    var stat = e.target.closest('.chip[data-stat]');
    if (stat) return goStat(+stat.getAttribute('data-stat'), true);
    var p = e.target.closest('[data-player]');
    if (p) return openPlayer(p.getAttribute('data-player'));
    var t = e.target.closest('[data-team]');
    if (t && !t.closest('svg')) return openTeam(t.getAttribute('data-team'));
  });

  function pressed(group, btn) {
    $$('button', group).forEach(function (b) { b.setAttribute('aria-pressed', String(b === btn)); });
  }

  function onControl(ctl, val, btn) {
    pressed(btn.parentNode, btn);
    if (ctl === 'view') {
      S.view = val; store.set('nbaviz-view', val);
      drawRatingsBody();
    } else if (ctl === 'mode') {
      S.mode = val;
      if (S.view === 'ladder') updateLadder(true); else updateDiamond();
    } else if (ctl === 'conf') {
      S.conf = val;
      if (S.view === 'ladder') updateLadder(false); else updateDiamond();
    } else if (ctl === 'range-mvp' || ctl === 'range-title') {
      var key = ctl.split('-')[1];
      S.range[key] = val;
      drawTrend(key);
    }
  }

  /* ============================================================ RATINGS */

  function rv(t, k) { return S.mode === 'adj' ? t[k + '_a'] : t[k]; }
  function rr(t, k) { return S.mode === 'adj' ? t.rk[k + '_a'] : t.rk[k]; }
  function visible(t) { return S.conf === 'all' || t.conf === S.conf; }
  function sortedTeams() {
    return S.data.teams.slice().sort(function (a, b) { return rv(b, 'nrtg') - rv(a, 'nrtg'); });
  }

  function renderRatings(v) {
    if (!S.view) S.view = window.innerWidth >= 640 ? 'diamond' : 'ladder';
    v.innerHTML =
      '<section class="card">' +
      '<div class="card-h"><p class="kicker">Team ratings</p><h2>Net rating</h2>' +
      '<p>Points per 100 possessions, offense minus defense. <b>Adjusted</b> takes out the strength of the opponents each team has played.</p></div>' +
      '<div class="controls">' +
      segBtns('view', [['ladder', 'Ladder'], ['diamond', 'Diamond']], S.view) +
      segBtns('mode', [['adj', 'Adjusted'], ['raw', 'Raw']], S.mode) +
      '</div>' +
      '<div class="chips" role="group">' + [['all', 'All teams'], ['East', 'East'], ['West', 'West']].map(function (c) {
        return '<button type="button" class="chip" data-conf="' + c[0] + '" aria-pressed="' + (S.conf === c[0]) + '">' + c[1] + '</button>';
      }).join('') + '</div>' +
      '<div id="rt-body"></div><p class="foot" id="rt-foot"></p></section>';
    drawRatingsBody();
  }

  function drawRatingsBody() {
    var body = $('#rt-body'), foot = $('#rt-foot');
    if (!body) return;
    if (S.view === 'ladder') {
      body.innerHTML = ladderHTML();
      updateLadder(false);
      foot.innerHTML = 'Sorted by the selected rating. Ring = raw, dot = adjusted; a <b>green</b> link means a tougher-than-average schedule, so adjusting raised the rating. ' +
        'O / D = offensive and defensive rating (points scored and allowed per 100 possessions; lower D is better). Tap a team for details.';
    } else {
      drawDiamond(body);
    }
  }

  function ladderExtent() {
    var m = 0;
    S.data.teams.forEach(function (t) { m = Math.max(m, Math.abs(t.nrtg), Math.abs(t.nrtg_a)); });
    return Math.max(8, Math.ceil(m + 1));
  }

  function ladderHTML() {
    var ext = ladderExtent();
    var x = function (v) { return ((v + ext) / (2 * ext) * 100).toFixed(2); };
    var tks = ticks(-ext, ext, ext > 15 ? 4 : 6);
    var grid = tks.map(function (t) {
      return '<span class="' + (t === 0 ? 'zero' : 'gl') + '" style="left:' + x(t) + '%"></span>';
    }).join('');
    var head = '<div class="l-axis" aria-hidden="true"><span></span><span></span><span></span><div class="track">' +
      tks.map(function (t) { return '<span class="tick" style="left:' + x(t) + '%">' + (t === 0 ? '0' : sign(t, 0)) + '</span>'; }).join('') +
      '</div><span class="colh"><span class="narrow-only">Net<br>O / D</span><span class="wide-only">Net</span></span>' +
      '<span class="colh wide-only">ORtg</span><span class="colh wide-only">DRtg</span></div>';
    var rows = sortedTeams().map(function (t) {
      var a = t.nrtg_a, r = t.nrtg, lo = Math.min(a, r), hi = Math.max(a, r);
      return '<button type="button" class="lrow" data-team="' + t.abbr + '" data-conf="' + t.conf + '">' +
        '<span class="lrank"></span>' + logo(t.abbr) +
        '<span class="lname"><b>' + t.abbr + '</b><small>' + t.w + '–' + t.l + '</small></span>' +
        '<span class="track">' + grid +
        '<span class="conn' + (a > r ? ' up' : '') + '" style="left:' + x(lo) + '%;width:' + (x(hi) - x(lo)).toFixed(2) + '%"></span>' +
        '<span class="dot raw" style="left:' + x(r) + '%"></span><span class="dot" style="left:' + x(a) + '%"></span></span>' +
        '<span class="lval v-net"><b></b><small class="narrow-only"></small></span>' +
        '<span class="lval wide-only v-o"><b></b><small></small></span>' +
        '<span class="lval wide-only v-d"><b></b><small></small></span></button>';
    }).join('');
    return '<div class="legend" aria-hidden="true"><span><i class="lg-dot"></i>Adjusted</span><span><i class="lg-ring"></i>Raw</span>' +
      '<span><i class="lg-line" style="background:var(--up-mark)"></i>adj. higher</span>' +
      '<span><i class="lg-line" style="background:var(--muted);opacity:.6"></i>adj. lower</span></div>' +
      '<div class="ladder">' + head + '<div class="ladder-rows">' + rows + '</div></div>';
  }

  function updateLadder(animate) {
    var wrap = $('.ladder-rows');
    if (!wrap) return;
    var rows = $$('.lrow', wrap);
    var first = new Map();
    if (animate) rows.forEach(function (r) { first.set(r, r.getBoundingClientRect().top); });
    var rank = 0;
    sortedTeams().forEach(function (t) {
      var r = wrap.querySelector('[data-team="' + t.abbr + '"]');
      wrap.appendChild(r);
      var show = visible(t);
      r.classList.toggle('hide', !show);
      if (!show) return;
      rank += 1;
      $('.lrank', r).textContent = rank;
      $('.v-net b', r).textContent = sign(rv(t, 'nrtg'));
      $('.v-net small', r).textContent = rv(t, 'ortg').toFixed(1) + ' / ' + rv(t, 'drtg').toFixed(1);
      $('.v-o b', r).textContent = rv(t, 'ortg').toFixed(1);
      $('.v-o small', r).textContent = ordinal(rr(t, 'ortg'));
      $('.v-d b', r).textContent = rv(t, 'drtg').toFixed(1);
      $('.v-d small', r).textContent = ordinal(rr(t, 'drtg'));
      r.setAttribute('aria-label', t.name + ', ' + (S.mode === 'adj' ? 'adjusted' : 'raw') + ' net rating ' + sign(rv(t, 'nrtg')) +
        ', offense ' + rv(t, 'ortg').toFixed(1) + ', defense ' + rv(t, 'drtg').toFixed(1));
    });
    if (!animate) return;
    rows.forEach(function (r) {
      var dy = first.get(r) - r.getBoundingClientRect().top;
      if (!dy) return;
      r.style.transition = 'none';
      r.style.transform = 'translateY(' + dy + 'px)';
    });
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        rows.forEach(function (r) {
          r.style.transition = 'transform .6s cubic-bezier(.2,.8,.2,1)';
          r.style.transform = '';
        });
      });
    });
  }

  /* Diamond: ORtg vs DRtg rotated 45 degrees so height = net rating.
     Pinch, double-tap, ctrl+wheel or the +/- buttons zoom; logos keep their
     size while zooming, so the crowded middle spreads out. Drag to pan. */
  var dia = null;
  var ZMAX = 6;
  function drawDiamond(body) {
    var narrow = window.innerWidth < 640;
    var W = avail(body) + (narrow ? 32 : 0), lg = S.data.league.rtg, teams = S.data.teams;
    function pos(t, m) {
      var o = (m === 'adj' ? t.ortg_a : t.ortg) - lg, dd = lg - (m === 'adj' ? t.drtg_a : t.drtg);
      return { u: (o - dd) / Math.SQRT2, v: (o + dd) / Math.SQRT2 };
    }
    var umax = 0, vmax = 0;
    teams.forEach(function (t) {
      ['adj', 'raw'].forEach(function (m) {
        var p = pos(t, m);
        umax = Math.max(umax, Math.abs(p.u)); vmax = Math.max(vmax, Math.abs(p.v));
      });
    });
    umax += 0.6; vmax += 0.6;
    var L = narrow ? 24 : 32;                                      // logo size, constant while zooming
    var gutter = 30, padTop = 26, padBot = 24;
    var k = (W - gutter - 8 - L) / (2 * umax);
    var H = 2 * vmax * k + padTop + padBot + L;
    var maxH = narrow ? Math.max(420, Math.min(W * 1.5, window.innerHeight * 0.74)) : Math.max(420, Math.min(W * 1.05, 760));
    if (H > maxH) { k = (maxH - padTop - padBot - L) / (2 * vmax); H = maxH; }
    var cx = gutter + (W - gutter) / 2, cy = padTop + L / 2 + vmax * k;
    var top = 8, bot = H - 8;

    var s = svgEl(W, H, 'Diamond chart of offensive versus defensive rating for all 30 teams', 'diamond');
    s += '<defs><clipPath id="dclip"><rect x="' + (gutter - 2) + '" y="' + top + '" width="' + (W - gutter + 2) + '" height="' + (bot - top) + '"/></clipPath></defs>';
    s += '<g class="d-grid" clip-path="url(#dclip)"></g><g class="d-ticks"></g>';
    s += '<text class="ax-strong corner" x="' + (W - 4) + '" y="' + (top + 4) + '" text-anchor="end" dominant-baseline="hanging">better offense ↗</text>';
    s += '<text class="ax-strong corner" x="' + (gutter + 2) + '" y="' + (top + 4) + '" dominant-baseline="hanging">↖ better defense</text>';
    s += '<text class="ax-label corner" x="' + (W - 4) + '" y="' + (bot - 4) + '" text-anchor="end">worse defense ↘</text>';
    s += '<text class="ax-label corner" x="' + (gutter + 2) + '" y="' + (bot - 4) + '">↙ worse offense</text>';
    s += '<g class="d-plot" clip-path="url(#dclip)">';
    teams.forEach(function (t) {
      s += '<g class="ghost" data-team="' + t.abbr + '"><line/><circle r="3.5"/></g>';
    });
    teams.slice().sort(function (p, q) { return p.nrtg_a - q.nrtg_a; }).forEach(function (t) {
      s += '<g class="pt" data-team="' + t.abbr + '" tabindex="0" role="button" aria-label="' + esc(t.name) + '">' +
        '<circle class="halo" r="' + (L / 2 + 1) + '" opacity=".85"/><circle class="sel-ring" r="' + (L / 2 + 3) + '"/>' +
        '<image href="' + logoSrc(t.abbr) + '" x="' + (-L / 2) + '" y="' + (-L / 2) + '" width="' + L + '" height="' + L + '"/>' +
        '<text class="pt-label" y="' + (-L / 2 - 6) + '" text-anchor="middle"></text></g>';
    });
    s += '</g></svg>';
    body.innerHTML = '<div class="chart-wrap' + (narrow ? ' bleed' : '') + '">' + s +
      '<div class="zoom-ctl"><button type="button" data-z="in" aria-label="Zoom in">+</button>' +
      '<button type="button" data-z="out" aria-label="Zoom out">−</button>' +
      '<button type="button" data-z="reset" aria-label="Reset zoom" hidden>↺</button></div></div>';
    dia = {
      svg: $('svg', body), wrap: $('.chart-wrap', body), W: W, H: H, top: top, bot: bot, gutter: gutter, k: k, cy: cy,
      X: function (u) { return cx + u * k; }, Y: function (v) { return cy - v * k; },
      pos: pos, z: { s: 1, tx: 0, ty: 0 },
    };
    updateDiamond();

    var svg = dia.svg;
    $$('.pt', svg).forEach(function (g) {
      var abbr = g.getAttribute('data-team');
      g.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') g.classList.add('hover'); });
      g.addEventListener('pointerleave', function () { g.classList.remove('hover'); });
      g.addEventListener('click', function () { setSelection(abbr); openTeam(abbr); });
      g.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelection(abbr); openTeam(abbr); } });
    });
    $$('.zoom-ctl button', dia.wrap).forEach(function (b) {
      b.addEventListener('click', function () {
        var mid = [(dia.gutter + dia.W) / 2, (top + bot) / 2];
        if (b.dataset.z === 'in') zoomAt(mid, 1.6);
        else if (b.dataset.z === 'out') zoomAt(mid, 1 / 1.6);
        else setZoom(1, 0, 0);
      });
    });
    bindDiamondGestures(svg);
  }

  // screen position of a point in rating space, after zoom
  function dP(u, v) { var z = dia.z; return [dia.X(u) * z.s + z.tx, dia.Y(v) * z.s + z.ty]; }

  function setZoom(s, tx, ty) {
    var W = dia.W, H = dia.H;
    s = clamp(s, 1, ZMAX);
    dia.z = { s: s, tx: clamp(tx, W - W * s, 0), ty: clamp(ty, H - H * s, 0) };
    dia.svg.classList.add('instant');
    dia.svg.classList.toggle('zoomed', s >= 2.2);
    dia.svg.classList.toggle('zoom-in', s > 1);
    dia.svg.style.touchAction = s > 1 ? 'none' : '';
    $('[data-z=reset]', dia.wrap).hidden = s <= 1;
    layoutDiamond();
  }
  function zoomAt(p, f) {
    var z = dia.z, s = clamp(z.s * f, 1, ZMAX);
    var bx = (p[0] - z.tx) / z.s, by = (p[1] - z.ty) / z.s;
    setZoom(s, p[0] - bx * s, p[1] - by * s);
  }

  function layoutDiamond() {
    var z = dia.z, W = dia.W, top = dia.top, bot = dia.bot, svg = dia.svg;
    // net-rating gridlines, re-ticked for the visible range
    var netAt = function (y) { return (dia.cy - (y - z.ty) / z.s) / dia.k * Math.SQRT2; };
    var nTop = netAt(top), nBot = netAt(bot);
    var g = '', lab = '';
    ticks(nBot, nTop, Math.round(6 * Math.min(z.s, 2))).forEach(function (n) {
      var y = dP(0, n / Math.SQRT2)[1];
      if (y < top + 4 || y > bot - 4) return;
      g += '<line class="' + (n === 0 ? 'zeroline' : 'gridline') + '" x1="' + dia.gutter + '" x2="' + W + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"/>';
      lab += '<text class="ax-label" x="2" y="' + (y + 3.5).toFixed(1) + '">' + (n === 0 ? '0' : sign(n, Math.abs(n) % 1 ? 1 : 0)) + '</text>';
    });
    // league-average offense (o = 0 -> u = -v) and defense (dd = 0 -> u = v) diagonals
    var big = 200;
    var a = dP(-big, big), b = dP(big, -big), c = dP(-big, -big), d = dP(big, big);
    g += '<line class="crossline" x1="' + a[0] + '" y1="' + a[1] + '" x2="' + b[0] + '" y2="' + b[1] + '"/>' +
      '<line class="crossline" x1="' + c[0] + '" y1="' + c[1] + '" x2="' + d[0] + '" y2="' + d[1] + '"/>';
    $('.d-grid', svg).innerHTML = g;
    $('.d-ticks', svg).innerHTML = lab;
    $$('.ghost', svg).forEach(function (gh) {
      var t = S.teams[gh.getAttribute('data-team')], r = dia.pos(t, 'raw'), q = dia.pos(t, 'adj');
      var p1 = dP(r.u, r.v), p2 = dP(q.u, q.v), ln = gh.firstChild, ci = gh.lastChild;
      ln.setAttribute('x1', p1[0]); ln.setAttribute('y1', p1[1]); ln.setAttribute('x2', p2[0]); ln.setAttribute('y2', p2[1]);
      ci.setAttribute('cx', p1[0]); ci.setAttribute('cy', p1[1]);
      gh.style.display = visible(t) ? '' : 'none';
    });
    $$('.pt', svg).forEach(function (pt) {
      var t = S.teams[pt.getAttribute('data-team')], q = dia.pos(t, S.mode), p = dP(q.u, q.v);
      pt.style.transform = 'translate(' + p[0].toFixed(1) + 'px,' + p[1].toFixed(1) + 'px)';
    });
  }

  function bindDiamondGestures(svg) {
    var ptrs = new Map(), start = null, moved = false, lastTap = null;
    function toSvg(e) {
      var r = svg.getBoundingClientRect();
      return [(e.clientX - r.left) * dia.W / r.width, (e.clientY - r.top) * dia.H / r.height];
    }
    function begin() {
      var p = Array.from(ptrs.values());
      var z = { s: dia.z.s, tx: dia.z.tx, ty: dia.z.ty };
      if (p.length >= 2) start = { pinch: true, d: Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) || 1, m: [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2], z: z };
      else if (p.length === 1) start = { pinch: false, p: p[0], z: z };
    }
    svg.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      ptrs.set(e.pointerId, toSvg(e));
      if (ptrs.size === 1) moved = false;
      begin();
    });
    svg.addEventListener('pointermove', function (e) {
      if (!ptrs.has(e.pointerId) || !start) return;
      ptrs.set(e.pointerId, toSvg(e));
      var p = Array.from(ptrs.values());
      if (start.pinch && p.length >= 2) {
        var d = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]), m = [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2];
        var s = clamp(start.z.s * d / start.d, 1, ZMAX);
        var bx = (start.m[0] - start.z.tx) / start.z.s, by = (start.m[1] - start.z.ty) / start.z.s;
        if (!moved) { moved = true; try { svg.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
        setZoom(s, m[0] - bx * s, m[1] - by * s);
        hideTip();
      } else if (!start.pinch && dia.z.s > 1) {
        var dx = p[0][0] - start.p[0], dy = p[0][1] - start.p[1];
        if (!moved && Math.hypot(dx, dy) < 6) return;
        if (!moved) { moved = true; try { svg.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
        setZoom(dia.z.s, start.z.tx + dx, start.z.ty + dy);
      }
    });
    function end(e) {
      if (!ptrs.has(e.pointerId)) return;
      var at = ptrs.get(e.pointerId);
      ptrs.delete(e.pointerId);
      if (ptrs.size) { begin(); return; }
      start = null;
      if (moved || e.type === 'pointercancel') return;
      // double-tap on empty space zooms in there (or back out when fully zoomed)
      var onLogo = e.target.closest && e.target.closest('.pt');
      var now = Date.now();
      if (!onLogo && lastTap && now - lastTap.t < 320 && Math.hypot(at[0] - lastTap.p[0], at[1] - lastTap.p[1]) < 30) {
        if (dia.z.s >= ZMAX - 0.01) setZoom(1, 0, 0); else zoomAt(at, 2);
        lastTap = null;
      } else {
        lastTap = { t: now, p: at };
      }
    }
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('click', function (e) {
      if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; }
    }, true);
    svg.addEventListener('dblclick', function (e) { e.preventDefault(); });
    svg.addEventListener('wheel', function (e) {
      if (!e.ctrlKey) return;                      // trackpad pinch arrives as ctrl+wheel
      e.preventDefault();
      zoomAt(toSvg(e), Math.exp(-e.deltaY * 0.01));
    }, { passive: false });
  }

  function updateDiamond() {
    if (!dia || !document.body.contains(dia.svg)) return;
    dia.svg.classList.remove('instant');           // let logos glide between raw and adjusted
    dia.svg.classList.toggle('mode-raw', S.mode === 'raw');
    $$('.pt', dia.svg).forEach(function (g) {
      var t = S.teams[g.getAttribute('data-team')];
      g.style.opacity = visible(t) ? '' : '0.12';
      g.style.pointerEvents = visible(t) ? '' : 'none';
      $('.pt-label', g).textContent = t.abbr + ' ' + sign(rv(t, 'nrtg'));
    });
    layoutDiamond();
    var foot = $('#rt-foot');
    if (foot && S.view === 'diamond') drawRatingsFootOnly(foot);
  }
  function drawRatingsFootOnly(foot) {
    foot.innerHTML = '<b>Height = net rating.</b> Further up-right = better offense, further up-left = better defense. ' +
      'The two diagonal lines mark the league average (' + S.data.league.rtg.toFixed(1) + '). ' +
      (S.mode === 'adj' ? 'Small rings show where each team sits before the adjustment. ' : '') +
      '<b>Pinch or double-tap to zoom</b>, drag to move, tap a logo for details.';
  }

  function setSelection(abbr) {
    S.sel = abbr;
    if (!dia || !document.body.contains(dia.svg)) return;
    dia.svg.classList.toggle('has-sel', !!abbr);
    $$('.pt, .ghost', dia.svg).forEach(function (g) { g.classList.toggle('sel', g.getAttribute('data-team') === abbr); });
    if (abbr) {
      var g = $('.pt[data-team="' + abbr + '"]', dia.svg);
      g.parentNode.appendChild(g);
    }
  }

  /* ============================================================ LEADERS */

  function statVal(s, v) { return s.pct ? v.toFixed(1) + '%' : v.toFixed(s.dec); }

  function renderLeaders(v) {
    var stats = S.data.leaders.stats;
    v.innerHTML =
      '<div class="chips" role="tablist" aria-label="Stat">' + stats.map(function (s, i) {
        return '<button type="button" class="chip" role="tab" data-stat="' + i + '" aria-pressed="' + (i === S.stat) + '">' + s.unit + '</button>';
      }).join('') + '</div>' +
      '<div class="carousel" id="car">' + stats.map(leaderCard).join('') + '</div>' +
      '<div class="dots" aria-hidden="true">' + stats.map(function (s, i) { return '<span' + (i === S.stat ? ' class="on"' : '') + '></span>'; }).join('') + '</div>' +
      '<section class="card" id="swarm-card"></section>';
    var car = $('#car');
    car.scrollLeft = carStep(car) * S.stat;
    var timer = null;
    car.addEventListener('scroll', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var i = Math.round(car.scrollLeft / carStep(car));
        if (i !== S.stat) goStat(i, false);
      }, 90);
    }, { passive: true });
    drawSwarm();
  }

  function carStep(car) { return car.firstElementChild.getBoundingClientRect().width + 16; }

  function leaderCard(s) {
    var rows = s.rows.slice(0, 5), top = rows.length ? rows[0][1] : 1;
    return '<section class="card" aria-label="' + esc(s.label) + ' leaders">' +
      '<div class="card-h"><p class="kicker">Season leaders · per game</p><h2>' + esc(s.label) + '</h2>' +
      '<p>' + s.rows.length + ' qualified players</p></div>' +
      rows.map(function (r, i) {
        var p = S.players[r[0]] || {};
        return '<button type="button" class="lead-row' + (i === 0 ? ' first' : '') + '" data-player="' + esc(r[0]) + '">' +
          '<span class="rk">' + (i + 1) + '</span>' + playerHead(r[0], 44) +
          '<span style="min-width:0"><span class="lead-name">' + esc(p.name) + '</span>' +
          '<span class="lead-team">' + esc(p.team) + ' · ' + p.gp + ' GP</span>' +
          '<span class="bar-track" style="height:5px;margin-top:5px"><span class="bar-fill" style="width:' + (r[1] / top * 100).toFixed(1) + '%"></span></span></span>' +
          '<span class="lead-val">' + statVal(s, r[1]) + '<small>' + s.unit + '</small></span></button>';
      }).join('') + '</section>';
  }

  function goStat(i, scroll) {
    var stats = S.data.leaders.stats;
    S.stat = clamp(i, 0, stats.length - 1);
    $$('.chip[data-stat]').forEach(function (c) { c.setAttribute('aria-pressed', String(+c.getAttribute('data-stat') === S.stat)); });
    $$('.dots span').forEach(function (d, j) { d.classList.toggle('on', j === S.stat); });
    var chip = $('.chip[data-stat="' + S.stat + '"]');
    if (chip && chip.scrollIntoView) chip.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    if (scroll) {
      var car = $('#car');
      car.scrollTo({ left: S.stat * carStep(car), behavior: 'smooth' });
    }
    try { history.replaceState(history.state, '', '#leaders/' + stats[S.stat].key); } catch (e) { /* ignore */ }
    drawSwarm();
  }

  function drawSwarm() {
    var card = $('#swarm-card');
    if (!card) return;
    var s = S.data.leaders.stats[S.stat];
    card.innerHTML = '<div class="card-h"><p class="kicker">' + esc(s.label) + ' · everyone who qualifies</p>' +
      '<h2>How far ahead is the top?</h2><p>Each dot is a player. The top 10 are highlighted. Tap a dot for the player.</p></div>' +
      '<div class="chart-wrap" id="swarm"></div><p class="foot">' + esc(S.data.leaders.rule) + '.</p>';
    var host = $('#swarm'), W = avail(host);
    var rows = s.rows;
    if (!rows.length) { host.innerHTML = '<p class="foot">No qualified players yet.</p>'; return; }
    var vals = rows.map(function (r) { return r[1]; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var tk = ticks(lo, hi, W < 420 ? 4 : 6);
    var d0 = Math.min(lo, tk[0]), d1 = Math.max(hi, tk[tk.length - 1]);
    var m = { l: 10, r: 10 };
    var X = function (v) { return m.l + (v - d0) / ((d1 - d0) || 1) * (W - m.l - m.r); };
    var R = rows.length > 250 ? 3.4 : 4;
    // beeswarm: place each dot at the y closest to the centre that does not overlap
    var pts = rows.map(function (r, i) { return { id: r[0], v: r[1], x: X(r[1]), rank: i + 1 }; })
      .sort(function (a, b) { return a.x - b.x; });
    var placed = [], D = 2 * R + 0.8;
    pts.forEach(function (p) {
      var blocked = [];
      for (var j = placed.length - 1; j >= 0; j--) {
        var q = placed[j], dx = p.x - q.x;
        if (dx >= D) break;
        var h = Math.sqrt(D * D - dx * dx);
        blocked.push([q.y - h, q.y + h]);
      }
      var cands = [0];
      blocked.forEach(function (b) { cands.push(b[0], b[1]); });
      cands.sort(function (a, b) { return Math.abs(a) - Math.abs(b); });
      for (var c = 0; c < cands.length; c++) {
        var y = cands[c], ok = true;
        for (var k = 0; k < blocked.length; k++) if (y > blocked[k][0] + 1e-6 && y < blocked[k][1] - 1e-6) { ok = false; break; }
        if (ok) { p.y = y; break; }
      }
      placed.push(p);
    });
    var ymax = 0;
    pts.forEach(function (p) { ymax = Math.max(ymax, Math.abs(p.y)); });
    var top = 26, mid = top + ymax + R + 2, H = mid + ymax + R + 30;
    var svg = svgEl(W, H, s.label + ' for all ' + rows.length + ' qualified players');
    tk.forEach(function (t) {
      svg += '<line class="gridline" x1="' + X(t) + '" x2="' + X(t) + '" y1="' + (top - 6) + '" y2="' + (H - 20) + '"/>' +
        '<text class="ax-label" x="' + X(t) + '" y="' + (H - 6) + '" text-anchor="middle">' + (s.pct ? t + '%' : t) + '</text>';
    });
    var surface = css('--surface'), accent = css('--accent'), muted = css('--muted');
    pts.sort(function (a, b) { return b.rank - a.rank; }).forEach(function (p) {
      var hot = p.rank <= 10;
      svg += '<circle class="swarm-dot" data-pid="' + esc(p.id) + '" cx="' + p.x.toFixed(1) + '" cy="' + (mid + p.y).toFixed(1) + '" r="' + (hot ? R + 0.6 : R) +
        '" fill="' + (hot ? accent : muted) + '" fill-opacity="' + (hot ? 1 : 0.45) + '"' +
        (hot ? ' stroke="' + surface + '" stroke-width="1.5"' : '') + '/>';
    });
    var leader = pts.filter(function (p) { return p.rank === 1; })[0];
    if (leader) {
      var lp = S.players[leader.id] || {};
      var anchor = leader.x > W - 90 ? 'end' : leader.x < 90 ? 'start' : 'middle';
      svg += '<text class="ax-strong" x="' + leader.x + '" y="' + (top - 10) + '" text-anchor="' + anchor + '">' + esc(lp.short || lp.name) + ' ' + statVal(s, leader.v) + '</text>';
    }
    svg += '<circle class="swarm-hl" r="' + (R + 3) + '" fill="none" stroke="' + css('--ink') + '" stroke-width="2" visibility="hidden"/></svg>';
    host.innerHTML = svg;
    var el = $('svg', host), hl = $('.swarm-hl', el);
    function nearest(e) {
      var r = el.getBoundingClientRect(), sx = (e.clientX - r.left) * (W / r.width), sy = (e.clientY - r.top) * (H / r.height);
      var best = null, bd = 18 * 18;
      pts.forEach(function (p) {
        var dx = p.x - sx, dy = mid + p.y - sy, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = p; }
      });
      return best;
    }
    el.addEventListener('pointermove', function (e) {
      var p = nearest(e);
      if (!p) { hideTip(); hl.setAttribute('visibility', 'hidden'); return; }
      var pl = S.players[p.id] || {};
      hl.setAttribute('cx', p.x); hl.setAttribute('cy', mid + p.y); hl.setAttribute('visibility', 'visible');
      var br = el.getBoundingClientRect();
      showTip('<b>' + esc(pl.name) + '</b> · ' + esc(pl.team) + '<br>' + statVal(s, p.v) + ' ' + s.unit + ' · ' + ordinal(p.rank),
        br.left + p.x * br.width / W, br.top + (mid + p.y) * br.height / H);
    });
    el.addEventListener('pointerleave', function () { hideTip(); hl.setAttribute('visibility', 'hidden'); });
    el.addEventListener('click', function (e) { var p = nearest(e); if (p) openPlayer(p.id); });
  }

  /* =============================================================== ODDS */

  function deltaHTML(d1) {
    if (d1 == null || Math.abs(d1) < 0.0005) return '';
    var v = d1 * 100;
    return '<span class="delta ' + (v > 0 ? 'up' : 'down') + '" title="Change in the last 24 hours">' +
      (v > 0 ? '▲ ' : '▼ ') + Math.abs(v).toFixed(1) + '</span>';
  }

  function oddsBars(ev, kind) {
    var outs = ev.outcomes, top = outs.slice(0, 8), rest = outs.slice(8);
    var max = top.length ? top[0].prob : 1;
    var restP = rest.reduce(function (a, o) { return a + o.prob; }, 0);
    var html = '<div class="bars">' + top.map(function (o) {
      var left, name, sub, attr;
      if (kind === 'title') {
        var t = S.teams[o.abbr];
        left = o.abbr ? logo(o.abbr) : '<span></span>';
        name = esc(t ? t.name : o.name);
        sub = t ? t.w + '–' + t.l + ' · adj. net ' + sign(t.nrtg_a) + ' (' + ordinal(t.rk.nrtg_a) + ')' : '';
        attr = o.abbr ? ' data-team="' + o.abbr + '"' : '';
      } else {
        var p = o.player ? S.players[o.player] : null;
        left = headHTML(o.name, o.head ? '/img/heads/' + o.head + '.png' : null, p && p.team, 40);
        name = esc(o.name) + (p ? ' <small>' + esc(p.team) + '</small>' : '');
        sub = p ? p.pts.toFixed(1) + ' pts · ' + p.reb.toFixed(1) + ' reb · ' + p.ast.toFixed(1) + ' ast' : 'No games this season';
        attr = o.player ? ' data-player="' + esc(o.player) + '"' : '';
      }
      return '<button type="button" class="bar-row"' + attr + '>' + left +
        '<span class="bar-main"><span class="bar-name">' + name + '</span><span class="bar-sub">' + sub + '</span>' +
        '<span class="bar-track"><span class="bar-fill" style="width:' + (o.prob / max * 100).toFixed(1) + '%"></span></span></span>' +
        '<span class="bar-val"><b>' + pct(o.prob) + '</b>' + deltaHTML(o.d1) + '</span></button>';
    }).join('');
    if (rest.length) {
      html += '<div class="bar-row" style="cursor:default"><span></span><span class="bar-main"><span class="bar-name">' + rest.length +
        ' others</span><span class="bar-sub">combined</span><span class="bar-track"><span class="bar-fill other" style="width:' +
        (restP / max * 100).toFixed(1) + '%"></span></span></span><span class="bar-val"><b>' + pct(restP) + '</b></span></div>';
    }
    return html + '</div>';
  }

  function money(v) {
    if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'K';
    return '$' + Math.round(v);
  }

  function oddsFoot(ev) {
    return 'Polymarket prices, read-only. Shares normalized to add up to 100% (raw prices add up to ' +
      (ev.total_price * 100).toFixed(1) + '%). ▲▼ = change over 24 hours in percentage points. ' + money(ev.volume) + ' traded.';
  }

  function renderMVP(v) {
    var ev = S.data.odds.mvp;
    if (!ev || !ev.outcomes || !ev.outcomes.length) { v.innerHTML = '<div class="card">No MVP market found.</div>'; return; }
    v.innerHTML =
      '<section class="card"><div class="card-h"><p class="kicker">Polymarket</p><h2>MVP odds</h2>' +
      '<p>Chance of winning ' + esc(S.data.season) + ' MVP, as priced by the market.</p></div>' +
      oddsBars(ev, 'mvp') + '<p class="foot">' + oddsFoot(ev) + '</p></section>' +
      trendCard('mvp', 'How the favourites moved');
    drawTrend('mvp');
  }

  function renderTitle(v) {
    var ev = S.data.odds.title;
    if (!ev || !ev.outcomes || !ev.outcomes.length) { v.innerHTML = '<div class="card">No championship market found.</div>'; return; }
    v.innerHTML =
      '<section class="card"><div class="card-h"><p class="kicker">Polymarket</p><h2>Championship odds</h2>' +
      '<p>Chance of winning the title, as priced by the market.</p></div>' +
      oddsBars(ev, 'title') + '<p class="foot">' + oddsFoot(ev) + '</p></section>' +
      trendCard('title', 'How the favourites moved') +
      '<section class="card"><div class="card-h"><p class="kicker">Market vs. court</p><h2>Odds against adjusted net rating</h2>' +
      '<p>Teams above the line are priced higher than their play so far suggests; teams below are playing better than they’re priced.</p></div>' +
      '<div class="chart-wrap" id="mvc"></div><p class="foot">Vertical axis uses a square-root scale so long shots stay readable. Line = least-squares fit. Tap a logo for details.</p></section>';
    drawTrend('title');
    drawMarketVsCourt();
  }

  function trendCard(key, title) {
    return '<section class="card"><div class="card-h"><p class="kicker">Odds over time</p><h2>' + title + '</h2>' +
      '<p>Market price for the current top ' + Math.min(5, S.data.odds[key].outcomes.filter(function (o) { return o.history && o.history.length; }).length) + '.</p></div>' +
      '<div class="controls">' + segBtns('range-' + key, [['1m', '30 days'], ['all', 'All']], S.range[key]) + '</div>' +
      '<div id="trend-' + key + '"></div><p class="foot">Raw market price, 12-hour steps. Drag across the chart to read values.</p></section>';
  }

  function drawTrend(key) {
    var host = $('#trend-' + key);
    if (!host) return;
    var ev = S.data.odds[key];
    var picked = ev.outcomes.filter(function (o) { return o.history && o.history.length > 1; }).slice(0, 5);
    var lastOf = function (o) { return o.name.split(' ').slice(-1)[0]; };
    var series = picked.map(function (o, i) {
      var name = key === 'title' ? (S.teams[o.abbr] ? S.teams[o.abbr].nick : o.name) : lastOf(o);
      if (key !== 'title' && picked.filter(function (q) { return lastOf(q) === name; }).length > 1) name = o.name[0] + '. ' + name;
      return { name: name, full: o.name, color: css(SERIES[i]), pts: o.history };
    });
    if (!series.length) { host.innerHTML = '<p class="foot">No price history yet.</p>'; return; }
    var tMax = 0, tMin = Infinity;
    series.forEach(function (s) { s.pts.forEach(function (p) { tMax = Math.max(tMax, p[0]); tMin = Math.min(tMin, p[0]); }); });
    var from = S.range[key] === '1m' ? Math.max(tMin, tMax - 30 * 86400) : tMin;
    series.forEach(function (s) { s.view = s.pts.filter(function (p) { return p[0] >= from; }); });
    var yMax = 0;
    series.forEach(function (s) { s.view.forEach(function (p) { yMax = Math.max(yMax, p[1]); }); });
    var yt = ticks(0, yMax * 1.08, 4);
    var yTop = Math.max(yt[yt.length - 1], yMax);
    var W = avail(host), H = W < 500 ? 220 : 260, m = { l: 36, r: 14, t: 10, b: 24 };
    var X = function (t) { return m.l + (t - from) / ((tMax - from) || 1) * (W - m.l - m.r); };
    var Y = function (p) { return m.t + (1 - p / yTop) * (H - m.t - m.b); };
    var svg = svgEl(W, H, 'Price history of the top candidates');
    yt.forEach(function (t) {
      svg += '<line class="' + (t === 0 ? 'zeroline' : 'gridline') + '" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + Y(t) + '" y2="' + Y(t) + '"/>' +
        '<text class="ax-label" x="' + (m.l - 6) + '" y="' + (Y(t) + 3.5) + '" text-anchor="end">' + Math.round(t * 100) + '%</text>';
    });
    var span = tMax - from, nx = W < 500 ? 3 : 5;
    for (var i = 0; i <= nx; i++) {
      var tt = from + span * i / nx;
      svg += '<text class="ax-label" x="' + X(tt) + '" y="' + (H - 6) + '" text-anchor="' + (i === 0 ? 'start' : i === nx ? 'end' : 'middle') + '">' +
        dateShort(new Date(tt * 1000)) + '</text>';
    }
    var surface = css('--surface');
    series.slice().reverse().forEach(function (s) {
      var d = s.view.map(function (p, j) { return (j ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1); }).join('');
      svg += '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
      var last = s.view[s.view.length - 1];
      if (last) svg += '<circle cx="' + X(last[0]) + '" cy="' + Y(last[1]) + '" r="4" fill="' + s.color + '" stroke="' + surface + '" stroke-width="2"/>';
    });
    svg += '<g class="hover" visibility="hidden"><line class="cross" y1="' + m.t + '" y2="' + (H - m.b) + '"/>' +
      series.map(function (s) { return '<circle r="4" fill="' + s.color + '" stroke="' + surface + '" stroke-width="2"/>'; }).join('') + '</g>';
    svg += '<rect x="' + m.l + '" y="0" width="' + (W - m.l - m.r) + '" height="' + H + '" fill="transparent" style="touch-action:pan-y"/></svg>';
    var legend = '<div class="series-legend">' + series.map(function (s) {
      var last = s.view[s.view.length - 1];
      return '<span><i style="background:' + s.color + '"></i>' + esc(s.name) + ' <b>' + (last ? (last[1] * 100).toFixed(1) + '%' : '') + '</b></span>';
    }).join('') + '</div>';
    host.innerHTML = legend + '<div class="chart-wrap">' + svg + '</div>';
    var el = $('svg', host), hov = $('.hover', el), cross = $('line', hov), dots = $$('circle', hov);
    function at(s, t) {
      var best = null;
      for (var j = 0; j < s.view.length; j++) { if (s.view[j][0] <= t) best = s.view[j]; else break; }
      return best;
    }
    function move(e) {
      var r = el.getBoundingClientRect(), sx = (e.clientX - r.left) * (W / r.width);
      var t = from + clamp((sx - m.l) / (W - m.l - m.r), 0, 1) * (tMax - from);
      hov.setAttribute('visibility', 'visible');
      cross.setAttribute('x1', X(t)); cross.setAttribute('x2', X(t));
      var rows = [];
      series.forEach(function (s, i) {
        var p = at(s, t);
        if (!p) { dots[i].setAttribute('visibility', 'hidden'); return; }
        dots[i].setAttribute('visibility', 'visible');
        dots[i].setAttribute('cx', X(p[0])); dots[i].setAttribute('cy', Y(p[1]));
        rows.push([s, p[1]]);
      });
      rows.sort(function (a, b) { return b[1] - a[1]; });
      showTip('<b>' + dateShort(new Date(t * 1000)) + '</b><br>' + rows.map(function (rw) {
        return '<span class="sw" style="background:' + rw[0].color + '"></span>' + esc(rw[0].name) + ' ' + (rw[1] * 100).toFixed(1) + '%';
      }).join('<br>'), r.left + X(t) * r.width / W, r.top + m.t * r.height / H + 20);
    }
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', move);
    el.addEventListener('pointerleave', function () { hov.setAttribute('visibility', 'hidden'); hideTip(); });
  }

  function drawMarketVsCourt() {
    var host = $('#mvc');
    if (!host) return;
    var teams = S.data.teams.filter(function (t) { return t.title != null; });
    var W = avail(host), H = Math.round(clamp(W * 0.9, 300, 440));
    var L = W < 500 ? 22 : 28, m = { l: 40, r: L / 2 + 6, t: L / 2 + 6, b: 30 };
    var xs = teams.map(function (t) { return t.nrtg_a; });
    var x0 = Math.floor(Math.min.apply(null, xs) / 5) * 5, x1 = Math.ceil(Math.max.apply(null, xs) / 5) * 5;
    var pmax = Math.max.apply(null, teams.map(function (t) { return t.title; }));
    var yTop = Math.sqrt(Math.max(0.05, pmax * 1.1));
    var X = function (v) { return m.l + (v - x0) / (x1 - x0) * (W - m.l - m.r); };
    var Y = function (p) { return m.t + (1 - Math.sqrt(p) / yTop) * (H - m.t - m.b); };
    var svg = svgEl(W, H, 'Title odds against adjusted net rating');
    [0, 0.01, 0.05, 0.1, 0.2, 0.3, 0.5].filter(function (p) { return Math.sqrt(p) <= yTop; }).forEach(function (p) {
      svg += '<line class="' + (p === 0 ? 'zeroline' : 'gridline') + '" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + Y(p) + '" y2="' + Y(p) + '"/>' +
        '<text class="ax-label" x="' + (m.l - 6) + '" y="' + (Y(p) + 3.5) + '" text-anchor="end">' + Math.round(p * 100) + '%</text>';
    });
    ticks(x0, x1, W < 500 ? 4 : 6).forEach(function (v) {
      svg += '<line class="' + (v === 0 ? 'zeroline' : 'gridline') + '" x1="' + X(v) + '" x2="' + X(v) + '" y1="' + m.t + '" y2="' + (H - m.b) + '"/>' +
        '<text class="ax-label" x="' + X(v) + '" y="' + (H - m.b + 15) + '" text-anchor="middle">' + (v === 0 ? '0' : sign(v, 0)) + '</text>';
    });
    svg += '<text class="ax-label" x="' + (W - m.r) + '" y="' + (H - 2) + '" text-anchor="end">adjusted net rating →</text>';
    // least-squares fit of sqrt(odds) on net rating
    var n = teams.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    teams.forEach(function (t) { var y = Math.sqrt(t.title); sx += t.nrtg_a; sy += y; sxx += t.nrtg_a * t.nrtg_a; sxy += t.nrtg_a * y; });
    var b = (n * sxy - sx * sy) / ((n * sxx - sx * sx) || 1), a = (sy - b * sx) / n;
    var fit = [];
    for (var v = x0; v <= x1 + 1e-9; v += (x1 - x0) / 40) {
      var y = a + b * v;
      if (y >= 0 && y <= yTop) fit.push((fit.length ? 'L' : 'M') + X(v).toFixed(1) + ' ' + (m.t + (1 - y / yTop) * (H - m.t - m.b)).toFixed(1));
    }
    if (fit.length > 1) svg += '<path d="' + fit.join('') + '" fill="none" stroke="' + css('--muted') + '" stroke-width="1.5" opacity=".7"/>';
    teams.slice().sort(function (p, q) { return p.title - q.title; }).forEach(function (t) {
      svg += '<g class="pt" data-team="' + t.abbr + '" style="transform:translate(' + X(t.nrtg_a).toFixed(1) + 'px,' + Y(t.title).toFixed(1) + 'px)" tabindex="0" role="button" aria-label="' + esc(t.name) + '">' +
        '<circle class="halo" r="' + (L / 2 + 1) + '" opacity=".85"/><image href="' + logoSrc(t.abbr) + '" x="' + (-L / 2) + '" y="' + (-L / 2) + '" width="' + L + '" height="' + L + '"/></g>';
    });
    host.innerHTML = svg + '</svg>';
    $$('.pt', host).forEach(function (g) {
      var t = S.teams[g.getAttribute('data-team')];
      g.addEventListener('click', function () { openTeam(t.abbr); });
      g.addEventListener('keydown', function (e) { if (e.key === 'Enter') openTeam(t.abbr); });
      g.addEventListener('pointerenter', function (e) {
        if (e.pointerType !== 'mouse') return;
        var r = g.getBoundingClientRect();
        showTip('<b>' + esc(t.name) + '</b><br>Title ' + pct(t.title) + ' · adj. net ' + sign(t.nrtg_a), r.left + r.width / 2, r.top);
      });
      g.addEventListener('pointerleave', hideTip);
    });
  }

  /* ============================================================= SHEETS */

  function openTeam(abbr) {
    var t = S.teams[abbr];
    if (!t) return;
    var odds = (S.data.odds.title && S.data.odds.title.outcomes || []).filter(function (o) { return o.abbr === abbr; })[0];
    function row(label, k, note) {
      return '<tr><td>' + label + (note ? ' <span class="rk" style="text-align:left">' + note + '</span>' : '') + '</td>' +
        '<td><b>' + (k === 'nrtg' ? sign(t[k + '_a']) : t[k + '_a'].toFixed(1)) + '</b> <span class="rk">' + ordinal(t.rk[k + '_a']) + '</span></td>' +
        '<td>' + (k === 'nrtg' ? sign(t[k]) : t[k].toFixed(1)) + ' <span class="rk">' + ordinal(t.rk[k]) + '</span></td></tr>';
    }
    var html =
      '<div class="sh-top">' + logo(abbr, 'logo', t.name) + '<div><h3 id="sheet-title">' + esc(t.name) + '</h3>' +
      '<p>' + t.w + '–' + t.l + ' · ' + t.conf + (odds ? ' · title odds ' + pct(odds.prob) : '') + '</p></div></div>' +
      '<div class="hero"><div class="hero-num">' + sign(t.nrtg_a) + '</div><div class="hero-cap"><b>Adjusted net rating</b><br>' +
      ordinal(t.rk.nrtg_a) + ' of 30 · raw ' + sign(t.nrtg) + ' (' + ordinal(t.rk.nrtg) + ')</div></div>' +
      '<table class="rtable"><thead><tr><th></th><th>Adjusted</th><th>Raw</th></tr></thead><tbody>' +
      row('Offense', 'ortg') + row('Defense', 'drtg', 'lower = better') + row('Net', 'nrtg') + '</tbody></table>' +
      '<div class="tiles" style="margin-top:14px">' +
      '<div class="tile"><span>Schedule</span><b>' + sign(t.sos) + '</b><small>' + ordinal(t.rk.sos) + ' toughest</small></div>' +
      '<div class="tile"><span>Pace</span><b>' + t.pace.toFixed(1) + '</b><small>poss. per game</small></div>' +
      '<div class="tile"><span>Points</span><b>' + t.ppg.toFixed(1) + '</b><small>allow ' + t.oppg.toFixed(1) + '</small></div></div>' +
      '<p class="foot">Schedule = average adjusted net rating of the opponents faced so far. Ratings per 100 possessions.' +
      (t.gp < t.w + t.l ? ' Ratings cover ' + t.gp + ' of ' + (t.w + t.l) + ' games; ESPN’s season totals catch up a few hours after games end.' : '') + '</p>' +
      threeChart(t);
    openSheet(html);
  }

  function threeChart(t) {
    var lgp = S.data.league.tp;
    var all = t.roster.map(function (id) { return [id, S.players[id]]; }).filter(function (r) { return r[1]; });
    var rows = all.filter(function (r) { return r[1].tpa > 0; });
    var none = all.filter(function (r) { return r[1].tpa === 0; });
    if (!rows.length) return '';
    var dmax = 70;
    var x = function (v) { return (clamp(v, 0, dmax) / dmax * 100).toFixed(2); };
    var maxA = Math.max.apply(null, rows.map(function (r) { return r[1].tpa; }));
    var html = '<div class="section-t">3-point shooting <small>sorted by attempts</small></div>' +
      '<div class="tp-head"><span>Team <b>' + (t.tp != null ? t.tp.toFixed(1) + '%' : '–') + '</b> on ' + t.tpa_g.toFixed(1) + ' attempts a game</span>' +
      '<span>League ' + (lgp != null ? lgp.toFixed(1) + '%' : '–') + '</span></div>' +
      '<div class="tp-axis" aria-hidden="true"><span></span><span class="track">' + [0, 20, 40, 60].map(function (v) {
        return '<span class="tick" style="left:' + x(v) + '%">' + v + '%</span>';
      }).join('') + '</span><span></span></div>';
    html += rows.map(function (r) {
      var id = r[0], p = r[1], v = p.tp, above = v >= lgp;
      var lo = Math.min(v, lgp), hi = Math.max(v, lgp);
      var dsz = (7 + 9 * Math.sqrt(p.tpa / maxA)).toFixed(1);
      return '<button type="button" class="tp-row' + (p.tpa < 10 ? ' small' : '') + '" data-player="' + esc(id) + '" aria-label="' +
        esc(p.name) + ', ' + p.tpm + ' of ' + p.tpa + ' threes, ' + v.toFixed(1) + ' percent">' +
        '<span class="tp-name">' + esc(p.short || p.name) + '</span><span class="track">' +
        '<span class="avg" style="left:' + x(lgp) + '%"></span>' +
        '<span class="stem ' + (above ? 'pos' : 'neg') + '" style="left:' + x(lo) + '%;width:' + (x(hi) - x(lo)).toFixed(2) + '%"></span>' +
        '<span class="bub ' + (above ? 'pos' : 'neg') + '" style="left:' + x(v) + '%;width:' + dsz + 'px;height:' + dsz + 'px"></span></span>' +
        '<span class="tp-val"><small>' + p.tpm + '/' + p.tpa + '</small><b>' + v.toFixed(1) + '%</b></span></button>';
    }).join('');
    html += '<div class="tp-legend"><span><i style="width:9px;height:9px;background:var(--pos)"></i>above league average</span>' +
      '<span><i style="width:9px;height:9px;background:var(--neg)"></i>below</span><span>bigger dot = more attempts</span>' +
      '<span>faded = fewer than 10 attempts</span></div>';
    if (none.length) html += '<p class="tp-none">No threes attempted: ' + none.map(function (r) { return esc(r[1].short || r[1].name); }).join(', ') + '.</p>';
    return html;
  }

  function openPlayer(id) {
    var p = S.players[id];
    if (!p) return;
    var t = S.teams[p.team];
    var mvp = (S.data.odds.mvp && S.data.odds.mvp.outcomes || []).filter(function (o) { return o.player === id; })[0];
    var ranks = S.data.leaders.stats.map(function (s) {
      var r = S.ranks[s.key][id];
      return r && r <= 20 ? '<span class="pill">' + ordinal(r) + ' in ' + esc(s.label.toLowerCase()) + '</span>' : '';
    }).join('');
    var html =
      '<div class="sh-top">' + playerHead(id, 60) + '<div><h3 id="sheet-title">' + esc(p.name) + '</h3>' +
      '<p>' + esc(t ? t.name : p.team) + (p.pos ? ' · ' + esc(p.pos) : '') + ' · ' + p.gp + ' GP · ' + p.mpg.toFixed(1) + ' min</p></div></div>' +
      '<div class="tiles">' +
      '<div class="tile"><span>Points</span><b>' + p.pts.toFixed(1) + '</b></div>' +
      '<div class="tile"><span>Rebounds</span><b>' + p.reb.toFixed(1) + '</b></div>' +
      '<div class="tile"><span>Assists</span><b>' + p.ast.toFixed(1) + '</b></div></div>' +
      '<div class="tiles four" style="margin-top:8px">' +
      '<div class="tile"><span>Steals</span><b>' + p.stl.toFixed(1) + '</b></div>' +
      '<div class="tile"><span>Blocks</span><b>' + p.blk.toFixed(1) + '</b></div>' +
      '<div class="tile"><span>3P</span><b>' + (p.tp != null ? p.tp.toFixed(1) + '%' : '–') + '</b><small>' + p.tpm + '/' + p.tpa + '</small></div>' +
      '<div class="tile"><span>TS%</span><b>' + (p.ts != null ? p.ts.toFixed(1) : '–') + '</b></div></div>' +
      (mvp ? '<div class="section-t">MVP market</div><div class="pills"><span class="pill">' + pct(mvp.prob) + ' to win MVP</span></div>' : '') +
      (ranks ? '<div class="section-t">Leaderboard ranks</div><div class="pills">' + ranks + '</div>' :
        (!p.q ? '<p class="foot">Not on the leaderboards yet: hasn’t played enough games to qualify.</p>' : '')) +
      (t ? '<div class="section-t">Team</div><button type="button" class="bar-row" data-team="' + t.abbr + '">' + logo(t.abbr) +
        '<span class="bar-main"><span class="bar-name">' + esc(t.name) + '</span><span class="bar-sub">' + t.w + '–' + t.l +
        ' · adj. net ' + sign(t.nrtg_a) + ' · roster 3P% chart</span></span><span class="bar-val">›</span></button>' : '');
    openSheet(html);
  }

  /* ------------------------------------------------------------ resizing */

  var rt = null;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(function () {
      if (!S.data || Math.abs(window.innerWidth - S.width) < 24) return;
      S.width = window.innerWidth;
      if (S.tab === 'ratings') drawRatingsBody();
      else if (S.tab === 'leaders') drawSwarm();
      else { drawTrend(S.tab); if (S.tab === 'title') drawMarketVsCourt(); }
    }, 180);
  });
  if (window.matchMedia) {
    var mq = matchMedia('(prefers-color-scheme: dark)');
    var onScheme = function () { if (S.data) render(); };
    if (mq.addEventListener) mq.addEventListener('change', onScheme); else if (mq.addListener) mq.addListener(onScheme);
  }
  setInterval(function () { if (S.data && !S.demo) renderHeader(); }, 60000);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () { /* optional */ }); });
  }

  load();
})();
