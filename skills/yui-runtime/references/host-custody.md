# Host custody, protocol and upgrades

Read for Host protocol/custody or persistence failures, or when diagnosing or
changing Host custody during an upgrade. An ordinary Controller outage alone
does not require it. Apply [Runtime recovery](recovery.md) first.

Compatible upgrades preserve logical Sessions. Build generations and historical
Skill packages are provenance, not continuation gates. Load current stable
Skills and current authority; never change a user's model, account, native
permissions or workspace to make an upgrade work.

Within Host control/event v1, status advertises `controlCapabilities` and the
loaded `hostImplementation`, independently of `endpointImplementation`. Missing
capabilities or `eventDelivery` are unreported, not healthy. A Controller must
not repeatedly send an unsupported `reconcile-turn`; the existing raw Inbox
still permits exact event consumption without executing the input again.
Current Hosts retain unpersisted original facts during a filesystem failure;
keep that process alive until persistence recovers. Those volatile bytes cannot
be recovered after process loss merely by restarting the Controller.

Program/storage upgrade success does not mean Host replacement succeeded.
Compatible live Hosts may continue, including busy ones. A new Host may resume
the same native Session only through the existing authorized lifecycle after
exact execution, background resources and writer release are proven. An idle
status, a stopped proxy or a missing control field is insufficient. Unknown
effects preserve the original Session, input and resources; do not force-kill,
replay, hot-replace loaded modules or silently create a new Session. Existing
explicit stop/replacement authority is separate from an ordinary upgrade.
Unsupported protocols require an explicit bounded recovery plan, not arbitrary
historical Host adoption. Storage migration remains independently fenced.
