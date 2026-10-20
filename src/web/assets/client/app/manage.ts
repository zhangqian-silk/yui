export const MANAGE_SCRIPT = String.raw`
import "/assets/js/app/settings.js";
import "/assets/js/app/models.js";
import { startManagement, i18n } from "/assets/js/layout/manageShell.js";
import { bindSignOut } from "/assets/js/lib/session.js";
import { createToast } from "/assets/js/ui/toast.js";
startManagement();
bindSignOut(document.querySelector("#sign-out"), i18n.t, createToast(document.querySelector("#toast")));
`;
