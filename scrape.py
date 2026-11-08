"""NBAViz data collector.

Pulls the current NBA season from two public, login-free sources and writes
data/dashboard.json for the web app:

  * ESPN's public JSON API
      - season team totals for all 30 teams, incl. opponent totals (1 request)
        -> possessions, ORtg, DRtg, NRtg
      - daily scoreboards (results only, no box scores) -> who played whom,
        used for the opponent adjustment and W-L. A finished day never
        changes, so it is cached in data/cache/days/ and fetched once.
      - season per-game stats for every player (2 requests: all players for
        the team 3P% chart, qualified players for the leaderboards)
  * Polymarket (Gamma + CLOB, read-only): championship and MVP markets plus
    their price history.

Basketball-Reference (the source in the research doc) answers scripts with a
Cloudflare bot challenge and cdn.nba.com/stats.nba.com JSON is blocked from
this IP, so neither is used. The raw and opponent-adjusted ratings that
Basketball-Reference publishes are computed here instead (see model.py).

A normal refresh makes about 30 requests (most of them Polymarket price
history); the first run of a season also fetches each past scoreboard once.

Run by hand:   python3 scrape.py            (refresh everything)
               python3 scrape.py --offline  (rebuild from cache, no requests)
The Flask app also calls refresh() on a background timer.
"""

import json
import os
import re
import sys
import tempfile
import time
import unicodedata
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import requests

import model

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
CACHE_DIR = os.path.join(DATA_DIR, 'cache')
DAY_DIR = os.path.join(CACHE_DIR, 'days')
IMG_DIR = os.path.join(DATA_DIR, 'img')
SNAP_DIR = os.path.join(DATA_DIR, 'snapshots')
DASHBOARD = os.path.join(DATA_DIR, 'dashboard.json')

ESPN = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba'
ESPN_STATS = 'https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/statistics'
ESPN_CORE = 'https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba'
ESPN_IMG = 'https://a.espncdn.com/combiner/i?img='
GAMMA = 'https://gamma-api.polymarket.com'
CLOB = 'https://clob.polymarket.com'

US_EAST = ZoneInfo('America/New_York')
HEADERS = {'User-Agent': 'NBAViz/1.0 (personal dashboard)', 'Accept': 'application/json'}

# ESPN uses a few non-standard abbreviations; the site shows the usual NBA ones.
ESPN_TO_NBA = {'GS': 'GSW', 'NY': 'NYK', 'SA': 'SAS', 'NO': 'NOP', 'UTAH': 'UTA', 'WSH': 'WAS'}

# Number of outcomes per market whose price history is fetched.
HISTORY_TOP_N = 6


class RateLimited(Exception):
    pass


# --------------------------------------------------------------------------- io

def write_json(path, obj, indent=None):
    """Atomic write: temp file in the same folder, then os.replace()."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.tmp_', suffix='.json')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(obj, f, indent=indent, separators=None if indent else (',', ':'))
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def read_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


class Fetcher:
    """requests.Session with a polite minimum gap per host and a hard stop on 429."""

    GAPS = {'espn': 0.6, 'polymarket': 0.25}

    def __init__(self, log=print):
        self.s = requests.Session()
        self.s.headers.update(HEADERS)
        self.last = {}
        self.count = 0
        self.log = log

    def _wait(self, host):
        gap = self.GAPS.get(host, 0.6)
        elapsed = time.monotonic() - self.last.get(host, 0)
        if elapsed < gap:
            time.sleep(gap - elapsed)
        self.last[host] = time.monotonic()

    def get(self, url, host='espn', params=None, binary=False):
        for attempt in (1, 2):
            self._wait(host)
            self.count += 1
            try:
                r = self.s.get(url, params=params, timeout=25)
            except requests.RequestException as e:
                if attempt == 2:
                    raise
                self.log(f'  retry after error: {e}')
                time.sleep(3)
                continue
            if r.status_code == 429:
                raise RateLimited(url)
            if r.status_code >= 500 and attempt == 1:
                time.sleep(3)
                continue
            r.raise_for_status()
            return r.content if binary else r.json()


# ----------------------------------------------------------------------- season

def season_end_year(today=None):
    today = today or datetime.now(US_EAST).date()
    return today.year + 1 if today.month >= 8 else today.year


def season_label(end_year):
    return f'{end_year - 1}-{str(end_year)[2:]}'


def season_bounds(f, end_year):
    """Regular-season start/end dates (US dates) from ESPN's core API, cached."""
    path = os.path.join(CACHE_DIR, f'season_{end_year}.json')
    cached = read_json(path)
    if cached:
        return date.fromisoformat(cached['start']), date.fromisoformat(cached['end'])
    d = f.get(f'{ESPN_CORE}/seasons/{end_year}/types/2')
    # ESPN stores US dates as 07:00Z; converting to US Eastern gives the calendar date.
    start = datetime.fromisoformat(d['startDate'].replace('Z', '+00:00')).astimezone(US_EAST).date()
    end = datetime.fromisoformat(d['endDate'].replace('Z', '+00:00')).astimezone(US_EAST).date()
    write_json(path, {'start': start.isoformat(), 'end': end.isoformat()})
    return start, end


