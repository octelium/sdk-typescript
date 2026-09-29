import {
  ObjectReference,
  CommonListOptions,
  CommonListOptions_OrderBy_Type,
  CommonListOptions_OrderBy_Mode,
} from "@octelium/apis/main/metav1";
import type { ListResponseMeta } from "@octelium/apis/main/metav1";
import { CordiumError, integer, invalid, nonempty } from "./errors.js";

/** Per-operation cancellation and deadline. A timeout of zero disables the default deadline. */
export interface RequestOptions {
  /** Cancels this operation, including polling and streaming. */
  signal?: AbortSignal;
  /** Total operation deadline in milliseconds; zero means unlimited. */
  timeoutMs?: number;
}
/** Identify an object by name or immutable UID. Strings are names, including qualified Space names. */
export type Reference =
  | string
  | { name: string; uid?: never }
  | { uid: string; name?: never };
/** Pagination and sorting; page numbers start at zero. */
export interface ListOptions {
  /** Page number, starting at zero. */
  page?: number;
  /** Number of items per page. Omitted values use the server default. */
  pageSize?: number;
  /** Sort field. */
  orderBy?: "name" | "createdAt";
  /** Sort direction. */
  order?: "asc" | "desc";
}
/** A single page, with authoritative pagination metadata from the server. */
export interface Page<T> {
  /** Items on this page. */
  items: T[];
  /** Pagination details. */
  page: ListResponseMeta;
}
/** Polling options used by readiness and build wait helpers. */
export interface WaitOptions extends RequestOptions {
  /** Poll interval in milliseconds, default 1,000. */
  pollIntervalMs?: number;
}
export function reference(value: Reference): ObjectReference {
  if (typeof value === "string")
    return ObjectReference.create({ name: nonempty(value, "Reference") });
  if (!value || Boolean(value.name) === Boolean(value.uid))
    invalid("Specify exactly one of name or uid");
  return ObjectReference.create(
    value.uid
      ? { uid: nonempty(value.uid, "UID") }
      : { name: nonempty(value.name!, "Name") },
  );
}
export function common(options: ListOptions = {}): CommonListOptions {
  return CommonListOptions.create({
    page: options.page === undefined ? 0 : integer(options.page, "page"),
    itemsPerPage:
      options.pageSize === undefined
        ? 0
        : integer(options.pageSize, "pageSize", 1),
    orderBy: {
      type:
        options.orderBy === "name"
          ? CommonListOptions_OrderBy_Type.NAME
          : options.orderBy === "createdAt"
            ? CommonListOptions_OrderBy_Type.CREATED_AT
            : 0,
      mode:
        options.order === "asc"
          ? CommonListOptions_OrderBy_Mode.ASC
          : options.order === "desc"
            ? CommonListOptions_OrderBy_Mode.DESC
            : 0,
    },
  });
}
export async function* paginate<T, O extends ListOptions>(
  fetch: (o: O) => Promise<Page<T>>,
  options: O,
): AsyncGenerator<T> {
  for (let page = options.page ?? 0; ; page++) {
    const result = await fetch({
      ...options,
      pageSize: options.pageSize ?? 100,
      page,
    });
    for (const item of result.items) yield item;
    if (!result.page.hasMore) return;
    if (!result.items.length || result.page.page !== page)
      throw new CordiumError(
        "Server returned non-progressing pagination",
        "PROTOCOL_ERROR",
      );
    integer(page + 1, "page");
  }
}
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      done();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
