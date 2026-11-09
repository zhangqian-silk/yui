#!/bin/sh
# usage: shot.sh url width height out [extra-python]
browser-use <<PY 2>&1 | grep -v "browser-harness"
import time
cdp("Emulation.setDeviceMetricsOverride", width=$2, height=$3, deviceScaleFactor=1, mobile=$2 < 700)
goto_url("$1"); wait_for_load(); time.sleep(2.2)
$5
capture_screenshot("$4")
print(js("JSON.stringify({vw: innerWidth, vh: innerHeight, sw: document.documentElement.scrollWidth, sh: document.querySelector('#manage-scroll')?.scrollHeight})"))
PY
