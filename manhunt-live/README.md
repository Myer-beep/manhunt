# Manhunt (live): real GPS, real multiplayer

A real-time GPS tag game. Players open a web page on their phones, join with a code, and the
server runs the game: real GPS, a real map, server-side rules and anti-cheat.

- `engine.js`   game rules (server only): roles, tags, zone, pings, chat, visibility
- `server.js`   HTTP API + serves the web app. No dependencies, just Node 18+
- `public/`     the phone web app (Leaflet + OpenStreetMap map, falls back to a simple map)
- `test/`       unit tests, API tests, real-browser tests (3 simulated phones with GPS)

## Run it on your computer
    node server.js            # then open http://localhost:3000
Phones can't use GPS on a plain http:// address (except localhost), so to try it with real phones
you need an https address: deploy it (below) or use a tunnel like `cloudflared tunnel --url http://localhost:3000`.

## Put it online (free tiers work)
You need the folder in a GitHub repo. Then, on **Render.com**:
1. New > Web Service > connect the repo
2. Runtime: Node. Build command: leave empty (or `npm install`). Start command: `node server.js`
3. Pick the free plan and deploy. You get an https:// URL. That's your game. Send it to friends.

Notes on the free plan: the service sleeps after ~15 minutes of nobody using it (the first visit
then takes 30-60 seconds), and a restart wipes any running games. For friends playing a round
that's fine. Paid plans (about $7/month) stay awake. Railway, Fly.io and Replit also work.

## How to play-test it with friends
1. Everyone opens the URL on their phone, enters a name, and allows location when asked.
2. One person taps Host a game, shares the code (Share button), and sets the rules.
3. Others tap Join with a code, pick a role, tap Ready. Host taps Start game.
4. Keep the page open and in front: web pages stop GPS when the phone locks or you switch apps.

## What works
Create/join with codes (rate-limited), lobby with roles/ready/kick, host rules, Classic and Infection,
head start, zone that shrinks on the server clock, ping pins with age, out-of-zone countdown, physical
tagging that the tagged player must confirm (with a distance sanity check from both real GPS fixes),
team-only chat, host pause/resume/end, reconnect after a reload, game-over summary, locations wiped
when a game ends. Runners can never receive hunters' hidden positions: the server just doesn't send them.

## Not built yet (was in the browser simulation)
XP, beacons, power-ups, missions, replay, profile photos, friends, leaderboards, accounts/passwords.
Players are identified by a random token stored in their browser (a guest), not an account.

## Honest limits
- **Background GPS:** a web page can't track you when the screen is locked or the app is in the
  background. For that you need a native app (Expo/Capacitor wrapper around this same server).
- **GPS accuracy:** phones are accurate to 5-30 m outdoors, worse near buildings. Tags need both
  players within ~75 m (after accuracy) and the tagged player confirms. Zone checks forgive GPS error.
- **Scale:** one small server, games kept in memory. Fine for friend groups, not for thousands.
- **Real-world safety, minors, privacy policy and app-store rules:** see `../manhunt/RELEASE.md`.
- **Tested here:** rules, API, and 3 simulated phones in a real browser with emulated GPS. NOT tested:
  real phones, real GPS drift, the real OpenStreetMap tiles, or a real deployment. Do a field test
  with 2-3 phones before inviting a crowd.
