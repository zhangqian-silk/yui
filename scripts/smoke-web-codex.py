# Explicit live opt-in fixture only. Run through Browser Use via the driver.
import os
import json
import time
from pathlib import Path

assert os.environ.get("YUI_LIVE_CODEX") == "authorized"
exec(Path("scripts/smoke-web-browser.py").read_text().split('cdp("Emulation.clearDeviceMetricsOverride")\nnew_tab')[0])
fixture = json.loads((evidence / "report.json").read_text())
endpoint = "/api/conversation?scope=task&task=" + fixture["taskId"] + "&role=leader"
def facts():
    return read_api(endpoint)["body"]
def history(thread):
    return read_api(endpoint + "&session=" + thread)["body"]
def save(name, value):
    (evidence / (name + ".json")).write_text(json.dumps(value, ensure_ascii=False, indent=2))

target = cdp("Target.createTarget", url=base + "/?task=" + fixture["taskId"])["targetId"]
try:
    switch_tab(target)
    cdp("Emulation.setDeviceMetricsOverride", width=1365, height=850, deviceScaleFactor=1, mobile=False)
    wait_for_load()
    print(page_info())
    click_named("Conversation", "tab")
    wait("!!document.querySelector('textarea[aria-label=\"Message to the selected Session\"]')")
    wait("!([...document.querySelectorAll('button')].find(b=>b.textContent==='Send')).disabled")
    before = facts()
    thread = before["currentSessionId"]
    assert before["turn"]["status"] == "completed"
    save("before-browser", {"facts": before, "history": history(thread)})
    # Observe the genuine fetch; no mocking, alteration, retry, or injected state.
    js("""(()=>{window.__executionReceipts=[];const original=window.fetch.bind(window);
    window.fetch=async function(url,options){const response=await original(url,options);
    if(String(url).startsWith('/api/conversation?')&&options?.method==='POST'){
      window.__executionReceipts.push({url:String(url),body:JSON.parse(options.body),
        status:response.status,result:await response.clone().json()});}return response;};})()""")
    prompt = ("Read your own Session Manifest and its specified full current Context command, "
              "and this Message in full. In your own workspace read fixture-value.txt; its value "
              "has deliberately not been supplied in this prompt. Create exactly one new UTF-8 "
              "file business-result.json with keys taskId (your Task), value (the file value trimmed), "
              "and result (the value reversed). Use actual tools to read and write. Do not modify "
              "the fixture or preflight-proof.json. Read back the result, then reply with the "
              "actual value and result and the output filename. Do not complete the Task, delegate, "
              "make external requests, or create any other work. This one bounded file task is authorized.")
    type_label("Message to the selected Session", prompt)
    click_named("Send")
    end = time.monotonic() + 150
    current = before
    while time.monotonic() < end:
        current = facts()
        turn = current.get("turn", {})
        if turn.get("nativeTurnId") != before["turn"]["nativeTurnId"] and turn.get("status") in ("completed", "failed", "cancelled"):
            break
        time.sleep(.3)
    receipts = js("window.__executionReceipts")
    h = history(thread)
    save("browser-result", {"before": before, "facts": current, "history": h, "receipts": receipts})
    capture("native-business-result")
    assert len(receipts) == 1, "Do not resend an unknown outcome"
    request_id = receipts[0]["body"]["requestId"]
    receipt = read_api(endpoint + "&requestId=" + request_id)
    save("browser-receipt", receipt)
    assert current["currentSessionId"] == thread
    assert current["turn"]["nativeTurnId"] != before["turn"]["nativeTurnId"]
    assert current["turn"]["status"] == "completed", current
    startup = json.loads((evidence / "native-startup.json").read_text())["startup"]
    workspace = Path(startup["cwd"])
    original = (workspace / "fixture-value.txt").read_text().strip()
    result = json.loads((workspace / "business-result.json").read_text())
    assert result == {"taskId": fixture["taskId"], "value": original, "result": original[::-1]}, result
    assert original not in prompt
    assert original in js("document.body.innerText")
    assert original[::-1] in js("document.body.innerText")
    assert len(set(i["turnId"] for i in h["items"])) == 2, "Activation plus one business Turn only"
    save("business-proof", {"status": "passed", "threadId": thread,
         "turnId": current["turn"]["nativeTurnId"], "requestId": request_id,
         "result": result, "outputSha256": hashlib.sha256((workspace / "business-result.json").read_bytes()).hexdigest(),
         "fixtureSha256": hashlib.sha256((workspace / "fixture-value.txt").read_bytes()).hexdigest(),
         "bodyText": js("document.body.innerText")})
    print("PASS browser Message -> same native Thread -> real read/write -> matching Web content")
finally:
    close_tab(target)