# ------------------------------------------------------------------------- ESPN

def nba_abbr(espn_abbr):
    a = ESPN_TO_NBA.get(espn_abbr, espn_abbr)
    return re.sub(r'[^A-Z0-9]', '', (a or '').upper())     # used in file names and HTML


def safe_id(v):
    return re.sub(r'[^0-9]', '', str(v or ''))              # ESPN ids are numeric


def parse_team(t):
    return {
        'espn_id': t['id'],
        'abbr': nba_abbr(t['abbreviation']),
        'espn_abbr': t['abbreviation'],
        'name': t.get('displayName'),
        'nick': t.get('name') or t.get('shortDisplayName'),
        'color': '#' + (t.get('color') or '777777'),
        'alt': '#' + (t.get('alternateColor') or 'cccccc'),
    }


def fetch_day(f, d, teams):
    """Results for one US date (scores only). Cached once every game is done."""
    path = os.path.join(DAY_DIR, d.strftime('%Y%m%d') + '.json')
    cached = read_json(path)
    if cached and cached.get('complete'):
        return cached
    sb = f.get(f'{ESPN}/scoreboard', params={'dates': d.strftime('%Y%m%d')})
    events, complete = [], True
    for e in sb.get('events', []):
        if e.get('season', {}).get('type') != 2:     # regular season only
            continue
        comp = e['competitions'][0]
        st = comp['status']['type']
        done = bool(st.get('completed'))
        if not done and st.get('name') not in ('STATUS_POSTPONED', 'STATUS_CANCELED'):
            complete = False
        sides = {}
        for c in comp['competitors']:
            team = parse_team(c['team'])
            teams[team['abbr']] = {**teams.get(team['abbr'], {}), **team}
            sides[c['homeAway']] = {'abbr': team['abbr'], 'score': int(c.get('score') or 0)}
        events.append({
            'id': e['id'], 'date': d.isoformat(),
            'final': done and st.get('name') == 'STATUS_FINAL',
            'home': sides.get('home'), 'away': sides.get('away'),
        })
    out = {'date': d.isoformat(), 'complete': complete, 'events': events}
    write_json(path, out)
    return out


def _float(v):
    try:
        return float(str(v).replace(',', '').replace('+', ''))
    except (TypeError, ValueError):
        return 0.0


def _categories(payload, row):
    """ESPN stats rows list categories in the same order as payload['categories'].
    A category name that appears twice is the opponent's version of it, and the
    second copy comes without its own 'names' list."""
    names_by_cat, out = {}, {}
    for meta, cat in zip(payload.get('categories', []), row.get('categories', [])):
        cname = meta.get('name') or cat.get('name')
        names = meta.get('names') or names_by_cat.get(cname) or []
        prefix = 'opp_' if cname in names_by_cat else ''
        names_by_cat.setdefault(cname, names)
        for k, v in zip(names, cat.get('totals') or cat.get('values') or []):
            out.setdefault(prefix + k, _float(v))
    return out


def fetch_team_totals(f, end_year):
    d = f.get(f'{ESPN_STATS}/byteam', params={
        'region': 'us', 'lang': 'en', 'contentorigin': 'espn',
        'limit': 30, 'season': end_year, 'seasontype': 2})
    out = {}
    for row in d.get('teams', []):
        s = _categories(d, row)
        g = s.get('gamesPlayed', 0)
        out[nba_abbr(row['team']['abbreviation'])] = {
            'gp': int(g),
            'pts': s.get('points', 0), 'fgm': s.get('fieldGoalsMade', 0),
            'fga': s.get('fieldGoalsAttempted', 0), 'fta': s.get('freeThrowsAttempted', 0),
            'tpm': s.get('threePointFieldGoalsMade', 0), 'tpa': s.get('threePointFieldGoalsAttempted', 0),
            'orb': s.get('offensiveRebounds', 0), 'drb': s.get('defensiveRebounds', 0),
            'tov': s.get('turnovers', 0),
            'opp_pts': s.get('opp_points', 0), 'opp_fgm': s.get('opp_fieldGoalsMade', 0),
            'opp_fga': s.get('opp_fieldGoalsAttempted', 0), 'opp_fta': s.get('opp_freeThrowsAttempted', 0),
            'opp_orb': s.get('opp_offensiveRebounds', 0), 'opp_drb': s.get('opp_defensiveRebounds', 0),
            'opp_tov': s.get('opp_turnovers', 0),
        }
    return out


