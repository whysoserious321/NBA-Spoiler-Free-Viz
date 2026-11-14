"""Shot locations for the hot-zone chart on the 3-point page.

ESPN's game summary (one request per game, about 450 KB) lists every play with
an x/y for each field-goal attempt. Only the shot itself is kept, never scores
or play text:

    [player id, x, y, made (0/1), three (0/1)]

ESPN's court coordinates are whole feet: x runs 0-50 across the court and y is
measured from the basket, which sits at about (25, 0.5); every shot is folded
onto one half. Free throws have no real location and are skipped. Checked
against the NBA's own shot data (1,405 shots, 2025-26): x < 25 is the NBA's
"Left" for every shot, corner threes land in the same corner, and distances
from (25, 0.5) agree within about half a foot.

Play-by-play also lists end-of-quarter heaves that the official totals don't
count; leaving out everything beyond HEAVE_R makes most players' zone totals
equal their official FGA/3PA (the rest are off by a shot or two).

2 or 3: ESPN's pointsAttempted flag where it is set (reliable from 2022-23 on).
Older games mostly lack it, so a made shot uses its scoreValue and a miss the
play text ("three point") or its distance (24+ ft, or a corner shot beyond the
22-ft line). Checked against box scores: exact for 2022-23 onwards, 1 in ~1,000
threes off in 2021-22.

Caches (data/cache/shots/, git-ignored like the rest of data/):

    <end year>/days/YYYYMMDD.json   current season: {gid: rows} per US game date,
                                    fetched once per final game
    <end year>/index.json           rebuilt from those: per player [[day, zone, made]]
                                    plus the league's zone tallies per day, so any
                                    "up to a date" cutoff can be summed exactly
    past/<end year>.raw.json.gz     an earlier season's rows (zones can be redrawn offline)
    past/<end year>.json            that season's zone tallies per player and for the league
    fill.json                       when the last earlier season was fetched

Career hot zones = this season + up to CAREER_SEASONS earlier seasons. Those are
fetched one season per day after the morning refresh (about 1,230 requests and
25 minutes each), newest first; `python3 scrape.py --shots-fill` fetches every
missing one at once.
"""

import bisect
import gzip
import json
import math
import os
import re
import tempfile
from collections import defaultdict
from datetime import datetime

import requests

import scrape

SHOT_DIR = os.path.join(scrape.CACHE_DIR, 'shots')
PAST_DIR = os.path.join(SHOT_DIR, 'past')
FILL_STATE = os.path.join(SHOT_DIR, 'fill.json')
CAREER_SEASONS = 5          # earlier seasons in the career view
MAX_MISSING = 0.01          # an earlier season is saved only if at most 1% of its games failed

# ---------------------------------------------------------------------- zones
#
# 14 zones, as in NBA 2K's hot zones. "Left" is the shooter's left when facing the
# basket. Distances in feet from the basket; angles in degrees from the line straight
# out from the basket (negative = left, +-90 = along the baseline, +-180 = behind it).
#
#   0          restricted area             (under RIM_R)
#   1  2  3    short range  left / middle / right       (RIM_R .. SHORT_R, middle = +-30)
#   4 .. 8     mid-range twos: left baseline, left wing, top (+-22.5), right wing,
#              right baseline (beyond +-60)
#   9 .. 13    threes: left corner, left wing, top (+-22.5), right wing, right corner
#              (corner = less than CORNER_DY in front of the basket)
#
# Shots from beyond HEAVE_R (end-of-quarter heaves) are left out. The front end
# (static/hotspot.js) draws the same shapes; change both together.

N_ZONES = 14
BASKET_X, BASKET_Y = 25.0, 0.5
MIRROR = False              # ESPN x < 25 = shooter's left (verified against NBA zone names)
RIM_R, SHORT_R, HEAVE_R = 5.0, 14.0, 35.0
CORNER_DY = 9.0
THREE_PT = re.compile(r'three point|3-pt|three-point', re.I)


def zone(x, y, three):
    dx, dy = x - BASKET_X, y - BASKET_Y
    if MIRROR:
        dx = -dx
    dist = math.hypot(dx, dy)
    if dist > HEAVE_R:
        return None
    ang = abs(math.degrees(math.atan2(dx, dy)))
    left = dx < 0
    if three:
        if dy < CORNER_DY:
            return 9 if left else 13
        if ang <= 22.5:
            return 11
        return 10 if left else 12
    if dist < RIM_R:
        return 0
    if dist < SHORT_R:
        if ang <= 30:
            return 2
        return 1 if left else 3
    if ang <= 22.5:
        return 6
    if ang <= 60:
        return 5 if left else 7
    return 4 if left else 8


def _is_three(p, x, y):
    pa = p.get('pointsAttempted')
    if pa in (2, 3):
        return pa == 3
    if p.get('scoringPlay'):
        return p.get('scoreValue') == 3
    dx, dy = x - BASKET_X, y - BASKET_Y
    return bool(THREE_PT.search(p.get('text') or '')) or math.hypot(dx, dy) >= 24 or (abs(dx) >= 22 and dy < CORNER_DY)


