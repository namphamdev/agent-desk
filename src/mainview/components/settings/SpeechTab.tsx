import type { Dispatch, SetStateAction } from "react";
import type { AppSettings, SttSettings } from "../../../shared/rpc";
import { Input } from "@/components/ui/input";
import { Field } from "./Field";

const EMPTY_STT: SttSettings = {
  baseUrl: "",
  apiKey: "",
  model: "xai/grok-stt",
  language: "en",
};

type Props = {
  draft: AppSettings;
  setDraft: Dispatch<SetStateAction<AppSettings>>;
};

export function SpeechTab({ draft, setDraft }: Props) {
  const stt = draft.stt ?? EMPTY_STT;

  const patchStt = (patch: Partial<SttSettings>) => {
    setDraft((d) => ({
      ...d,
      stt: { ...(d.stt ?? EMPTY_STT), ...patch },
    }));
  };

  return (
    <div className="space-y-4">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Configure speech-to-text for the prompt-bar microphone. Uses an
        OpenAI-compatible{" "}
        <code className="text-muted-foreground">
          POST /v1/audio/transcriptions
        </code>{" "}
        endpoint (e.g. a gateway with{" "}
        <code className="text-muted-foreground">xai/grok-stt</code>).
        Credentials are stored only in local app settings.
      </p>

      <Field label="Base URL">
        <Input
          value={stt.baseUrl}
          onChange={(e) => patchStt({ baseUrl: e.target.value })}
          className="font-mono text-xs"
          placeholder="https://api.example.com"
          spellCheck={false}
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          Root or <code className="text-muted-foreground">/v1</code> URL — the
          app appends{" "}
          <code className="text-muted-foreground">
            /v1/audio/transcriptions
          </code>{" "}
          when needed.
        </p>
      </Field>

      <Field label="API key">
        <Input
          type="password"
          value={stt.apiKey}
          onChange={(e) => patchStt({ apiKey: e.target.value })}
          className="font-mono text-xs"
          placeholder="Bearer token"
          spellCheck={false}
          autoComplete="off"
        />
      </Field>

      <Field label="Model">
        <Input
          value={stt.model}
          onChange={(e) => patchStt({ model: e.target.value })}
          className="font-mono text-xs"
          placeholder="xai/grok-stt"
          spellCheck={false}
        />
      </Field>

      <Field label="Language">
        <Input
          value={stt.language}
          onChange={(e) => patchStt({ language: e.target.value })}
          className="font-mono text-xs"
          placeholder="en"
          spellCheck={false}
        />
        <p className="mt-1 text-[11px] text-muted-foreground">
          Optional language hint (e.g. <code className="text-muted-foreground">en</code>
          ). Leave blank for the provider default.
        </p>
      </Field>
    </div>
  );
}
