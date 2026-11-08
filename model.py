"""Turns the cached ESPN + Polymarket data into the dashboard JSON.

Ratings follow Basketball-Reference's definitions:

  possessions  0.5 * (team poss + opponent poss), each estimated as
               FGA + 0.4*FTA - 1.07*(ORB/(ORB+opp DRB))*(FGA-FG) + TOV
  ORtg / DRtg  points scored / allowed per 100 possessions
  NRtg         ORtg - DRtg

Opponent adjustment ("/A", SRS-style): each team's raw rating is modelled as
its own quality plus the average quality of the opponents it has faced,

  ORtg_i = lg + o_i + mean(d_j over opponents)
  DRtg_i = lg + d_i + mean(o_j over opponents)

with sum(o) = sum(d) = 0, solved by least squares. ORtg/A = lg + o_i and
DRtg/A = lg + d_i: what the team would post against a league-average schedule.
"""

from collections import defaultdict

import numpy as np

EAST = {'ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DET', 'IND', 'MIA', 'MIL',
        'NYK', 'ORL', 'PHI', 'TOR', 'WAS'}

LEADER_STATS = [
    # key, label, short unit, decimals, is percentage
    ('pts', 'Points', 'PPG', 1, False),
    ('reb', 'Rebounds', 'RPG', 1, False),
    ('ast', 'Assists', 'APG', 1, False),
    ('tpm_g', '3-Pointers Made', '3PM', 1, False),
    ('stl', 'Steals', 'SPG', 1, False),
    ('blk', 'Blocks', 'BPG', 1, False),
    ('ts', 'True Shooting', 'TS%', 1, True),
]
TS_MIN_FGA = 10        # TS% leaderboard: at least this many field-goal attempts per game
HEADS_PER_STAT = 10


def _poss(fga, fta, orb, opp_drb, fgm, tov):
    reb = orb + opp_drb
    return fga + 0.4 * fta - 1.07 * (orb / reb if reb else 0) * (fga - fgm) + tov


def _rank(values, reverse):
    order = sorted(values, key=lambda k: values[k], reverse=reverse)
    return {k: i + 1 for i, k in enumerate(order)}


def adjust(raw_o, raw_d, opps, lg):
    """Least-squares opponent adjustment. Returns (ORtg/A, DRtg/A) dicts."""
    teams = sorted(raw_o)
    idx = {t: i for i, t in enumerate(teams)}
    n = len(teams)
    rows, rhs = [], []
    for t in teams:
        ops = [o for o in opps.get(t, []) if o in idx]
        if not ops:
            continue
        w = 1.0 / len(ops)
        r = np.zeros(2 * n)                      # ORtg_t - lg = o_t + mean(d_opp)
        r[idx[t]] = 1
        for o in ops:
            r[n + idx[o]] += w
        rows.append(r)
        rhs.append(raw_o[t] - lg)
        r = np.zeros(2 * n)                      # DRtg_t - lg = d_t + mean(o_opp)
        r[n + idx[t]] = 1
        for o in ops:
            r[idx[o]] += w
        rows.append(r)
        rhs.append(raw_d[t] - lg)
    for block in (0, n):                         # sum(o) = 0, sum(d) = 0
        r = np.zeros(2 * n)
        r[block:block + n] = 10.0
        rows.append(r)
        rhs.append(0.0)
    sol = np.linalg.lstsq(np.array(rows), np.array(rhs), rcond=None)[0]
    return ({t: lg + sol[idx[t]] for t in teams},
            {t: lg + sol[n + idx[t]] for t in teams})


def _team_for(name, teams):
    """Map a Polymarket outcome like 'San Antonio Spurs' to a team abbreviation."""
    low = (name or '').lower()
    best = None
    for abbr, t in teams.items():
        nick = (t.get('nick') or '').lower()
        if nick and low.endswith(nick) and (best is None or len(nick) > len(teams[best]['nick'])):
            best = abbr
    return best


