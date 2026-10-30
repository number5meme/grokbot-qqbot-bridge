#!/usr/bin/env bash
# See fetch-media.cjs for usage.
cd "$(dirname "$0")/.." || exit 1
exec "${NODE:-node}" relay/fetch-media.cjs "$@"
