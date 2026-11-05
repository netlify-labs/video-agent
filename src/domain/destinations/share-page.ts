// The share page as a destination kind (publish destinations §2.1, §2.3). It has no destination_publications rows
// and no background step: both publish routes call publishVersion / unpublishVersion (src/domain/videos.ts), so the
// publications row, the /v/{slug} mirror, links, embeds and the transcript choice stay exactly as they were.
import { registerKind } from './registry.js'
import type { DestinationKind } from './types.js'

export const sharePageKind: DestinationKind = {
  kind: 'share_page',
  optionsSchema: () => null,
  unpublishOptionsSchema: () => null,
  ready: async () => ({ ok: true }),
  step: async () => ({
    status: 'failed',
    error: { code: 'inline_only', message: 'The share page publishes inline.' },
  }),
}

registerKind(sharePageKind)
