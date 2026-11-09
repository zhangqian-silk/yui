#!/bin/sh
# usage: start.sh mode port [root]   (mode: full | readonly | empty | nomodels | badnative | badbound)
# Run `npm run build` first. Uses an isolated temp Home; never touches a real one.
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../.." && pwd)
cd "$here"
YUI_REPO="$repo" setsid nohup node fixture.mjs "$1" "$2" $3 > "fx-$2.log" 2>&1 < /dev/null &
echo $! >> pids.txt
sleep 1.5; cat "fx-$2.log"
