/**
 * Grok ACP extension: `_x.ai/ask_user_question`.
 * Parse agent params and shape client responses.
 */

export const GROK_ASK_USER_QUESTION_METHOD = "_x.ai/ask_user_question";

export type GrokAskUserQuestionParams = {
  sessionId?: string;
  toolCallId?: string | null;
  questions?: unknown;
  annotations?: unknown;
};

export type GrokUserQuestionOption = {
  label: string;
  description?: string;
  preview?: string;
};

export type GrokUserQuestionItem = {
  question: string;
  header?: string;
  options: GrokUserQuestionOption[];
  multiSelect?: boolean;
};

export type GrokAskUserQuestionParsed = {
  sessionId: string;
  toolCallId?: string | null;
  questions: GrokUserQuestionItem[];
  annotations?: Record<string, unknown> | null;
};

/** Wire response accepted by Grok's AskUserQuestionExtResponse. */
export type GrokAskUserQuestionResponse =
  | {
      answers: Record<string, string>;
      partial_answers?: boolean;
    }
  | { skip_interview: true }
  | { chat_about_this: true; message?: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseOption(raw: unknown): GrokUserQuestionOption | null {
  const o = asRecord(raw);
  if (!o) return null;
  const label = asString(o.label);
  if (!label) return null;
  return {
    label,
    ...(asString(o.description) ? { description: asString(o.description) } : {}),
    ...(asString(o.preview) ? { preview: asString(o.preview) } : {}),
  };
}

function parseQuestion(raw: unknown): GrokUserQuestionItem | null {
  const q = asRecord(raw);
  if (!q) return null;
  const question = asString(q.question);
  if (!question) return null;
  const optionsRaw = Array.isArray(q.options) ? q.options : [];
  const options = optionsRaw
    .map(parseOption)
    .filter((x): x is GrokUserQuestionOption => x != null);
  const multi =
    q.multiSelect === true ||
    q.multi_select === true ||
    q.multiSelect === "true";
  return {
    question,
    ...(asString(q.header) ? { header: asString(q.header) } : {}),
    options,
    ...(multi ? { multiSelect: true } : {}),
  };
}

/** ACP `onRequest` params parser for `_x.ai/ask_user_question`. */
export function parseGrokAskUserQuestionParams(
  value: unknown,
): GrokAskUserQuestionParams {
  const obj = asRecord(value) ?? {};
  return {
    sessionId: asString(obj.sessionId) ?? asString(obj.session_id),
    toolCallId:
      asString(obj.toolCallId) ??
      asString(obj.tool_call_id) ??
      (obj.toolCallId === null || obj.tool_call_id === null ? null : undefined),
    questions: obj.questions,
    annotations: obj.annotations,
  };
}

export function normalizeGrokAskUserQuestion(
  params: GrokAskUserQuestionParams,
): GrokAskUserQuestionParsed {
  const sessionId = params.sessionId?.trim() || "unknown";
  const list = Array.isArray(params.questions) ? params.questions : [];
  const questions = list
    .map(parseQuestion)
    .filter((q): q is GrokUserQuestionItem => q != null);
  const ann = asRecord(params.annotations);
  return {
    sessionId,
    toolCallId: params.toolCallId,
    questions,
    annotations: ann,
  };
}

export function toGrokAskUserQuestionResponse(decision: {
  action: "accepted" | "skip_interview" | "chat_about_this";
  answers?: Record<string, string>;
  partialAnswers?: boolean;
  message?: string;
}): GrokAskUserQuestionResponse {
  if (decision.action === "skip_interview") {
    return { skip_interview: true };
  }
  if (decision.action === "chat_about_this") {
    return {
      chat_about_this: true,
      ...(decision.message?.trim()
        ? { message: decision.message.trim() }
        : {}),
    };
  }
  return {
    answers: decision.answers ?? {},
    ...(decision.partialAnswers ? { partial_answers: true } : {}),
  };
}
