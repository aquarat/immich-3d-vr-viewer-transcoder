# immich-3d-vr-viewer-transcoder

Note from the author (or owner/steward hah):
I've experimented with 3D video for quite some time. Some of these experiments involved filming events, trips, etc. with 3D camcorders from circa 2012, like the Sony HDR-TD10 and JVC GS-TD1. These cameras recorded in a clever format called H.264 MVC (multi-view coding). This codec worked by recording a primary video stream for the left lens and then a delta stream for the right lens. This was bitrate efficient but unfortunately the tools around this codec never really developed in the open source ecosystem and so this footage was largely inaccessible 3D-wise for a long time.

In more recent times others have done work to extend this, and of course, we now have "AI" agents.


Watch the stereoscopic 3D and 360° photos and videos in your
[Immich](https://immich.app) library in a VR headset — and convert old 3D
camcorder footage into a format that modern players and headsets understand.

Two halves that work on their own or together:

- **[`viewer/`](viewer/)** — a WebXR player served alongside Immich. Open it in
  the headset's browser and your side-by-side 3D video plays with real depth,
  360° media surrounds you, and your room stays visible behind it in
  passthrough. A control panel and a browsable thumbnail pane float in the
  space; point and pinch with your hands to use them, and drag them wherever
  you like. Built and tested on a Meta Quest 3.
- **[`transcoder/`](transcoder/)** — converts H.264 MVC recordings from 3D
  camcorders (Sony HDR-TD10, JVC GS-TD1 and relatives) into full-width
  side-by-side HEVC, with the recording date, camera and GPS position carried
  over. Stock FFmpeg decodes only one eye of MVC, so this uses a patched build,
  in **[`ffmpeg/`](ffmpeg/)**, made in a container.

They meet in the middle:

```
3D camcorder (.mts / .mp4, H.264 MVC)
   │  transcoder/mvcscan.py      find it
   │  transcoder/mvc2sbs.py      convert it  ──>  *_LR.mp4  (3840x1080 side-by-side HEVC)
   ▼
Immich library  ──  viewer/tools/backfill-albums.py  ──>  "VR 3D-SBS", "VR 360", "VR Spatial" albums
   ▼
https://your-immich/vr/  in the headset
```

## Getting started

- To **watch**, start with [viewer/README.md](viewer/README.md): put media into
  three albums, run one small container, and add a route to the reverse proxy
  that already fronts Immich.
- To **convert camcorder footage**, start with
  [transcoder/README.md](transcoder/README.md): build the patched FFmpeg, scan,
  dry run, convert.

[docs/findings.md](docs/findings.md) collects the non-obvious things learned
along the way — about WebXR on the Quest browser, about Immich, and about MVC —
and is worth reading before changing anything.

## Status

Tested with Immich v3.2.1, a Meta Quest 3 running Quest Browser 152, and a
corpus of 324 camcorder recordings (Sony HDR-TD10, JVC GS-TD1).

| Part | State |
| --- | --- |
| Side-by-side 3D video, passthrough, controls, dragging | used on the headset |
| 360° video | used on the headset |
| In-VR browse pane | **not yet run on a headset**; layout logic covered by tests |
| 360° photos as media layers (works in passthrough) | **not yet run on a headset**; the older WebGL path remains selectable |
| Spatial (MV-HEVC) video | plays, but one eye only: the browser decodes the base view |
| MVC conversion, VAAPI | the whole corpus; output reproduced frame for frame by this build |
| MVC conversion, x265 | tested on sample recordings |
| PAL (50i) recordings, AMD VAAPI | untested |

## Licence

[AGPL-3.0](LICENSE), with one exception: the patches in
[`ffmpeg/patches/`](ffmpeg/patches/) modify FFmpeg and stay under FFmpeg's own
licence (LGPL-2.1-or-later), so they can go upstream.

Section 13 of the AGPL applies to the viewer, since people use it over a
network: if you run a modified copy, its pages must offer your modified source.
They link to this repository; change the link in `viewer/public/index.html` and
`probe.html` to point at yours.

## Credits

- H.264 MVC decoding in FFmpeg is Dom Cobley's work (popcornmix), submitted
  upstream as an 18-patch series; this project adds four fixes on top.
- Written with Claude (Anthropic); commits carry a co-author trailer.
