# NBAViz

Mobile-first NBA dashboard: net rating (raw and opponent-adjusted) with a
zoomable ORtg/DRtg diamond, offensive and defensive rating, season stat leaders, a 3P% chart for every roster, and
Polymarket championship and MVP odds.

## Run

```bash
python3 app.py                                  # http://<pi>:5003
FLASK_APP=app.py flask run --host=0.0.0.0 --port=5003   # WebServers/Start.sh style
```

Started on boot by `WebServers/Start.sh` (port 5003, PID in `WebServers/flask_3.pid`).

The app refreshes its data once a day at 08:00 local time (`NBAVIZ_REFRESH_AT`)
in a background thread:

- a failed refresh is retried every 30 minutes until it works;
- if ESPN's season totals don't include last night's games yet, it checks
  again every hour until they do (not after 14:00);
- after a reboot it refreshes straight away if the data is older than the
  latest 08:00.

`/api/status` shows the next run and the last result. `NBAVIZ_NO_REFRESH=1`
turns the schedule off, `NBAVIZ_PORT` changes the port.

Manual refresh: `python3 scrape.py` (or `--offline` to rebuild from cache).

## Spoiler-free demo

Open `/?demo=1` to see made-up numbers and fictional players (real team logos).
The browser remembers it until you tap the yellow "Demo data" badge, which asks
before switching to live data. `/?live=1` also switches back. Demo data comes
from `demo.py` (`python3 demo.py` regenerates it).

## Data

| What | Source | Requests per refresh |
|---|---|---|
| Team season totals incl. opponents -> ORtg, DRtg, NRtg | ESPN `statistics/byteam` | 1 |
| Results (who played whom) for the opponent adjustment and W-L | ESPN scoreboard, one per day, finished days cached forever | 1-2 |
| Player per-game stats, qualified + all | ESPN `statistics/byathlete` | 2 |
| Title + MVP odds and price history | Polymarket Gamma + CLOB (read-only) | ~14 |
| Logos, headshots | ESPN CDN, downloaded once to `data/img/` | 0 after first run |

Basketball-Reference (the original plan) serves scripts a Cloudflare bot
challenge, and stats.nba.com / cdn.nba.com JSON is blocked from this IP, so
neither is used. `model.py` computes the ratings the Basketball-Reference way:
possessions from FGA, FTA, ORB, TOV; ORtg/DRtg per 100 possessions; and an
SRS-style least-squares opponent adjustment for ORtg/A, DRtg/A, NRtg/A.
ESPN's season totals can lag the scoreboard by a game for a few hours; the
adjustment only counts opponents of games the totals include.

`data/snapshots/YYYY-MM-DD.json` keeps one small record per day (ratings and
odds) for future trend charts.

## Files

- `app.py` - Flask app, background refresh, `/api/dashboard`, `/img/...`
- `scrape.py` - fetching and caching
- `model.py` - ratings, adjustment, leaders, odds matching
- `demo.py` - spoiler-free demo data
- `templates/index.html`, `static/app.js`, `static/app.css` - the page (vanilla JS + SVG, no build step)
- `static/sw.js`, `static/manifest.json`, `static/icons/` - installable PWA

## Privacy

Keep it private (LAN or Tailscale). Sports-data sites and the NBA restrict
republishing, and NBA logos are trademarks.
