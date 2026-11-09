// The `x-sdk` extension every route carries (docs/plans/2026-11-04-cli-and-sdk.md §4.1). The SDK generator
// (scripts/gen-sdk.ts) names its methods from it, never from paths or operationIds, so a method's name is a
// decision a reviewer sees in the route's diff. app/test/openapi-ids.test.ts checks every operation has one.
import type { Feature } from '../domain/features.js'

export type SdkMeta =
  /** No SDK method (web app, admin and run routes); still reachable through `va.raw`. */
  | false
  | {
      /** The namespace: `va.<resource>`. camelCase. */
      resource: string
      /** The method: `va.<resource>.<method>`. camelCase. */
      method: string
      /** The `features` string the whole operation needs; the SDK refuses it with unsupported_by_server without it. */
      feature?: Feature
      /** Input fields a feature added to an older route, so an older server can't silently drop them. */
      fieldFeatures?: Record<string, Feature>
    }
