"""NBAViz - mobile-first NBA ratings, leaders and odds.

Serves one page plus the JSON that scrape.py writes. A background thread
refreshes the data once a day at REFRESH_AT (local time, default 08:00):

  * a failed refresh is retried every RETRY_MINUTES until it works;
  * if ESPN's season totals don't include last night's games yet (they can lag
    the scoreboard by several hours), it checks again every CATCHUP_MINUTES
    until they do, but not after CATCHUP_UNTIL o'clock;
  * after a reboot or downtime it refreshes straight away if the data is older
    than the most recent REFRESH_AT.

Only one process runs the scheduler (file lock), even if the app is started twice.

    python3 app.py                         # http://<pi>:5003
    FLASK_APP=app.py flask run --port 5003 # the way WebServers/Start.sh runs it

Add ?demo=1 to the URL for made-up, spoiler-free data (?live=1 switches back).
Set NBAVIZ_NO_REFRESH=1 to serve the existing files without refreshing.
"""

import fcntl
import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone

from flask import Flask, abort, jsonify, render_template, request, send_from_directory

import scrape

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DEMO_FILE = os.path.join(scrape.DATA_DIR, 'demo.json')
LOCK_FILE = os.path.join(scrape.DATA_DIR, '.refresh.lock')
REFRESH_AT = os.environ.get('NBAVIZ_REFRESH_AT', '08:00')
RETRY_MINUTES = 30
CATCHUP_MINUTES = 60
CATCHUP_UNTIL = 14
PORT = int(os.environ.get('NBAVIZ_PORT', 5003))

app = Flask(__name__)
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
    """Returns 'ok', 'lagging' (ESPN totals behind the results) or 'failed'."""
    status['running'] = True
    try:
        dash = scrape.refresh(log=log.info)
        lagging = sum(1 for t in (dash or {}).get('teams', []) if t['gp'] < t['w'] + t['l'])
        status['last_ok'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
        status['last_error'] = None
        result = 'lagging' if lagging else 'ok'
        if lagging:
            log.info('ESPN season totals are behind the results for %d teams', lagging)
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
                   for f in ('app.js', 'app.css', 'tpchart.js', 'threes.js')))


@app.route('/threes')
def threes_page():
    """Stand-alone 3-point page. It loads /api/threes only, which carries no
    records, ratings, standings or odds, so it is safe to open mid-game."""
    return render_template('threes.html', v=_asset_version())


_json_cache = {}


def _load_json(path):
    mtime = os.path.getmtime(path)
    hit = _json_cache.get(path)
    if not hit or hit[0] != mtime:
        hit = (mtime, scrape.read_json(path))
        _json_cache[path] = hit
    return hit[1]


DEMO_GAMES = [('BOS', 'NYK'), ('GSW', 'LAL'), ('PHX', 'DEN'), ('MIA', 'ORL')]


def _todays_games():
    """Today's matchups (US date) from the cached scoreboard: team pairs only, never scores."""
    today = datetime.now(scrape.US_EAST).date()
    day = scrape.read_json(os.path.join(scrape.DAY_DIR, today.strftime('%Y%m%d') + '.json')) or {}
    games = []
    for ev in day.get('events', []):
        if ev.get('away') and ev.get('home'):
            games.append({'away': ev['away']['abbr'], 'home': ev['home']['abbr']})
    return today.isoformat(), games


@app.route('/api/threes')
def api_threes():
    demo_mode = request.args.get('demo') == '1'
    path = DEMO_FILE if demo_mode else scrape.DASHBOARD
    if demo_mode and not os.path.exists(DEMO_FILE):
        import demo
        demo.write()
    if not os.path.exists(path):
        return jsonify({'error': 'No data yet - the first refresh is still running.'}), 503
    d = _load_json(path)
    players = d.get('players', {})
    teams = []
    for t in sorted(d['teams'], key=lambda t: t['name']):
        roster = [players[pid] for pid in t.get('roster', []) if pid in players]
        teams.append({
            'abbr': t['abbr'], 'name': t['name'], 'nick': t.get('nick'),
            'tp': t.get('tp'), 'tpa_g': t.get('tpa_g'),
            'players': [{'name': p['name'], 'short': p.get('short'), 'pos': p.get('pos'),
                         'tpm': p['tpm'], 'tpa': p['tpa']} for p in roster],
        })
    if demo_mode:
        games_date, games = None, [{'away': a, 'home': h} for a, h in DEMO_GAMES]
    else:
        games_date, games = _todays_games()
    return jsonify({
        'demo': demo_mode, 'season': d.get('season'), 'generated': d.get('generated'),
        'league_tp': (d.get('league') or {}).get('tp'),
        'games_date': games_date, 'games': games, 'teams': teams,
    })


@app.route('/api/dashboard')
def dashboard():
    path = DEMO_FILE if request.args.get('demo') == '1' else scrape.DASHBOARD
    if request.args.get('demo') == '1' and not os.path.exists(DEMO_FILE):
        import demo
        demo.write()
    if not os.path.exists(path):
        return jsonify({'error': 'No data yet - the first refresh is still running.'}), 503
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
