#!/usr/bin/env bash
# 手机端截图：390×844（iPhone 14 逻辑分辨率）
#
# 为什么要绕这一圈：
#   Windows 的窗口有最小宽度限制（约 500px），Edge headless 也继承。
#   --window-size=390 时真实 CSS 视口仍然是 500 左右，页面按 500 布局，
#   截图只裁 390 —— 结果右侧看着像被切掉了，误导判断。
#   所以用固定尺寸 iframe 把视口钉死，截完按 iframe 区域裁掉背景。
#
# 用法：
#   bash scripts/shot-mobile.sh            # 全部视图
#   bash scripts/shot-mobile.sh star gewu  # 指定视图

set -u

ROOT=/d/wenjin
APP=$ROOT/apps/mobile
EDGE="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
PY="/c/Users/Administrator/.workbuddy/binaries/python/envs/wj/Scripts/python.exe"
PORT=${PORT:-4193}

W=${W:-390}
H=${H:-844}
# 非标准高度时给文件名加后缀，免得把标准尺寸的截图覆盖掉
SUFFIX=${SUFFIX:-}
RAW=$ROOT/shots-m/raw
OUT=$ROOT/docs/screenshots/mobile

VIEWS=("$@")
if [ ${#VIEWS[@]} -eq 0 ]; then
  VIEWS=(star read gewu debate me method book set)
fi

mkdir -p "$RAW" "$OUT"

# 辅助页不是构建产物，每次都要重新放进去（vite build 会清空 www）
cp "$ROOT/scripts/viewport-mobile.html" "$APP/www/viewport.html"

cd "$APP" || exit 1
npx vite preview --port "$PORT" --strictPort >/tmp/shot-mobile.log 2>&1 &
PV=$!

code=""
for _ in $(seq 1 30); do
  code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" 2>/dev/null)
  [ "$code" = "200" ] && break
  sleep 1
done

if [ "$code" != "200" ]; then
  echo "预览服务没起来，看 /tmp/shot-mobile.log"
  kill "$PV" 2>/dev/null
  exit 1
fi

for t in "${VIEWS[@]}"; do
  # 窗口开得比 iframe 高：--window-size 在 headless 里是窗口尺寸，
  # 内容区会矮一截（标题栏/边框），只给 900 的话底栏会被裁掉约 85px。
  "$EDGE" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --virtual-time-budget=4000 \
    --window-size=$((W + 130)),$((H + 256)) \
    --screenshot="$RAW/$t$SUFFIX.png" \
    "http://127.0.0.1:$PORT/viewport.html?w=$W&h=$H#$t" 2>/dev/null

  if [ -f "$RAW/$t$SUFFIX.png" ]; then
    "$PY" "$ROOT/scripts/crop.py" "$RAW/$t$SUFFIX.png" "$OUT/$t$SUFFIX.png" $W $H >/dev/null
    echo "  $t$SUFFIX.png"
  else
    echo "  $t$SUFFIX.png 截图失败"
  fi
done

# 收尾：辅助页别留在产物目录里，免得被 cap sync 打进 apk
mv "$APP/www/viewport.html" "$RAW/viewport.html.used" 2>/dev/null

kill "$PV" 2>/dev/null
echo "完成 → $OUT"
