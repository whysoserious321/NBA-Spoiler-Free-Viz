"""NBAViz - mobile-first NBA ratings, leaders and odds.

Serves one page plus the JSON that scrape.py writes. A background thread
refreshes the data once a day at REFRESH_AT (local time, default 08:00):

  * a failed refresh is retried every RETRY_MINUTES until it works;
  * if the refresh is only partial - ESPN's season totals don't include last
    night's games yet (they can lag the scoreboard by several hours) or not
    every game of the night has finished - it checks again every
    CATCHUP_MINUTES until it is full, but not after CATCHUP_UNTIL o'clock;
  * after a reboot or downtime it refreshes straight away if the data is older
    than the most recent REFRESH_AT.

Only one process runs the scheduler (file lock), even if the app is started twice.

    python3 app.py                         # http://<pi>:5003
    FLASK_APP=app.py flask run --port 5003 # the way WebServers/Start.sh runs it

Every page load asks: live data, everything only up to a saved game day, or
demo data (static/gate.js). The data endpoints take the answer as ?date=YYYY-MM-DD
(served from data/snapshots/) or ?demo=1; no parameter means live. Page URLs
with ?live=1, ?date=... or ?demo=1 skip the question. /api/shots (hot zones)
answers "up to a date" by counting only cached games through that day.
Set NBAVIZ_NO_REFRESH=1 to serve the existing files without refreshing.
"""

import fcntl
import logging
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone

from flask import Flask, abort, jsonify, render_template, request, send_from_directory

import scrape
import shots

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEMO_FILE = os.path.join(scrape.DATA_DIR, 'demo.json')
DEMO_SHOTS = os.path.join(scrape.DATA_DIR, 'demo_shots.json')
LOCK_FILE = os.path.join(scrape.DATA_DIR, '.refresh.lock')
REFRESH_AT = os.environ.get('NBAVIZ_REFRESH_AT', '08:00')
RETRY_MINUTES = 30
CATCHUP_MINUTES = 60
CATCHUP_UNTIL = 14
PORT = int(os.environ.get('NBAVIZ_PORT', 5003))

app = Flask(__name__)
app.json.sort_keys = False
log = logging.getLogger('nbaviz')
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(message)s')

status = {'last_ok': None, 'last_error': None, 'last_result': None, 'next_run': None,
          'running': False, 'scheduler': False}
_lock_handle = None


def _data_time():
    try:
        return datetime.fromtimestamp(os.path.getmtime(scrape.DASHBOARD))
    except OSError:
        return datetime.min


def _slot(day):
    h, m = (int(x) for x in REFRESH_AT.split(':'))
    return datetime.combine(day, datetime.min.time()).replace(hour=h, minute=m)


def _last_slot(now):
    s = _slot(now.date())
    return s if now >= s else s - timedelta(days=1)


def _next_slot(now):
    s = _slot(now.date())
    return s if now < s else s + timedelta(days=1)


