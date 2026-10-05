# FFmpeg with H.264 MVC decoding

Stock FFmpeg decodes only the base view of H.264 MVC, so 3D camcorder footage
comes out as one eye. This builds an FFmpeg that decodes both, in a container,
for the [transcoder](../transcoder/).

## What's in it

The source is FFmpeg with Dom Cobley's H.264 MVC series applied: 18 patches
that add Annex H multiview decoding to the h264 decoder. They reuse the
`view_ids` options and `-map 0:v:view:N` specifiers that FFmpeg already has for
MV-HEVC, and they handle the field-coded MVC that camcorders record. The series
has been submitted upstream but is not yet in an FFmpeg release.

On top of it are the four fixes in [`patches/`](patches/), found while
converting a few hundred real camcorder recordings:

1. **h264dec:** a dependent-view picture holding only its first field was
   output early, which duplicated every non-reference frame.
2. **h264_slice:** cropping was not carried over to frame threads, so the
   dependent view came out 1088 lines tall instead of 1080.
3. **h264_parser:** the dependent view's parameter sets and SEI ended the access
   unit, which broke IDR handling and produced grey frames.
4. **mpegts:** in `.mts` files the dependent view travels on its own stream
   (stream type 0x20). It is now merged into the base view's stream, with the
   access units interleaved, so `ffmpeg -i x.mts -map 0:v:view:all` just works.
   This is on by default; the demuxer option `-merge_mvc 0` turns it off.

The patches apply on top of the series at commit `f5a6ecf95d`, which sits on
FFmpeg master at `a1050d48b0`. The combined result is published as a branch,
and `build.sh` fetches it pinned to `3155d2da27`.

## Building

```sh
./build.sh
```

This needs Docker. It builds a Debian image with the toolchain and the Intel
and AMD VAAPI drivers, fetches the source, and compiles FFmpeg with libx265,
VAAPI and Opus. A first build takes minutes; later ones are incremental.
Binaries land in `build/`.

To build a checkout you already have, leaving it untouched:

```sh
FFMPEG_SRC=~/src/FFmpeg ./build.sh
```

## Running

`bin/ffmpeg` and `bin/ffprobe` run the built binaries in the container as
though they were installed locally. The current directory is bind-mounted at
its own path, and so is each directory listed in `MVC_MOUNTS` (one per line,
with a `:ro` suffix for read-only). File paths therefore mean the same inside
the container as outside. `/dev/dri` is passed through when it exists, for
VAAPI. The transcoder sets `MVC_MOUNTS` itself; for your own commands:

```sh
MVC_MOUNTS="/media/camcorder:ro" bin/ffmpeg -i /media/camcorder/clip.mts \
    -filter_complex '[0:v:view:0][0:v:view:1]hstack' -c:v libx265 out.mp4
```

## Licence

The patches modify FFmpeg and are under FFmpeg's licence, LGPL-2.1-or-later,
like the files they change. The built binaries are GPL, because of
`--enable-gpl` and libx265. Everything else in this directory is AGPL-3.0, like
the rest of the repository.
