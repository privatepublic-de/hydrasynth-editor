#!/bin/sh
# Rebuilds local/extract/ from Edisyn's Hydrasynth driver, run headless over the
# patch dumps in local/patches/*.bin (from tools/dumpBanks.ts). Needs git and a JDK.
# Then: npx vite-node tools/generateParams.ts
set -e
cd "$(dirname "$0")/../.."
COMMIT=b53a5b313d0cd5c229e0fd03a33058bb8c9f2695
SRC=local/edisyn
if [ ! -d "$SRC" ]; then git clone --quiet https://github.com/eclab/edisyn.git "$SRC"; fi
git -C "$SRC" checkout --quiet "$COMMIT"
mkdir -p local/edisyn-build local/extract-build local/extract
if [ ! -f local/edisyn-build/.built-$COMMIT ]; then
  javac -nowarn -d local/edisyn-build -cp "$SRC/libraries/coremidi4j-1.6.jar" $(find "$SRC/edisyn" -name '*.java') 2>&1 | grep -v '^Note:' || true
  touch local/edisyn-build/.built-$COMMIT
fi
javac -nowarn -d local/extract-build -cp local/edisyn-build tools/edisyn-extract/edisyn/synth/asmhydrasynth/Extract.java 2>&1 | grep -v '^Note:' || true
# Edisyn's panels need a real AWT (headless throws); UIElement keeps it out of the Dock.
java -Dapple.awt.UIElement=true -cp "local/edisyn-build:local/extract-build:$SRC" \
  edisyn.synth.asmhydrasynth.Extract local/extract local/patches/*.bin > local/extract/edisyn.log 2>&1
echo "$COMMIT" > local/extract/EDISYN_COMMIT
echo "extracted to local/extract"