def _refresh_once():
    """Returns 'ok' (a full refresh), 'partial' (scrape.partial_reason) or 'failed'."""
    status['running'] = True
    try:
        dash = scrape.refresh(log=log.info)
        partial = scrape.snapshot_partial(dash or {})
        status['last_ok'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
        status['last_error'] = None
        result = 'partial' if partial else 'ok'
        if partial:
            log.info('partial refresh: %s', partial)
    except Exception as e:                       # keep serving the last good data
        log.exception('refresh failed')
        status['last_error'] = f'{type(e).__name__}: {e}'
        result = 'failed'
    finally:
        status['running'] = False
    status['last_result'] = result
    return result


def _sleep_until(when):
    status['next_run'] = when.isoformat(timespec='minutes')
    while True:
        left = (when - datetime.now()).total_seconds()
        if left <= 0:
            return
        time.sleep(min(left, 900))               # wake up regularly; survives clock jumps


def _scheduler():
    while True:
        now = datetime.now()
        due = now if _data_time() < _last_slot(now) else _next_slot(now)
        _sleep_until(due)
        result = _refresh_once()
        while result != 'ok':
            now = datetime.now()
            if result == 'failed':
                wait = RETRY_MINUTES
            elif now.hour < CATCHUP_UNTIL:
                wait = CATCHUP_MINUTES
            else:
                break                            # accept slightly stale totals until tomorrow
            retry = now + timedelta(minutes=wait)
            if retry >= _next_slot(now):
                break
            log.info('refresh %s, trying again at %s', result, retry.strftime('%H:%M'))
            _sleep_until(retry)
            result = _refresh_once()


def _start_scheduler():
    global _lock_handle
    os.makedirs(scrape.DATA_DIR, exist_ok=True)
    try:
        _lock_handle = open(LOCK_FILE, 'a')
        fcntl.flock(_lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log.info('another NBAViz process runs the refresh schedule (or the lock is not writable)')
        return
    status['scheduler'] = True
    threading.Thread(target=_scheduler, name='nbaviz-refresh', daemon=True).start()


if os.environ.get('NBAVIZ_NO_REFRESH') != '1':
    _start_scheduler()


@app.after_request
def no_cache_html(resp):
    if resp.mimetype in ('text/html', 'application/json'):
        resp.headers['Cache-Control'] = 'no-cache'
    return resp


@app.route('/')
def index():
    return render_template('index.html', v=_asset_version())


def _asset_version():
    return int(max(os.path.getmtime(os.path.join(BASE_DIR, 'static', f))
                   for f in ('app.js', 'app.css', 'tpchart.js', 'threes.js', 'gate.js', 'hotspot.js')))


@app.route('/threes')
def threes_page():
    """Stand-alone 3-point page. It loads /api/threes and, for a tapped player's
    hot zones, /api/shots; neither carries scores, records, ratings, standings
    or odds, so it is safe to open mid-game."""
    return render_template('threes.html', v=_asset_version())


_json_cache = {}


def _load_json(path):
    mtime = os.path.getmtime(path)
    hit = _json_cache.get(path)
    if not hit or hit[0] != mtime:
        hit = (mtime, scrape.read_json(path))
        _json_cache[path] = hit
    return hit[1]


# ------------------------------------------------------------------ data sources
# Every data endpoint serves one of three sources:
#   live   the latest refresh                       (no parameter)
#   date   the snapshot saved for games through a day  (?date=YYYY-MM-DD)
#   demo   made-up numbers                             (?demo=1)

DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
DEMO_GAMES = [('BOS', 'NYK'), ('GSW', 'LAL'), ('PHX', 'DEN'), ('MIA', 'ORL')]
_snap_cache = {}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


@app.errorhandler(ApiError)
def _api_error(e):
    return jsonify({'error': str(e)}), e.status


def _snapshot_dates():
    try:
        names = os.listdir(scrape.SNAP_DIR)
    except OSError:
        return []
    days = (n[:-len('.json.gz')] for n in names if n.endswith('.json.gz'))
    return sorted((d for d in days if DATE_RE.match(d)), reverse=True)


def _load_snapshot(day):
    path = os.path.join(scrape.SNAP_DIR, f'{day}.json.gz')
    mtime = os.path.getmtime(path)
    hit = _snap_cache.get(day)
    if not hit or hit[0] != mtime:
        hit = (mtime, scrape.read_snapshot(day))
        _snap_cache[day] = hit
    return hit[1]


def _dated(day):
    """The dashboard as saved for games through `day`, with odds price history
    cut off at the moment it was saved, so no later movement shows."""
    snap = _load_snapshot(day)
    cutoff = datetime.fromisoformat(snap['generated']).timestamp()
    archive = scrape.read_json(scrape.ODDS_ARCHIVE, {}) or {}
    odds = {}
    for key, ev in (snap.get('odds') or {}).items():
        if not ev:
            odds[key] = ev
            continue
        hist = archive.get(key) or {}
        outs = []
        for i, o in enumerate(ev.get('outcomes', [])):
            o = dict(o)
            if i < scrape.HISTORY_TOP_N:
                o['history'] = [p for p in hist.get(o['name'], []) if p[0] <= cutoff]
            outs.append(o)
        odds[key] = {**ev, 'outcomes': outs}
    return {**snap, 'odds': odds, 'asof': day, 'partial': scrape.snapshot_partial(snap)}


def _source():
    """(data, mode, day) for the request's ?demo / ?date / live choice."""
    if request.args.get('demo') == '1':
        if not os.path.exists(DEMO_FILE):
            import demo
            demo.write()
        return _load_json(DEMO_FILE), 'demo', None
    day = request.args.get('date')
    if day:
        if not DATE_RE.match(day) or day not in _snapshot_dates():
            raise ApiError(404, 'No saved data for that date.')
        return _dated(day), 'date', day
    if not os.path.exists(scrape.DASHBOARD):
        raise ApiError(503, 'No data yet - the first refresh is still running.')
    d = _load_json(scrape.DASHBOARD)
    if not d:
        raise ApiError(503, 'The data file could not be read; try again in a moment.')
    return d, 'live', None


def _games_on(day):
    """Matchups on a US date from the cached scoreboard: team pairs only, never scores."""
    data = scrape.read_json(os.path.join(scrape.DAY_DIR, day.strftime('%Y%m%d') + '.json')) or {}
    return [{'away': ev['away']['abbr'], 'home': ev['home']['abbr']}
            for ev in data.get('events', []) if ev.get('away') and ev.get('home')]


_saved_cache = {}


def _snapshot_saved(day):
    """(when the snapshot for `day` was saved as UTC ISO, why it is partial or None).
    Only these two are kept in memory, re-read when the file changes."""
    path = os.path.join(scrape.SNAP_DIR, f'{day}.json.gz')
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return None, None
    hit = _saved_cache.get(day)
    if not hit or hit[0] != mtime:
        try:
            snap = scrape.read_snapshot(day)
            info = (snap.get('generated'), scrape.snapshot_partial(snap))
        except (OSError, ValueError, EOFError):
            info = (None, None)
        hit = (mtime, info)
        _saved_cache[day] = hit
    return hit[1]


@app.route('/api/dates')
def api_dates():
    """Days you can pick in the start screen (newest first), when each was saved
    and whether it is partial, and how far live data goes: its refresh time, why
    it is partial (None = full) and when the last full refresh ran."""
    live = (_load_json(scrape.DASHBOARD) if os.path.exists(scrape.DASHBOARD) else None) or {}
    dates = _snapshot_dates()
    info = {d: _snapshot_saved(d) for d in dates}
    partial = scrape.snapshot_partial(live) if live else None
    return jsonify({'dates': dates, 'saved': {d: info[d][0] for d in dates},
                    'partial': {d: info[d][1] for d in dates},
                    'live_through': live.get('through'),
                    'live_generated': live.get('generated'),
                    'live_partial': partial,
                    'live_last_full': live.get('last_full', None if partial else live.get('generated'))})


def _career_base(season_label):
    """3PM/3PA summed over every earlier season (scrape.update_career), or None
    when it is missing or belongs to another season."""
    try:
        end_year = int(str(season_label)[:4]) + 1
    except ValueError:
        return None
    if not os.path.exists(scrape.CAREER_BASE):
        return None
    base = _load_json(scrape.CAREER_BASE) or {}
    return base.get('players') if base.get('season') == end_year else None


def _with_career(row, pid, p, base):
    """Adds career 3PM/3PA (this season included) and 'first' for a first season.
    Demo players carry their own made-up career numbers."""
    if 'ctpa' in p:
        row.update(ctpm=p['ctpm'], ctpa=p['ctpa'], first=bool(p.get('first')))
    elif base is not None:
        prev = base.get(pid)
        row.update(ctpm=p['tpm'] + (prev[0] if prev else 0), ctpa=p['tpa'] + (prev[1] if prev else 0),
                   first=prev is None)
    return row


@app.route('/api/threes')
def api_threes():
    d, mode, day = _source()
    players = d.get('players', {})
    base = None if mode == 'demo' else _career_base(d.get('season'))
    teams = []
    for t in sorted(d['teams'], key=lambda t: t['name']):
        roster = [(pid, players[pid]) for pid in t.get('roster', []) if pid in players]
        teams.append({
            'abbr': t['abbr'], 'name': t['name'], 'nick': t.get('nick'),
            'tp': t.get('tp'), 'tpa_g': t.get('tpa_g'),
            'players': [_with_career({'id': pid, 'name': p['name'], 'short': p.get('short'), 'pos': p.get('pos'),
                                      'tpm': p['tpm'], 'tpa': p['tpa']}, pid, p, base) for pid, p in roster],
        })
    if mode == 'demo':
        games_date, games = None, [{'away': a, 'home': h} for a, h in DEMO_GAMES]
    elif mode == 'date':
        nxt = datetime.fromisoformat(day).date() + timedelta(days=1)   # the games you are about to watch
        games_date, games = nxt.isoformat(), _games_on(nxt)
    else:
        today = datetime.now(scrape.US_EAST).date()
        games_date, games = today.isoformat(), _games_on(today)
    return jsonify({
        'demo': mode == 'demo', 'mode': mode, 'asof': day,
        'season': d.get('season'), 'generated': d.get('generated'), 'through': d.get('through'),
        'partial': None if mode == 'demo' else scrape.snapshot_partial(d),
        'league_tp': (d.get('league') or {}).get('tp'),
        'games_date': games_date, 'games': games, 'teams': teams,
    })


def _demo_shots():
    if not os.path.exists(DEMO_SHOTS):
        import demo
        demo.write_shots()
    return _load_json(DEMO_SHOTS)


@app.route('/api/shots')
def api_shots():
    """Hot zones of one player for the 3-point page: made/attempted in 14 court
    zones this season and over the career (this season plus up to
    shots.CAREER_SEASONS earlier ones), each next to the league's numbers.
    Like /api/threes it never carries scores, records, ratings, standings or
    odds, and "up to a date" only counts games through that day."""
    pid = request.args.get('player', '')
    if not re.fullmatch(r'\d{1,12}', pid):
        raise ApiError(404, 'Unknown player.')
    d, mode, day = _source()
    p = (d.get('players') or {}).get(pid)
    if not p:
        raise ApiError(404, 'Unknown player.')
    if mode == 'demo':
        demo_z = _demo_shots() or {}
        z = (demo_z.get('players') or {}).get(pid)
        if not z:
            raise ApiError(404, 'Unknown player.')
        lg = demo_z['league']
        zones = {
            'season': {'label': d.get('season'), 'zones': z['season'], 'league': lg['season']},
            'career': {'zones': z['career'], 'league': lg['career'], 'seasons': z['seasons'],
                       'past': len(z['seasons']) - 1, 'complete': True, 'max_past': shots.CAREER_SEASONS},
        }
    else:
        try:
            end_year = int(str(d.get('season'))[:4]) + 1
        except ValueError:
            raise ApiError(503, 'The data has no season yet.')
        zones = shots.player_zones(end_year, pid, day if mode == 'date' else d.get('through'), _load_json)
        if zones is None:
            raise ApiError(503, 'Shot locations are still being collected; they arrive with the next refresh.')
    return jsonify({
        'demo': mode == 'demo', 'mode': mode, 'asof': day,
        'player': {'id': pid, 'name': p['name'], 'short': p.get('short'), 'team': p.get('team'), 'pos': p.get('pos')},
        **zones,
    })


@app.route('/api/dashboard')
def dashboard():
    if request.args.get('date'):
        d, _, _ = _source()
        return jsonify(d)
    path = DEMO_FILE if request.args.get('demo') == '1' else scrape.DASHBOARD
    _source()                                    # same checks and errors as the other modes
    return send_from_directory(os.path.dirname(path), os.path.basename(path),
                               mimetype='application/json', max_age=0)


@app.route('/api/status')
def api_status():
    return jsonify({**status, 'data_time': _data_time().isoformat(timespec='minutes'),
                    'refresh_at': REFRESH_AT})


@app.route('/img/<kind>/<name>')
def image(kind, name):
    if kind not in ('logos', 'heads'):
        abort(404)
    return send_from_directory(os.path.join(scrape.IMG_DIR, kind), name, max_age=7 * 86400)


@app.route('/favicon.ico')
def favicon():
    return send_from_directory(os.path.join(BASE_DIR, 'static', 'icons'), 'icon-192.png',
                               mimetype='image/png', max_age=7 * 86400)


@app.route('/sw.js')
def service_worker():
    resp = send_from_directory(os.path.join(BASE_DIR, 'static'), 'sw.js',
                               mimetype='application/javascript', max_age=0)
    resp.headers['Service-Worker-Allowed'] = '/'
    return resp


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=PORT, debug=False)
