#!/bin/sh
# Builds Flisk App and installs it so it shows up in Launchpad, Spotlight and Finder > Applications.
# Installs to /Applications when writable, otherwise ~/Applications. Never uses sudo.
set -eu
cd "$(dirname "$0")/.."
./macos/build.sh
SRC="dist/Flisk App.app"

if [ -w /Applications ]; then DEST_DIR=/Applications; else DEST_DIR="$HOME/Applications"; mkdir -p "$DEST_DIR"; fi
DEST="$DEST_DIR/Flisk App.app"

# Quit a running copy so it can be replaced. The pre-rename app is still named TDK App on the first upgrade.
osascript -e 'tell application "Flisk App" to quit' >/dev/null 2>&1 || true
osascript -e 'tell application "TDK App" to quit' >/dev/null 2>&1 || true
sleep 1
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
# The app was called TDK App before the rename; remove that bundle from either Applications directory,
# since the old install may have used the other one.
for OLD_DEST in "/Applications/TDK App.app" "$HOME/Applications/TDK App.app"; do
  # `|| true`: an unwritable old bundle (other admin account, MDM, flags) must not abort
  # the install before Launch Services registration and the success message.
  if [ -d "$OLD_DEST" ]; then rm -rf "$OLD_DEST" || true; fi
done
xattr -dr com.apple.quarantine "$DEST" >/dev/null 2>&1 || true
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" >/dev/null 2>&1 || true
touch "$DEST"
echo "Installed $DEST"
echo "Open it from Launchpad or Spotlight, or run: open -a \"Flisk App\""
