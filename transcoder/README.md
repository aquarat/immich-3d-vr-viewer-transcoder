# Transcoder

Converts 3D camcorder recordings into side-by-side HEVC MP4s that headsets,
media players and Immich all understand.

Consumer 3D camcorders from around 2011–2014 — Sony's HDR-TD10/TD20/TD30, JVC's
GS-TD1, Panasonic's HDC-Z10000 and others — record **H.264 MVC**: an ordinary
H.264 stream for one eye, with the other eye coded as an extra layer that
almost nothing decodes any more. Played normally, the footage looks flat.
These tools find it, decode both eyes, and write them side by side.

| Input | Output |
| --- | --- |
| H.264 MVC (Sony `.mts`, JVC `.mp4`, …) | `*_LR.mp4` — full-width side-by-side, 3840x1080 for 1080i, each eye at full resolution |
| Frame-packed side-by-side (JVC AVCHD 3D `.MTS`) | `*_3DH.mp4` — half-width side-by-side, 1920x1080, as recorded |

Both are deinterlaced to the full field rate (59.94p from NTSC, 50p from PAL)
with `bwdif`, one view at a time, and encoded as HEVC.

- **Audio:** AAC is copied; anything else (the Sony cameras' AC-3 5.1) becomes
  AAC, because the Meta Quest's default player plays no Opus in MP4. Where a
  recording's audio starts before its picture, the lead is trimmed so that both
  tracks start at zero rather than relying on an MP4 edit list.
- **Metadata:** the recording date, with its time zone, comes from the camera's
  own MDPM metadata in the stream, or the container's creation time where there
  is none. The GPS position also comes from MDPM, where the camera recorded one.
  The camera make and model are carried over too. All of it is written as
  QuickTime metadata, which Immich reads.

## You will need

- **The patched FFmpeg** from [`../ffmpeg`](../ffmpeg/). Stock FFmpeg decodes
  only the base view of MVC — one eye. Building it takes Docker and a few
  minutes: `../ffmpeg/build.sh`. The transcoder finds it automatically once it
  is built.
- Python 3.9 or later. No other packages are needed.

## Use

```sh
# 1. Find the 3D recordings. Only the start of each file is read, and an
#    interrupted scan resumes.
./mvcscan.py /media/camcorder /media/old-backups -o scan.jsonl

# 2. Optional: a report by camera, and what is missing from a library folder.
./camcorder_report.py scan.jsonl --library /srv/immich/originals

# 3. See where each output will go.
./mvc2sbs.py --scan scan.jsonl --out-root /srv/media/3d-sbs --dry-run

# 4. Convert.
./mvc2sbs.py --scan scan.jsonl --out-root /srv/media/3d-sbs
```

Outputs are filed by recording date as `YYYY/MM/<date>_<make>_<name>_LR.mp4`.
With `--keep-layout ROOT`, inputs under `ROOT` keep their folders and names
instead. Each file is written under a temporary name and checked: the duration
must match, and the frame count must match the source's field rate. Only then
is it renamed into place, so an interrupted run just picks up where it stopped.
Per-file logs and a `summary.jsonl` go to `mvc2sbs-logs/`.

Point an Immich external library at the output folder, then run the viewer's
`tools/backfill-albums.py`. It picks up `*_LR.mp4` and `*_3DH.mp4` by name.

### Encoders

| `--encoder` | |
| --- | --- |
| `x265` (default) | Software. Runs anywhere; `--crf` (default 20) and `--preset` (default `slow`). Slow on small machines: about 0.65 frames per second for 3840x1080 at `slow` on an Intel N150. |
| `vaapi` | Intel or AMD GPU, quality-targeted VBR (`--quality`, default 25), 20 Mbit/s target and 30 Mbit/s cap for full-width. About 1.5x realtime on an N150. |

The container includes the Intel and AMD VAAPI drivers, so only `/dev/dri` has
to be available; the wrapper passes it in.

### Taking metadata from Immich

If the recordings are already in Immich, `--immich-metadata` reads Immich's
database for each file. Immich's date is used where the camera recorded none,
and Immich's GPS position is preferred to the camera's, so a location you set
by hand survives. Immich stores paths as its container sees them, so map them
to local ones:

```sh
./mvc2sbs.py --scan scan.jsonl --out-root /srv/media/3d-sbs \
    --immich-metadata --immich-path-map /originals=/srv/immich/originals
```

The database settings are the same as the viewer's tools: `IMMICH_DB_CONTAINER`,
`DB_USERNAME` and `DB_DATABASE_NAME`, defaulting to Immich's official names.

## The other tools

- **`mvcmerge.py`** joins the two MVC views of a `.mts` into one H.264 stream,
  for standalone MVC decoders such as edge264. The patched FFmpeg does not need
  it.
- **`quality-sweep.sh`** encodes one recording with the encoder settings you
  give it and measures SSIM and PSNR against the unencoded picture. It is how
  the defaults above were chosen.

## Things that went wrong, so they don't again

- **The two MVC views travel separately in `.mts` files**, on different MPEG-TS
  streams (PIDs 0x1011 and 0x1012). FFmpeg treated them as unrelated streams
  and decoded one eye. One of the four FFmpeg patches merges them.
- **Camcorder MVC is interlaced (field-coded)**, and most MVC decoders don't
  handle that. edge264 and Android's libavc have no interlaced MVC; another
  FFmpeg fork skips the inter-view references for fields. Dom Cobley's series
  does it properly.
- **Video-only ffmpeg runs shift the timestamps** by the video's first packet in
  decode order, and an MP4 edit list then hides the first frames. With audio
  mapped, the timing comes out right.
- **Some recordings' audio starts before the picture**: about 0.8 s in fifteen
  Sony clips here. That lead is now measured on the decoded frames and trimmed.
- **Check a converted file against its video stream's duration.** The container
  duration includes audio that runs past the picture, and two files failed
  verification for that reason alone.
- **Compare quality with frame-numbered timestamps.** Give both inputs the same
  timebase with `settb`, then `setpts=N`. Otherwise the SSIM and PSNR filters
  pair the wrong frames.
