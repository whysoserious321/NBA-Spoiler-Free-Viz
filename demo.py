"""Spoiler-free demo data: made-up ratings, fictional players, random odds.

Same shape as data/dashboard.json, so the page cannot tell the difference
except for the 'demo' flag (which shows a 'Demo data' badge). Real team names
and logos are kept so the page looks like the real thing; every number and
every player is invented.

    python3 demo.py      # writes data/demo.json and data/demo_shots.json (hot zones)
"""

import math
import os
import random
from datetime import datetime, timedelta, timezone

import model
import scrape

TEAMS = {
    'ATL': ('Atlanta Hawks', 'Hawks', '#c8102e'), 'BKN': ('Brooklyn Nets', 'Nets', '#000000'),
    'BOS': ('Boston Celtics', 'Celtics', '#008348'), 'CHA': ('Charlotte Hornets', 'Hornets', '#008ca8'),
    'CHI': ('Chicago Bulls', 'Bulls', '#ce1141'), 'CLE': ('Cleveland Cavaliers', 'Cavaliers', '#860038'),
    'DAL': ('Dallas Mavericks', 'Mavericks', '#0064b1'), 'DEN': ('Denver Nuggets', 'Nuggets', '#0e2240'),
    'DET': ('Detroit Pistons', 'Pistons', '#1d428a'), 'GSW': ('Golden State Warriors', 'Warriors', '#fdb927'),
    'HOU': ('Houston Rockets', 'Rockets', '#ce0e2d'), 'IND': ('Indiana Pacers', 'Pacers', '#0c2340'),
    'LAC': ('LA Clippers', 'Clippers', '#12173f'), 'LAL': ('Los Angeles Lakers', 'Lakers', '#552583'),
    'MEM': ('Memphis Grizzlies', 'Grizzlies', '#5d76a9'), 'MIA': ('Miami Heat', 'Heat', '#98002e'),
    'MIL': ('Milwaukee Bucks', 'Bucks', '#00471b'), 'MIN': ('Minnesota Timberwolves', 'Timberwolves', '#266092'),
    'NOP': ('New Orleans Pelicans', 'Pelicans', '#0a2240'), 'NYK': ('New York Knicks', 'Knicks', '#1d428a'),
    'OKC': ('Oklahoma City Thunder', 'Thunder', '#007ac1'), 'ORL': ('Orlando Magic', 'Magic', '#0150b5'),
    'PHI': ('Philadelphia 76ers', '76ers', '#1d428a'), 'PHX': ('Phoenix Suns', 'Suns', '#29127a'),
    'POR': ('Portland Trail Blazers', 'Trail Blazers', '#e03a3e'), 'SAC': ('Sacramento Kings', 'Kings', '#5a2d81'),
    'SAS': ('San Antonio Spurs', 'Spurs', '#000000'), 'TOR': ('Toronto Raptors', 'Raptors', '#d91244'),
    'UTA': ('Utah Jazz', 'Jazz', '#4e008e'), 'WAS': ('Washington Wizards', 'Wizards', '#e31837'),
}

FIRST = ['Avery', 'Bram', 'Cass', 'Dario', 'Emeka', 'Felix', 'Gideon', 'Hollis', 'Idris', 'Jalen',
         'Kofi', 'Lucan', 'Milo', 'Nico', 'Orrin', 'Pax', 'Quinn', 'Rafe', 'Silas', 'Tobias',
         'Ulric', 'Vance', 'Wes', 'Xavi', 'Yusuf', 'Zane', 'Arlo', 'Beck', 'Cyrus', 'Dax']
LAST_A = ['Ash', 'Bran', 'Cal', 'Dun', 'El', 'Fair', 'Gar', 'Hol', 'Ing', 'Jes', 'Kil', 'Lock',
          'Mar', 'North', 'Ok', 'Pem', 'Quar', 'Rour', 'Stan', 'Thorn', 'Under', 'Vos', 'Whit', 'Yard']
