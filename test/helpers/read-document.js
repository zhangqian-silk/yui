import assert from "node:assert/strict";

/** Test consumer for the public long-document contract, not a silent fallback. */
export function readDocument(read) {
  let value = read();
  if (!value.contentPage) return value;
  let text = "";
  let offset = 0;
  const digest = value.contentPage.digest;
  while (true) {
    const page = value.contentPage;
    assert.equal(page.digest, digest);
    assert.equal(page.offset, offset);
    text += page.text;
    offset += page.text.length;
    if (page.complete) {
      assert.equal(page.nextCursor, null);
      assert.equal(offset, page.totalCharacters);
      return JSON.parse(text);
    }
    value = read(page.nextCursor);
  }
}