def game_shots(f, gid):
    """Every field-goal attempt of one game as [pid, x, y, made, three]."""
    s = f.get(f'{scrape.ESPN}/summary', params={'event': gid})
    rows = []
    for p in s.get('plays') or []:
        if not p.get('shootingPlay'):
            continue
        if 'free throw' in ((p.get('type') or {}).get('text') or '').lower():
            continue
        c = p.get('coordinate') or {}
        x, y = c.get('x'), c.get('y')
        if not isinstance(x, (int, float)) or not isinstance(y, (int, float)) or x < -1000 or y < -1000:
            continue
        parts = p.get('participants') or [{}]
        pid = scrape.safe_id((parts[0].get('athlete') or {}).get('id'))
        if not pid:
            continue
        rows.append([pid, x, y, 1 if p.get('scoringPlay') else 0, 1 if _is_three(p, x, y) else 0])
    return rows


def _empty():
    return [[0, 0] for _ in range(N_ZONES)]


def _add(acc, zones):
    for i, (m, a) in enumerate(zones):
        acc[i][0] += m
        acc[i][1] += a
    return acc


def tally(rows):
    """Zone tallies per player and for the league: {pid: [[made, att] x 14]}, [[made, att] x 14]."""
    players, league = defaultdict(_empty), _empty()
    for pid, x, y, made, three in rows:
        z = zone(x, y, three)
        if z is None:
            continue
        players[pid][z][0] += made
        players[pid][z][1] += 1
        league[z][0] += made
        league[z][1] += 1
    return dict(players), league


# ------------------------------------------------------------------ io helpers

def day_dir(end_year):
    return os.path.join(SHOT_DIR, str(end_year), 'days')


def index_path(end_year):
    return os.path.join(SHOT_DIR, str(end_year), 'index.json')


def past_path(end_year, raw=False):
    return os.path.join(PAST_DIR, f'{end_year}.raw.json.gz' if raw else f'{end_year}.json')


