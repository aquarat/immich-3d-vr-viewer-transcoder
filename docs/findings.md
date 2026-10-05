# Findings

Things that cost time to discover, in case they save you some. Each was
confirmed on real hardware or real files: a Meta Quest 3 on Quest Browser 152
(Chromium 152), Immich v3.2.1, and a few hundred 3D camcorder recordings.

## WebXR on the Quest browser

**Stereo media layers work, and are the thing to build on.** `XRMediaBinding`
offers quad, cylinder and equirect layers. A quad layer with
`layout: 'stereo-left-right'` gives real depth from a side-by-side video. The
headset composites media layers itself, so they cost the page almost nothing
and look better than anything drawn through WebGL.

**Quad layer `width` and `height` are half-extents.** Ask for `width: 1.6` and
the panel is 3.2 m wide.

**Layers composite in array order, not by depth.** A layer later in
`renderState.layers` covers earlier ones wherever they overlap, even if it is
further away. Keep panels beside the picture, not in front of it.

**A projection layer needs `depthFormat: 0` when you draw without depth.** By
default it allocates a depth texture, and the compositor reprojects against it.
If you draw with depth testing off and never attach that texture, the WebGL
context is lost after exactly one frame, every time. The frame before reports a
complete framebuffer and no GL errors.

**In passthrough (`immersive-ar`), a WebGL projection layer loses its context
after one frame, even with `depthFormat: 0`.** The same layer runs for thousands
of frames in `immersive-vr`. Media layers are fine in both. That is why this
viewer draws its panels on 2D canvases, captures them with `captureStream()`,
and shows them as media layers. It needs no WebGL anywhere, and it works in
passthrough.

**A lost WebGL context outlives the page.** After a few losses,
`getContext('webgl2')` returns `null` even on a freshly loaded page, because
the browser's GPU process is exhausted. Reloading does not help; closing the
browser completely does.

**`XRProjectionLayer.textureType` cannot be read back.** It is an option you
pass in, not an attribute of the layer, so it reads as `undefined`. Branch on
whether `getViewSubImage()` returned an `imageIndex` instead. Getting this wrong
sends a texture array to `framebufferTexture2D`, and you get an empty
framebuffer.

**A canvas keeps its first context.** Calling `getContext('webgl2')` once
without attributes fixes the context's attributes for good. A later request
for `{ xrCompatible: true }` then gets the old, non-XR context back.

**The gesture that opens a session arrives inside it.** Entering VR is a
trigger press, and a double-tap is two; the trailing release turns up as a
`select` in the new session. Ignore inputs for a moment after the session
starts, and never end a session because nothing has loaded yet.

**If you stop calling `requestAnimationFrame`, the screen goes black,
including media layers.** Stop drawing when something breaks, but keep the
frame loop running.

**With hands, pinch is the only input you can rely on.** It arrives as
`select`, exactly like a trigger. There are no thumbsticks or face buttons, and
`squeeze` is unreliable. Design around one gesture, and let what it points at
decide what it does.

**Hundreds of decoded images exhaust the renderer.** A thumbnail grid that
decoded 324 images at once took the WebXR session down with it. Load what is in
view, and release what is not.

## Immich

**Immich's service worker breaks video playback from other pages on its
origin.** It is registered at `/`. It intercepts
`/api/assets/<id>/(original|thumbnail)`, de-duplicates requests by URL alone,
and hands back a clone of the first response for five minutes. A `<video>`
element makes successive Range requests to the same URL, so the second request
gets the first one's bytes. It fails as `MEDIA_ERR_SRC_NOT_SUPPORTED`, which
looks exactly like a codec problem. Immich's own player is unaffected, because
it uses `/video/playback`. The fix is a worker of your own at a narrower scope:
the longest scope wins. If the page can load without a trailing slash, that
scope must be `/vr` rather than `/vr/`, which needs a `Service-Worker-Allowed`
header on the worker script.

**Tags set by hand do not survive.** Metadata extraction calls
`replaceAssetTags()`, which replaces an asset's whole tag set with what the
file's own XMP carries. Watched here, 1113 hand-applied tags were being removed
within the hour. Every asset that lost its tag had just had its metadata
re-extracted. Albums are not derived from file metadata, and they survive.

**`GET /api/albums/{id}` does not list the album's assets** in v3; it returns
`assetCount` only. Use `POST /api/search/metadata` with `albumIds`.

**`duration` is in milliseconds** in v3: an integer, `null` for photos.

**No CORS headers**, by design. Serve anything that uses the API from Immich's
own origin.

**Play `/api/assets/{id}/original`, not `/video/playback`, for stereo video.**
Immich's transcodes follow its configured policy, which can halve each eye's
resolution or leave a file untranscoded entirely.

**`asset_exif.projectionType = 'EQUIRECTANGULAR'`** marks 360° media. Some of
it is phone panoramas wider than 2:1: a full turn horizontally, but less than a
full sphere vertically. Map those with their real vertical extent, 360 ÷ aspect
degrees, or they come out stretched.

**Never delete and re-add a file in an external library.** The watcher drops
the asset and imports it again as a new one, losing its albums and faces.
Overwrite it in place instead.

## Spatial and MVC video

**Apple spatial video (MV-HEVC) is marked by a `vexu` box**, which iPhone `.MOV`
files write in a `moov` atom at the *end* of the file. A scan of the first few
megabytes finds nothing. Browsers decode only the base view, so in the headset
it looks flat. FFmpeg 7.1 and later can split the views:
`[0:v:0:view:0][0:v:0:view:1]hstack`.

**Camcorder MVC is field-coded, and most MVC decoders can't decode that.**
edge264 and Android's libavc have no interlaced MVC, and one FFmpeg fork skips
the inter-view references for fields. Dom Cobley's FFmpeg series handles it.

**In `.mts` files the two views are separate streams** (PIDs 0x1011 and 0x1012,
stream type 0x20). They have to be merged before a decoder sees both. This
build's mpegts demuxer does it.

**The Quest's default player plays no Opus in MP4.** Use AAC.

**Encoding MV-HEVC on Linux is still awkward.** x265 4.1 built with
`ENABLE_MULTIVIEW` can do it — reportedly at 8 bits only so far — but FFmpeg
can't yet mux the result cleanly. The tools that add the `vexu` box which makes Apple devices
treat a file as spatial are Windows- and macOS-only. Full-width side-by-side
HEVC is the pragmatic archive format: every player and headset understands it,
and it can be turned into MV-HEVC later.
