#!/bin/zsh
# shoot.sh <source.html> <out-dir> <label> [width] [height]
#
# Captures an HTML file at an EXACT CSS viewport width.
#
# WHY THIS IS NOT `chrome --screenshot --window-size 375,N`.
# Headless Chrome clamps --window-size to a 500x288 floor. Asking for
# 375 wide silently renders a 500px viewport and hands back a 375px-wide
# CROP of it, so every `@media (max-width: 640px)` answers for the wrong
# screen and the crop reads as horizontal overflow that is not there. It
# was probed directly: --window-size=375,200 reported 500x288. A whole
# round of "375px proof" was thrown away over it once already.
#
# The fix is that AN IFRAME IS A VIEWPORT. The page renders inside an
# iframe of the exact width, inside an outer window kept above the floor,
# so media queries inside the frame answer for the frame. The frame is
# CENTRED because `sips` crops from the centre and has no working offset;
# left-aligning it produced a screenshot of the middle of the page.
#
# Generalised from the version that lived in one agent's worktree with
# every path hard-coded — which is why the next person could not use it.
set -e

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
SRC="${1:?usage: shoot.sh <source.html> <out-dir> <label> [width] [height]}"
OUT="${2:?missing out-dir}"
LABEL="${3:?missing label}"
W="${4:-375}"
H="${5:-812}"

[[ -f "$SRC" ]] || { print -u2 "shoot.sh: no such file: $SRC"; exit 1; }
[[ -x "$CHROME" ]] || { print -u2 "shoot.sh: Chrome not found at $CHROME"; exit 1; }

mkdir -p "$OUT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp "$SRC" "$WORK/page.html"
cat > "$WORK/frame.html" <<EOF
<body style="margin:0;background:#fff;display:flex;justify-content:center">
<iframe src="./page.html" width="$W" height="$H" style="border:0;display:block"></iframe>
</body>
EOF

# The outer window must clear Chrome's 500x288 floor or the clamp is back.
WIN_W=$(( W > 500 ? W : 500 ))
WIN_H=$(( H > 288 ? H : 288 ))

"$CHROME" --headless=new --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 --virtual-time-budget=3000 \
  --screenshot="$OUT/$LABEL.png" --window-size="$WIN_W,$WIN_H" \
  "file://$WORK/frame.html" 2>/dev/null

# --force-device-scale-factor=2 means the PNG is 2x the CSS box; crop back
# to the iframe so the file is exactly the viewport that was asked for.
sips --cropToHeightWidth $(( H * 2 )) $(( W * 2 )) --cropOffset 0 0 \
  "$OUT/$LABEL.png" --out "$OUT/$LABEL.png" >/dev/null

print "$OUT/$LABEL.png  (${W}x${H} CSS px @2x)"
