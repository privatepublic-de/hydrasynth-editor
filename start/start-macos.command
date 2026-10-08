#!/bin/sh
# Double-click in Finder: builds the editor and opens it at http://localhost:5179.
cd "$(dirname "$0")/.." || exit 1
exec sh start/start.sh
