// LOCKED (render-engines plan §5.1): props.json is the one source of truth. The composition only reads it, so the
// render, the check and the editor's Player can't disagree; parsing it here makes a bad props.json fail at once.
import { Composition } from 'remotion'
import props from '../props.json'
import { vaMetadata } from './va/metadata'
import { vaSchema } from './va/schema'
import { VaVideo } from './va/Video'

export const Root = () => (
  <Composition
    id="main"
    component={VaVideo}
    schema={vaSchema}
    defaultProps={vaSchema.parse(props)}
    calculateMetadata={vaMetadata}
    fps={30}
    width={props.width}
    height={props.height}
    durationInFrames={1}
  />
)
