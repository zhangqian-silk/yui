import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

// Disposable local substitute, not a claim about a real notification service.
// Sending produces an append-only effect before a response can be dropped.
export class NotificationSimulator {
  constructor(path) {
    this.path = path;
    writeFileSync(path, "", { flag: "wx" });
  }

  ledger() {
    return readFileSync(this.path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  }

  send({ key, recipient, body }, { dropResponse = false } = {}) {
    const previous = this.ledger();
    let receipt = previous.find(item => item.key === key);
    if (receipt && (receipt.recipient !== recipient || receipt.body !== body)) {
      throw new Error("Request key reused with a different payload");
    }
    if (!receipt) {
      receipt = { key, recipient, body, effectId: `effect-${previous.length + 1}`, status: "confirmed" };
      appendFileSync(this.path, `${JSON.stringify(receipt)}\n`);
    }
    return dropResponse ? undefined : receipt;
  }

  lookup(key) {
    return this.ledger().find(item => item.key === key);
  }
}
