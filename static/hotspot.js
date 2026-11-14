/* Hot-zone chart (NBA 2K style) for the 3-point page's player sheet: a half
   court split into 14 zones, each coloured by the player's FG% there against
   the league's in the same zone. Data: /api/shots. The zone shapes match
   zone() in shots.py; change both together. */
(function () {
  'use strict';

  var NAMES = [
    'Restricted area', 'Short range, left', 'Short range, middle', 'Short range, right',
    'Mid-range, left baseline', 'Mid-range, left wing', 'Mid-range, top', 'Mid-range, right wing', 'Mid-range, right baseline',
    'Left corner 3', 'Left wing 3', 'Top of the key 3', 'Right wing 3', 'Right corner 3',
  ];
  var MIN_ATT = 10;               // fewer attempts: hatched, no colour
  var STEPS = [3, 6, 10];         // FG% points from the league average for the 3 colour steps

  // Court in feet: x 0-50 across, y down the court from the baseline; basket at the top.
  var BX = 25, BY = 5.25, R3 = 23.75, RS = 14, RR = 5, BOTTOM = 35;
  var CY = BY + Math.sqrt(R3 * R3 - 22 * 22);          // where the 3-point arc meets the corner line
  var BXR = Math.sqrt(RS * RS - BY * BY);              // where the 14-ft circle meets the baseline

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function f(n) { return +n.toFixed(2); }
  // Point at distance r from the basket, angle a in degrees from straight out (negative = left).
  function P(r, a) { var t = a * Math.PI / 180; return f(BX + r * Math.sin(t)) + ' ' + f(BY + r * Math.cos(t)); }
  // Arc to `to`. sweep 0 = angle growing (left to right through the front), 1 = shrinking.
  function arc(r, to, sweep, large) { return ' A' + r + ' ' + r + ' 0 ' + (large ? 1 : 0) + ' ' + sweep + ' ' + to; }
  function ray(a) {
    var t = a * Math.PI / 180, k = (BOTTOM - BY) / Math.cos(t);
    return f(BX + k * Math.sin(t)) + ' ' + BOTTOM;
  }
  function sector(r1, r2, a1, a2) {
    return 'M' + P(r1, a1) + arc(r1, P(r1, a2), 0) + ' L' + P(r2, a2) + arc(r2, P(r2, a1), 1) + 'Z';
  }

  var TILES = (function () {
    var t = [];
    t[0] = 'M' + (BX - RR) + ' ' + BY + arc(RR, (BX + RR) + ' ' + BY, 0, 1) + arc(RR, (BX - RR) + ' ' + BY, 0, 1) + 'Z';
    t[2] = sector(RR, RS, -30, 30);
    t[5] = sector(RS, R3, -60, -22.5);
    t[6] = sector(RS, R3, -22.5, 22.5);
    t[7] = sector(RS, R3, 22.5, 60);
    t[11] = 'M' + P(R3, -22.5) + arc(R3, P(R3, 22.5), 0) + ' L' + ray(22.5) + ' L' + ray(-22.5) + 'Z';
    [-1, 1].forEach(function (s) {
      var L = s < 0;
      var X = function (x) { return f(L ? x : 50 - x); };
      var grow = L ? 1 : 0, shrink = L ? 0 : 1;   // sweep when the angle's size grows / shrinks
      // short range, one side: from 30 degrees round to the baseline, behind the basket to the middle
      t[L ? 1 : 3] = 'M' + P(RS, 30 * s) + arc(RS, X(BX - BXR) + ' 0', grow) + ' L' + BX + ' 0 L' + P(RR, 180 * s) +
        arc(RR, P(RR, 30 * s), shrink) + 'Z';
      // mid-range baseline: from 60 degrees to the 3-point line, the corner line and the baseline
      t[L ? 4 : 8] = 'M' + P(RS, 60 * s) + arc(RS, X(BX - BXR) + ' 0', grow) + ' L' + X(3) + ' 0 L' + X(3) + ' ' + f(CY) +
        arc(R3, P(R3, 60 * s), shrink) + 'Z';
      t[L ? 9 : 13] = 'M' + X(0) + ' 0 L' + X(3) + ' 0 L' + X(3) + ' ' + f(CY) + ' L' + X(0) + ' ' + f(CY) + 'Z';
      t[L ? 10 : 12] = 'M' + X(0) + ' ' + f(CY) + ' L' + X(3) + ' ' + f(CY) + arc(R3, P(R3, 22.5 * s), shrink) +
        ' L' + ray(22.5 * s) + ' L' + X(0) + ' ' + BOTTOM + 'Z';
    });
    return t;
  })();

  // Where each zone's percentage goes when it is selected.
  var LABEL = [[25, 8.6], [P(9.5, -70)], [25, 14.6], [P(9.5, 70)], [P(17.5, -80)], [P(19, -41)], [25, 24.3],
    [P(19, 41)], [P(17.5, 80)], [1.5, 7.5], [P(28.5, -48)], [25, 31.5], [P(28.5, 48)], [48.5, 7.5]].map(function (v) {
    return v.length === 2 ? v : v[0].split(' ').map(Number);
  });

  var COURT =
    '<rect x="0" y="0" width="50" height="' + BOTTOM + '"/>' +
    '<rect x="17" y="0" width="16" height="19"/>' +
    '<circle cx="25" cy="19" r="6"/>' +
    '<path d="M3 0 L3 ' + f(CY) + arc(R3, '47 ' + f(CY), 0) + ' L47 0"/>' +
    '<path d="M21 ' + BY + ' A4 4 0 0 0 29 ' + BY + '"/>' +
    '<path d="M22 4 L28 4"/>' +
    '<circle cx="25" cy="' + BY + '" r=".75"/>';

  function pct(m, a) { return a ? 100 * m / a : null; }
  function cls(z, lg) {
    if (z[1] < MIN_ATT) return 'few';
    var d = pct(z[0], z[1]) - (pct(lg[0], lg[1]) || 0), ad = Math.abs(d);
    if (ad < STEPS[0]) return 'n';
    return (d > 0 ? 'h' : 'c') + (ad >= STEPS[2] ? 3 : ad >= STEPS[1] ? 2 : 1);
  }
  function signed(v) { return (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(1); }

  /* data: an /api/shots answer; state: { view: 'season' | 'career', sel: zone number or null } */
  function render(data, state) {
    var v = state.view === 'career' ? data.career : data.season;
    var zones = v.zones, lg = v.league, sel = state.sel;
    var att = zones.reduce(function (s, z) { return s + z[1]; }, 0);
    var made = zones.reduce(function (s, z) { return s + z[0]; }, 0);
    var lgAtt = lg.reduce(function (s, z) { return s + z[1]; }, 0);
    var lgMade = lg.reduce(function (s, z) { return s + z[0]; }, 0);
    var c = data.career;

    var span;
    if (state.view === 'season') {
      span = esc(data.season.label) + ' season' + (data.mode === 'date' && data.asof ? ', games through ' + esc(window.NBAGate ? NBAGate.day(data.asof, true) : data.asof) : '');
    } else if (!c.seasons.length) {
      span = 'No shots yet';
    } else if (!c.past && c.complete) {
      span = 'First season: career = this season';
    } else {
      span = esc(c.seasons[0]) + (c.seasons.length > 1 ? ' to ' + esc(c.seasons[c.seasons.length - 1]) : '') +
        ' · ' + c.seasons.length + ' season' + (c.seasons.length === 1 ? '' : 's') +
        (c.complete ? '' : ' (earlier seasons still being fetched)');
    }

    var html = '<div class="hz-top"><div class="seg" role="group" aria-label="Season or career">' +
      ['season', 'career'].map(function (k) {
        return '<button type="button" data-hz-view="' + k + '" aria-pressed="' + (state.view === k) + '">' +
          (k === 'season' ? 'Season' : 'Career') + '</button>';
      }).join('') + '</div><span class="hz-span">' + span + '</span></div>';

    html += '<svg class="hz-court" viewBox="-0.6 -0.6 51.2 ' + (BOTTOM + 1.2) + '" role="group" aria-label="Hot zones on a half court, basket at the top">' +
      '<defs><pattern id="hz-hatch" width="1.6" height="1.6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">' +
      '<rect width="1.6" height="1.6" class="hz-hatch-bg"/><line x1="0" y1="0" x2="0" y2="1.6" class="hz-hatch-ln"/></pattern></defs><g>' +
      TILES.map(function (d, i) {
        var z = zones[i], p = pct(z[0], z[1]), lp = pct(lg[i][0], lg[i][1]);
        var label = NAMES[i] + ': ' + (z[1] ? z[0] + ' of ' + z[1] + ', ' + p.toFixed(1) + ' percent' : 'no shots') +
          (lp != null ? ', league ' + lp.toFixed(1) + ' percent' : '');
        return '<path class="hz-t ' + cls(z, lg[i]) + '" d="' + d + '" data-zone="' + i + '" role="button" tabindex="0" aria-pressed="' +
          (sel === i) + '" aria-label="' + esc(label) + '"/>';
      }).join('') + '</g><g class="hz-lines" aria-hidden="true">' + COURT + '</g>';
    if (sel != null) {
      var z = zones[sel], at = LABEL[sel], small = sel === 9 || sel === 13;
      html += '<path class="hz-sel" d="' + TILES[sel] + '" aria-hidden="true"/>';
      if (z[1]) {
        html += '<text class="hz-lbl' + (small ? ' small' : '') + '" x="' + f(at[0]) + '" y="' + f(at[1]) + '" aria-hidden="true">' +
          Math.round(pct(z[0], z[1])) + '%</text>';
      }
    }
    html += '</svg>';

    if (sel == null) {
      html += '<div class="hz-detail" aria-live="polite"><p class="hz-hint">Tap a zone to see its shooting.</p></div>';
    } else {
      var zs = zones[sel], p = pct(zs[0], zs[1]), lp = pct(lg[sel][0], lg[sel][1]);
      var d = p != null && lp != null ? p - lp : null, k = cls(zs, lg[sel]);
      html += '<div class="hz-detail" aria-live="polite"><p class="hz-d-name">' + esc(NAMES[sel]) + '</p><p class="hz-d-nums">' +
        (zs[1]
          ? '<b>' + p.toFixed(1) + '%</b> <span class="hz-sub">' + zs[0] + ' of ' + zs[1] + '</span>' +
            (lp != null ? ' · league ' + lp.toFixed(1) + '%' : '') +
            (d != null ? ' · <span class="hz-diff ' + (k.charAt(0) === 'h' ? 'hot' : k.charAt(0) === 'c' ? 'cold' : '') + '">' + signed(d) + '</span>' : '') +
            ' · ' + Math.round(100 * zs[1] / att) + '% of shots' + (zs[1] < MIN_ATT ? ' · few shots' : '')
          : 'No shots from here' + (lp != null ? ' · league ' + lp.toFixed(1) + '%' : '')) + '</p></div>';
    }
    html += '<p class="hz-total">' + (att
      ? 'All zones: <b>' + pct(made, att).toFixed(1) + '%</b> on ' + made + ' of ' + att +
        (lgAtt ? ' · league ' + pct(lgMade, lgAtt).toFixed(1) + '%' : '')
      : 'No shots yet.') + '</p>';

    html += '<details class="help" data-help="hz"><summary><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/>' +
      '<path d="M8 7.2v4M8 4.6v.1"/></svg>How to read this</summary><div class="help-body">' +
      '<div class="hz-legend"><span><i class="hz-k h3"></i><i class="hz-k h2"></i><i class="hz-k h1"></i>hot</span>' +
      '<span><i class="hz-k n"></i>about average</span>' +
      '<span><i class="hz-k c1"></i><i class="hz-k c2"></i><i class="hz-k c3"></i>cold</span>' +
      '<span><i class="hz-k few"></i>fewer than ' + MIN_ATT + ' shots</span></div>' +
      '<p class="foot">Each tile is one area of the court, coloured by the player’s field-goal percentage there against the ' +
      'league’s in the same area: <b>red</b> is better (hot), <b>blue</b> is worse (cold), grey is within ' + STEPS[0] + ' points. ' +
      'Darker means a bigger gap (' + STEPS.join(', ') + '+ points). Hatched tiles have too few shots to colour. ' +
      'Tap a tile for its numbers. Left and right are as a shooter facing the basket sees them.</p>' +
      '<p class="foot">Shot locations come from ESPN play-by-play, so the numbers can differ by a shot or two from the season ' +
      'totals; heaves from beyond 35 feet are left out. <b>Career</b> is this season plus up to the last ' + c.max_past +
      ' regular seasons before it (the career 3P% on the page counts every season).</p></div></details>';
    return html;
  }

  window.hotspot = { render: render, names: NAMES };
})();
