/**
 * Browser-side helpers of the provisioning dialogs (Patch B12): the idempotency key, and the mapping from an API
 * failure to what the person sees. Nothing here is persisted and nothing server-supplied is shown verbatim: every
 * message is fixed wording chosen by the error CODE, so a hash, a stack trace or database text cannot reach the screen.
 */
import type { ApiResult } from "@/lib/auth/client";
import { MEMBER_SLOTS } from "@/lib/contracts/provisioning";

type Failure = Extract<ApiResult<unknown>, { ok: false }>;

export interface FormFailure {
  /** A message for the whole form (shown in an alert). */
  form?: string;
  /** Messages for individual fields, keyed by the API's field names (`admissionNos.2` = member M2). */
  fields: Record<string, string>;
}

/** A random UUID v4. `crypto.randomUUID` needs a secure context, so fall back to `getRandomValues`. */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const GENERIC = "Something went wrong on our side. Please try again.";

const FIELD_TEXT: Record<string, string> = {
  username: "Use 3–64 letters, numbers, dots, dashes or underscores.",
  loginId: "Use 3–64 letters, numbers, dots, dashes or underscores.",
  teamCode: "Use up to 16 letters, numbers, dashes or underscores.",
  name: "Enter a team name of up to 100 characters.",
  confirmPassword: "The passwords don't match.",
};

export type FormKind = "admin" | "team";

/** The text for one invalid field (the browser-side and the server-reported ones agree). */
export function fieldMessage(kind: FormKind, field: string): string {
  if (field === "password") {
    return kind === "admin"
      ? "Use 10–72 characters."
      : "Use 8–72 characters that differ from the Team ID and Login ID.";
  }
  const slot = /^admissionNos\.([1-4])$/.exec(field)?.[1];
  if (slot) return `Check M${slot}'s admission number (each must be different).`;
  return FIELD_TEXT[field] ?? "Check this field.";
}

/** Maps a failed API call to the messages shown in the dialog. Unknown codes become the generic message. */
export function provisioningFailure(failure: Failure, kind: FormKind): FormFailure {
  const fields: Record<string, string> = {};
  switch (failure.code) {
    case "VALIDATION_FAILED": {
      const named = Array.isArray(failure.details?.fields) ? failure.details.fields : [];
      for (const f of named) {
        if (typeof f === "string" && f.length <= 64) fields[f] = fieldMessage(kind, f);
      }
      return Object.keys(fields).length
        ? { fields }
        : { form: "Check the details and try again.", fields };
    }
    case "USERNAME_TAKEN":
      return { fields: { username: "That username is already taken." } };
    case "TEAM_CODE_TAKEN":
      return { fields: { teamCode: "That Team ID is already in use." } };
    case "LOGIN_ID_TAKEN":
      return { fields: { loginId: "That Login ID is already in use." } };
    case "ADMISSION_NO_TAKEN": {
      const slot = failure.details?.slot;
      const n =
        typeof slot === "number" && Number.isInteger(slot) && slot >= 1 && slot <= MEMBER_SLOTS
          ? slot
          : null;
      return n
        ? {
            fields: {
              [`admissionNos.${n}`]: `M${n}'s admission number is already registered to a team.`,
            },
          }
        : { form: "An admission number is already registered to a team.", fields };
    }
    case "UNAUTHENTICATED":
      return { form: "Your session has ended. Sign in again to continue.", fields };
    case "FORBIDDEN":
      return { form: "You are not allowed to do that.", fields };
    case "IDEMPOTENCY_KEY_REUSED":
      return {
        form: "That request was already used for something else. Please try again.",
        fields,
      };
    case "NETWORK_ERROR":
      return { form: "Couldn't reach the server. Check your connection and try again.", fields };
    default:
      return { form: GENERIC, fields };
  }
}

/**
 * Whether the outcome of the request is unknown (it may or may not have been applied). Only then is the SAME
 * Idempotency-Key reused for the retry, so a request that did succeed is replayed instead of repeated.
 */
export function outcomeUnknown(failure: Failure): boolean {
  return failure.status === 0 || failure.status >= 500 || failure.code === "BAD_RESPONSE";
}
