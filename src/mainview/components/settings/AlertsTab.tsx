import type { Dispatch, SetStateAction } from "react";
import type { AppSettings } from "../../../shared/rpc";
import { ensureNotificationPermission } from "../../completionAlert";

type Props = {
  draft: AppSettings;
  setDraft: Dispatch<SetStateAction<AppSettings>>;
};

export function AlertsTab({ draft, setDraft }: Props) {
  return (
    <div className="space-y-3">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-gray-500">
        Completion alerts
      </span>
      <div>
        <label className="flex items-center gap-2 text-gray-300">
          <input
            type="checkbox"
            checked={draft.enableNotifications ?? true}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                enableNotifications: e.target.checked,
              }))
            }
            className="rounded border-[#444]"
          />
          System notification when a task completes
        </label>
        <p className="mt-1 text-[11px] text-gray-500">
          Native OS banner via Electrobun. macOS may ask for permission the first
          time a notification is shown — allow “terminal-react” under System
          Settings → Notifications if banners don’t appear.
        </p>
      </div>
      <div>
        <label className="flex items-center gap-2 text-gray-300">
          <input
            type="checkbox"
            checked={draft.enableSound ?? true}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                enableSound: e.target.checked,
              }))
            }
            className="rounded border-[#444]"
          />
          Play sound when a task completes
        </label>
        <p className="mt-1 text-[11px] text-gray-500">
          OS notification sound when banners are on; otherwise a short in-app
          chime.
        </p>
      </div>
      {draft.enableNotifications && (
        <button
          type="button"
          onClick={() => void ensureNotificationPermission()}
          className="rounded-md border border-[#333] px-2.5 py-1 text-xs text-gray-300 hover:bg-[#2a2a2a] hover:text-gray-100"
        >
          Send test notification
        </button>
      )}
    </div>
  );
}
