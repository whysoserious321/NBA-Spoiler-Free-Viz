/* Shared 3-point chart: one row per player, dot at their 3P%, line from the
   league average, dot size = attempts. Used by the dashboard's team sheet and
   the stand-alone spoiler-free /threes page. */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /**
   * team:    { tp, tpa_g }          team 3P% and attempts per game
   * players: [{ id, name, short, tpm, tpa, ctpm?, ctpa?, first? }]  in display order;
   *          ctpm/ctpa = career totals (this season included), first = first season
   * lgp:     league 3P%
   * opts:    { interactive: rows (and the no-threes names) are buttons with data-player, heading: show the section title,
   *            sort: 'pct' = by 3P%, highest first, players under SMALL attempts last,
   *            domain: [lo, hi] = the 3P% range to draw (default 0-70); values outside it are
   *            drawn as a small arrow at the edge }
   */
  var SMALL = 10;
  function pctOf(p) { return p.tpm / p.tpa; }
  window.tpChart = function (team, players, lgp, opts) {
    opts = opts || {};
    var rows = players.filter(function (p) { return p.tpa > 0; });
    var none = players.filter(function (p) { return !p.tpa; });
    if (!rows.length) return '<p class="tp-none">No three-point attempts yet.</p>';
    if (opts.sort === 'pct') {
      rows = rows.slice().sort(function (a, b) {
        return ((a.tpa < SMALL) - (b.tpa < SMALL)) || (pctOf(b) - pctOf(a)) || (b.tpa - a.tpa);
      });
    }
    // career column only when the data has it (the /threes page)
    var car = rows.some(function (p) { return p.ctpa != null; });
    var d0 = opts.domain ? opts.domain[0] : 0, d1 = opts.domain ? opts.domain[1] : 70;
    var x = function (v) { return +((clamp(v, d0, d1) - d0) / (d1 - d0) * 100).toFixed(2); };
    var tks = [];
    if (!opts.domain) tks = [0, 20, 40, 60];
    else {
      var step = d1 - d0 <= 20 ? 5 : 10;
      for (var tv = Math.ceil(d0 / step) * step; tv <= d1; tv += step) tks.push(tv);
    }
    var maxA = Math.max.apply(null, rows.map(function (p) { return p.tpa; }));
    var html = (opts.heading === false ? '' : '<div class="section-t">3-point shooting</div>') +
      '<div class="tp-head"><span>Team <b>' + (team.tp != null ? team.tp.toFixed(1) + '%' : '–') + '</b> on ' +
      (team.tpa_g != null ? team.tpa_g.toFixed(1) : '–') + ' attempts a game</span>' +
      '<span>League ' + (lgp != null ? lgp.toFixed(1) + '%' : '–') + '</span></div>' +

      '<div class="tp-axis' + (car ? ' car' : '') + '" aria-hidden="true"><span></span><span class="track">' + tks.map(function (v) {
        return '<span class="tick" style="left:' + x(v) + '%">' + v + '%</span>';
      }).join('') + '</span>' + (car ? '<span class="colh">Season</span><span class="colh">Career</span>' : '<span></span>') + '</div>';
    html += rows.map(function (p) {
      var v = 100 * p.tpm / p.tpa, above = v >= lgp;
      var lo = Math.min(v, lgp), hi = Math.max(v, lgp);
      var dsz = (7 + 9 * Math.sqrt(p.tpa / maxA)).toFixed(1);
      var tag = opts.interactive ? 'button' : 'div';
      var cv = car && p.ctpa && !p.first ? 100 * p.ctpm / p.ctpa : null;
      var clip = v < d0 ? ' clip lo' : v > d1 ? ' clip hi' : '';
      // career cell shade: green = shooting better than the career mark this season, red = worse
      var dv = cv != null && p.tpa >= SMALL ? v - cv : 0, ad = Math.abs(dv);
      var shade = ad < 1 ? '' : ' ' + (dv > 0 ? 'hot' : 'cold') + (ad >= 6 ? 3 : ad >= 3 ? 2 : 1);
      var label = esc(p.name) + ', ' + p.tpm + ' of ' + p.tpa + ' threes, ' + v.toFixed(1) + ' percent' +
        (cv != null ? ', career ' + cv.toFixed(1) + ' percent' : car && p.first ? ', first season' : '');
      return '<' + tag + (opts.interactive ? ' type="button" data-player="' + esc(p.id) + '"' : '') +
        ' class="tp-row' + (car ? ' car' : '') + (p.tpa < SMALL ? ' small' : '') + (opts.interactive ? '' : ' static') + '" aria-label="' +
        label + '">' +
        '<span class="tp-name">' + esc(p.short || p.name) + '</span><span class="track">' +
        '<span class="avg" style="left:' + x(lgp) + '%"></span>' +
        '<span class="stem ' + (above ? 'pos' : 'neg') + '" style="left:' + x(lo) + '%;width:' + (x(hi) - x(lo)).toFixed(2) + '%"></span>' +
        (cv != null && cv >= d0 && cv <= d1 ? '<span class="ctick" style="left:' + x(cv) + '%"></span>' : '') +
        '<span class="bub ' + (above ? 'pos' : 'neg') + clip + '" style="left:' + x(v) + '%' +
        (clip ? '' : ';width:' + dsz + 'px;height:' + dsz + 'px') + '"></span></span>' +
        (car
          ? '<span class="tp-val two"><b>' + v.toFixed(1) + '%</b><small>' + p.tpm + '/' + p.tpa + '</small></span>' +
            '<span class="tp-car' + shade + '"' + (shade ? ' title="This season ' + (dv > 0 ? '+' : '−') + ad.toFixed(1) + ' points vs career"' : '') +
            '>' + (cv != null ? cv.toFixed(1) + '%' : p.first ? '<small>1st yr</small>' : '–') + '</span>'
          : '<span class="tp-val"><small>' + p.tpm + '/' + p.tpa + '</small><b>' + v.toFixed(1) + '%</b></span>') +
        '</' + tag + '>';
    }).join('');
    if (none.length) {
      html += '<p class="tp-none">No threes attempted: ' + none.map(function (p) {
        return opts.interactive
          ? '<button type="button" class="tp-none-p" data-player="' + esc(p.id) + '">' + esc(p.short || p.name) + '</button>'
          : esc(p.short || p.name);
      }).join(', ') + '.</p>';
    }
    html +=
      '<details class="help" data-help="tp"><summary><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/>' +
      '<path d="M8 7.2v4M8 4.6v.1"/></svg>How to read this</summary><div class="help-body">' +
      '<p class="foot">Season 3-point shooting, players sorted by ' +
      (opts.sort === 'pct' ? '3P%, best first (players with fewer than ' + SMALL + ' attempts at the bottom)' : 'attempts') +
      '. The line is the league average.' +
      (car ? ' <b>Career</b> is every regular season so far, this one included; the small dark tick marks it on the bar, ' +
        'so a dot right of its tick means a player is shooting better than their career mark. The career number is shaded ' +
        '<b class="tp-k hot2">green</b> when this season is better than the career mark and <b class="tp-k cold2">red</b> when it is worse; ' +
        'darker = a bigger gap (1, 3 and 6+ points). No shade under ' + SMALL + ' attempts.' : '') +
      (opts.domain ? ' The scale is zoomed to ' + d0 + '–' + d1 + '% (league average ± ' + (d1 - d0) / 2 + '), where most shooters are; ' +
        'an arrow at the edge means further out (the number on the right is exact).' : '') + '</p>' +
      '<div class="tp-legend"><span><i style="width:9px;height:9px;background:var(--pos)"></i>above league average</span>' +
      '<span><i style="width:9px;height:9px;background:var(--neg)"></i>below</span><span>bigger dot = more attempts</span>' +
      (car ? '<span><i class="tp-lg-car"></i>career 3P%</span>' : '') +
      '<span>faded = fewer than ' + SMALL + ' attempts</span></div></div></details>';
    return html;
  };
})();
