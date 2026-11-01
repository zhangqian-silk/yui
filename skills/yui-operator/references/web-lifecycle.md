# Web lifecycle

For user-requested Web lifecycle operations, use `yui web`, `yui web --status`
and `yui web --stop` with the current Operator identity and intended Home.
Operator starts return a Controller-owned receipt without holding this turn
open. Non-loopback binding requires `--auth-file <absolute-path>` containing
an owner-only (0600) regular file with a unique 32–128 character printable ASCII
password; browser username is `yui`. There is no default password.
Honor the user's exact network exposure and credential scope. Never clear
managed identity, impersonate a browser user, launch a bypass server or restart
the Controller merely to open Web. Report actual access URLs and failures,
never a wildcard address or an old snapshot as a working link. Explain that
HTTP is unencrypted, and keep credentials out of messages, logs and URLs.
Lifecycle authority does not authenticate visitors. On unknown startup outcome,
inspect status before retrying; a running listener is not proof of remote reachability.
Stopping Web closes browser connections without stopping Agents. Password
rotation requires explicit stop/start; changing the file alone does not revoke
the running credential. Controller recovery does not automatically reopen Web.

