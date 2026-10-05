#!/bin/sh
# Build FFmpeg with H.264 MVC decoding in a container.
#
# The source is Dom Cobley's H.264 MVC series for FFmpeg with the four fixes in
# patches/ applied on top, published as a branch so it can be fetched in one go.
# Binaries land in ./build and are run through ./bin/ffmpeg and ./bin/ffprobe.
#
#   ./build.sh                          fetch the pinned source and build
#   FFMPEG_SRC=~/src/FFmpeg ./build.sh  build an existing checkout, untouched
#
# Rebuilds are incremental (ccache), so re-running after a change is quick.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
IMAGE=${IMAGE:-immich-3d-ffmpeg}
FFMPEG_REPO=${FFMPEG_REPO:-https://github.com/aquarat/FFmpeg.git}
FFMPEG_REF=${FFMPEG_REF:-3155d2da276acfe7cf7e279aee0f14f1c89957da}
FFMPEG_SRC=${FFMPEG_SRC:-}
build=$here/build

docker build -t "$IMAGE" "$here"

if [ -z "$FFMPEG_SRC" ]; then
    # Our own clone: safe to move to the pinned commit.
    FFMPEG_SRC=$here/src
    if [ ! -d "$FFMPEG_SRC/.git" ]; then
        git clone --filter=blob:none --no-checkout "$FFMPEG_REPO" "$FFMPEG_SRC"
    fi
    git -C "$FFMPEG_SRC" cat-file -e "$FFMPEG_REF^{commit}" 2>/dev/null \
        || git -C "$FFMPEG_SRC" fetch --filter=blob:none origin "$FFMPEG_REF"
    git -C "$FFMPEG_SRC" checkout -q --detach "$FFMPEG_REF"
fi
# A checkout supplied by the caller is built as it stands, and mounted read-only:
# configure runs out of tree and never writes to the source.
FFMPEG_SRC=$(cd "$FFMPEG_SRC" && pwd)

mkdir -p "$build"
docker run --rm --user "$(id -u):$(id -g)" \
    -v "$FFMPEG_SRC:$FFMPEG_SRC:ro" -v "$build:$build" -w "$build" \
    -e CCACHE_DIR="$build/.ccache" \
    "$IMAGE" sh -ec "
        '$FFMPEG_SRC/configure' --cc='ccache gcc' --disable-doc --disable-debug \
            --enable-gpl --enable-vaapi --enable-libopus --enable-libx265
        nice -n 19 make -j\$(nproc)   # background work: yield to anything else running
    "

echo "built: $build/ffmpeg and $build/ffprobe — run them through $here/bin/"
