import { TagsInput } from '@mantine/core'
import { $api } from '../api/client'

export const MAX_TAGS = 10

/** What a person typed, as a tag: lowercase, spaces to dashes, nothing else odd, at most 30 characters. */
export function toTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+/, '')
    .slice(0, 30)
}

/** The tags in use on videos you can see, most used first (the library's filters and the field's suggestions). */
export function useTagsInUse() {
  return $api.useQuery('get', '/api/v1/video-tags').data?.items ?? []
}

/** Tags on a video: type one and press Enter or comma. Suggests the tags already in use. */
export function TagsField({
  value,
  onChange,
  label = 'Tags',
  description,
  size,
}: {
  value: string[]
  onChange: (tags: string[]) => void
  label?: string | null
  description?: string
  size?: 'xs' | 'sm'
}) {
  const inUse = useTagsInUse()
  return (
    <TagsInput
      {...(label ? { label } : { 'aria-label': 'Tags' })}
      {...(description ? { description } : {})}
      {...(size ? { size } : {})}
      placeholder={value.length ? '' : 'Add a tag, like demo'}
      data-testid="tags-field"
      value={value}
      data={inUse.map((t) => t.tag)}
      maxTags={MAX_TAGS}
      splitChars={[',', ' ']}
      onChange={(next) => {
        // Normalised and de-duplicated here, so what's shown is what the server stores.
        const tags = [...new Set(next.map(toTag).filter(Boolean))]
        onChange(tags)
      }}
    />
  )
}
