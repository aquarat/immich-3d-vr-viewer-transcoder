# Viewer

A WebXR player for the 3D and 360° media in an Immich library, served from
`/vr/` on the same address as Immich itself. Open it in the headset's browser,
pick a collection, double-tap a clip, and put the headset on.

- Side-by-side 3D video plays with real depth, on a panel you can resize and
  move. Full-width (3840x1080) and half-width (1920x1080) packing are both
  shown at the right shape.
- 360° video and photos surround you.
- Passthrough is on by default, so the panel floats in your room.
- A control panel under the picture, and a browsable pane of every collection,
  work with bare hands: point and pinch.

Built and tested on a Meta Quest 3 (Quest Browser 152) against Immich v3.2.1.

## What you need

- **Immich over HTTPS, with a certificate the headset trusts.** WebXR refuses to
  start on plain HTTP. A Let's Encrypt certificate on your Immich hostname is
  ideal.
- **The viewer on the same origin as Immich**, at `https://<your-immich>/vr/`.
  Immich sends no CORS headers, and same origin means your Immich login simply
  works for the viewer too. This needs one route in the reverse proxy that
  already fronts Immich.
- **Docker**, for the small container that serves the viewer.
- **Your media in three Immich albums**, which is how the viewer finds it.

## Setting up

### 1. Albums

The viewer shows three collections, each an Immich album:

| Album | Shown as |
| --- | --- |
| `VR 3D-SBS` | side-by-side 3D: video and photos, left eye on the left |
| `VR 360` | equirectangular 360°: video and photos |
| `VR Spatial` | Apple spatial video (see the limitation below) |

Fill them by hand in Immich, or let `tools/backfill-albums.py` do it. It finds
the transcoder's output by name, everything Immich already marks as
equirectangular, and spatial video from a list made by
`tools/find-spatial-videos.py`. It reads Immich's database and writes through
the API, and shows what it would do before it does anything:

```sh
cd viewer/tools
./backfill-albums.py                              # dry run: counts per album and owner
IMMICH_API_KEY=... ./backfill-albums.py --apply   # create and fill the albums
```

If your database container isn't Immich's default `immich_postgres`, set
`IMMICH_DB_CONTAINER`, `DB_USERNAME` and `DB_DATABASE_NAME`. An API key belongs
to one user, so `--apply` files that user's own media. Each person who wants the
viewer needs their own albums.

Why albums and not tags: Immich's metadata extraction replaces an asset's tags
with whatever the file itself carries, so hand-applied tags quietly disappear.
Album membership survives.

To find spatial video (it takes a while; the marker is at the end of each file):

```sh
./find-spatial-videos.py --path-map /usr/src/app/upload=/srv/immich/upload > spatial.txt
./backfill-albums.py --spatial-list spatial.txt
```

To keep the albums current as new media arrives, run `tools/refresh-albums.sh`
daily from cron. It finds new spatial video, then adds anything new to all three
albums. A cache means it reads only files that are new or changed, so after a
first full pass it is quick:

```sh
0 5 * * * /path/to/viewer/tools/refresh-albums.sh >> ~/.local/state/immich-3d/refresh.log 2>&1
```