LAST_B = ['by', 'dell', 'loway', 'more', 'ery', 'banks', 'row', 'ford', 'ram', 'sup', 'bride', 'ett',
          'stead', 'cutt', 'wood', 'itt', 'les', 'ke', 'ton', 'wick', 'hill', 'sen', 'lock', 'ley']
POS = ['G', 'G', 'F', 'F', 'C', 'G', 'F', 'C', 'G', 'F', 'G', 'F', 'C', 'G', 'F']


def _rank(values, reverse):
    order = sorted(values, key=lambda k: values[k], reverse=reverse)
    return {k: i + 1 for i, k in enumerate(order)}


def _walk(rng, end_price, start_ts, end_ts, step=43200):
    """Random walk ending exactly at end_price (Polymarket-style 12h history)."""
    n = max(2, int((end_ts - start_ts) / step))
    p, pts = end_price, []
    for i in range(n):
        pts.append([end_ts - i * step, round(min(0.95, max(0.002, p)), 4)])
        p *= math.exp(rng.gauss(0, 0.06))
    return pts[::-1]


def build(seed=11):
    rng = random.Random(seed)
    # career 3P% and standings splits use their own stream, so every other demo number stays as it was
    xr = random.Random(seed + 1000)
    lg = 114.0
    now = int(datetime.now(timezone.utc).timestamp())

    # ---- teams
    raw = {}
    for abbr in TEAMS:
        o, d = rng.gauss(0, 3.6), rng.gauss(0, 3.6)
        so, sd = rng.gauss(0, 2.2), rng.gauss(0, 2.2)          # made-up schedule effect
        raw[abbr] = {'ortg_a': lg + o, 'drtg_a': lg - d, 'ortg': lg + o + so, 'drtg': lg - d + sd}
    shift_o = lg - sum(r['ortg_a'] for r in raw.values()) / 30
    shift_d = lg - sum(r['drtg_a'] for r in raw.values()) / 30
    for r in raw.values():
        r['ortg_a'] += shift_o
        r['drtg_a'] += shift_d
        r['nrtg'] = r['ortg'] - r['drtg']
        r['nrtg_a'] = r['ortg_a'] - r['drtg_a']
        r['pace'] = rng.gauss(99.5, 2.4)
        r['sos'] = (r['nrtg_a'] - r['nrtg']) * 0.9 + rng.gauss(0, 0.6)
    ranks = {k: _rank({a: r[k] for a, r in raw.items()}, k not in ('drtg', 'drtg_a'))
             for k in ('ortg', 'drtg', 'nrtg', 'ortg_a', 'drtg_a', 'nrtg_a', 'pace', 'sos')}

    # ---- title odds from adjusted net rating plus noise
    weights = {a: math.exp(0.32 * r['nrtg_a'] + rng.gauss(0, 0.5)) for a, r in raw.items()}
    wsum = sum(weights.values())
    title_out = []
    for abbr, w in sorted(weights.items(), key=lambda kv: -kv[1]):
        prob = w / wsum
        title_out.append({'name': TEAMS[abbr][0], 'abbr': abbr, 'price': round(prob * 1.045, 4),
                          'prob': prob, 'd1': round(rng.gauss(0, 0.006), 4) if rng.random() < .7 else None,
                          'w1': round(rng.gauss(0, 0.015), 4), 'image': None})
    for o in title_out[:scrape.HISTORY_TOP_N]:
        o['history'] = _walk(rng, o['price'], now - 180 * 86400, now)

    # ---- fictional players
    surnames = [a + b for a in LAST_A for b in LAST_B]
    rng.shuffle(surnames)
    players, rosters = {}, {a: [] for a in TEAMS}
    pid = 900000
    for abbr in TEAMS:
        tq = raw[abbr]['nrtg_a']
        for slot in range(15):
            name = f'{rng.choice(FIRST)} {surnames.pop()}'
            pid += 1
            gp = max(1, min(10, int(rng.gauss(8.5, 1.6)))) if slot < 12 else rng.randint(1, 5)
            mpg = max(4.0, rng.gauss(34 - slot * 2.3, 3))
            star = 1.0 + (0.25 if slot == 0 and rng.random() < .45 else 0) + tq * 0.01
            pos = POS[slot]
            fga = max(0.8, mpg * rng.uniform(0.27, 0.45) * star * (1.08 if slot < 2 else 0.85))
            tpa = fga * {'G': 0.48, 'F': 0.38, 'C': 0.12}[pos] * rng.uniform(0.6, 1.3)
            tpa_tot = int(round(tpa * gp))
            tp_pct = min(0.6, max(0.0, rng.gauss(0.355, 0.06 if tpa_tot > 25 else 0.14)))
            tpm_tot = int(round(tpa_tot * tp_pct))
            fta = fga * rng.uniform(0.15, 0.38)
            pts = fga * rng.uniform(0.98, 1.22) + fta * 0.78
            short = f'{name[0]}. {name.split(" ", 1)[1]}'
            shots = fga + 0.44 * fta
            players[str(pid)] = {
                'name': name, 'short': short, 'team': abbr, 'pos': pos, 'gp': gp, 'mpg': round(mpg, 1),
                'pts': round(pts, 1),
                'reb': round(mpg * {'G': 0.13, 'F': 0.2, 'C': 0.3}[pos] * rng.uniform(0.7, 1.3), 1),
                'ast': round(mpg * {'G': 0.14, 'F': 0.08, 'C': 0.06}[pos] * rng.uniform(0.6, 1.5) * star, 1),
                'stl': round(mpg * 0.03 * rng.uniform(0.5, 1.7), 1),
                'blk': round(mpg * {'G': 0.01, 'F': 0.02, 'C': 0.055}[pos] * rng.uniform(0.4, 1.8), 1),
                'tpm_g': round(tpm_tot / gp, 1), 'tpa_g': round(tpa_tot / gp, 1),
                'tpm': tpm_tot, 'tpa': tpa_tot,
                'tp': round(100 * tpm_tot / tpa_tot, 1) if tpa_tot else None,
                'ts': round(100 * pts / (2 * shots), 1), 'fga_g': round(fga, 1),
                'q': gp >= 6 and mpg >= 12, 'head': False,
            }
            # made-up career 3PM/3PA (this season included); some are in their first season
            if xr.random() < 0.12:
                players[str(pid)].update(ctpm=tpm_tot, ctpa=tpa_tot, first=True)
            else:
                prev_a = int(tpa * xr.uniform(25, 70) * xr.randint(1, 11))
                prev_m = int(round(prev_a * min(0.47, max(0.15, tp_pct + xr.gauss(0, 0.035)))))
                players[str(pid)].update(ctpm=tpm_tot + prev_m, ctpa=tpa_tot + prev_a, first=False)
            rosters[abbr].append(str(pid))
        rosters[abbr].sort(key=lambda p: (-players[p]['tpa'], -players[p]['mpg']))

    leader_stats = []
    for key, label, unit, dec, pct in model.LEADER_STATS:
        rows = [[p, round(v[key], 1)] for p, v in players.items()
                if v['q'] and (key != 'ts' or v['fga_g'] >= model.TS_MIN_FGA)]
        rows.sort(key=lambda r: -r[1])
        leader_stats.append({'key': key, 'label': label, 'unit': unit, 'dec': dec, 'pct': pct, 'rows': rows})

    # ---- MVP market: best scorers on good teams
    cands = sorted((p for p in players.values() if p['q']),
                   key=lambda p: -(p['pts'] + p['ast'] + p['reb'] * 0.6 + raw[p['team']]['nrtg_a'] * 1.5))
    by_name = {p['name']: k for k, p in players.items()}
    mw = [math.exp(-0.42 * i + rng.gauss(0, 0.25)) for i in range(34)]
    msum = sum(mw)
    mvp_out = []
    for i, p in enumerate(cands[:34]):
        prob = mw[i] / msum
        mvp_out.append({'name': p['name'], 'player': by_name[p['name']], 'price': round(prob * 1.04, 4),
                        'prob': prob, 'd1': round(rng.gauss(0, 0.008), 4) if rng.random() < .6 else None,
                        'w1': None, 'image': None, 'head': None})
    mvp_out.sort(key=lambda o: -o['prob'])
    for o in mvp_out[:scrape.HISTORY_TOP_N]:
        o['history'] = _walk(rng, o['price'], now - 24 * 86400, now)

    # ---- assemble in dashboard.json's shape
    team_rows = []
    for abbr, (name, nick, color) in sorted(TEAMS.items()):
        r = raw[abbr]
        gp = rng.choice([8, 9, 9, 10])
        w = max(0, min(gp, round(gp / 2 + r['nrtg'] / 3.2 + rng.gauss(0, 0.8))))
        roster = rosters[abbr]
        tpm = sum(players[p]['tpm'] for p in roster)
        tpa = sum(players[p]['tpa'] for p in roster)
        # standings splits: a made-up game-by-game sequence with exactly w wins
        seq = ['W'] * w + ['L'] * (gp - w)
        xr.shuffle(seq)
        at_home = [i % 2 == 0 for i in range(gp)]
        xr.shuffle(at_home)
        in_conf = [xr.random() < 0.6 for _ in range(gp)]
        rec = lambda pick: [sum(1 for i in range(gp) if pick(i) and seq[i] == 'W'),
                            sum(1 for i in range(gp) if pick(i) and seq[i] == 'L')]
        run = 0
        for res in reversed(seq):            # (not `r`: that is this team's ratings)
            if res != seq[-1]:
                break
            run += 1
        team_rows.append({
            'abbr': abbr, 'name': name, 'nick': nick, 'conf': 'East' if abbr in model.EAST else 'West',
            'color': color, 'alt': '#cccccc', 'w': w, 'l': gp - w, 'gp': gp,
            'home': rec(lambda i: at_home[i]), 'away': rec(lambda i: not at_home[i]),
            'conf_rec': rec(lambda i: in_conf[i]), 'l10': rec(lambda i: i >= gp - 10),
            'strk': f'{seq[-1]}{run}' if seq else None,
            **{k: round(r[k], 2) for k in ('ortg', 'drtg', 'nrtg', 'ortg_a', 'drtg_a', 'nrtg_a', 'sos')},
            'pace': round(r['pace'], 1), 'ppg': round(r['ortg'] * r['pace'] / 100, 1),
            'oppg': round(r['drtg'] * r['pace'] / 100, 1),
            'tp': round(100 * tpm / tpa, 1) if tpa else None, 'tpa_g': round(tpa / gp, 1),
            'rk': {k: v[abbr] for k, v in ranks.items()},
            'title': round(next(o['prob'] for o in title_out if o['abbr'] == abbr), 4),
            'roster': roster,
        })
    seeds = model.conference_seeds({t['abbr']: (t['w'], t['l']) for t in team_rows},
                                   {t['abbr']: t['conf'] for t in team_rows},
                                   diff={t['abbr']: t['nrtg'] for t in team_rows})
    for t in team_rows:
        t['seed'] = seeds.get(t['abbr'])
    # made-up long-term injuries for the injury marker: core players on six teams
    # (two on the first, a suspension on the last). Own random stream, so every
    # number above stays as it was.
    ir = random.Random(seed + 2000)
    today = datetime.now(scrape.US_EAST).date()
    for t in team_rows:
        t['inj'] = []
    for i, t in enumerate(ir.sample(team_rows, 6)):
        top = sorted(t['roster'], key=lambda q: -players[q]['pts'])[:model.INJ_TOP]
        susp = i == 5
        for pid in sorted(ir.sample(top, 2 if i == 0 else 1), key=lambda q: -players[q]['pts']):
            p = players[pid]
            t['inj'].append({
                'id': pid, 'name': p['name'], 'short': p['short'], 'status': 'susp' if susp else 'out',
                'part': None if susp else ir.choice(['Knee', 'Ankle', 'Hamstring', 'Foot', 'Back', 'Calf', 'Wrist']),
                'ret': (today + timedelta(days=ir.randint(12, 45))).isoformat(),
                'missed': max(0, t['gp'] - p['gp']), 'of': t['gp'], 'ppg': p['pts'], 'mpg': p['mpg'], 'basis': 'now',
            })
    all_tpm = sum(p['tpm'] for p in players.values())
    all_tpa = sum(p['tpa'] for p in players.values())
    return {
        'demo': True,
        'season': '2026-27', 'through': None, 'n_games': 0,
        'league': {'rtg': lg, 'tp': round(100 * all_tpm / all_tpa, 1), 'pace': 99.5},
        'teams': team_rows, 'players': players,
        'leaders': {'stats': leader_stats,
                    'rule': f'Demo data. Real rule: ESPN-qualified players; TS% also needs {model.TS_MIN_FGA}+ FGA per game'},
        'odds': {
            'title': {'slug': 'demo', 'title': 'Demo: 2027 Champion', 'volume': 12_345_678,
                      'total_price': 1.045, 'outcomes': title_out},
            'mvp': {'slug': 'demo', 'title': 'Demo: 2026-27 MVP', 'volume': 234_567,
                    'total_price': 1.04, 'outcomes': mvp_out},
        },
        'generated': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'injuries_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'requests': 0,
    }


