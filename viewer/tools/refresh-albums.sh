#!/bin/sh
# Keep the viewer's albums current: look for new spatial video, then add anything
# new to all three albums (new transcoder output, newly imported 360 media, and
# the spatial video just found). Made for cron:
#
#   0 5 * * * /path/to/viewer/tools/refresh-albums.sh >> ~/.local/state/immich-3d/refresh.log 2>&1
#
# Settings come from the environment, or from a shell file of assignments at
# $REFRESH_ENV (default ~/.config/immich-3d/env), which can hold:
#
#   IMMICH_DB_CONTAINER, DB_USERNAME, DB_DATABASE_NAME   see immich_db.py
#   IMMICH_URL            Immich's address               (default http://127.0.0.1:2283)
#   IMMICH_API_KEY_FILE   a file holding only the key    (default ~/.config/immich-3d/api-key)
#   SPATIAL_PATH_MAPS     one IMMICH=HOST mapping per line, as for find-spatial-videos.py
#   STATE_DIR             cache and lists                (default ~/.local/state/immich-3d)
#
# The API key needs only user.read, album.read, album.create and
# albumAsset.create, and adds that key's owner's media only.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
conf=${REFRESH_ENV:-$HOME/.config/immich-3d/env}
# shellcheck disable=SC1090
[ -f "$conf" ] && . "$conf"
state=${STATE_DIR:-$HOME/.local/state/immich-3d}
key_file=${IMMICH_API_KEY_FILE:-$HOME/.config/immich-3d/api-key}
export IMMICH_DB_CONTAINER DB_USERNAME DB_DATABASE_NAME IMMICH_URL 2>/dev/null || true
mkdir -p "$state"

echo "=== $(date '+%Y-%m-%d %H:%M:%S') refresh-albums"

# One run at a time: a slow night must not overlap the next.
exec 9>"$state/refresh.lock"
if ! flock -n 9; then
    echo "another refresh is still running; skipping"
    exit 0
fi

if [ ! -r "$key_file" ]; then
    echo "no API key at $key_file — create one in Immich (user.read, album.read, album.create," \
         "albumAsset.create) and put it there, readable only by you"
    exit 1
fi

# Spatial video. The list is only replaced when the scan succeeds, so a failed
# night leaves yesterday's list rather than an empty one.
set --
if [ -n "${SPATIAL_PATH_MAPS:-}" ]; then
    old_ifs=$IFS
    IFS='
'
    for m in $SPATIAL_PATH_MAPS; do set -- "$@" --path-map "$m"; done
    IFS=$old_ifs
fi
nice -n 19 ionice -c 3 python3 "$here/find-spatial-videos.py" "$@" \
    --cache "$state/spatial-cache.tsv" > "$state/spatial.txt.new"
mv "$state/spatial.txt.new" "$state/spatial.txt"

IMMICH_API_KEY=$(cat "$key_file") python3 "$here/backfill-albums.py" --apply \
    --spatial-list "$state/spatial.txt"
