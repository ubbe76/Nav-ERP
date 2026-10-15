// Material shortage on reporting (system setting "Materialbrist vid
// rapportering"). In warn mode the API answers 409 `material-shortage` with
// overridable: true; the user is asked and the call is repeated with
// allowMaterialShortage: true. In block mode (overridable: false) the error
// is rethrown and shown as an ordinary error.

import { ApiError } from "./api";
import { confirmDialog } from "./confirm";
import { shortageList } from "./errorMessages";

// Resolves to null when the user declined to report anyway (the caller then
// leaves the form as it was and shows no error).
export async function runWithShortageConfirm<T>(
  run: (allowMaterialShortage: boolean) => Promise<T>
): Promise<T | null> {
  try {
    return await run(false);
  } catch (err) {
    if (
      err instanceof ApiError &&
      err.code === "material-shortage" &&
      (err.body as { overridable?: unknown } | undefined)?.overridable === true
    ) {
      const ok = await confirmDialog(`Det saknas ingående delar: ${shortageList(err)}. Rapportera ändå?`, {
        confirmLabel: "Rapportera ändå",
      });
      if (!ok) return null;
      return run(true);
    }
    throw err;
  }
}
