// LOCKED (render-engines §5.1): props.json is the one source of truth; the composition only reads it.
import { Composition } from 'remotion'
import props from '../props.json'
import { vaMetadata } from './va/metadata'
import { vaSchema, type VaProps } from './va/schema'
import { VaVideo } from './va/Video'

export const Root = () => (
  <Composition
    id="main"
    component={VaVideo}
    schema={vaSchema}
    defaultProps={props as VaProps}
    calculateMetadata={vaMetadata}
    fps={30}
    width={props.width}
    height={props.height}
    durationInFrames={1}
  />
)
