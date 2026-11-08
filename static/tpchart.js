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
   * players: [{ id, name, short, tpm, tpa }]  in display order
   * lgp:     league 3P%
   * opts:    { interactive: rows are buttons with data-player, heading: show the section title }
   */
  window.tpChart = function (team, players, lgp, opts) {
    opts = opts || {};
    var rows = players.filter(function (p) { return p.tpa > 0; });
    var none = players.filter(function (p) { return !p.tpa; });
    if (!rows.length) return '<p class="tp-none">No three-point attempts yet.</p>';
    var dmax = 70;
    var x = function (v) { return +(clamp(v, 0, dmax) / dmax * 100).toFixed(2); };
    var maxA = Math.max.apply(null, rows.map(function (p) { return p.tpa; }));
    var html = (opts.heading === false ? '' : '<div class="section-t">3-point shooting <small>sorted by attempts</small></div>') +
      '<div class="tp-head"><span>Team <b>' + (team.tp != null ? team.tp.toFixed(1) + '%' : '–') + '</b> on ' +
      (team.tpa_g != null ? team.tpa_g.toFixed(1) : '–') + ' attempts a game</span>' +
      '<span>League ' + (lgp != null ? lgp.toFixed(1) + '%' : '–') + '</span></div>' +
      '<div class="tp-axis" aria-hidden="true"><span></span><span class="track">' + [0, 20, 40, 60].map(function (v) {
        return '<span class="tick" style="left:' + x(v) + '%">' + v + '%</span>';
      }).join('') + '</span><span></span></div>';
    html += rows.map(function (p) {
      var v = 100 * p.tpm / p.tpa, above = v >= lgp;
      var lo = Math.min(v, lgp), hi = Math.max(v, lgp);
      var dsz = (7 + 9 * Math.sqrt(p.tpa / maxA)).toFixed(1);
      var tag = opts.interactive ? 'button' : 'div';
      return '<' + tag + (opts.interactive ? ' type="button" data-player="' + esc(p.id) + '"' : '') +
        ' class="tp-row' + (p.tpa < 10 ? ' small' : '') + (opts.interactive ? '' : ' static') + '" aria-label="' +
        esc(p.name) + ', ' + p.tpm + ' of ' + p.tpa + ' threes, ' + v.toFixed(1) + ' percent">' +
        '<span class="tp-name">' + esc(p.short || p.name) + '</span><span class="track">' +
        '<span class="avg" style="left:' + x(lgp) + '%"></span>' +
        '<span class="stem ' + (above ? 'pos' : 'neg') + '" style="left:' + x(lo) + '%;width:' + (x(hi) - x(lo)).toFixed(2) + '%"></span>' +
        '<span class="bub ' + (above ? 'pos' : 'neg') + '" style="left:' + x(v) + '%;width:' + dsz + 'px;height:' + dsz + 'px"></span></span>' +
        '<span class="tp-val"><small>' + p.tpm + '/' + p.tpa + '</small><b>' + v.toFixed(1) + '%</b></span></' + tag + '>';
    }).join('');
    html += '<div class="tp-legend"><span><i style="width:9px;height:9px;background:var(--pos)"></i>above league average</span>' +
      '<span><i style="width:9px;height:9px;background:var(--neg)"></i>below</span><span>bigger dot = more attempts</span>' +
      '<span>faded = fewer than 10 attempts</span></div>';
    if (none.length) {
      html += '<p class="tp-none">No threes attempted: ' + none.map(function (p) { return esc(p.short || p.name); }).join(', ') + '.</p>';
    }
    return html;
  };
})();
