// LOCKED. Read only by the Remotion CLI, which runs never use for rendering (spikes E5): the run renders through the
// Node API (scripts/lib/engines/remotion.ts). No webpack override and no browser executable, ever.
import { Config } from '@remotion/cli/config'

Config.setPublicDir('./assets')
Config.setCodec('h264')