def _split(total, weights):
    """total split over weights in whole numbers that add up exactly (largest remainder)."""
    s = sum(weights) or 1.0
    raw = [total * w / s for w in weights]
    out = [int(r) for r in raw]
    for i in sorted(range(len(raw)), key=lambda i: -(raw[i] - out[i]))[:total - sum(out)]:
        out[i] += 1
    return out


def _deal(rng, made, atts, pcts):
    """Exactly `made` makes over zones with these attempts, never more than a zone's attempts."""
    m = [0] * len(atts)
    for _ in range(min(made, sum(atts))):
        w = [(a - k) * p for a, k, p in zip(atts, m, pcts)]
        r, pick = rng.random() * sum(w), None
        for i, wi in enumerate(w):
            if wi > 0:
                pick = i
                r -= wi
                if r < 0:
                    break
        m[pick] += 1
    return m


def _binom(rng, n, p):
    if n < 60:
        return sum(1 for _ in range(n) if rng.random() < p)
    sd = math.sqrt(n * p * (1 - p))
    return int(max(0, min(n, round(rng.gauss(n * p, sd)))))


# Made-up shot profile: share of 2-point attempts per zone 0-8 and of threes per zone 9-13
# (see shots.py for the zones), and league-ish FG% in the 2-point zones.
TWO_W = [0.36, 0.06, 0.09, 0.06, 0.035, 0.06, 0.06, 0.06, 0.035]
TWO_PCT = [0.66, 0.43, 0.45, 0.43, 0.41, 0.42, 0.43, 0.42, 0.41]
THREE_W = [0.15, 0.24, 0.22, 0.24, 0.15]
POS_TWO = {'C': (1.9, 1.2, 0.4), 'F': (1.0, 1.0, 1.0), 'G': (0.75, 0.9, 1.35)}   # rim, short, mid
POS_THREE = {'C': (1.2, 1.0), 'F': (1.4, 1.0), 'G': (1.0, 1.2)}                    # corners, top


