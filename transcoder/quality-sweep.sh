#!/bin/sh
# Encode one MVC recording to full-width side-by-side with the given encoder
# arguments, then measure SSIM and PSNR against the unencoded, deinterlaced
# side-by-side picture. This is how the bitrates in mvc2sbs.py were chosen.
#
#   ./quality-sweep.sh input.mts /tmp/sweep x265-crf20 -c:v libx265 -preset slow -crf 20
#   VAAPI=1 ./quality-sweep.sh input.mts /tmp/sweep vaapi-q25 \
#       -c:v hevc_vaapi -low_power 1 -rc_mode QVBR -global_quality 25 -b:v 20M -maxrate 30M
#
# VAAPI=1 uploads the picture to the GPU inside the filter graph (VAAPI_DEVICE,
# default /dev/dri/renderD128). FFMPEG / FFPROBE default to the bundled,
# MVC-capable builds.
set -eu
IN=$1; OUT=$2; LABEL=$3; shift 3
here=$(cd "$(dirname "$0")" && pwd)
FF=${FFMPEG:-$here/../ffmpeg/bin/ffmpeg}
FP=${FFPROBE:-$here/../ffmpeg/bin/ffprobe}
mkdir -p "$OUT"
export MVC_MOUNTS="$(cd "$(dirname "$IN")" && pwd):ro
$(cd "$OUT" && pwd)"

SBS="[0:v:view:0]bwdif=mode=send_field:parity=auto:deint=all[l];[0:v:view:1]bwdif=mode=send_field:parity=auto:deint=all[r];[l][r]hstack=inputs=2"
hw=""; tail=""
if [ "${VAAPI:-}" = 1 ]; then
    hw="-init_hw_device vaapi=va:${VAAPI_DEVICE:-/dev/dri/renderD128} -filter_hw_device va"
    tail=",format=nv12,hwupload"
fi
start=$(date +%s.%N)
# shellcheck disable=SC2086  # $hw is a list of options
"$FF" -hide_banner -nostats -v error $hw -i "$IN" -filter_complex "$SBS$tail[v]" -map "[v]" -map 0:a? -c:a copy \
    -fps_mode passthrough "$@" -y "$OUT/$LABEL.mkv"
end=$(date +%s.%N)

frames=$("$FP" -v error -count_packets -select_streams v -show_entries stream=nb_read_packets -of csv=p=0 "$OUT/$LABEL.mkv")
fps=$("$FP" -v error -select_streams v -show_entries stream=avg_frame_rate -of csv=p=0 "$OUT/$LABEL.mkv")
dur=$(awk -v f="$frames" -v r="$fps" 'BEGIN{split(r, p, "/"); print f / (p[1] / p[2])}')
size=$(stat -c %s "$OUT/$LABEL.mkv")
# A common timebase and frame-numbered timestamps, or the comparison pairs the wrong frames.
q=$("$FF" -hide_banner -nostats -i "$OUT/$LABEL.mkv" -i "$IN" -filter_complex \
    "$(echo "$SBS" | sed 's/0:v:view/1:v:view/g'),settb=1/1000,setpts=N,split[r1][r2];[0:v]settb=1/1000,setpts=N,split[a][b];[a][r1]ssim;[b][r2]psnr" \
    -f null - 2>&1 | grep -oE "SSIM Y:[0-9.]+|PSNR y:[0-9.]+" | tr '\n' ' ')
awk -v l="$LABEL" -v s="$size" -v d="$dur" -v t="$(awk "BEGIN{print $end-$start}")" -v f="$frames" -v q="$q" \
    'BEGIN{printf "%-28s %6.1f Mbit/s  %5.1f fps  %s\n", l, s*8/d/1e6, f/t, q}'
