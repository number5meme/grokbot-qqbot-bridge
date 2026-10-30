#!/usr/bin/env bash
# See note-inbound.cjs for usage.
cd "$(dirname "$0")/.." || exit 1
exec "${NODE:-node}" relay/note-inbound.cjs "$@"
