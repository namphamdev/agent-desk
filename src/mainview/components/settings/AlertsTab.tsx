import type { Dispatch, SetStateAction } from "react";
import type { AppSettings } from "../../../shared/rpc";
import { ensureNotificationPermission } from "../../completionAlert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";

type Props = {
  draft: AppSettings;
  setDraft: Dispatch<SetStateAction<AppSettings>>;
};

export function AlertsTab({ draft, setDraft }: Props) {
  return (
    <div className="space-y-3">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Completion alerts
      </span>
      <div>
        <label className="flex items-center gap-2 text-foreground/90">
          <Checkbox
            checked={draft.enableNotifications ?? true}
            onCheckedChange={(checked) =>
              setDraft((d) => ({
                ...d,
                enableNotifications: checked === true,
              }))
            }
          />
          System notification when a task completes
        </label>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Native OS banner via Electrobun. macOS may ask for permission the first
          time a notification is shown — allow “terminal-react” under System
          Settings → Notifications if banners don’t appear.
        </p>
      </div>
      <div>
        <label className="flex items-center gap-2 text-foreground/90">
          <Checkbox
            checked={draft.enableSound ?? true}
            onCheckedChange={(checked) =>
              setDraft((d) => ({
                ...d,
                enableSound: checked === true,
              }))
            }
          />
          Play sound when a task completes
        </label>
        <p className="mt-1 text-[11px] text-muted-foreground">
          OS notification sound when banners are on; otherwise a short in-app
          chime.
        </p>
      </div>
      {draft.enableNotifications && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void ensureNotificationPermission()}
        >
          Send test notification
        </Button>
      )}
    </div>
  );
}
