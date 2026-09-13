/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as reviewLifecycle from "../reviewLifecycle.js";
import type * as costLedgerData from "../costLedgerData.js";
import type * as costLedgerActions from "../costLedgerActions.js";
import type * as artifactData from "../artifactData.js";
import type * as http from "../http.js";
import type * as memoryAccess from "../memoryAccess.js";
import type * as memoryActions from "../memoryActions.js";
import type * as memoryData from "../memoryData.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  artifactData: typeof artifactData;
  http: typeof http;
  reviewLifecycle: typeof reviewLifecycle;
  costLedgerData: typeof costLedgerData;
  costLedgerActions: typeof costLedgerActions;

  memoryAccess: typeof memoryAccess;
  memoryActions: typeof memoryActions;
  memoryData: typeof memoryData;
  validators: typeof validators;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  rag: import("@convex-dev/rag/_generated/component.js").ComponentApi<"rag">;
};
