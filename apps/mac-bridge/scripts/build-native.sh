#!/bin/sh
set -eu

node_binary="${NODE_BINARY:-$(command -v node)}"
node_prefix="$($node_binary -p 'process.execPath.replace(/\/bin\/node$/, "")')"
node_include="$node_prefix/include/node"
source_file="native/coreaudio-bridge.cc"
output_dir="build/Release"
output_file="$output_dir/coreaudio_bridge.node"

if [ ! -f "$node_include/node_api.h" ]; then
  echo "Node headers not found at $node_include" >&2
  exit 1
fi

mkdir -p "$output_dir"
xcrun clang++ \
  -std=c++17 \
  -O2 \
  -fvisibility=hidden \
  -bundle \
  -undefined dynamic_lookup \
  -DNODE_GYP_MODULE_NAME=coreaudio_bridge \
  -I"$node_include" \
  -framework CoreAudio \
  -framework AudioToolbox \
  "$source_file" \
  -o "$output_file"

echo "Built $output_file"