def hot_zones(dash, seed=11):
    """Invented hot zones for every demo player (data/demo_shots.json): the 3-point
    zones add up exactly to the player's 3PM/3PA (season) and career 3PM/3PA, so the
    hot-zone chart agrees with the 3P% chart. Own random stream: nothing else changes."""
    rng = random.Random(seed + 2000)
    end_year = int(dash['season'][:4]) + 1
    players = {}
    lg_season, lg_career = [[0, 0] for _ in range(14)], [[0, 0] for _ in range(14)]

    def profile(p):
        rim, short, mid = POS_TWO.get(p['pos'], POS_TWO['F'])
        corner, top = POS_THREE.get(p['pos'], POS_THREE['F'])
        lean = rng.uniform(0.8, 1.2)                         # a favourite side
        side = [1, lean, 1, 2 - lean, lean, lean, 1, 2 - lean, 2 - lean]
        two = [w * m * s * rng.uniform(0.55, 1.45) for w, m, s in
               zip(TWO_W, [rim, short, short, short, mid, mid, mid, mid, mid], side)]
        three = [w * m * s * rng.uniform(0.55, 1.45) for w, m, s in
                 zip(THREE_W, [corner, 1, top, 1, corner], [lean, lean, 1, 2 - lean, 2 - lean])]
        skill = rng.gauss(0, 0.03)
        two_pct = [min(0.8, max(0.2, q + skill + rng.gauss(0, 0.05))) for q in TWO_PCT]
        tp = p['tpm'] / p['tpa'] if p['tpa'] else 0.35
        three_pct = [max(0.05, tp + b + rng.gauss(0, 0.04)) for b in (0.03, 0, 0, 0, 0.03)]
        return two, three, two_pct, three_pct

    def zones(two_a, tpa, tpm, prof):
        two, three, two_pct, three_pct = prof
        a2 = _split(two_a, two)
        a3 = _split(tpa, three)
        m3 = _deal(rng, tpm, a3, three_pct)
        return [[_binom(rng, a, q), a] for a, q in zip(a2, two_pct)] + [[m, a] for m, a in zip(m3, a3)]

    for pid in sorted(dash['players']):
        p = dash['players'][pid]
        prof = profile(p)
        two_a = max(0, int(round(p['fga_g'] * p['gp'])) - p['tpa'])
        season = zones(two_a, p['tpa'], p['tpm'], prof)
        if p.get('first') or 'ctpa' not in p:
            career, n_past = [list(z) for z in season], 0
        else:
            past3a, past3m = p['ctpa'] - p['tpa'], p['ctpm'] - p['tpm']
            ratio = two_a / p['tpa'] if p['tpa'] >= 5 else {'C': 6.0, 'F': 1.6, 'G': 1.1}.get(p['pos'], 1.6)
            past = zones(int(round(past3a * ratio)), past3a, past3m, prof)
            career = [[a[0] + b[0], a[1] + b[1]] for a, b in zip(season, past)]
            n_past = rng.randint(1, 5)
        for acc, zs in ((lg_season, season), (lg_career, career)):
            for i, (m, a) in enumerate(zs):
                acc[i][0] += m
                acc[i][1] += a
        players[pid] = {'season': season, 'career': career,
                        'seasons': [scrape.season_label(y) for y in range(end_year - n_past, end_year + 1)]}
    return {'demo': True, 'league': {'season': lg_season, 'career': lg_career}, 'players': players}


def write():
    dash = build()
    scrape.write_json(os.path.join(scrape.DATA_DIR, 'demo.json'), dash)
    scrape.write_json(os.path.join(scrape.DATA_DIR, 'demo_shots.json'), hot_zones(dash))


def write_shots():
    scrape.write_json(os.path.join(scrape.DATA_DIR, 'demo_shots.json'), hot_zones(build()))


if __name__ == '__main__':
    write()
    print('wrote data/demo.json and data/demo_shots.json')
