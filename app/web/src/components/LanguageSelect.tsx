// The video's spoken language (plan 2026-11-02 §6.6 "Language"): recorded narration is transcribed in it. Names come
// from the browser (Intl.DisplayNames); the ones the local transcriber doesn't cover say they need ElevenLabs.
import { Select } from '@mantine/core'
import { LANGUAGES, isLanguage, parakeetCovers, type Language } from '../../../server/lib/language'

let names: Intl.DisplayNames | null = null
/** "German" for 'de', in the browser's language; the code itself without Intl.DisplayNames. */
export function languageName(code: string): string {
  try {
    names ??= new Intl.DisplayNames(undefined, { type: 'language' })
    return names.of(code) ?? code
  } catch {
    return code
  }
}

export function LanguageSelect(props: { defaultValue: Language; onChange: (l: Language) => void }) {
  const data = LANGUAGES.map((code) => ({
    value: code,
    label: parakeetCovers(code) ? languageName(code) : `${languageName(code)} (needs ElevenLabs)`,
  })).sort((a, b) => a.label.localeCompare(b.label))
  return (
    <Select
      label="Spoken language"
      description="Recorded narration is transcribed in it for captions."
      data={data}
      defaultValue={props.defaultValue}
      allowDeselect={false}
      searchable
      comboboxProps={{ withinPortal: true }}
      onChange={(v) => {
        if (v && isLanguage(v)) props.onChange(v)
      }}
      data-testid="language-select"
      data-autofocus
    />
  )
}