def fetch_players(f, end_year, qualified):
    params = {'region': 'us', 'lang': 'en', 'contentorigin': 'espn',
              'isqualified': 'true' if qualified else 'false', 'limit': 1000, 'page': 1,
              'season': end_year, 'seasontype': 2, 'sort': 'offensive.avgPoints:desc'}
    pages = [f.get(f'{ESPN_STATS}/byathlete', params=params)]
    while params['page'] < (pages[-1].get('pagination') or {}).get('pages', 1) and params['page'] < 20:
        params['page'] += 1
        pages.append(f.get(f'{ESPN_STATS}/byathlete', params=params))
    out = []
    for d, row in ((d, row) for d in pages for row in d.get('athletes', [])):
        a = row['athlete']
        s = _categories(d, row)
        out.append({
            'id': safe_id(a['id']), 'name': a.get('displayName'), 'short': a.get('shortName'),
            'last': a.get('lastName'), 'pos': (a.get('position') or {}).get('abbreviation'),
            'team': nba_abbr(a.get('teamShortName') or ''),
            'gp': int(s.get('gamesPlayed', 0)), 'mpg': s.get('avgMinutes', 0),
            'pts': s.get('avgPoints', 0), 'reb': s.get('avgRebounds', 0),
            'ast': s.get('avgAssists', 0), 'stl': s.get('avgSteals', 0),
            'blk': s.get('avgBlocks', 0), 'tov': s.get('avgTurnovers', 0),
            'tpm_g': s.get('avgThreePointFieldGoalsMade', 0),
            'tpa_g': s.get('avgThreePointFieldGoalsAttempted', 0),
            'fga_g': s.get('avgFieldGoalsAttempted', 0),
            'fta_g': s.get('avgFreeThrowsAttempted', 0),
            'tpm': int(s.get('threePointFieldGoalsMade', 0)),
            'tpa': int(s.get('threePointFieldGoalsAttempted', 0)),
            'fg_pct': s.get('fieldGoalPct', 0),
            # season totals, for exact percentages
            'pts_tot': int(s.get('points', 0)),
            'fga': int(s.get('fieldGoalsAttempted', 0)),
            'fta': int(s.get('freeThrowsAttempted', 0)),
        })
    return out


# ------------------------------------------------------------------- Polymarket

def poly_event(f, slug):
    ev = f.get(f'{GAMMA}/events/slug/{slug}', host='polymarket')
    outcomes = []
    for m in ev.get('markets', []):
        if not m.get('active') or m.get('closed'):
            continue
        try:
            price = float(json.loads(m['outcomePrices'])[0])
            token = json.loads(m['clobTokenIds'])[0]
        except (KeyError, ValueError, TypeError, IndexError):
            continue
        outcomes.append({
            'name': m.get('groupItemTitle') or m.get('question'),
            'price': price,
            'd1': m.get('oneDayPriceChange'),
            'w1': m.get('oneWeekPriceChange'),
            'token': token,
            'image': m.get('image') or m.get('icon'),
        })
    total = sum(o['price'] for o in outcomes) or 1.0
    for o in outcomes:
        o['prob'] = o['price'] / total
    outcomes.sort(key=lambda o: -o['price'])
    for o in outcomes[:HISTORY_TOP_N]:
        try:
            # interval=max is only honest at 12-hour buckets (fidelity=720).
            h = f.get(f'{CLOB}/prices-history', host='polymarket',
                      params={'market': o['token'], 'interval': 'max', 'fidelity': 720})
            o['history'] = [[int(x['t']), round(float(x['p']), 4)] for x in h.get('history', [])]
        except requests.RequestException:
            o['history'] = []
    for o in outcomes:
        o.pop('token', None)
    return {
        'slug': slug, 'title': ev.get('title'),
        'volume': float(ev.get('volume') or 0),
        'total_price': round(total, 4),
        'outcomes': outcomes,
    }


# ----------------------------------------------------------------------- images

def norm_name(s):
    s = unicodedata.normalize('NFKD', s or '').encode('ascii', 'ignore').decode().lower()
    s = re.sub(r'[^a-z ]', '', s.replace('-', ' '))
    return ' '.join(w for w in s.split() if w not in ('jr', 'sr', 'ii', 'iii', 'iv'))


