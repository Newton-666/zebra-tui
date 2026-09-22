#!/bin/sh
# 把 pi-tui（及其运行时依赖）从本地已安装的 pi 复制到 deps/
# 仓库不提交第三方代码（pi-tui 是 MIT，但打包里没有 LICENSE 文件，故独立 vendor）
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_SRC="$HOME/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui"
SRC="${1:-$DEFAULT_SRC}"

if [ ! -d "$SRC" ]; then
  echo "找不到 pi-tui: $SRC" >&2
  echo "用法: $0 [pi-tui 路径]" >&2
  echo "  或先安装 pi:  npm i -g @earendil-works/pi-coding-agent" >&2
  exit 1
fi

NODE_MODULES="$(cd "$SRC/../.." && pwd)"   # pi 的 node_modules

echo "vendor pi-tui: $SRC"
rm -rf "$ROOT/deps/pi-tui"
mkdir -p "$ROOT/deps/pi-tui"
cp -R "$SRC/." "$ROOT/deps/pi-tui/"

# pi-tui 的运行时依赖（与 pi-tui 同级）
mkdir -p "$ROOT/deps/pi-tui/node_modules"
for dep in marked get-east-asian-width; do
  if [ -d "$NODE_MODULES/$dep" ]; then
    cp -R "$NODE_MODULES/$dep" "$ROOT/deps/pi-tui/node_modules/"
    echo "  + $dep"
  else
    echo "  ! 缺少依赖 $dep（可能需要重新安装 pi）" >&2
  fi
done

echo "完成。现在可以运行 ./zebra"