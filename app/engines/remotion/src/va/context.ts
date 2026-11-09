// LOCKED. The beat a component is in, and where its files are.
import { createContext, useContext } from 'react'
import type { VaBeat } from './schema'

export const BeatContext = createContext<VaBeat | null>(null)
export function useBeat(): VaBeat {
  const b = useContext(BeatContext)
  if (!b) throw new Error('A va component is used outside a beat.')
  return b
}
/** assets/media/x.png in props → staticFile('media/x.png'): the public dir is assets/. */
export const assetPath = (src: string) => src.replace(/^assets\//, '')