def build(games, teams_meta, season, label, norm_name):
    totals = season.get('totals') or {}
    players_raw = season.get('players') or []
    qualified = set(season.get('qualified') or [])
    odds = season.get('odds') or {}

    # ---- results: record + who played whom
    opps, wins, losses = defaultdict(list), defaultdict(int), defaultdict(int)
    through = None
    for g in games:
        h, a = g['home'], g['away']
        opps[h['abbr']].append(a['abbr'])
        opps[a['abbr']].append(h['abbr'])
        win, lose = (h, a) if h['score'] > a['score'] else (a, h)
        wins[win['abbr']] += 1
        losses[lose['abbr']] += 1
        through = max(through or g['date'], g['date'])

    # ---- raw ratings from season totals
    poss, ortg, drtg = {}, {}, {}
    for abbr, s in totals.items():
        if not s.get('gp'):
            continue
        p_team = _poss(s['fga'], s['fta'], s['orb'], s['opp_drb'], s['fgm'], s['tov'])
        p_opp = _poss(s['opp_fga'], s['opp_fta'], s['opp_orb'], s['drb'], s['opp_fgm'], s['opp_tov'])
        poss[abbr] = 0.5 * (p_team + p_opp)
        ortg[abbr] = 100 * s['pts'] / poss[abbr]
        drtg[abbr] = 100 * s['opp_pts'] / poss[abbr]
    lg = 100 * sum(totals[t]['pts'] for t in poss) / sum(poss.values()) if poss else 110.0
    # ESPN's season totals can lag the scoreboard by a game for a few hours, so
    # only count the opponents of the games the totals already include.
    rated_opps = {t: opps[t][:totals[t]['gp']] for t in poss}
    ortg_a, drtg_a = adjust(ortg, drtg, rated_opps, lg) if poss else ({}, {})

    nrtg = {t: ortg[t] - drtg[t] for t in poss}
    nrtg_a = {t: ortg_a[t] - drtg_a[t] for t in poss}
    pace = {t: poss[t] / totals[t]['gp'] for t in poss}
    sos = {t: float(np.mean([nrtg_a[o] for o in rated_opps[t] if o in nrtg_a])) if rated_opps[t] else 0.0
           for t in poss}
    ranks = {
        'ortg': _rank(ortg, True), 'drtg': _rank(drtg, False), 'nrtg': _rank(nrtg, True),
        'ortg_a': _rank(ortg_a, True), 'drtg_a': _rank(drtg_a, False), 'nrtg_a': _rank(nrtg_a, True),
        'pace': _rank(pace, True), 'sos': _rank(sos, True),
    }

    # ---- odds
    title = odds.get('title') or {}
    title_by_team = {}
    for o in title.get('outcomes', []):
        o['abbr'] = _team_for(o['name'], teams_meta)
        if o['abbr']:
            title_by_team[o['abbr']] = o

    # ---- players
    by_name = {norm_name(p['name']): p['id'] for p in players_raw}
    players, rosters = {}, defaultdict(list)
    for p in players_raw:
        shots = p['fga_g'] + 0.44 * p['fta_g']
        tp = 100 * p['tpm'] / p['tpa'] if p['tpa'] else None
        players[p['id']] = {
            'name': p['name'], 'short': p['short'], 'team': p['team'], 'pos': p['pos'],
            'gp': p['gp'], 'mpg': round(p['mpg'], 1),
            'pts': p['pts'], 'reb': p['reb'], 'ast': p['ast'], 'stl': p['stl'], 'blk': p['blk'],
            'tpm_g': p['tpm_g'], 'tpa_g': p['tpa_g'], 'tpm': p['tpm'], 'tpa': p['tpa'],
            'tp': round(tp, 1) if tp is not None else None,
            'ts': round(100 * p['pts'] / (2 * shots), 1) if shots else None,
            'fga_g': p['fga_g'], 'q': p['id'] in qualified,
        }
        if p['gp'] > 0 and p['team']:
            rosters[p['team']].append(p['id'])
    for abbr in rosters:
        rosters[abbr].sort(key=lambda pid: (-players[pid]['tpa'], -players[pid]['mpg']))

    mvp = odds.get('mvp') or {}
    for o in mvp.get('outcomes', []):
        o['player'] = by_name.get(norm_name(o['name']))

    # ---- leaders (ESPN-qualified players)
    head_ids = set()
    leader_stats = []
    for key, name, unit, dec, pct in LEADER_STATS:
        rows = []
        for pid, p in players.items():
            if not p['q'] or p.get(key) is None:
                continue
            if key == 'ts' and p['fga_g'] < TS_MIN_FGA:
                continue
            rows.append([pid, round(p[key], 1)])
        rows.sort(key=lambda r: -r[1])
        head_ids.update(pid for pid, _ in rows[:HEADS_PER_STAT])
        leader_stats.append({'key': key, 'label': name, 'unit': unit, 'dec': dec, 'pct': pct,
                             'rows': rows})
    head_ids.update(o['player'] for o in mvp.get('outcomes', [])[:12] if o.get('player'))

    # ---- teams
    league_tpm = sum(s.get('tpm', 0) for s in totals.values())
    league_tpa = sum(s.get('tpa', 0) for s in totals.values())
    team_rows = []
    for abbr in sorted(poss):
        meta = teams_meta.get(abbr, {})
        s = totals[abbr]
        t_odds = title_by_team.get(abbr)
        team_rows.append({
            'abbr': abbr, 'name': meta.get('name', abbr), 'nick': meta.get('nick', abbr),
            'conf': 'East' if abbr in EAST else 'West',
            'color': meta.get('color', '#777777'), 'alt': meta.get('alt', '#cccccc'),
            'w': wins[abbr], 'l': losses[abbr], 'gp': s['gp'],
            'ortg': round(ortg[abbr], 2), 'drtg': round(drtg[abbr], 2), 'nrtg': round(nrtg[abbr], 2),
            'ortg_a': round(ortg_a[abbr], 2), 'drtg_a': round(drtg_a[abbr], 2),
            'nrtg_a': round(nrtg_a[abbr], 2),
            'pace': round(pace[abbr], 1), 'sos': round(sos[abbr], 2),
            'ppg': round(s['pts'] / s['gp'], 1), 'oppg': round(s['opp_pts'] / s['gp'], 1),
            'tp': round(100 * s['tpm'] / s['tpa'], 1) if s.get('tpa') else None,
            'tpa_g': round(s['tpa'] / s['gp'], 1),
            'rk': {k: v[abbr] for k, v in ranks.items()},
            'title': round(t_odds['prob'], 4) if t_odds else None,
            'roster': rosters.get(abbr, []),
        })

    return {
        'season': label,
        'through': through,
        'n_games': len(games),
        'league': {'rtg': round(lg, 2), 'tp': round(100 * league_tpm / league_tpa, 1) if league_tpa else None,
                   'pace': round(float(np.mean(list(pace.values()))), 1) if pace else None},
        'teams': team_rows,
        'players': players,
        'leaders': {'stats': leader_stats,
                    'rule': f'ESPN-qualified players; TS% also needs {TS_MIN_FGA}+ FGA per game'},
        'odds': {'title': title, 'mvp': mvp},
        'head_ids': sorted(head_ids),
    }


def snapshot(dash):
    """Small daily record for future trend charts."""
    return {
        'through': dash['through'],
        'generated': dash.get('generated'),
        'teams': {t['abbr']: [t['w'], t['l'], t['ortg'], t['drtg'], t['ortg_a'], t['drtg_a']]
                  for t in dash['teams']},
        'title': {o['name']: round(o['prob'], 4) for o in (dash['odds'].get('title') or {}).get('outcomes', [])},
        'mvp': {o['name']: round(o['prob'], 4) for o in (dash['odds'].get('mvp') or {}).get('outcomes', [])},
    }
