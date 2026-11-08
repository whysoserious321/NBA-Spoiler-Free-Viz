/* Start screen shared by the dashboard and the 3P% page: on every load you
   choose Live, Up to a date (a saved game day), or Demo before any data is
   fetched. ?live=1, ?date=YYYY-MM-DD or ?demo=1 in the URL skip the question. */
(function () {
  'use strict';

  var KEY = 'nbaviz-choice';
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function day(iso, long) {
    return new Date(iso + 'T12:00:00').toLocaleDateString('en-US',
      long ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric' });
  }
  function valid(c) {
    return c && (c.mode === 'live' || c.mode === 'demo' || (c.mode === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(c.date || '')));
  }

  /* A choice given in the URL (used by links between the two pages). */
  function fromUrl() {
    var q = new URLSearchParams(location.search), c = null;
    if (q.get('demo') === '1') c = { mode: 'demo' };
    else if (q.get('live') === '1') c = { mode: 'live' };
    else if (q.get('date')) c = { mode: 'date', date: q.get('date') };
    if (q.has('demo') || q.has('live') || q.has('date')) {
      try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* ignore */ }
    }
    if (valid(c)) { store.set(KEY, JSON.stringify(c)); return c; }
    return null;
  }

  function last() {
    try { var c = JSON.parse(store.get(KEY) || 'null'); return valid(c) ? c : null; } catch (e) { return null; }
  }

  /* Query string for the data endpoints. */
  function query(c) { return c.mode === 'demo' ? '?demo=1' : c.mode === 'date' ? '?date=' + c.date : ''; }
  /* Query string for links to the other page, so it opens with the same choice. */
  function linkQuery(c) { return c.mode === 'live' ? '?live=1' : query(c); }

  function pill(c) {
    if (c.mode === 'demo') return { text: 'Demo data', cls: 'demo' };
    if (c.mode === 'date') return { text: 'To ' + day(c.date), cls: 'date' };
    return { text: 'Live', cls: 'live' };
  }

  /* Show the start screen; calls done(choice). opts.cancelable adds "Keep current". */
  function ask(done, opts) {
    opts = opts || {};
    var prev = last();
    var el = document.createElement('div');
    el.className = 'gate' + (opts.cancelable ? ' over' : '');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'gate-title');
    el.innerHTML = '<div class="gate-card"><p class="gate-load">Loading…</p></div>';
    document.body.appendChild(el);
    document.body.classList.add('gate-open');

    function close() {
      document.removeEventListener('keydown', onKey);
      el.remove();
      if (!document.querySelector('.gate')) document.body.classList.remove('gate-open');
    }
    function choose(c) {
      store.set(KEY, JSON.stringify(c));
      close();
      done(c);
    }
    function onKey(e) { if (e.key === 'Escape' && opts.cancelable) close(); }
    document.addEventListener('keydown', onKey);

    fetch('/api/dates', { cache: 'no-cache' })
      .then(function (r) { return r.json(); })
      .catch(function () { return { dates: [] }; })
      .then(function (info) {
        var dates = info.dates || [];
        var pick = prev && prev.mode === 'date' && dates.indexOf(prev.date) >= 0 ? prev.date : dates[0];
        var was = prev ? prev.mode : null;
        var opt = function (mode, title, sub, extra) {
          return '<div class="gate-opt' + (was === mode ? ' last' : '') + '">' +
            '<span class="gate-dot ' + mode + '"></span><span class="gate-txt"><b>' + title + '</b><small>' + sub + '</small>' +
            (extra || '') + '</span></div>';
        };
        el.firstChild.innerHTML =
          '<p class="kicker">NBAViz</p><h2 id="gate-title">What do you want to see?</h2>' +
          '<p class="gate-sub">Behind on games? Pick the last game day you have watched and nothing after it will show, ' +
          'not even in the odds.</p>' +
          '<button type="button" class="gate-btn" data-mode="live">' +
          opt('live', 'Live', 'Everything up to now' + (info.live_through ? ', games through ' + esc(day(info.live_through, true)) : '')) +
          '</button>' +
          '<div class="gate-btn gate-dated">' +
          opt('date', 'Up to a date', 'Only games up to and including:',
            dates.length
              ? '<span class="gate-row"><select id="gate-day" aria-label="Last game day you have watched">' +
                dates.map(function (d, i) {
                  return '<option value="' + d + '"' + (d === pick ? ' selected' : '') + '>' + esc(day(d, true)) + (i === 0 ? ' (latest)' : '') + '</option>';
                }).join('') + '</select><button type="button" class="gate-go" data-mode="date">Show</button></span>'
              : '<small class="gate-none">No saved days yet. Every morning’s refresh saves the night before.</small>') +
          '</div>' +
          '<button type="button" class="gate-btn" data-mode="demo">' + opt('demo', 'Demo', 'Made-up numbers and players') + '</button>' +
          (opts.cancelable ? '<button type="button" class="gate-cancel">Keep current</button>' : '');
        el.addEventListener('click', function (e) {
          var b = e.target.closest('[data-mode]');
          if (e.target.closest('.gate-cancel')) { close(); return; }
          if (!b) return;
          var mode = b.getAttribute('data-mode');
          if (mode === 'date') choose({ mode: 'date', date: el.querySelector('#gate-day').value });
          else choose({ mode: mode });
        });
        var first = el.querySelector(was === 'date' && dates.length ? '#gate-day' : '[data-mode="' + (was || 'live') + '"]') ||
          el.querySelector('[data-mode]');
        if (first) first.focus({ preventScroll: true });
      });
  }

  window.NBAGate = { fromUrl: fromUrl, ask: ask, query: query, linkQuery: linkQuery, pill: pill, day: day };
})();