def _write_gz(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.tmp_', suffix='.gz')
    try:
        with os.fdopen(fd, 'wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as gz:
            gz.write(json.dumps(obj, separators=(',', ':')).encode())
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def _read_gz(path):
    try:
        with gzip.open(path, 'rt') as fh:
            return json.load(fh)
    except (OSError, ValueError, EOFError):
        return None


def _day_files(end_year):
    """{iso date: {gid: rows}} from the cached day files of one season."""
    out = {}
    try:
        names = sorted(os.listdir(day_dir(end_year)))
    except OSError:
        return out
    for n in names:
        if re.fullmatch(r'\d{8}\.json', n):
            d = scrape.read_json(os.path.join(day_dir(end_year), n)) or {}
            if d.get('games'):
                out[d['date']] = d['games']
    return out


# -------------------------------------------------------------- current season

def update_season(f, games, end_year, log=print):
    """Fetch the shots of every final game not cached yet (f=None: no requests),
    then rebuild the season index. games: the refresh's final events (id, date)."""
    if f is not None:
        by_day = defaultdict(list)
        for g in games:
            by_day[g['date']].append(g['id'])
        fetched = failed = 0
        for d in sorted(by_day):
            path = os.path.join(day_dir(end_year), d.replace('-', '') + '.json')
            cached = scrape.read_json(path) or {'date': d, 'games': {}}
            need = [gid for gid in by_day[d] if gid not in cached['games']]
            if not need:
                continue
            for gid in need:
                try:
                    rows = game_shots(f, gid)
                except (requests.RequestException, ValueError, KeyError, TypeError) as e:
                    log(f'shots: game {gid} failed ({type(e).__name__}); trying again next refresh')
                    failed += 1
                    continue
                if not rows:                       # no play-by-play yet: try again next refresh
                    failed += 1
                    continue
                cached['games'][gid] = rows
                fetched += 1
            scrape.write_json(path, cached)
        if fetched or failed:
            log(f'shots: {fetched} new games' + (f', {failed} failed' if failed else ''))
    build_index(end_year)


def build_index(end_year):
    """index.json for one season: per player [[day index, zone, made]], plus the
    league's zone tallies per day (both only from cached final games)."""
    days = _day_files(end_year)
    order = sorted(days)
    players, league = defaultdict(list), []
    for di, d in enumerate(order):
        lg = _empty()
        for rows in days[d].values():
            for pid, x, y, made, three in rows:
                z = zone(x, y, three)
                if z is None:
                    continue
                players[pid].append([di, z, made])
                lg[z][0] += made
                lg[z][1] += 1
        league.append(lg)
    out = {'season': end_year, 'days': order, 'games': sum(len(g) for g in days.values()),
           'players': players, 'league': league}
    scrape.write_json(index_path(end_year), out)
    return out


# --------------------------------------------------------------- past seasons

def _season_games(f, end_year):
    """Ids of every final regular-season game of an earlier season (one request a month)."""
    start, end = scrape.season_bounds(f, end_year)
    ids, seen = [], set()
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        sb = f.get(f'{scrape.ESPN}/scoreboard', params={'dates': f'{y}{m:02d}', 'limit': 300})
        for e in sb.get('events', []):
            st = ((e.get('competitions') or [{}])[0].get('status') or {}).get('type') or {}
            if (e.get('season') or {}).get('type') == 2 and st.get('name') == 'STATUS_FINAL' and e['id'] not in seen:
                seen.add(e['id'])
                ids.append(e['id'])
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return ids


def fill_season(f, end_year, log=print):
    """Fetch every game of one earlier season and save its rows and zone tallies.
    Games already cached as day files (from when it was the current season) are reused."""
    label = scrape.season_label(end_year)
    ids = _season_games(f, end_year)
    if not ids:
        raise RuntimeError(f'no games listed for {label}')
    local = {}
    for games in _day_files(end_year).values():
        local.update(games)
    rows, missing = [], 0
    for i, gid in enumerate(ids, 1):
        if gid in local:
            rows += local[gid]
            continue
        try:
            got = game_shots(f, gid)
        except (requests.RequestException, ValueError, KeyError, TypeError):
            got = []
        if got:
            rows += got
        else:
            missing += 1
            if missing > MAX_MISSING * len(ids):
                raise RuntimeError(f'{label}: too many games without shot data ({missing} of {i}); trying again tomorrow')
        if i % 200 == 0:
            log(f'shots: {label} {i}/{len(ids)} games')
    _write_gz(past_path(end_year, raw=True), {'season': end_year, 'games': len(ids), 'missing': missing, 'rows': rows})
    _save_past(end_year, len(ids), missing, rows)
    log(f'shots: saved {label} ({len(ids) - missing} games, {len(rows)} shots)')


def _save_past(end_year, games, missing, rows):
    players, league = tally(rows)
    scrape.write_json(past_path(end_year), {'season': end_year, 'games': games, 'missing': missing,
                                            'players': players, 'league': league})


def fill_past(f, end_year, everything=False, log=print):
    """Fetch the newest missing earlier season (only one per day unless everything=True)."""
    want = [end_year - k for k in range(1, CAREER_SEASONS + 1)]
    todo = [yr for yr in want if not os.path.exists(past_path(yr))]
    if not todo:
        return
    today = datetime.now(scrape.US_EAST).date().isoformat()
    if not everything and (scrape.read_json(FILL_STATE) or {}).get('last') == today:
        return
    for yr in todo:
        # written before the attempt, so a failure (or a 429) waits until tomorrow
        scrape.write_json(FILL_STATE, {'last': today, 'season': yr})
        log(f'shots: fetching {scrape.season_label(yr)} for the career hot zones')
        fill_season(f, yr, log=log)
        if not everything:
            break


def rebuild_past(log=print):
    """Recount every earlier season's zone tallies from its raw rows (no requests),
    e.g. after the zone shapes changed."""
    try:
        names = os.listdir(PAST_DIR)
    except OSError:
        return
    for n in sorted(names):
        m = re.fullmatch(r'(\d{4})\.raw\.json\.gz', n)
        if not m:
            continue
        raw = _read_gz(os.path.join(PAST_DIR, n))
        if raw:
            _save_past(int(m.group(1)), raw.get('games', 0), raw.get('missing', 0), raw.get('rows', []))
            log(f'shots: recounted {scrape.season_label(int(m.group(1)))}')


# ----------------------------------------------------------------- for the API

def player_zones(end_year, pid, cutoff, load):
    """Season and career zone tallies of one player next to the league's, counting
    only games on or before `cutoff` (ISO date; None = no games). load(path) reads
    JSON (the app's cached loader). None while the season has no shot index yet."""
    path = index_path(end_year)
    if not os.path.exists(path):
        return None
    idx = load(path) or {}
    n = bisect.bisect_right(idx.get('days') or [], cutoff) if cutoff else 0
    season, league = _empty(), _empty()
    for di, z, made in (idx.get('players') or {}).get(pid, []):
        if di < n:
            season[z][0] += made
            season[z][1] += 1
    for lg in (idx.get('league') or [])[:n]:
        _add(league, lg)

    career = _add(_empty(), season)
    career_lg = _add(_empty(), league)
    seasons, cached = [], 0
    for yr in range(end_year - CAREER_SEASONS, end_year):
        p = past_path(yr)
        if not os.path.exists(p):
            continue
        cached += 1
        past = load(p) or {}
        zones = (past.get('players') or {}).get(pid)
        if not zones:
            continue
        seasons.append(scrape.season_label(yr))
        _add(career, zones)
        _add(career_lg, past.get('league') or _empty())
    now = any(a for _, a in season)
    return {
        'season': {'label': scrape.season_label(end_year), 'zones': season, 'league': league},
        'career': {'zones': career, 'league': career_lg,
                   'seasons': seasons + ([scrape.season_label(end_year)] if now else []),
                   'past': len(seasons), 'complete': cached == CAREER_SEASONS,
                   'max_past': CAREER_SEASONS},
    }
