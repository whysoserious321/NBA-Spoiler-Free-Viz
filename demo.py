"""Spoiler-free demo data: made-up ratings, fictional players, random odds.

Same shape as data/dashboard.json, so the page cannot tell the difference
except for the 'demo' flag (which shows a 'Demo data' badge). Real team names
and logos are kept so the page looks like the real thing; every number and
every player is invented.

    python3 demo.py      # writes data/demo.json
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
        team_rows.append({
            'abbr': abbr, 'name': name, 'nick': nick, 'conf': 'East' if abbr in model.EAST else 'West',
            'color': color, 'alt': '#cccccc', 'w': w, 'l': gp - w, 'gp': gp,
            **{k: round(r[k], 2) for k in ('ortg', 'drtg', 'nrtg', 'ortg_a', 'drtg_a', 'nrtg_a', 'sos')},
            'pace': round(r['pace'], 1), 'ppg': round(r['ortg'] * r['pace'] / 100, 1),
            'oppg': round(r['drtg'] * r['pace'] / 100, 1),
            'tp': round(100 * tpm / tpa, 1) if tpa else None, 'tpa_g': round(tpa / gp, 1),
            'rk': {k: v[abbr] for k, v in ranks.items()},
            'title': round(next(o['prob'] for o in title_out if o['abbr'] == abbr), 4),
            'roster': roster,
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
        'requests': 0,
    }


def write():
    scrape.write_json(os.path.join(scrape.DATA_DIR, 'demo.json'), build())


if __name__ == '__main__':
    write()
    print('wrote data/demo.json')