def cache_image(f, url, path):
    if os.path.exists(path):
        return True
    try:
        data = f.get(url, host='espn' if 'espncdn' in url else 'polymarket', binary=True)
    except requests.RequestException:
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as fh:
        fh.write(data)
    return True


def cache_team_logos(f, teams):
    for t in teams.values():
        low = re.sub(r'[^a-z0-9]', '', t['espn_abbr'].lower())
        cache_image(f, f'{ESPN_IMG}/i/teamlogos/nba/500/{low}.png&h=96&w=96',
                    os.path.join(IMG_DIR, 'logos', f"{t['abbr']}.png"))
        cache_image(f, f'{ESPN_IMG}/i/teamlogos/nba/500-dark/{low}.png&h=96&w=96',
                    os.path.join(IMG_DIR, 'logos', f"{t['abbr']}-dark.png"))


def cache_headshots(f, player_ids):
    for pid in filter(None, map(safe_id, player_ids)):
        cache_image(f, f'{ESPN_IMG}/i/headshots/nba/players/full/{pid}.png&w=150&h=110',
                    os.path.join(IMG_DIR, 'heads', f'{pid}.png'))


def pm_head_key(name):
    return 'pm-' + re.sub(r'[^a-z0-9]+', '-', norm_name(name)).strip('-')


# ---------------------------------------------------------------------- refresh

def refresh(offline=False, log=print):
    t0 = time.time()
    f = Fetcher(log=log)
    end_year = season_end_year()
    today = datetime.now(US_EAST).date()
    teams = read_json(os.path.join(CACHE_DIR, 'teams.json'), {}) or {}

    start, end = season_bounds(f, end_year)
    games = []
    d = start
    while d <= min(today, end):
        day = (read_json(os.path.join(DAY_DIR, d.strftime('%Y%m%d') + '.json'))
               if offline else fetch_day(f, d, teams))
        games += [e for e in (day or {}).get('events', []) if e.get('final')]
        d += timedelta(days=1)
    log(f'results: {len(games)} finished games')

    cache = os.path.join(CACHE_DIR, 'season.json')
    if offline:
        season = read_json(cache, {})
    else:
        old = read_json(cache, {}) or {}
        season = {
            'totals': fetch_team_totals(f, end_year),
            'players': fetch_players(f, end_year, qualified=False),
            'qualified': [p['id'] for p in fetch_players(f, end_year, qualified=True)],
            'odds': {},
        }
        for key, slug in (('title', f'nba-{end_year}-champion'),
                          ('mvp', f'nba-{end_year - 1}-{str(end_year)[2:]}-mvp')):
            try:
                season['odds'][key] = poly_event(f, slug)
            except requests.RequestException as e:
                log(f'polymarket {slug} failed: {e}')
                season['odds'][key] = (old.get('odds') or {}).get(key)
        write_json(cache, season)
        write_json(os.path.join(CACHE_DIR, 'teams.json'), teams)
        cache_team_logos(f, teams)

    dash = model.build(games, teams, season, label=season_label(end_year), norm_name=norm_name)
    if not dash['teams']:
        # Before the first regular-season game (e.g. after the season rolls over in
        # August) there is nothing to rate: keep serving the existing data.
        log('no regular-season games with team totals yet; keeping the existing dashboard')
        return read_json(DASHBOARD)

    if not offline:
        cache_headshots(f, dash['head_ids'])
        for o in (dash['odds'].get('mvp') or {}).get('outcomes', [])[:10]:
            if not o.get('player') and o.get('image'):
                cache_image(f, o['image'], os.path.join(IMG_DIR, 'heads', pm_head_key(o['name']) + '.png'))

    # Tell the page which headshots exist so it never requests a missing one.
    heads = set(os.listdir(os.path.join(IMG_DIR, 'heads'))) if os.path.isdir(os.path.join(IMG_DIR, 'heads')) else set()
    for pid, p in dash['players'].items():
        p['head'] = f'{pid}.png' in heads
    for o in (dash['odds'].get('mvp') or {}).get('outcomes', []):
        key = o.get('player') or pm_head_key(o['name'])
        o['head'] = key if f'{key}.png' in heads else None
    del dash['head_ids']

    dash['generated'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
    dash['requests'] = f.count
    write_json(DASHBOARD, dash)
    write_json(os.path.join(SNAP_DIR, f'{today.isoformat()}.json'), model.snapshot(dash))
    log(f'wrote dashboard.json: {len(games)} games, {f.count} requests, {time.time() - t0:.1f}s')
    return dash


if __name__ == '__main__':
    try:
        refresh(offline='--offline' in sys.argv)
    except RateLimited as e:
        print(f'Stopped: rate limited (429) on {e}. Try again later.', file=sys.stderr)
        sys.exit(2)
