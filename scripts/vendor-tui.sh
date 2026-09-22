#!/bin/sh
# 把 TUI 框架（及其运行时依赖）vendor 到 deps/ —— 仓库不提交第三方代码
# 用法: sh scripts/vendor-tui.sh [TUI 框架包路径]
# 默认路径指向常见安装位置；也可显式传入（如 node_modules 下的包目录）
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_SRC="$HOME/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui"
# 也可用环境变量指定：TUI_SRC=/path/to/tui sh scripts/vendor-tui.sh
SRC="${1:-$DEFAULT_SRC}"

if [ ! -d "$SRC" ]; then
  echo "找不到 TUI 框架包: $SRC" >&2
  echo "用法: $0 [包路径]" >&2
  echo "  默认位置不存在时，请显式传入包目录" >&2
  exit 1
fi

NODE_MODULES="$(cd "$SRC/../.." && pwd)"   # 宿主包的 node_modules

echo "vendor TUI framework: $SRC"
rm -rf "$ROOT/deps/pi-tui"
mkdir -p "$ROOT/deps/pi-tui"
cp -R "$SRC/." "$ROOT/deps/pi-tui/"

# 框架的运行时依赖（与框架同级）
mkdir -p "$ROOT/deps/pi-tui/node_modules"
for dep in marked get-east-asian-width; do
  if [ -d "$NODE_MODULES/$dep" ]; then
    cp -R "$NODE_MODULES/$dep" "$ROOT/deps/pi-tui/node_modules/"
    echo "  + $dep"
  else
    echo "  ! 缺少依赖 $dep（请检查传入的包路径）" >&2
  fi
done

echo "完成。现在可以运行 ./zebra"