# Build and runtime image for the MVC-capable FFmpeg.
#
# Everything comes from Debian's own archive (non-free enabled for Intel's media
# driver), so the container can encode with VAAPI on its own: only /dev/dri has
# to be passed in, not a driver from the host.
FROM debian:trixie

RUN sed -i 's/^Components: main$/Components: main non-free non-free-firmware/' \
        /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
        build-essential nasm pkg-config ccache git ca-certificates \
        libva-dev libdrm-dev libopus-dev libx265-dev zlib1g-dev \
        mesa-va-drivers vainfo \
        $( [ "$(dpkg --print-architecture)" = amd64 ] && echo intel-media-va-driver-non-free ) \
 && rm -rf /var/lib/apt/lists/*