It reads its settings from `~/.config/immich-3d/env` (the database settings
above, `SPATIAL_PATH_MAPS`, and so on — see the script's header). It also needs
an API key in `~/.config/immich-3d/api-key`, readable only by you. The key
needs just four permissions: `user.read`, `album.read`, `album.create` and
`albumAsset.create`.

### 2. The container

```sh
cd viewer/deploy
docker compose up -d
```

This serves `public/` on port 8088, plus a small collector that receives
diagnostics from the headset. If your reverse proxy runs on the same machine,
bind the port to loopback in `docker-compose.yml`.

The collector only accepts reports from someone logged in to Immich. Before
passing a report on, nginx asks Immich's `/api/users/me` whether the report's
own session cookie or API key belongs to a user, and anything else is turned
away. This assumes Immich is published on the same machine's port 2283, as in
Immich's own compose file. If yours is elsewhere, change the `upstream` at the
top of `deploy/nginx.conf`.

### 3. The route

Send `/vr/` on your Immich hostname to port 8088, stripping the `/vr` prefix.
There are working examples for Caddy, nginx and Traefik in
[`deploy/proxy/`](deploy/proxy/).

If Immich is also reachable through a tunnel or CDN (Cloudflare Tunnel, say),
check that path ends at the same proxy. A tunnel pointed straight at Immich's
port skips the route, and `/vr/` shows Immich's 404 page.

### 4. In the headset

Log into Immich in the Quest Browser, then open `https://<your-immich>/vr/`.
Double-tap a thumbnail to go straight in, or select one and press **Enter VR**
in the bar along the bottom of the page.

## Controls

A pinch with your hand works like a trigger pull, so everything works with
either hands or controllers. What a pinch does depends on what you point at
when it starts:

| Point at | Pinch | Pinch and drag |
| --- | --- | --- |
| a panel button | press it (it fires when you let go over it) | |
| the progress bar | jump there | scrub |
| the video, or the panel's background | play / pause | move it |
| a thumbnail in the browse pane | play it | scroll the pane |
| the pane's right edge | jump through the list | |
| empty space | play / pause | **hold for a second to leave VR** |

The panel's buttons are previous, play/pause, next, **browse** (opens the pane
of every collection), **link** and **Exit VR**. With link on (the default), the
panel docks under the video and they move together; with it off, each moves on
its own. Positions are remembered between sessions; **Reset positions** under
Viewing options puts them back.

With controllers, you also have: **A** to play or pause, **B** or squeeze to
leave, thumbstick left and right for the previous or next clip, and up and
down to seek.

## Viewing options

On the page, under *Viewing options*:

- **Passthrough** — your room behind the picture (on by default). The grid, and
  photos drawn the older WebGL way, need a fully immersive session, so they
  switch it off for that session and say so.
- **Grid background** — a floor grid and status board. It needs WebGL, which
  has been the least stable part of the Quest browser; leave it off unless you
  want it.
- **Sound**; **Stereo** to override a collection's layout; panel **width** and
  **distance**.
- **Photo detail** — the largest dimension a photo is decoded to (4096 by
  default). 8192 is sharper and uses about four times the memory.
- **Photos via** — *media layer* (default), or the older *WebGL* path.

## Diagnostics

The headset has no developer tools you can use, so the viewer reports what it
sees back to the collector, which writes one JSON line per report into
`deploy/logs/`. It reports when the page loads, on any failure, when a session
starts and ends, and when you leave the page.

```sh
tools/vrlog              # the latest report
tools/vrlog --fails      # only what failed or warned
tools/vrlog -n 5         # the last five
```

`/vr/probe.html` is a capability probe for checking a new headset, browser or
server. It shows which WebXR layers exist, whether the media will decode
smoothly, whether authentication works from this origin, and which service
worker controls the page. It picks test clips from the albums above, or from a
`test-assets.json` beside it if you want specific ones.

## Tests

The pointing, docking, stereo-packing and browse-pane layout code is tested
against the real functions, pulled out of `public/xr.js`, with no browser or
headset needed:

```sh
node test/geometry.test.js < public/xr.js
node test/pane.test.js < public/xr.js
```

## How it works

Everything you see in the headset is a WebXR *media layer*, composited by the
headset itself. That includes the control panel and the browse pane. They are
drawn as ordinary 2D canvases, captured as live video with `captureStream()`,
and shown exactly like a clip. Photos are drawn the same way, as single frames.
Drawing through WebGL instead proved fragile on the Quest browser (see
[findings](../docs/findings.md)); media layers have been solid.

The page registers its own small service worker for `/vr`. Immich's own worker
would otherwise intercept the viewer's video requests and break seeking and
playback.

## Known limitations

- **Spatial video shows one eye.** Apple's MV-HEVC carries the second eye as an
  extra layer the browser does not decode. Converting it to side-by-side on the
  server would fix this.
- **Photos in `VR 3D-SBS`** play as stereo panels. Stereo photo formats such as
  MPO and Apple's spatial photos are not converted.
- **One user's media per session**: the albums of whoever is logged in.
